import { workspaceForPage } from '@/lib/auth/workspace';
import { getSendingSettings, POSTAL_ADDRESS_MAX } from '@/lib/workspace/settings';
import { sendingConfig } from '@/lib/sending/config';
import { SENDING_MODE_LABEL } from '@/lib/sending/gate';
import { ActionForm } from '@/components/action-form';
import { Alert } from '@/components/ui/alert';
import { Textarea } from '@/components/ui/textarea';
import { updatePostalAddressAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * Workspace settings that shape what is sent. Owners and admins may edit; every
 * member may read, since the footer is part of what their campaigns say.
 */
export default async function SettingsPage() {
  const { workspaceId, role } = await workspaceForPage();
  const canEdit = role === 'owner' || role === 'admin';
  const { postalAddress } = await getSendingSettings(workspaceId);
  const sending = sendingConfig();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-(--color-muted-foreground)">
          Sending mode for this deployment: <strong>{SENDING_MODE_LABEL[sending.mode]}</strong>. Daily limit:{' '}
          {sending.dailyCap.toLocaleString()} messages. A contact reached by one campaign is skipped by others for{' '}
          {sending.contactCooldownMinutes === 0 ? 'no time at all (cooldown off)' : `${sending.contactCooldownMinutes / 60} hours`}.
        </p>
      </div>

      <section className="flex flex-col gap-3 rounded-lg border p-4">
        <div>
          <h2 className="font-medium">Postal address for the email footer</h2>
          <p className="text-sm text-(--color-muted-foreground)">
            Added automatically, beside the unsubscribe link, to the footer of every message of a campaign that
            requires unsubscribe. Templates cannot remove it. Campaigns like that cannot be scheduled or sent while
            this is empty.
          </p>
        </div>

        {postalAddress === null && (
          <Alert tone="destructive">No postal address is set, so bulk campaigns are blocked.</Alert>
        )}

        {canEdit ? (
          <ActionForm action={updatePostalAddressAction} submitLabel="Save address">
            <label htmlFor="postalAddress" className="text-sm font-medium">
              Address
            </label>
            <Textarea
              id="postalAddress"
              name="postalAddress"
              rows={4}
              maxLength={POSTAL_ADDRESS_MAX}
              defaultValue={postalAddress ?? ''}
              placeholder={'Company name\nStreet\nTown, postcode\nCountry'}
            />
          </ActionForm>
        ) : (
          <pre className="whitespace-pre-wrap text-sm">{postalAddress ?? 'Not set.'}</pre>
        )}
      </section>
    </div>
  );
}
