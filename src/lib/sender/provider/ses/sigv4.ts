import 'server-only';
import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4, for the handful of SES configuration calls P3 makes.
 *
 * ── Why this exists rather than the AWS SDK ───────────────────────────────
 *
 * `@aws-sdk/client-sesv2` ships `SendEmailCommand` in the same package as the
 * identity APIs. Installing it would put a fully-formed send path one import
 * away from any file in the codebase, and the standing guarantee this project
 * makes — enforced by tests/no-sending.test.ts — is that no such path exists
 * before P5. Signing four requests is roughly a hundred lines; a dependency that
 * can send email is not something a test can meaningfully constrain.
 *
 * The secondary benefits are real but not the reason: no transitive dependency
 * surface, and a cold start that does not pay for a client it barely uses.
 *
 * ── Credential handling ───────────────────────────────────────────────────
 *
 * The secret key is used only as an HMAC key and is never returned, logged, or
 * placed in a header. What reaches the wire is the derived signature, the access
 * key id (which AWS itself treats as public), and the session token when one is
 * present.
 */

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | undefined;
}

export interface SignableRequest {
  method: 'GET' | 'POST' | 'PUT';
  /** Already percent-encoded, and always absolute. */
  path: string;
  host: string;
  region: string;
  service: string;
  /** Empty string for a request with no body. */
  body: string;
  credentials: AwsCredentials;
  /** Injectable so signing is deterministic under test. */
  now?: Date;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

/** `20240115T093045Z` and its `20240115` date half. */
function amzDate(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

export interface SignedHeaders {
  [name: string]: string;
}

/**
 * Returns the headers that authenticate `request`.
 *
 * The signed header set is fixed and minimal — host, x-amz-date, the payload
 * hash, content-type when there is a body, and the session token when there is
 * one. A caller cannot add headers to the signature, which means a caller cannot
 * influence what the signature covers.
 */
export function signRequest(request: SignableRequest): SignedHeaders {
  const now = request.now ?? new Date();
  const { amzDate: stamp, dateStamp } = amzDate(now);

  const payloadHash = sha256Hex(request.body);

  const headers: SignedHeaders = {
    host: request.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': stamp,
  };
  if (request.body.length > 0) headers['content-type'] = 'application/json';
  if (request.credentials.sessionToken !== undefined) {
    headers['x-amz-security-token'] = request.credentials.sessionToken;
  }

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${(headers[name] ?? '').trim()}\n`)
    .join('');
  const signedHeaderList = signedHeaderNames.join(';');

  // No query string is used by any operation in the allowlist, so the canonical
  // query is empty. If one is ever needed it must be sorted and encoded here,
  // not appended to `path`.
  const canonicalRequest = [
    request.method,
    request.path,
    '',
    canonicalHeaders,
    signedHeaderList,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${request.region}/${request.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    stamp,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${request.credentials.secretAccessKey}`, dateStamp), request.region), request.service),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return {
    ...headers,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${request.credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaderList}, Signature=${signature}`,
  };
}
