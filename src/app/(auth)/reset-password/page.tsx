import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { RECOVERY_COOKIE } from '@/lib/auth/recovery';
import { ResetPasswordForm } from './reset-password-form';

export const dynamic = 'force-dynamic';

/**
 * Reached only from a password-recovery link (/auth/confirm sets the marker
 * after signing the person in). Anything else is sent to request a link.
 */
export default async function ResetPasswordPage() {
  const user = await getCurrentUser();
  const marker = (await cookies()).get(RECOVERY_COOKIE);
  if (user === null || marker === undefined) redirect('/forgot-password?notice=link-expired');

  return <ResetPasswordForm email={user.email ?? null} />;
}
