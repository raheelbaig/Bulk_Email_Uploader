import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Send, Upload, Users } from 'lucide-react';
import { workspaceForPage } from '@/lib/auth/workspace';
import { getContactList } from '@/lib/lists/service';
import { listContacts } from '@/lib/contacts/service';
import { isAppError } from '@/lib/errors';
import { renameListAction, deleteListAction, removeListMemberAction } from '../../actions';
import { ActionForm } from '@/components/action-form';
import { Field } from '@/components/field';
import { PageHeader } from '@/components/page-header';
import { SectionCard } from '@/components/section-card';
import { ContactStatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';

export const dynamic = 'force-dynamic';

export default async function ListDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { workspaceId } = await workspaceForPage();

  let list;
  try {
    list = await getContactList(workspaceId, id);
  } catch (err) {
    // "Absent" and "not yours" answer identically, so this page cannot be used
    // to probe for list ids belonging to another workspace.
    if (isAppError(err)) notFound();
    throw err;
  }

  const members = await listContacts(workspaceId, { listId: list.id, limit: 100 });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        back={{ href: '/lists', label: 'Lists' }}
        title={list.name}
        meta={
          <Badge tone="neutral">
            <Users aria-hidden />
            {list.contact_count.toLocaleString()} {list.contact_count === 1 ? 'contact' : 'contacts'}
          </Badge>
        }
        description="The contacts on this list. Choose this list as the audience when you create a campaign."
        actions={
          <Link href="/campaigns#new" className={buttonVariants()}>
            <Send aria-hidden />
            Send a campaign
          </Link>
        }
      />

      {members.items.length === 0 ? (
        <EmptyState
          icon={Users}
          title="This list is empty"
          description="Add contacts by importing a file into this list, or open any contact and add them to it."
          action={
            <Link href="/imports" className={buttonVariants()}>
              <Upload aria-hidden />
              Import contacts
            </Link>
          }
          secondaryAction={
            <Link href="/contacts" className={buttonVariants({ variant: 'outline' })}>
              Browse contacts
            </Link>
          }
        />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Contact</TH>
              <TH>Status</TH>
              <TH className="text-right">
                <span className="sr-only">Actions</span>
              </TH>
            </TR>
          </THead>
          <TBody>
            {members.items.map((contact) => {
              const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ');
              return (
                <TR key={contact.id}>
                  <TD className="max-w-[16rem] sm:max-w-none">
                    <Link
                      href={`/contacts/${contact.id}`}
                      className="block min-w-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring)"
                    >
                      <span className="block truncate font-medium hover:underline">
                        {name.length > 0 ? name : contact.email_normalized}
                      </span>
                      {name.length > 0 && (
                        <span className="block truncate text-sm text-(--color-muted-foreground)">
                          {contact.email_normalized}
                        </span>
                      )}
                    </Link>
                  </TD>
                  <TD>
                    <ContactStatusBadge status={contact.status} />
                  </TD>
                  <TD className="text-right">
                    <ActionForm
                      action={removeListMemberAction}
                      submitLabel="Remove"
                      pendingLabel="Removing…"
                      variant="ghost"
                      className="flex flex-col items-end gap-1"
                      actionsClassName="justify-end"
                      confirm={{
                        title: 'Remove from this list?',
                        description: `${contact.email_normalized} will be taken off “${list.name}” and won’t receive campaigns sent to this list. The contact itself is kept, and you can add them back at any time.`,
                        confirmLabel: 'Remove from list',
                      }}
                    >
                      <input type="hidden" name="listId" value={list.id} />
                      <input type="hidden" name="contactId" value={contact.id} />
                    </ActionForm>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}

      {members.hasMore && (
        <p className="text-sm text-(--color-muted-foreground)">Showing the first 100 members.</p>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Rename list" description="Only you and your team see this name — recipients never do.">
          <ActionForm action={renameListAction} submitLabel="Save name" pendingLabel="Saving…" variant="outline" successMessageMs={5000}>
            <input type="hidden" name="listId" value={list.id} />
            <Field name="name" label="List name" required defaultValue={list.name} maxLength={120} />
          </ActionForm>
        </SectionCard>

        <SectionCard
          title="Delete list"
          description="Removes the list itself. The contacts on it are kept and stay in your workspace."
          className="border-(--color-danger-border)"
        >
          <ActionForm
            action={deleteListAction}
            submitLabel="Delete list"
            pendingLabel="Deleting…"
            variant="destructive"
            confirm={{
              title: `Delete “${list.name}”?`,
              description:
                'The list is deleted. The contacts on it stay in your workspace. A list that a campaign uses can’t be deleted — change or delete that campaign first.',
              irreversible: true,
            }}
          >
            <input type="hidden" name="listId" value={list.id} />
          </ActionForm>
        </SectionCard>
      </div>
    </div>
  );
}
