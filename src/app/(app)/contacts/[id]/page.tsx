import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ListChecks, Plus } from 'lucide-react';
import { workspaceForPage } from '@/lib/auth/workspace';
import { getContact } from '@/lib/contacts/service';
import { listContactLists, listIdsForContact } from '@/lib/lists/service';
import { findSuppression } from '@/lib/suppression/service';
import { isAppError } from '@/lib/errors';
import { updateContactAction, deleteContactAction, addListMemberAction } from '../../actions';
import { ActionForm } from '@/components/action-form';
import { Field, FieldShell } from '@/components/field';
import { PageHeader } from '@/components/page-header';
import { SectionCard } from '@/components/section-card';
import { ContactStatusBadge } from '@/components/status-badge';
import { SUPPRESSION_REASON_LABEL } from '@/components/suppression-copy';
import { Alert } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { Select } from '@/components/ui/select';

export const dynamic = 'force-dynamic';

export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { workspaceId } = await workspaceForPage();

  let contact;
  try {
    contact = await getContact(workspaceId, id);
  } catch (err) {
    // getContact answers "absent" and "not yours" identically; both render as
    // not found so the page cannot be used to probe for ids.
    if (isAppError(err)) notFound();
    throw err;
  }

  const [suppression, lists, memberOf] = await Promise.all([
    findSuppression(workspaceId, contact.email_normalized),
    listContactLists(workspaceId, { limit: 100 }),
    listIdsForContact(workspaceId, contact.id),
  ]);

  const available = lists.items.filter((list) => !memberOf.includes(list.id));
  const current = lists.items.filter((list) => memberOf.includes(list.id));
  const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ');

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        back={{ href: '/contacts', label: 'Contacts' }}
        title={name.length > 0 ? name : contact.email_normalized}
        meta={<ContactStatusBadge status={contact.status} />}
        description={
          <>
            {name.length > 0 && <span className="text-(--color-foreground)">{contact.email_normalized} · </span>}
            Added{' '}
            {new Date(contact.created_at).toLocaleDateString(undefined, {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })}
          </>
        }
      />

      {suppression !== null && (
        <Alert tone="warning" title="This person won’t receive your emails">
          Reason: {SUPPRESSION_REASON_LABEL[suppression.reason] ?? suppression.reason}. They stay on your lists
          but are skipped whenever a campaign sends. Deleting the contact doesn’t change this.{' '}
          <Link href="/suppressions" className="font-medium underline underline-offset-4">
            View unsubscribed &amp; blocked
          </Link>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <SectionCard
          title="Contact details"
          description="Used to personalise your emails — for example, “Hi {{first_name}}”."
          className="lg:col-span-2"
        >
          <ActionForm action={updateContactAction} submitLabel="Save changes" pendingLabel="Saving…" size="default" successMessageMs={5000}>
            <input type="hidden" name="contactId" value={contact.id} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                name="email"
                label="Email address"
                type="email"
                required
                defaultValue={contact.email_raw}
                maxLength={320}
                className="sm:col-span-2"
                hint="Changing the address re-checks whether it’s unsubscribed or blocked."
              />
              <Field name="firstName" label="First name" defaultValue={contact.first_name ?? ''} maxLength={120} />
              <Field name="lastName" label="Last name" defaultValue={contact.last_name ?? ''} maxLength={120} />
              <Field name="company" label="Company" defaultValue={contact.company ?? ''} maxLength={200} />
              <Field name="phone" label="Phone" defaultValue={contact.phone ?? ''} maxLength={50} />
              <Field
                name="website"
                label="Website"
                defaultValue={contact.website ?? ''}
                maxLength={300}
                className="sm:col-span-2"
              />
            </div>
          </ActionForm>
        </SectionCard>

        <div className="flex flex-col gap-6">
          <SectionCard title="Lists" description="The audiences this contact belongs to.">
            <div className="flex flex-col gap-4">
              {current.length === 0 ? (
                <p className="text-sm text-(--color-muted-foreground)">Not on any list yet.</p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {current.map((list) => (
                    <li key={list.id}>
                      <Link
                        href={`/lists/${list.id}`}
                        className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors hover:bg-(--color-muted)"
                      >
                        <ListChecks className="size-4 text-(--color-muted-foreground)" aria-hidden />
                        <span className="truncate">{list.name}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}

              {available.length > 0 ? (
                <ActionForm
                  action={addListMemberAction}
                  submitLabel="Add to list"
                  pendingLabel="Adding…"
                  variant="outline"
                  submitIcon={<Plus aria-hidden />}
                  className="flex flex-col gap-3 border-t pt-4"
                >
                  <input type="hidden" name="contactId" value={contact.id} />
                  <FieldShell id="listId" label="Add to another list" required>
                    <Select id="listId" name="listId" required className="w-full">
                      {available.map((list) => (
                        <option key={list.id} value={list.id}>
                          {list.name}
                        </option>
                      ))}
                    </Select>
                  </FieldShell>
                </ActionForm>
              ) : (
                lists.items.length === 0 && (
                  <Link href="/lists#new" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                    <Plus aria-hidden />
                    Create a list
                  </Link>
                )
              )}
            </div>
          </SectionCard>

          <SectionCard
            title="Delete contact"
            description="Removes this person and their list memberships. If they’re unsubscribed or blocked, that stays in place."
            className="border-(--color-danger-border)"
          >
            <ActionForm
              action={deleteContactAction}
              submitLabel="Delete contact"
              pendingLabel="Deleting…"
              variant="destructive"
              confirm={{
                title: `Delete ${contact.email_normalized}?`,
                description:
                  'This contact, their details and their list memberships are deleted. If they unsubscribed or were blocked, that stays in place, so they still won’t be emailed.',
                irreversible: true,
              }}
            >
              <input type="hidden" name="contactId" value={contact.id} />
            </ActionForm>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
