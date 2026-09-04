'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { Mail } from 'lucide-react';
import { signUp, type AuthFormState } from '../actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const initialState: AuthFormState = { message: null };

export default function SignupPage() {
  const [state, action, pending] = useActionState(signUp, initialState);

  return (
    <Card>
      <CardHeader>
        <Mail className="h-5 w-5 text-[--color-muted-foreground]" aria-hidden />
        <CardTitle>Create your account</CardTitle>
        <CardDescription>A workspace is set up for you automatically.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="flex flex-col gap-4">
          {state.message !== null && <Alert tone="destructive">{state.message}</Alert>}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="workspace_name">Workspace name</Label>
            <Input id="workspace_name" name="workspace_name" placeholder="Acme" maxLength={120} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
            />
            <p className="text-xs text-[--color-muted-foreground]">At least 8 characters.</p>
          </div>
          <Button type="submit" disabled={pending}>
            {pending ? 'Creating account…' : 'Create account'}
          </Button>
          <p className="text-center text-sm text-[--color-muted-foreground]">
            Already have an account?{' '}
            <Link href="/login" className="underline underline-offset-4">
              Sign in
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
