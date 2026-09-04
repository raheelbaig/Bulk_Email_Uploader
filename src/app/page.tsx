import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';

export default async function IndexPage() {
  const user = await getCurrentUser();
  redirect(user === null ? '/login' : '/dashboard');
}
