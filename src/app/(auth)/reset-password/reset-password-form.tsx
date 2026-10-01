'use client';

import { useActionState } from 'react';
import { updatePassword, type AuthFormState } from '../actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const initialState: AuthFormState = { message: null };

export function ResetPasswordForm({ email }: { email: string | null }) {
  const [state, action, pending] = useActionState(updatePassword, initialState);

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle>Choose a new password</CardTitle>
        <CardDescription>
          {email === null ? 'Set a new password for your account.' : `Set a new password for ${email}.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="flex flex-col gap-4">
          {state.message !== null && <Alert tone="destructive">{state.message}</Alert>}
          {/* Lets password managers file the new password under the right account. */}
          {email !== null && (
            <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">New password</Label>
            <Input id="password" name="password" type="password" autoComplete="new-password" minLength={8} required />
            <p className="text-xs text-(--color-muted-foreground)">At least 8 characters.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="confirm">Repeat the new password</Label>
            <Input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={8} required />
          </div>
          <Button type="submit" disabled={pending} className="w-full">
            {pending ? 'Saving…' : 'Save new password'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
