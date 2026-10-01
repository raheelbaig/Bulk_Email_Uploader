'use client';

import Link from 'next/link';
import { use, useActionState } from 'react';
import { requestPasswordReset, type AuthFormState } from '../actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const initialState: AuthFormState = { message: null };

const NOTICES: Record<string, string> = {
  'link-expired': 'That reset link has expired or was already used. Request a new one below.',
};

export default function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string | string[] }>;
}) {
  const [state, action, pending] = useActionState(requestPasswordReset, initialState);
  const { notice } = use(searchParams);
  const noticeText = typeof notice === 'string' ? NOTICES[notice] : undefined;

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle>Reset your password</CardTitle>
        <CardDescription>Enter the email address you sign in with and we will send you a reset link.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="flex flex-col gap-4">
          {state.message === null && noticeText !== undefined && <Alert tone="info">{noticeText}</Alert>}
          {state.message !== null && <Alert tone={state.ok === true ? 'success' : 'destructive'}>{state.message}</Alert>}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <Button type="submit" disabled={pending} className="w-full">
            {pending ? 'Sending…' : 'Send reset link'}
          </Button>
          <p className="text-center text-sm text-(--color-muted-foreground)">
            Remembered it?{' '}
            <Link href="/login" className="font-medium text-(--color-primary) hover:underline">
              Sign in
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
