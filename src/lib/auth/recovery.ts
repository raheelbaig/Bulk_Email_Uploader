import 'server-only';

/**
 * The password-recovery marker.
 *
 * A recovery link signs the person in (Supabase issues a session), then lands
 * on /reset-password. This short-lived, httpOnly cookie is set by
 * /auth/confirm only after that link was exchanged successfully, and the reset
 * page and action refuse without it — so an ordinary session that wanders to
 * /reset-password is sent to the "forgot password" form instead.
 *
 * It is a navigation guard, not the security boundary: anyone holding a valid
 * session can already ask Supabase Auth to change its password. The boundary
 * for that is the Supabase project setting "Secure password change"
 * (Authentication → Providers → Email), which requires a recent sign-in.
 */
export const RECOVERY_COOKIE = 'pw_recovery';
export const RECOVERY_MAX_AGE_SECONDS = 15 * 60;
/** The fixed query flag /auth/confirm recognises. A flag, never a URL. */
export const RECOVERY_FLOW = 'recovery';
