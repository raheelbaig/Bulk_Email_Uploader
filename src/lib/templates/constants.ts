/**
 * Template limits and vocabulary.
 *
 * Every bound the template engine enforces is named here rather than inlined,
 * for the same reason `lib/imports/constants.ts` exists: a limit that appears
 * once inside a condition is a limit nobody can review.
 *
 * Each is *below* the corresponding CHECK constraint in migration 0009. The
 * application refuses first, with a message that says what to do; the database
 * refuses second, unconditionally, for anything that reaches it by another path.
 *
 * Deliberately free of `server-only`: the editor shows these same numbers, and a
 * limit the client displays differently from the one the server enforces is a
 * support ticket waiting to happen.
 */

/** Column check is `< 512000`. ARCHITECTURE §3.7. */
export const MAX_HTML_CHARS = 500_000;

/** Column check is `< 256000`. Generated text is far smaller; this is the ceiling. */
export const MAX_TEXT_CHARS = 250_000;

/** A subject line longer than this is truncated by every client that shows it. */
export const MAX_SUBJECT_CHARS = 200;

/** Preheader text. Shown in the inbox list beside the subject. */
export const MAX_PREVIEW_TEXT_CHARS = 200;

export const MAX_TEMPLATE_NAME_CHARS = 120;

/** Distinct variables one template may use. Matches the column check. */
export const MAX_TEMPLATE_VARIABLES = 40;

/**
 * Nesting depth the sanitiser will keep.
 *
 * Deeply nested markup is either a mistake or an attempt to exhaust the parser
 * of whatever renders it. Beyond this, elements are unwrapped rather than kept.
 */
export const MAX_HTML_DEPTH = 64;

/** Bytes of HTML the sanitiser will accept in one pass, before it refuses. */
export const MAX_SANITIZE_INPUT_CHARS = 1_000_000;
