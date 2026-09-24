import type { TestDb } from './db';
import { seedContact, seedList } from './p1';
import { seedSenderDomain, seedSenderIdentity, verifiedDomainState } from './sender';
import { seedTemplate } from './p4';

/**
 * P5 seeds.
 *
 * A "launchable" campaign is one in `scheduled` whose time has come, with a
 * verified sender, a frozen template and a list of real contacts — the state
 * the worker's promotion sweep looks for. It is built by walking the campaign
 * through the real transitions (draft → validating → scheduled), so the P4
 * transition trigger and completeness check apply exactly as in production.
 */

export interface LaunchableCampaign {
  workspaceId: string;
  campaignId: string;
  listId: string;
  templateId: string;
  senderIdentityId: string;
  domainId: string;
  contactIds: string[];
  emails: string[];
}

export async function seedLaunchableCampaign(
  db: TestDb,
  workspaceId: string,
  options: {
    recipients?: number;
    emails?: string[];
    /** Minutes relative to now. Negative = in the past (due). */
    scheduledInMinutes?: number;
    requiresUnsubscribe?: boolean;
    domain?: string;
    senderVerified?: boolean;
  } = {},
): Promise<LaunchableCampaign> {
  const tag = Math.random().toString(36).slice(2, 8);
  const domain = options.domain ?? `send-${tag}.example.com`;

  const domainId = await seedSenderDomain(
    db,
    workspaceId,
    domain,
    options.senderVerified === false ? {} : verifiedDomainState(),
  );
  const senderIdentityId = await seedSenderIdentity(db, workspaceId, domainId, `news@${domain}`, {
    fromName: 'Example News',
    verifiedAt: options.senderVerified === false ? null : new Date().toISOString(),
  });
  const templateId = await seedTemplate(db, workspaceId, { name: `Template ${tag}` });
  const listId = await seedList(db, workspaceId, `List ${tag}`);

  const emails =
    options.emails ??
    Array.from({ length: options.recipients ?? 3 }, (_, i) => `person${i}-${tag}@recipient.example`);

  const contactIds: string[] = [];
  for (const [i, email] of emails.entries()) {
    const contactId = await seedContact(db, workspaceId, email, {
      firstName: `Person${i}`,
      company: 'Acme',
    });
    contactIds.push(contactId);
    await db.raw(
      `insert into list_members (workspace_id, list_id, contact_id) values ($1, $2, $3)`,
      [workspaceId, listId, contactId],
    );
  }

  const campaign = await db.raw<{ id: string }>(
    `insert into campaigns (workspace_id, name, requires_unsubscribe) values ($1, $2, $3) returning id`,
    [workspaceId, `Campaign ${tag}`, options.requiresUnsubscribe ?? true],
  );
  const campaignId = campaign.rows[0]?.id;
  if (campaignId === undefined) throw new Error('failed to seed campaign');

  await db.raw(
    `update campaigns
        set template_id = $2, sender_identity_id = $3, list_id = $4,
            scheduled_at = now() + make_interval(mins => $5)
      where id = $1`,
    [campaignId, templateId, senderIdentityId, listId, options.scheduledInMinutes ?? -1],
  );
  await db.raw(`update campaigns set status = 'validating' where id = $1`, [campaignId]);

  const snapshot = await db.raw<{ snapshot: unknown }>(
    `select jsonb_build_object(
              'template_id', id, 'version', version, 'name', name, 'subject', subject,
              'preview_text', preview_text, 'html', html, 'text', text,
              'variables', to_jsonb(variables), 'frozen_at', now()::text) as snapshot
       from templates where id = $1`,
    [templateId],
  );
  await db.raw(
    `update campaigns set status = 'scheduled', template_snapshot = $2::jsonb where id = $1`,
    [campaignId, JSON.stringify(snapshot.rows[0]?.snapshot)],
  );

  return { workspaceId, campaignId, listId, templateId, senderIdentityId, domainId, contactIds, emails };
}

export async function jobsFor(
  db: TestDb,
  campaignId: string,
): Promise<Array<{ id: string; to_email: string; status: string; attempts: number; provider_message_id: string | null }>> {
  const res = await db.raw<{
    id: string;
    to_email: string;
    status: string;
    attempts: number;
    provider_message_id: string | null;
  }>(
    `select id, to_email, status::text as status, attempts, provider_message_id
       from email_jobs where campaign_id = $1 order by to_email`,
    [campaignId],
  );
  return res.rows;
}

export async function attemptsFor(
  db: TestDb,
  jobId: string,
): Promise<Array<{ attempt_no: number; state: string; mode: string; provider_message_id: string | null }>> {
  const res = await db.raw<{ attempt_no: number; state: string; mode: string; provider_message_id: string | null }>(
    `select attempt_no, state::text as state, mode, provider_message_id
       from send_attempts where job_id = $1 order by attempt_no`,
    [jobId],
  );
  return res.rows;
}

export async function campaignRow(
  db: TestDb,
  campaignId: string,
): Promise<{
  status: string;
  execution_mode: string | null;
  launched_at: unknown;
  pause_reason: string | null;
  n_total: number;
  n_sent: number;
  n_failed: number;
  n_suppressed: number;
  n_unsubscribed: number;
}> {
  const res = await db.raw<{
    status: string;
    execution_mode: string | null;
    launched_at: unknown;
    pause_reason: string | null;
    n_total: number;
    n_sent: number;
    n_failed: number;
    n_suppressed: number;
    n_unsubscribed: number;
  }>(
    `select status::text as status, execution_mode, launched_at, pause_reason,
            n_total, n_sent, n_failed, n_suppressed, n_unsubscribed
       from campaigns where id = $1`,
    [campaignId],
  );
  const row = res.rows[0];
  if (row === undefined) throw new Error(`no campaign ${campaignId}`);
  return row;
}

/** Moves every clock-sensitive column back, as if `minutes` had passed. */
export async function ageJobs(db: TestDb, campaignId: string, minutes: number): Promise<void> {
  await db.raw(
    `update email_jobs
        set claimed_at = claimed_at - make_interval(mins => $2),
            next_attempt_at = next_attempt_at - make_interval(mins => $2)
      where campaign_id = $1`,
    [campaignId, minutes],
  );
  // dispatched_at is immutable to every role (trg_send_attempts_guard). Time
  // travel is the one legitimate exception, so triggers are suspended for this
  // statement only — superuser-only, which is what the test connection is.
  await db.exec(`set session_replication_role = replica`);
  try {
    await db.raw(
      `update send_attempts a
          set dispatched_at = dispatched_at - make_interval(mins => $2)
         from email_jobs j
        where j.id = a.job_id and j.campaign_id = $1`,
      [campaignId, minutes],
    );
  } finally {
    await db.exec(`set session_replication_role = origin`);
  }
}
