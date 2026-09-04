/**
 * The email provider port.
 *
 * Provider-neutral by construction: no type in this file mentions SES, and
 * nothing outside `provider/ses/` imports an SES type. Everything the rest of
 * the application knows about the provider is declared here, which is what makes
 * "swap the provider" a matter of writing one adapter rather than auditing the
 * codebase for leaked vocabulary.
 *
 * ── What this interface deliberately cannot do ────────────────────────────
 *
 * There is no send method, and no method that could be talked into one. P3 is
 * sender *configuration*; delivery arrives in P5 with its own review, its own
 * IAM permission and its own queue. `tests/no-sending.test.ts` asserts this
 * interface's method set exactly, so adding a send path here fails the build.
 */

/** Where a domain identity stands with the provider. */
export type ProviderVerificationState =
  | 'not_started'
  | 'pending'
  | 'verified'
  | 'failed'
  | 'temporary_failure';

export interface ProviderDkimState {
  /** The selector tokens whose CNAME records the user must publish. */
  tokens: string[];
  status: ProviderVerificationState;
  signingEnabled: boolean;
}

export interface ProviderMailFromState {
  /** Null when no custom MAIL FROM has been configured for the identity. */
  domain: string | null;
  status: ProviderVerificationState;
}

export interface ProviderDomainIdentity {
  domain: string;
  /** The provider's own verification verdict for the identity as a whole. */
  status: ProviderVerificationState;
  /** True only when the provider considers the identity usable for sending. */
  usableForSending: boolean;
  dkim: ProviderDkimState;
  mailFrom: ProviderMailFromState;
  /** Null when the provider does not expose one. Informational only. */
  identityArn: string | null;
}

/** Account-level posture, used to warn before a domain is trusted. Read-only. */
export interface ProviderSendingLimits {
  /** True while the account is in the provider's sandbox. */
  sandbox: boolean;
  sendingEnabled: boolean;
  max24HourSend: number | null;
  maxSendRate: number | null;
}

/**
 * Errors an adapter is expected to distinguish.
 *
 * `already_exists` matters: creating an identity that is already present must be
 * a recognised, non-fatal outcome, because it is what makes domain provisioning
 * idempotent (§5).
 */
export type ProviderErrorKind =
  | 'not_found'
  | 'already_exists'
  | 'not_configured'
  | 'access_denied'
  | 'rate_limited'
  | 'invalid_request'
  | 'unavailable';

export class EmailProviderError extends Error {
  readonly kind: ProviderErrorKind;
  /**
   * A short provider-supplied message, safe to store in
   * `sender_domains.last_check_error`. Adapters must strip anything
   * credential-shaped before constructing this.
   */
  readonly detail: string;

  constructor(kind: ProviderErrorKind, detail: string, cause?: unknown) {
    super(`${kind}: ${detail}`);
    this.name = 'EmailProviderError';
    this.kind = kind;
    this.detail = detail;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Configuration operations only.
 *
 * Every method either reads provider state or configures how a domain
 * authenticates. None of them accepts a recipient, a subject or a body, and none
 * of them can be given one — there is nowhere to put it.
 */
export interface EmailProvider {
  /** The provider's region. Part of the DNS record values the UI displays. */
  readonly region: string;

  /**
   * Creates a domain identity with provider-managed DKIM, or returns the
   * existing one. Must be idempotent: calling it twice for the same domain
   * produces one identity and no error.
   */
  createDomainIdentity(domain: string): Promise<ProviderDomainIdentity>;

  /** Current provider state for a domain identity, or null when absent. */
  getDomainIdentity(domain: string): Promise<ProviderDomainIdentity | null>;

  /**
   * Points the identity's envelope sender at a subdomain the workspace controls.
   * The subdomain is derived, never supplied by a request.
   */
  configureMailFrom(domain: string, mailFromDomain: string): Promise<void>;

  getSendingLimits(): Promise<ProviderSendingLimits>;
}

/** The method names the port exposes. Asserted by the no-sending guard. */
export const EMAIL_PROVIDER_METHODS = [
  'createDomainIdentity',
  'getDomainIdentity',
  'configureMailFrom',
  'getSendingLimits',
] as const;
