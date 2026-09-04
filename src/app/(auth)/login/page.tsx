'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { Mail } from 'lucide-react';
import { signIn, type AuthFormState } from '../actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const initialState: AuthFormState = { message: null };

export default function LoginPage() {
  const [state, action, pending] = useActionState(signIn, initialState);

  return (
    <Card>
      <CardHeader>
        <Mail className="h-5 w-5 text-[--color-muted-foreground]" aria-hidden />
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Continue to your workspace.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="flex flex-col gap-4">
          {state.message !== null && <Alert tone="destructive">{state.message}</Alert>}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">Password</Label>
            <Input id="password" name="password" type="password" autoComplete="current-password" required />
          </div>
          <Button type="submit" disabled={pending}>
            {pending ? 'Signing in…' : 'Sign in'}
          </Button>
          <p className="text-center text-sm text-[--color-muted-foreground]">
            No account?{' '}
            <Link href="/signup" className="underline underline-offset-4">
              Create one
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
