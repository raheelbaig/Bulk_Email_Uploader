import 'server-only';

/**
 * The webhook's outbound calls — the third network call site in the
 * application, after P3's SES configuration client and P5's send client
 * (tests/sending-gates.test.ts pins all three).
 *
 * Two GETs, both to Amazon SNS and nothing else:
 *
 *   - the signing certificate named by a notification, and
 *   - the confirmation URL of a SubscriptionConfirmation.
 *
 * `lib/provider-events/sns-verify` has already decided each URL is SNS in the
 * configured topic's region before it reaches here. This module checks the host
 * again anyway, so a future caller that skips the verifier still cannot turn it
 * into a general-purpose fetcher. Redirects are refused, responses are capped,
 * and nothing here sends, subscribes to or publishes anything.
 */

const SNS_HOST = /^sns\.[a-z]{2}(?:-gov)?-[a-z]+-\d\.amazonaws\.com$/;
const TIMEOUT_MS = 5_000;
const MAX_CERT_BYTES = 16 * 1024;
const CACHE_MAX_ENTRIES = 16;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const certificates = new Map<string, { pem: string; expiresAt: number }>();

function snsUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    !SNS_HOST.test(url.hostname) ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new Error('refusing a non-SNS URL');
  }
  return url;
}

/**
 * The PEM certificate at an SNS signing-certificate URL. Cached by URL with a
 * bounded size and a TTL, so the endpoint cannot be used to make this server
 * fetch repeatedly. Throws when unreachable, so the caller can answer with a
 * retryable status instead of treating the message as forged.
 */
export async function fetchSigningCertificate(value: string): Promise<string> {
  const url = snsUrl(value);
  if (!url.pathname.endsWith('.pem') || url.search !== '') throw new Error('refusing a non-certificate URL');

  const key = url.toString();
  const cached = certificates.get(key);
  if (cached !== undefined && cached.expiresAt > Date.now()) return cached.pem;

  const response = await fetch(key, {
    method: 'GET',
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`certificate fetch failed: ${response.status}`);
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_CERT_BYTES) throw new Error('certificate too large');
  const pem = await response.text();
  if (pem.length > MAX_CERT_BYTES || !pem.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error('not a certificate');
  }

  if (certificates.size >= CACHE_MAX_ENTRIES) {
    const oldest = certificates.keys().next().value;
    if (oldest !== undefined) certificates.delete(oldest);
  }
  certificates.set(key, { pem, expiresAt: Date.now() + CACHE_TTL_MS });
  return pem;
}

/** Visits a validated ConfirmSubscription URL. True when SNS accepted it. */
export async function confirmSnsSubscription(value: string): Promise<boolean> {
  const url = snsUrl(value);
  if (url.searchParams.get('Action') !== 'ConfirmSubscription') throw new Error('refusing a non-confirmation URL');
  const response = await fetch(url.toString(), {
    method: 'GET',
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // The body (an XML receipt carrying the subscription ARN) is not needed.
  await response.body?.cancel().catch(() => undefined);
  return response.ok;
}

/** Test-only: empties the certificate cache. */
export function resetSnsCertificateCache(): void {
  certificates.clear();
}
