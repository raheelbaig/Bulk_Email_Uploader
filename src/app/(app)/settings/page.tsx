import { Building2, LogOut, Send, UserRound } from 'lucide-react';
import { workspaceForPage } from '@/lib/auth/workspace';
import { getCurrentUser } from '@/lib/auth/session';
import { getSendingSettings, POSTAL_ADDRESS_MAX } from '@/lib/workspace/settings';
import { sendingConfig } from '@/lib/sending/config';
import { LIVE_REQUIREMENT_MESSAGE, SENDING_MODE_LABEL, SENDING_MODE_NOTICE } from '@/lib/sending/gate';
import { signOut } from '../../(auth)/actions';
import { updatePostalAddressAction } from './actions';
import { ActionForm } from '@/components/action-form';
import { FieldShell } from '@/components/field';
import { PageHeader } from '@/components/page-header';
import { SectionCard } from '@/components/section-card';
import { SENDING_MODE_BADGE, SENDING_MODE_EXPLANATION } from '@/components/sending-copy';
import { StatusBadge } from '@/components/status-badge';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

export const dynamic = 'force-dynamic';

const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', member: 'Member' } as const;

/**
 * Workspace settings that shape what is sent. Owners and admins may edit; every
 * member may read, since the footer is part of what their campaigns say.
 */
export default async function SettingsPage() {
  const { workspaceId, role } = await workspaceForPage();
  const canEdit = role === 'owner' || role === 'admin';
  const [{ postalAddress }, user] = await Promise.all([getSendingSettings(workspaceId), getCurrentUser()]);
  const sending = sendingConfig();
  const liveBlocked = sending.mode === 'live' && !sending.live.allowed;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Settings" description="Your business address, email sending and your account. Sender domains and addresses are under Senders." />

      {/* Workspace */}
      <div className="flex flex-col gap-3">
        <h2 className="text-xs font-semibold tracking-wider text-(--color-muted-foreground) uppercase">Workspace</h2>
        <SectionCard
          id="business-address"
          headingLevel={3}
          icon={Building2}
          title="Business address"
          description="Added automatically to the footer of your marketing emails, next to the unsubscribe link. Email laws require a real postal address, so campaigns can’t be scheduled without one."
          actions={
            postalAddress === null ? (
              <StatusBadge tone="warning" label="Required before sending" />
            ) : (
              <StatusBadge tone="positive" label="Added" />
            )
          }
        >
          {canEdit ? (
            <ActionForm
              action={updatePostalAddressAction}
              submitLabel="Save changes"
              successMessageMs={5000}
              pendingLabel="Saving…"
              size="default"
              className="flex flex-col gap-4 sm:max-w-lg"
            >
              <FieldShell
                id="postalAddress"
                label="Postal address"
                required
                hint="Recipients see this exactly as written. Your templates can’t remove it."
              >
                <Textarea
                  id="postalAddress"
                  name="postalAddress"
                  rows={4}
                  maxLength={POSTAL_ADDRESS_MAX}
                  defaultValue={postalAddress ?? ''}
                  aria-describedby="postalAddress-hint"
                  className="font-sans"
                  placeholder={'Company name\nStreet\nTown, postcode\nCountry'}
                />
              </FieldShell>
            </ActionForm>
          ) : postalAddress === null ? (
            <Alert tone="warning">
              No business address yet. Ask a workspace owner or admin to add one — campaigns can’t be scheduled
              until they do.
            </Alert>
          ) : (
            <pre className="rounded-lg border bg-(--color-surface-subtle) px-4 py-3 font-sans text-sm whitespace-pre-wrap">
              {postalAddress}
            </pre>
          )}
        </SectionCard>
      </div>

      {/* Email sending */}
      <div className="flex flex-col gap-3">
        <h2 className="text-xs font-semibold tracking-wider text-(--color-muted-foreground) uppercase">
          Email sending
        </h2>
        <SectionCard
          headingLevel={3}
          icon={Send}
          title="Sending status"
          description={
            liveBlocked
              ? canEdit
                ? 'Email delivery is selected but isn’t fully switched on for this installation. That’s done in the server’s settings, not in the app — the technical details below list what’s missing.'
                : 'Email delivery isn’t fully switched on for this installation yet. Ask your workspace owner.'
              : SENDING_MODE_EXPLANATION[sending.mode]
          }
          actions={
            <StatusBadge
              tone={sending.mode === 'live' && !liveBlocked ? 'positive' : sending.mode === 'dry_run' ? 'info' : 'neutral'}
              label={liveBlocked ? 'Not available yet' : SENDING_MODE_BADGE[sending.mode]}
            />
          }
        >
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div className="rounded-lg border bg-(--color-surface-subtle) px-3 py-2.5">
              <dt className="text-(--color-muted-foreground)">Daily sending limit</dt>
              <dd className="mt-0.5 font-semibold">{sending.dailyCap.toLocaleString()} emails</dd>
            </div>
            <div className="rounded-lg border bg-(--color-surface-subtle) px-3 py-2.5">
              <dt className="text-(--color-muted-foreground)">Gap between campaigns per person</dt>
              <dd className="mt-0.5 font-semibold">
                {sending.contactCooldownMinutes === 0 ? 'None' : `${sending.contactCooldownMinutes / 60} hours`}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-sm text-(--color-muted-foreground)">
            If someone is reached by one campaign, other campaigns skip them until this gap has passed.
          </p>
          {canEdit && (
            <details className="mt-4 text-sm">
              <summary className="w-fit cursor-pointer text-(--color-muted-foreground) underline-offset-4 hover:underline">
                Advanced / technical details
              </summary>
              <div className="mt-2 flex flex-col gap-1.5 rounded-lg border bg-(--color-surface-subtle) p-3 text-(--color-muted-foreground)">
                <p>
                  Sending mode for this deployment: <strong>{SENDING_MODE_LABEL[sending.mode]}</strong>.
                </p>
                <p>{SENDING_MODE_NOTICE[sending.mode]}</p>
                {liveBlocked && (
                  <ul className="list-disc pl-5 break-words">
                    {sending.live.unmet.map((requirement) => (
                      <li key={requirement}>{LIVE_REQUIREMENT_MESSAGE[requirement]}</li>
                    ))}
                  </ul>
                )}
              </div>
            </details>
          )}
        </SectionCard>
      </div>

      {/* Account */}
      <div className="flex flex-col gap-3">
        <h2 className="text-xs font-semibold tracking-wider text-(--color-muted-foreground) uppercase">Account</h2>
        <SectionCard headingLevel={3} icon={UserRound} title="Your account">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <dl className="grid gap-3 text-sm sm:grid-cols-2 sm:gap-8">
              <div className="min-w-0">
                <dt className="text-(--color-muted-foreground)">Email address</dt>
                <dd className="mt-0.5 truncate font-medium">{user?.email ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-(--color-muted-foreground)">Role in this workspace</dt>
                <dd className="mt-0.5 font-medium">{ROLE_LABEL[role]}</dd>
              </div>
            </dl>
            <form action={signOut}>
              <Button type="submit" variant="outline">
                <LogOut aria-hidden />
                Sign out
              </Button>
            </form>
          </div>
        </SectionCard>
      </div>
    </div>
  );
}
