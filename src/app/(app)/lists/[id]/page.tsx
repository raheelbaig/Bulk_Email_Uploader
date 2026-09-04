import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { currentWorkspace } from '@/lib/auth/workspace';
import { getContactList } from '@/lib/lists/service';
import { listContacts } from '@/lib/contacts/service';
import { isAppError } from '@/lib/errors';
import { renameListAction, deleteListAction, removeListMemberAction } from '../../actions';
import { ActionForm } from '@/components/action-form';
import { Field } from '@/components/field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, THead, TBody, TR, TH, TD, EmptyState } from '@/components/ui/table';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

export default async function ListDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { workspaceId } = await currentWorkspace();

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
      <div>
        <Link
          href="/lists"
          className="inline-flex items-center gap-1 text-sm text-[--color-muted-foreground] underline underline-offset-4"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          Lists
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{list.name}</h1>
        <p className="text-sm text-[--color-muted-foreground]">
          {list.contact_count} {list.contact_count === 1 ? 'contact' : 'contacts'}
        </p>
      </div>

      {members.items.length === 0 ? (
        <EmptyState>No contacts on this list yet. Add one from a contact page.</EmptyState>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Email</TH>
              <TH>Name</TH>
              <TH>Status</TH>
              <TH className="text-right">Actions</TH>
            </TR>
          </THead>
          <TBody>
            {members.items.map((contact) => {
              const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ');
              return (
                <TR key={contact.id}>
                  <TD className="font-medium">
                    <Link href={`/contacts/${contact.id}`} className="underline underline-offset-4">
                      {contact.email_normalized}
                    </Link>
                  </TD>
                  <TD>{name.length > 0 ? name : '—'}</TD>
                  <TD>
                    <Badge tone={contact.status === 'active' ? 'positive' : 'danger'}>
                      {contact.status}
                    </Badge>
                  </TD>
                  <TD className="text-right">
                    <form action={removeListMemberAction}>
                      <input type="hidden" name="listId" value={list.id} />
                      <input type="hidden" name="contactId" value={contact.id} />
                      <Button type="submit" variant="ghost" size="sm">
                        Remove
                      </Button>
                    </form>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}

      {members.hasMore && (
        <p className="text-xs text-[--color-muted-foreground]">Showing the first 100 members.</p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Rename list</CardTitle>
        </CardHeader>
        <CardContent>
          <ActionForm action={renameListAction} submitLabel="Rename" pendingLabel="Renaming…">
            <input type="hidden" name="listId" value={list.id} />
            <Field name="name" label="Name" required defaultValue={list.name} maxLength={120} />
          </ActionForm>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Delete list</CardTitle>
          <CardDescription>
            Removes the list and its membership records. The contacts themselves are kept.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={deleteListAction}>
            <input type="hidden" name="listId" value={list.id} />
            <Button type="submit" variant="destructive" size="sm">
              Delete list
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
