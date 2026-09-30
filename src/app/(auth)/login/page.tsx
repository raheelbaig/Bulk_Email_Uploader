'use client';

import Link from 'next/link';
import { use, useActionState } from 'react';
import { signIn, type AuthFormState } from '../actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const initialState: AuthFormState = { message: null };

const NOTICES: Record<string, string> = {
  'confirm-failed':
    'That confirmation link could not sign you in. If you already confirmed your email, sign in below. If the link expired, sign up again with the same email address to get a new one.',
};

export default function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string | string[] }>;
}) {
  const [state, action, pending] = useActionState(signIn, initialState);
  const { notice } = use(searchParams);
  const noticeText = typeof notice === 'string' ? NOTICES[notice] : undefined;

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Welcome back. Sign in to continue to your workspace.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="flex flex-col gap-4">
          {state.message === null && noticeText !== undefined && <Alert tone="info">{noticeText}</Alert>}
          {state.message !== null && <Alert tone="destructive">{state.message}</Alert>}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">Password</Label>
            <Input id="password" name="password" type="password" autoComplete="current-password" required />
          </div>
          <Button type="submit" disabled={pending} className="w-full">
            {pending ? 'Signing in…' : 'Sign in'}
          </Button>
          <p className="text-center text-sm text-(--color-muted-foreground)">
            No account?{' '}
            <Link href="/signup" className="font-medium text-(--color-primary) hover:underline">
              Create one
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
