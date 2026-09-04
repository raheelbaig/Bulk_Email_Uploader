import 'server-only';
import { requireWorkspace } from '@/lib/auth/workspace';
import { writeAuditLog } from '@/lib/audit';
import { enforceRateLimit } from '@/lib/rate-limit';
import { ConflictError, ForbiddenError, ValidationError } from '@/lib/errors';
import { EMPTY_AUDIENCE, type AudienceCounts } from '@/lib/eligibility';
import type { Cursor, Page, PageDirection } from '@/lib/pagination';
import { getSenderReadiness } from '@/lib/sender/identities';
import { senderRepository } from '@/lib/sender/repository';
import type { SenderIdentityRecord } from '@/lib/sender/ports';
import type { SenderReadiness } from '@/lib/sender/readiness';
import { templateRepository } from '@/lib/templates/repository';
import type { TemplateRecord } from '@/lib/templates/ports';
import { buildPreview, type TemplatePreview } from '@/lib/templates/preview';
import { SAMPLE_CONTACT, type PersonalizationSource } from '@/lib/templates/render';
import { campaignRepository } from './repository';
import {
  evaluateCampaignPreflight,
  preflightSummary,
  type PreflightIntent,
  type PreflightResult,
} from './preflight';
import { parseScheduleRequest, SCHEDULE_FAILURE_MESSAGE } from './schedule';
import {
  buildTemplateSnapshot,
  parseTemplateSnapshot,
  renderableFromSnapshot,
  renderableFromTemplate,
  type TemplateSnapshot,
} from './snapshot';
import { isEditable, type CampaignStatus } from './status';
import type { CampaignRecord, CampaignRepository, ListSummary } from './ports';

/**
 * Campaigns.
 *
 * ── What this module is careful not to do ────────────────────────────────
 *
 * It does not decide whether a sender may be used — `getSenderReadiness` does.
 * It does not decide whether a recipient may be contacted — the eligibility
 * authority does. It does not decide whether a template is safe — the template
 * engine does. It does not decide which state changes are legal — the state
 * machine does, and the database enforces it. What is left is composition, and
 * that is deliberate: every one of those decisions has exactly one home, and a
 * campaign is where they meet rather than where they are made again.
 *
 * ── What it cannot do ────────────────────────────────────────────────────
 *
 * There is no function here that sends, dispatches, queues or launches anything,
 * and no transition it can request would reach a sending state — the database
 * refuses those for every role (migration 0009). `scheduleCampaign` freezes
 * content and records a time; nothing acts on that time.
 */

/** Contacts sampled from the audience for the preview picker. */
const PREVIEW_SAMPLE_SIZE = 25;

export interface CampaignListSummary {
  id: string;
  name: string;
}

/** Everything the campaign builder renders, gathered in one place. */
export interface CampaignView {
  campaign: CampaignRecord;
  status: CampaignStatus;
  editable: boolean;
  list: ListSummary | null;
  audience: AudienceCounts;
  senderIdentity: SenderIdentityRecord | null;
  senderReadiness: SenderReadiness | null;
  template: TemplateRecord | null;
  snapshot: TemplateSnapshot | null;
  timeZone: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Input parsing
// ─────────────────────────────────────────────────────────────────────────────

const MAX_CAMPAIGN_NAME = 160;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseName(input: unknown): string {
  const value = typeof input === 'string' ? input.trim() : '';
  if (value.length === 0) throw new ValidationError('Give the campaign a name.');
  if (value.length > MAX_CAMPAIGN_NAME) {
    throw new ValidationError(`Campaign names are limited to ${MAX_CAMPAIGN_NAME} characters.`);
  }
  return value;
}

/**
 * Reads an optional reference from a form.
 *
 * An empty string clears the reference; a malformed one is refused here rather
 * than reaching the database as a cast error. A *valid-looking* id belonging to
 * another workspace is not checked here at all — it does not need to be. The
 * composite foreign keys in migration 0009 refuse it, and the repository turns
 * that refusal into the same message an unknown id gets.
 */
function parseReference(input: unknown, field: string): string | null | undefined {
  if (input === undefined) return undefined;
  const value = typeof input === 'string' ? input.trim() : '';
  if (value.length === 0) return null;
  if (!UUID.test(value)) throw new ValidationError(`That is not a valid ${field}.`);
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Supporting reads
// ─────────────────────────────────────────────────────────────────────────────

/** The workspace's display timezone. Every schedule is interpreted in it. */
export async function workspaceTimeZone(workspaceId: string): Promise<string> {
  await requireWorkspace(workspaceId);
  const repository = await campaignRepository(workspaceId);
  return repository.timeZone();
}

/** The lists a campaign may target, with their maintained counter. No scan. */
export async function listAudienceOptions(workspaceId: string): Promise<ListSummary[]> {
  await requireWorkspace(workspaceId);
  const repository = await campaignRepository(workspaceId);
  return repository.listLists();
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

export async function listCampaigns(
  workspaceId: string,
  options: {
    limit?: number;
    cursor?: Cursor | undefined;
    direction?: PageDirection;
    status?: CampaignStatus | undefined;
  } = {},
): Promise<Page<CampaignRecord>> {
  await requireWorkspace(workspaceId);
  const repository = await campaignRepository(workspaceId);
  return repository.list(options);
}

async function loadView(
  workspaceId: string,
  repository: CampaignRepository,
  campaign: CampaignRecord,
): Promise<CampaignView> {
  const [list, senderIdentity, template, timeZone] = await Promise.all([
    campaign.list_id === null ? Promise.resolve(null) : repository.getList(campaign.list_id),
    campaign.sender_identity_id === null
      ? Promise.resolve(null)
      : senderRepository(workspaceId).then((repo) => repo.getIdentity(campaign.sender_identity_id ?? '')),
    campaign.template_id === null
      ? Promise.resolve(null)
      : templateRepository(workspaceId).then((repo) => repo.get(campaign.template_id ?? '')),
    repository.timeZone(),
  ]);

  // The readiness authority, never the status columns. Called only when there is
  // a sender to judge, so a campaign without one costs nothing.
  const senderReadiness =
    campaign.sender_identity_id === null
      ? null
      : await getSenderReadiness({ workspaceId, senderIdentityId: campaign.sender_identity_id });

  const audience =
    campaign.list_id === null || list === null
      ? EMPTY_AUDIENCE
      : await repository.audienceCounts(campaign.list_id);

  return {
    campaign,
    status: campaign.status,
    editable: isEditable(campaign.status),
    list,
    audience,
    senderIdentity,
    senderReadiness,
    template,
    snapshot: parseTemplateSnapshot(campaign.template_snapshot),
    timeZone,
  };
}

export async function getCampaign(workspaceId: string, campaignId: string): Promise<CampaignView> {
  await requireWorkspace(workspaceId);
  const repository = await campaignRepository(workspaceId);

  const campaign = await repository.get(campaignId);
  // Absent and not-yours answer identically, so a caller cannot enumerate ids.
  if (campaign === null) throw new ForbiddenError();

  return loadView(workspaceId, repository, campaign);
}

// ─────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────

export async function createCampaign(
  workspaceId: string,
  input: { name: unknown; requiresUnsubscribe?: unknown },
): Promise<CampaignRecord> {
  const access = await requireWorkspace(workspaceId);
  await enforceRateLimit('campaign.write', access.userId, access.workspaceId);

  const name = parseName(input.name);
  // Defaults to true. Marketing mail is the common case and the safe default;
  // opting out is a deliberate act recorded on the row and shown at preflight.
  const requiresUnsubscribe = input.requiresUnsubscribe === undefined ? true : input.requiresUnsubscribe !== 'false';

  const repository = await campaignRepository(access.workspaceId);
  const campaign = await repository.insert({ name, requiresUnsubscribe });

  await writeAuditLog({
    workspaceId: access.workspaceId,
    actorId: access.userId,
    actorType: 'user',
    action: 'campaign.created',
    entityType: 'campaign',
    entityId: campaign.id,
    metadata: { name: campaign.name, requiresUnsubscribe },
  });

  return campaign;
}

export interface CampaignDraftInput {
  name?: unknown;
  listId?: unknown;
  senderIdentityId?: unknown;
  templateId?: unknown;
  requiresUnsubscribe?: unknown;
  /** Wall-clock local time, interpreted in the workspace's timezone. */
  scheduledAtLocal?: unknown;
}

/**
 * Applies an edit to a campaign that is still open for changes.
 *
 * The state predicate lives in three places — the RLS UPDATE policy, the
 * repository's `.in('status', ...)` filter and the check below — and the
 * innermost one is the guarantee. The check here exists so the person gets
 * "unschedule it first" rather than "not found".
 */
export async function updateCampaignDraft(
  workspaceId: string,
  campaignId: string,
  input: CampaignDraftInput,
): Promise<CampaignRecord> {
  const access = await requireWorkspace(workspaceId);
  await enforceRateLimit('campaign.write', access.userId, access.workspaceId);

  const repository = await campaignRepository(access.workspaceId);
  const existing = await repository.get(campaignId);
  if (existing === null) throw new ForbiddenError();

  if (!isEditable(existing.status)) {
    throw new ConflictError(
      'This campaign is scheduled. Unschedule it before making changes.',
    );
  }

  const patch: Parameters<CampaignRepository['updateDraft']>[1] = {};
  if (input.name !== undefined) patch.name = parseName(input.name);

  const listId = parseReference(input.listId, 'list');
  if (listId !== undefined) patch.listId = listId;

  const senderIdentityId = parseReference(input.senderIdentityId, 'sender address');
  if (senderIdentityId !== undefined) patch.senderIdentityId = senderIdentityId;

  const templateId = parseReference(input.templateId, 'template');
  if (templateId !== undefined) patch.templateId = templateId;

  if (input.requiresUnsubscribe !== undefined) {
    patch.requiresUnsubscribe = input.requiresUnsubscribe !== 'false' && input.requiresUnsubscribe !== false;
  }

  if (input.scheduledAtLocal !== undefined) {
    const local = typeof input.scheduledAtLocal === 'string' ? input.scheduledAtLocal.trim() : '';
    if (local.length === 0) {
      patch.scheduledAt = null;
    } else {
      const timeZone = await repository.timeZone();
      const parsed = parseScheduleRequest({ local, timeZone });
      if (!parsed.ok) throw new ValidationError(SCHEDULE_FAILURE_MESSAGE[parsed.reason]);
      patch.scheduledAt = parsed.at.toISOString();
    }
  }

  const updated = await repository.updateDraft(campaignId, patch);
  if (updated === null) throw new ConflictError('This campaign can no longer be edited.');

  await writeAuditLog({
    workspaceId: access.workspaceId,
    actorId: access.userId,
    actorType: 'user',
    action: 'campaign.updated',
    entityType: 'campaign',
    entityId: campaignId,
    // Ids and flags, never a contact list or message content.
    metadata: {
      fields: Object.keys(patch),
      listId: updated.list_id,
      senderIdentityId: updated.sender_identity_id,
      templateId: updated.template_id,
      scheduledAt: updated.scheduled_at,
    },
  });

  return updated;
}

// ─────────────────────────────────────────────────────────────────────────────
// Preflight
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gathers the inputs and asks the engine.
 *
 * The `draft → validating → draft|stay` walk is not decoration: it is what makes
 * the check a *state transition* rather than a read, so a campaign that is
 * mid-validation is visibly so, and so the same compare-and-set that guards
 * scheduling guards this. A campaign whose preflight fails is returned to
 * `draft`; one that passes is left in `validating`, which is the only state
 * `scheduleCampaign` will accept.
 */
export async function runCampaignPreflight(
  workspaceId: string,
  campaignId: string,
  options: { intent?: PreflightIntent } = {},
): Promise<{ result: PreflightResult; view: CampaignView }> {
  const access = await requireWorkspace(workspaceId);
  await enforceRateLimit('campaign.preflight', access.userId, access.workspaceId);

  const intent = options.intent ?? 'check';
  const repository = await campaignRepository(access.workspaceId);

  const current = await repository.get(campaignId);
  if (current === null) throw new ForbiddenError();
  if (!isEditable(current.status)) {
    throw new ConflictError('This campaign is scheduled. Unschedule it to run the checks again.');
  }

  const validating =
    current.status === 'validating'
      ? current
      : await repository.transition(campaignId, ['draft'], 'validating');
  if (validating === null) throw new ConflictError('This campaign changed while it was being checked.');

  const view = await loadView(access.workspaceId, repository, validating);
  const result = await evaluate(view, intent);

  // A failed check returns the campaign to draft, so the only campaign sitting
  // in `validating` is one that is ready to be scheduled.
  if (!result.ready) {
    await repository.transition(campaignId, ['validating'], 'draft');
    view.campaign = { ...view.campaign, status: 'draft' };
    view.status = 'draft';
  }

  await writeAuditLog({
    workspaceId: access.workspaceId,
    actorId: access.userId,
    actorType: 'user',
    action: result.ready ? 'campaign.preflight_passed' : 'campaign.preflight_failed',
    entityType: 'campaign',
    entityId: campaignId,
    // Codes and counts. The messages contain list names and sample data; the
    // codes are the fact worth keeping forever.
    metadata: { intent, ...preflightSummary(result) },
  });

  return { result, view };
}

/**
 * Evaluates without transitioning. For the review step, which shows the current
 * verdict every time the page renders and must not write on a read.
 */
export async function previewCampaignPreflight(
  workspaceId: string,
  campaignId: string,
): Promise<{ result: PreflightResult; view: CampaignView }> {
  const view = await getCampaign(workspaceId, campaignId);
  return { result: await evaluate(view, 'check'), view };
}

async function evaluate(view: CampaignView, intent: PreflightIntent): Promise<PreflightResult> {
  // The sample render is what proves personalization resolves. It runs against
  // the placeholder contact rather than a real one so the check is deterministic
  // and does not depend on whichever contact happens to be first in the list.
  const sampleRender =
    view.template === null
      ? null
      : buildPreview({ template: renderableFromTemplate(view.template), contact: SAMPLE_CONTACT });

  return evaluateCampaignPreflight({
    campaign: view.campaign,
    intent,
    list: view.list,
    audience: view.audience,
    senderIdentity:
      view.senderIdentity === null
        ? null
        : {
            id: view.senderIdentity.id,
            from_email: view.senderIdentity.from_email,
            from_name: view.senderIdentity.from_name,
          },
    senderReadiness: view.senderReadiness,
    template: view.template,
    snapshot: view.snapshot,
    sampleRender:
      sampleRender === null
        ? null
        : {
            subject: sampleRender.subject,
            previewText: sampleRender.previewText,
            html: sampleRender.html,
            text: sampleRender.text,
            missing: sampleRender.missing,
            issues: sampleRender.issues,
          },
    timeZone: view.timeZone,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Freezes the campaign and records when it should go out.
 *
 * Two things happen, in one statement: the template's content is copied into
 * `template_snapshot`, and the status becomes `scheduled`. Both are written by
 * the same compare-and-set, so a campaign cannot end up scheduled without a
 * snapshot — and the `ck_campaigns_scheduled_complete` constraint refuses that
 * combination at the database anyway.
 *
 * Nothing about this makes the campaign deliverable. There is no promotion
 * sweep, no worker and no transition out of `scheduled` toward delivery. When
 * the time arrives the campaign sits there.
 */
export async function scheduleCampaign(
  workspaceId: string,
  campaignId: string,
): Promise<{ campaign: CampaignRecord; result: PreflightResult }> {
  const access = await requireWorkspace(workspaceId);

  const { result, view } = await runCampaignPreflight(access.workspaceId, campaignId, {
    intent: 'schedule',
  });

  if (!result.ready) {
    const first = result.blockers[0];
    throw new ConflictError(
      first === undefined
        ? 'This campaign is not ready to be scheduled.'
        : `This campaign is not ready to be scheduled: ${first.message}`,
    );
  }
  if (view.template === null) {
    // Unreachable: a missing template is a blocker above. Kept because the
    // snapshot below cannot be built without one, and an assertion that says why
    // beats a null dereference.
    throw new ConflictError('This campaign has no template to freeze.');
  }

  const repository = await campaignRepository(access.workspaceId);
  const snapshot = buildTemplateSnapshot(view.template);

  const scheduled = await repository.transition(campaignId, ['validating'], 'scheduled', {
    templateSnapshot: snapshot,
  });
  if (scheduled === null) {
    throw new ConflictError('This campaign changed while it was being scheduled.');
  }

  await writeAuditLog({
    workspaceId: access.workspaceId,
    actorId: access.userId,
    actorType: 'user',
    action: 'campaign.scheduled',
    entityType: 'campaign',
    entityId: campaignId,
    metadata: {
      scheduledAt: scheduled.scheduled_at,
      templateId: snapshot.template_id,
      templateVersion: snapshot.version,
      eligibleRecipients: view.audience.eligible,
      warnings: result.warnings.map((issue) => issue.code),
    },
  });

  return { campaign: scheduled, result };
}

/**
 * Returns a scheduled campaign to draft.
 *
 * The snapshot is cleared, deliberately: a draft's content is whatever its
 * template says now, and keeping a stale frozen copy on an editable campaign
 * would mean two answers to "what does this campaign contain?". Re-scheduling
 * takes a fresh snapshot. This is the *only* path that clears one, and the
 * database permits it only because the same statement returns the campaign to an
 * editable state.
 */
export async function unscheduleCampaign(
  workspaceId: string,
  campaignId: string,
): Promise<CampaignRecord> {
  const access = await requireWorkspace(workspaceId);
  await enforceRateLimit('campaign.write', access.userId, access.workspaceId);

  const repository = await campaignRepository(access.workspaceId);
  const updated = await repository.transition(campaignId, ['scheduled'], 'draft', {
    templateSnapshot: null,
  });
  if (updated === null) throw new ConflictError('That campaign is not scheduled.');

  await writeAuditLog({
    workspaceId: access.workspaceId,
    actorId: access.userId,
    actorType: 'user',
    action: 'campaign.unscheduled',
    entityType: 'campaign',
    entityId: campaignId,
  });

  return updated;
}

export async function cancelCampaign(
  workspaceId: string,
  campaignId: string,
): Promise<CampaignRecord> {
  const access = await requireWorkspace(workspaceId);

  const repository = await campaignRepository(access.workspaceId);
  const updated = await repository.transition(
    campaignId,
    ['draft', 'validating', 'scheduled'],
    'cancelled',
  );
  if (updated === null) throw new ConflictError('That campaign can no longer be cancelled.');

  await writeAuditLog({
    workspaceId: access.workspaceId,
    actorId: access.userId,
    actorType: 'user',
    action: 'campaign.cancelled',
    entityType: 'campaign',
    entityId: campaignId,
  });

  return updated;
}

export async function deleteCampaign(workspaceId: string, campaignId: string): Promise<void> {
  const access = await requireWorkspace(workspaceId);

  const repository = await campaignRepository(access.workspaceId);
  const existing = await repository.get(campaignId);
  if (existing === null) throw new ForbiddenError();

  const removed = await repository.remove(campaignId);
  // The RLS DELETE policy permits only draft and cancelled campaigns, so a
  // refusal here means the campaign is in a state that is kept as history.
  if (!removed) {
    throw new ConflictError('Only a draft or cancelled campaign can be deleted.');
  }

  await writeAuditLog({
    workspaceId: access.workspaceId,
    actorId: access.userId,
    actorType: 'user',
    action: 'campaign.deleted',
    entityType: 'campaign',
    entityId: campaignId,
    metadata: { name: existing.name, status: existing.status },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview
// ─────────────────────────────────────────────────────────────────────────────

export interface CampaignPreview {
  preview: TemplatePreview;
  /** A bounded sample of the audience, for the "preview as" picker. */
  contacts: Array<{ id: string; email: string; name: string | null }>;
  /** True when the preview came from the frozen snapshot rather than the template. */
  fromSnapshot: boolean;
}

/**
 * Builds the campaign preview.
 *
 * A scheduled campaign previews its *snapshot*, not its template: that is what
 * the campaign holds, and showing the live template would misrepresent it the
 * moment someone edits the template.
 *
 * The contact list is a bounded sample — never the whole audience. Loading an
 * audience into a page to populate a dropdown is the scan this design exists to
 * avoid, and a preview needs one contact, not all of them.
 */
export async function buildCampaignPreview(
  workspaceId: string,
  campaignId: string,
  options: { contactId?: string | undefined } = {},
): Promise<CampaignPreview | null> {
  await requireWorkspace(workspaceId);
  const repository = await campaignRepository(workspaceId);

  const campaign = await repository.get(campaignId);
  if (campaign === null) throw new ForbiddenError();

  const view = await loadView(workspaceId, repository, campaign);

  const source =
    view.snapshot !== null
      ? { renderable: renderableFromSnapshot(view.snapshot), fromSnapshot: true }
      : view.template !== null
        ? { renderable: renderableFromTemplate(view.template), fromSnapshot: false }
        : null;
  if (source === null) return null;

  const members =
    campaign.list_id === null ? [] : await repository.audienceSample(campaign.list_id, PREVIEW_SAMPLE_SIZE);

  const chosen =
    options.contactId === undefined
      ? undefined
      : members.find((member) => member.id === options.contactId);

  const contact: PersonalizationSource | undefined =
    chosen === undefined
      ? undefined
      : {
          email_normalized: chosen.email_normalized,
          first_name: chosen.first_name,
          last_name: chosen.last_name,
          company: chosen.company,
          website: chosen.website,
          phone: chosen.phone,
          custom: chosen.custom,
        };

  const preview = buildPreview({
    template: source.renderable,
    ...(contact === undefined ? {} : { contact }),
    sender:
      view.senderIdentity === null
        ? null
        : {
            from_name: view.senderIdentity.from_name,
            from_email: view.senderIdentity.from_email,
            reply_to: view.senderIdentity.reply_to,
          },
  });

  return {
    preview,
    fromSnapshot: source.fromSnapshot,
    contacts: members.map((member) => ({
      id: member.id,
      email: member.email_normalized,
      name: [member.first_name, member.last_name].filter((part) => part !== null && part !== '').join(' ') || null,
    })),
  };
}

export type { CampaignRecord, PreflightResult };
