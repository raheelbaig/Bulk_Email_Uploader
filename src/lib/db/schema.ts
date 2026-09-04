import {
  pgTable,
  uuid,
  text,
  bigint,
  timestamp,
  jsonb,
  boolean,
  inet,
  integer,
  pgEnum,
  primaryKey,
  index,
  unique,
} from 'drizzle-orm/pg-core';

/**
 * Drizzle schema — the TypeScript mirror of `supabase/migrations`.
 *
 * The raw SQL migrations are the source of truth: they carry the RLS policies,
 * triggers, grants and constraints that Drizzle cannot express, and they are
 * what actually runs. This file exists for typed reads and query building.
 *
 * The two are kept honest by `tests/schema-parity.test.ts`, which migrates a real
 * database and asserts that every table and column declared here exists there
 * with the same nullability. Drift fails the build rather than surfacing as a
 * runtime error in production.
 */

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
});

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid('workspace_id').notNull(),
    userId: uuid('user_id').notNull(),
    role: text('role').notNull().default('owner'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    index('ix_workspace_members_user').on(table.userId),
  ],
);

export const workspaceSettings = pgTable('workspace_settings', {
  workspaceId: uuid('workspace_id').primaryKey(),
  displayTimezone: text('display_timezone').notNull().default('UTC'),
  notificationEmail: text('notification_email'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
});

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    actorId: uuid('actor_id'),
    actorType: text('actor_type').notNull().default('user'),
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    metadata: jsonb('metadata').notNull().default({}),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('ix_audit_ws_time').on(table.workspaceId, table.createdAt)],
);

export type Workspace = typeof workspaces.$inferSelect;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type WorkspaceSetting = typeof workspaceSettings.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;

// ── P1: contacts, lists, suppression ────────────────────────────────────────

export const suppressionReasonEnum = pgEnum('suppression_reason', [
  'unsubscribe',
  'hard_bounce',
  'complaint',
  'invalid',
  'manually_blocked',
  'provider_suppressed',
]);

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    emailNormalized: text('email_normalized').notNull(),
    emailRaw: text('email_raw').notNull(),
    firstName: text('first_name'),
    lastName: text('last_name'),
    company: text('company'),
    website: text('website'),
    phone: text('phone'),
    custom: jsonb('custom').notNull().default({}),
    status: text('status').notNull().default('active'),
    // FK to `imports` is added in P2, when that table exists.
    importId: uuid('import_id'),
    // GENERATED ALWAYS ... STORED in SQL. Declared here so schema parity sees it;
    // it is never written by application code.
    searchText: text('search_text'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (table) => [
    unique('uq_contacts_ws_email').on(table.workspaceId, table.emailNormalized),
    index('ix_contacts_ws_created').on(table.workspaceId, table.createdAt),
  ],
);

export const contactLists = pgTable(
  'contact_lists',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    name: text('name').notNull(),
    contactCount: integer('contact_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (table) => [unique('uq_contact_lists_ws_name').on(table.workspaceId, table.name)],
);

export const listMembers = pgTable(
  'list_members',
  {
    workspaceId: uuid('workspace_id').notNull(),
    listId: uuid('list_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.listId, table.contactId] }),
    index('ix_list_members_contact').on(table.contactId),
  ],
);

export const suppressions = pgTable(
  'suppressions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    emailNormalized: text('email_normalized').notNull(),
    reason: suppressionReasonEnum('reason').notNull(),
    source: text('source').notNull(),
    // FK to `campaigns` is intentionally absent: a suppression must outlive the
    // campaign that caused it.
    campaignId: uuid('campaign_id'),
    detail: text('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('uq_suppressions').on(table.workspaceId, table.emailNormalized)],
);

export type Contact = typeof contacts.$inferSelect;
export type ContactList = typeof contactLists.$inferSelect;
export type ListMember = typeof listMembers.$inferSelect;
export type Suppression = typeof suppressions.$inferSelect;

// ── P2: import engine ───────────────────────────────────────────────────────

export const importStatusEnum = pgEnum('import_status', [
  'uploaded',
  'mapping',
  'processing',
  'completed',
  'failed',
]);

export const imports = pgTable(
  'imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    actorId: uuid('actor_id').notNull(),
    filename: text('filename').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    contentType: text('content_type').notNull(),
    storagePath: text('storage_path').notNull(),
    status: importStatusEnum('status').notNull().default('uploaded'),
    columnMapping: jsonb('column_mapping'),
    targetListId: uuid('target_list_id'),
    rowsTotal: integer('rows_total').notNull().default(0),
    rowsValid: integer('rows_valid').notNull().default(0),
    rowsInvalid: integer('rows_invalid').notNull().default(0),
    rowsDuplicate: integer('rows_duplicate').notNull().default(0),
    rowsSuppressed: integer('rows_suppressed').notNull().default(0),
    rowsRejected: integer('rows_rejected').notNull().default(0),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('ix_imports_ws_created').on(table.workspaceId, table.createdAt)],
);

export const importRejections = pgTable(
  'import_rejections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    importId: uuid('import_id').notNull(),
    rowNumber: integer('row_number').notNull(),
    rawRow: jsonb('raw_row').notNull(),
    bucket: text('bucket').notNull(),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('ix_import_rejections_import').on(table.importId, table.rowNumber)],
);

/**
 * The import-processing queue. Not pgmq — see migration 0006 for why, and why
 * the claim semantics are the same shape as the P5 job claim regardless.
 */
export const importJobs = pgTable('import_jobs', {
  importId: uuid('import_id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  status: text('status').notNull().default('queued'),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
});

/** Fixed-window API limiter (ARCHITECTURE §3.9). Service-role only. */
export const rateLimits = pgTable(
  'rate_limits',
  {
    bucketKey: text('bucket_key').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.bucketKey, table.windowStart] })],
);

export type Import = typeof imports.$inferSelect;
export type ImportRejection = typeof importRejections.$inferSelect;
export type ImportJob = typeof importJobs.$inferSelect;
export type RateLimit = typeof rateLimits.$inferSelect;

// ── P3: sender domains and identities ───────────────────────────────────────

export const verificationStatusEnum = pgEnum('verification_status', [
  'pending',
  'verified',
  'failed',
  'not_configured',
]);

/**
 * Sending domains and their verification state.
 *
 * Every status column is derived from SES and DNS. `authenticated` holds no
 * UPDATE grant on this table at all (migration 0008), so none of them can be
 * written from a browser session.
 */
export const senderDomains = pgTable(
  'sender_domains',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    domain: text('domain').notNull(),
    sesIdentityArn: text('ses_identity_arn'),
    dkimTokens: text('dkim_tokens').array(),
    mailFromDomain: text('mail_from_domain'),
    spfStatus: verificationStatusEnum('spf_status').notNull().default('pending'),
    dkimStatus: verificationStatusEnum('dkim_status').notNull().default('pending'),
    dmarcStatus: verificationStatusEnum('dmarc_status').notNull().default('not_configured'),
    dmarcPolicy: text('dmarc_policy'),
    mailFromStatus: verificationStatusEnum('mail_from_status').notNull().default('not_configured'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastCheckError: text('last_check_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (table) => [
    unique('uq_sender_domains_ws_domain').on(table.workspaceId, table.domain),
    index('ix_sender_domains_ws_created').on(table.workspaceId, table.createdAt),
  ],
);

/**
 * Addresses a workspace may send from.
 *
 * `from_domain` is GENERATED ALWAYS ... STORED in SQL and carries the composite
 * foreign key that makes a wrong-domain or cross-workspace identity impossible.
 * It is declared here for schema parity and is never written by application code.
 */
export const senderIdentities = pgTable(
  'sender_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    domainId: uuid('domain_id').notNull(),
    fromEmail: text('from_email').notNull(),
    fromName: text('from_name').notNull(),
    replyTo: text('reply_to'),
    fromDomain: text('from_domain').notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (table) => [
    unique('uq_sender_identities_ws_email').on(table.workspaceId, table.fromEmail),
    index('ix_sender_identities_domain').on(table.domainId),
  ],
);

export type SenderDomain = typeof senderDomains.$inferSelect;
export type SenderIdentity = typeof senderIdentities.$inferSelect;

// ── P4: templates and campaigns ─────────────────────────────────────────────

export const campaignStatusEnum = pgEnum('campaign_status', [
  'draft',
  'validating',
  'scheduled',
  // Declared because migration 0009 declares them. No transition in
  // `app.campaign_transition_allowed` reaches any of the four below, so no row
  // can hold one until P5 edits that function.
  'queued',
  'sending',
  'paused',
  'completed',
  'cancelled',
  'failed',
]);

/**
 * Reusable message content.
 *
 * `html` and `text` are stored already sanitised (lib/templates/service.ts), and
 * `version` is maintained by a trigger — it is outside the authenticated UPDATE
 * grant, so no client can rewind it.
 */
export const templates = pgTable(
  'templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    name: text('name').notNull(),
    subject: text('subject').notNull(),
    previewText: text('preview_text'),
    html: text('html').notNull(),
    text: text('text').notNull(),
    variables: text('variables').array().notNull().default([]),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (table) => [
    unique('uq_templates_ws_name').on(table.workspaceId, table.name),
    index('ix_templates_ws_created').on(table.workspaceId, table.createdAt),
  ],
);

/**
 * Prepared campaigns.
 *
 * Carries no recipient address and no message id: a campaign names an audience,
 * never the people in it. `status`, `template_snapshot` and every counter are
 * outside the authenticated UPDATE grant, and the transition trigger in
 * migration 0009 constrains them for every role including the service role.
 */
export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    name: text('name').notNull(),
    status: campaignStatusEnum('status').notNull().default('draft'),
    templateId: uuid('template_id'),
    senderIdentityId: uuid('sender_identity_id'),
    listId: uuid('list_id'),
    templateSnapshot: jsonb('template_snapshot'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    launchedAt: timestamp('launched_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    requiresUnsubscribe: boolean('requires_unsubscribe').notNull().default(true),
    maxRateOverride: integer('max_rate_override'),
    pauseReason: text('pause_reason'),
    launchedBy: uuid('launched_by'),
    nTotal: integer('n_total').notNull().default(0),
    nSent: integer('n_sent').notNull().default(0),
    nDelivered: integer('n_delivered').notNull().default(0),
    nBounced: integer('n_bounced').notNull().default(0),
    nComplained: integer('n_complained').notNull().default(0),
    nFailed: integer('n_failed').notNull().default(0),
    nUnsubscribed: integer('n_unsubscribed').notNull().default(0),
    nSuppressed: integer('n_suppressed').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (table) => [
    index('ix_campaigns_ws_status').on(table.workspaceId, table.status),
    index('ix_campaigns_ws_created').on(table.workspaceId, table.createdAt),
  ],
);

export type Template = typeof templates.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
