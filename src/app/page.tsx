import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';

export default async function IndexPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // An auth email whose redirect was not in the project's allow list lands on
  // the Site URL instead of /auth/confirm. Forward it rather than drop it.
  const params = await searchParams;
  const code = params['code'];
  const errorCode = params['error_code'];
  if (typeof code === 'string') {
    redirect(`/auth/confirm?code=${encodeURIComponent(code)}`);
  }
  if (typeof errorCode === 'string') {
    redirect(`/auth/confirm?error_code=${encodeURIComponent(errorCode)}`);
  }

  const user = await getCurrentUser();
  redirect(user === null ? '/login' : '/dashboard');
}
