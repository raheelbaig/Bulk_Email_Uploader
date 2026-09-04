import Link from 'next/link';
import { Globe, Plus } from 'lucide-react';
import { currentWorkspace } from '@/lib/auth/workspace';
import { listSenderDomains } from '@/lib/sender/service';
import { isProviderConfigured } from '@/lib/sender/provider';
import { READINESS_LABEL, READINESS_TONE } from '@/lib/sender/status';
import { addDomainAction } from './actions';
import { ActionForm } from '@/components/action-form';
import { Field } from '@/components/field';
import { SenderChecks, checksFor } from '@/components/sender-checks';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/table';

export const dynamic = 'force-dynamic';

/**
 * Sender domains.
 *
 * Every status shown here was written by the server after asking SES and DNS.
 * There is no control on this page that sets one — "Check again" runs the
 * verifier, whose answer comes from the provider.
 */
export default async function SenderDomainsPage() {
  const { workspaceId } = await currentWorkspace();
  const domains = await listSenderDomains(workspaceId);
  const configured = isProviderConfigured();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Sender domains</h1>
          <p className="text-sm text-[--color-muted-foreground]">
            Domains this workspace has proven it controls. A domain becomes usable only when the
            sending provider and DNS both confirm it — never because it was added here.
          </p>
        </div>
        <Link
          href="/senders/identities"
          className="shrink-0 text-sm underline underline-offset-4"
        >
          Sender addresses
        </Link>
      </div>

      {!configured && (
        <Alert tone="destructive">
          The sending provider is not configured for this deployment, so domains cannot be
          provisioned or verified. An administrator needs to add the AWS credentials described in
          <code className="mx-1">.env.example</code>.
        </Alert>
      )}

      <details className="rounded-lg border" open={domains.length === 0}>
        <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-medium">
          <Plus className="h-4 w-4" aria-hidden />
          Add a sending domain
        </summary>
        <div className="border-t px-4 py-4">
          <ActionForm action={addDomainAction} submitLabel="Add domain" pendingLabel="Setting up…">
            <Field
              name="domain"
              label="Domain"
              required
              placeholder="example.com"
              maxLength={253}
              hint="The domain only — no https://, no path, no email address. You will need to add DNS records to it."
            />
          </ActionForm>
        </div>
      </details>

      {domains.length === 0 ? (
        <EmptyState>
          No sending domains yet. Add one to begin setting up email authentication.
        </EmptyState>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {domains.map((view) => (
            <Card key={view.record.id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <CardTitle className="flex items-center gap-2">
                    <Globe className="h-4 w-4 shrink-0" aria-hidden />
                    {view.record.domain}
                  </CardTitle>
                  <Badge tone={READINESS_TONE[view.readiness]}>
                    {READINESS_LABEL[view.readiness]}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <SenderChecks checks={checksFor(view.record)} />
                <p className="text-xs text-[--color-muted-foreground]">{view.summary}</p>
                {view.record.last_check_error !== null && (
                  <p className="text-xs text-[--color-destructive]">
                    {view.record.last_check_error}
                  </p>
                )}
                <div className="flex items-center justify-between text-xs">
                  <Link
                    href={`/senders/${view.record.id}`}
                    className="underline underline-offset-4"
                  >
                    DNS records and setup
                  </Link>
                  <span className="text-[--color-muted-foreground]">
                    {view.identityCount} {view.identityCount === 1 ? 'address' : 'addresses'}
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
