/**
 * Header text encoding (RFC 2047, RFC 5322).
 *
 * SES accepts only 7-bit ASCII in the subject line and in the display name of an
 * address. A subject like "Café news" or a sender called "Zoë" must be sent as
 * encoded-words (`=?UTF-8?B?...?=`), or SES rejects the message outright.
 * Verified against the SESv2 `Message` reference while building P5.
 *
 * Deliberately free of `server-only`: pure.
 */

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/** RFC 2047 §2: an encoded-word is at most 75 characters. */
const MAX_ENCODED_WORD = 75;
const ENCODED_WORD_OVERHEAD = '=?UTF-8?B??='.length;
/** Bytes of UTF-8 per word, so base64(bytes) fits: 4 * ceil(n/3) + overhead <= 75. */
const MAX_BYTES_PER_WORD = Math.floor((MAX_ENCODED_WORD - ENCODED_WORD_OVERHEAD) / 4) * 3;

export function isPrintableAscii(value: string): boolean {
  return PRINTABLE_ASCII.test(value);
}

/**
 * Encodes free text for an unstructured header such as Subject.
 *
 * ASCII passes through untouched. Anything else becomes a sequence of
 * base64 encoded-words, split on code-point boundaries so no word ends halfway
 * through a multi-byte character — a split surrogate or UTF-8 sequence renders
 * as garbage in every mail client.
 */
export function encodeHeaderText(value: string): string {
  if (isPrintableAscii(value)) return value;

  const words: string[] = [];
  let chunk = '';
  let chunkBytes = 0;

  for (const char of value) {
    const bytes = Buffer.byteLength(char, 'utf8');
    if (chunkBytes + bytes > MAX_BYTES_PER_WORD && chunk.length > 0) {
      words.push(encodeWord(chunk));
      chunk = '';
      chunkBytes = 0;
    }
    chunk += char;
    chunkBytes += bytes;
  }
  if (chunk.length > 0) words.push(encodeWord(chunk));

  // Whitespace between adjacent encoded-words is ignored by decoders (§6.2), so
  // a space joins them without adding one to the decoded text.
  return words.join(' ');
}

function encodeWord(text: string): string {
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

/**
 * `Display Name <address>`, safely.
 *
 * An ASCII name is sent as a quoted-string with `\` and `"` escaped, so a name
 * like `Acme, Inc.` cannot be parsed as two addresses. A non-ASCII name is
 * encoded. An empty name yields the bare address.
 */
export function formatAddress(name: string, email: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return email;
  if (isPrintableAscii(trimmed)) {
    return `"${trimmed.replace(/[\\"]/g, (c) => `\\${c}`)}" <${email}>`;
  }
  return `${encodeHeaderText(trimmed)} <${email}>`;
}
