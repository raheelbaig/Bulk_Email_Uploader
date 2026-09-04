/**
 * Data access for sender configuration.
 *
 * Same pattern as `lib/imports/ports.ts` and for the same reason: the decisions
 * — is this domain usable, may this identity exist, is a repeated request a
 * duplicate — must be identical wherever they run, so they live in the services
 * and only the data access varies.
 *
 * Every implementation is workspace-scoped by construction: built from a
 * workspace id, never handed one per call. There is therefore no method here
 * that *could* read or write across tenants.
 *
 * Deliberately free of `server-only`: types only, and the test suite implements
 * them against a real migrated database.
 */

import type { VerificationStatus } from './status';

export interface SenderDomainRecord {
  id: string;
  workspace_id: string;
  domain: string;
  ses_identity_arn: string | null;
  dkim_tokens: string[] | null;
  mail_from_domain: string | null;
  spf_status: VerificationStatus;
  dkim_status: VerificationStatus;
  dmarc_status: VerificationStatus;
  dmarc_policy: string | null;
  mail_from_status: VerificationStatus;
  last_checked_at: string | null;
  last_check_error: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface SenderIdentityRecord {
  id: string;
  workspace_id: string;
  domain_id: string;
  from_email: string;
  from_name: string;
  reply_to: string | null;
  from_domain: string;
  verified_at: string | null;
  created_at: string;
  updated_at: string | null;
}

/** Fields written only after SES has issued them. */
export interface DomainProvisioningPatch {
  ses_identity_arn?: string | null;
  dkim_tokens?: string[] | null;
  mail_from_domain?: string | null;
}

/** Fields written only by the verifier, from SES and DNS answers. */
export interface DomainVerificationPatch {
  spf_status: VerificationStatus;
  dkim_status: VerificationStatus;
  dmarc_status: VerificationStatus;
  dmarc_policy: string | null;
  mail_from_status: VerificationStatus;
  last_checked_at: string;
  last_check_error: string | null;
}

export interface NewSenderIdentity {
  domainId: string;
  fromEmail: string;
  fromName: string;
  replyTo: string | null;
}

/** The outcome of a delete that the schema may refuse. */
export type DeleteOutcome = 'deleted' | 'missing' | 'in_use';

export interface SenderRepository {
  readonly workspaceId: string;

  listDomains(): Promise<SenderDomainRecord[]>;
  getDomain(domainId: string): Promise<SenderDomainRecord | null>;
  findDomainByName(domain: string): Promise<SenderDomainRecord | null>;

  /**
   * Inserts a domain, or returns the existing row for the same name.
   *
   * Returning the existing row rather than throwing is what makes the add flow
   * idempotent (§5): a retried or double-submitted request produces one row.
   */
  insertDomain(domain: string): Promise<{ record: SenderDomainRecord; created: boolean }>;

  /** Writes provider-issued configuration. Never touches verification status. */
  updateDomainProvisioning(domainId: string, patch: DomainProvisioningPatch): Promise<void>;

  /** Writes verification state. Only the verifier calls this. */
  updateDomainVerification(domainId: string, patch: DomainVerificationPatch): Promise<void>;

  /** Refused by the schema while identities still reference the domain. */
  deleteDomain(domainId: string): Promise<DeleteOutcome>;

  listIdentities(): Promise<SenderIdentityRecord[]>;
  getIdentity(identityId: string): Promise<SenderIdentityRecord | null>;
  countIdentitiesForDomain(domainId: string): Promise<number>;

  /** Rejected by the composite foreign key if the domain does not match. */
  insertIdentity(input: NewSenderIdentity): Promise<SenderIdentityRecord>;

  updateIdentity(
    identityId: string,
    patch: { fromName: string; replyTo: string | null },
  ): Promise<SenderIdentityRecord | null>;

  deleteIdentity(identityId: string): Promise<boolean>;

  /**
   * Stamps or clears `verified_at` on every identity under a domain.
   *
   * Called by the verifier when a domain crosses into or out of a usable state,
   * so an identity's own record reflects the authority rather than duplicating
   * the rule.
   */
  setIdentityVerification(domainId: string, verifiedAt: string | null): Promise<void>;
}

/** A domain due for re-checking, across workspaces. Used by the sweep only. */
export interface DueDomain {
  id: string;
  workspace_id: string;
}
