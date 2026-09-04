import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { currentWorkspace } from '@/lib/auth/workspace';
import { getContact } from '@/lib/contacts/service';
import { listContactLists, listIdsForContact } from '@/lib/lists/service';
import { findSuppression } from '@/lib/suppression/service';
import { isAppError } from '@/lib/errors';
import { updateContactAction, deleteContactAction, addListMemberAction } from '../../actions';
import { ActionForm } from '@/components/action-form';
import { Field } from '@/components/field';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { workspaceId } = await currentWorkspace();

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

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/contacts"
          className="inline-flex items-center gap-1 text-sm text-[--color-muted-foreground] underline underline-offset-4"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          Contacts
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{contact.email_normalized}</h1>
        <p className="text-sm text-[--color-muted-foreground]">
          Added {new Date(contact.created_at).toLocaleDateString()}
        </p>
      </div>

      {suppression !== null && (
        <Alert tone="destructive">
          <strong className="font-medium">This address is suppressed.</strong> It cannot be emailed
          from this workspace. Reason: {suppression.reason.replace(/_/g, ' ')}. Deleting the contact
          will not lift the suppression.
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
          <CardDescription>
            Changing the email address re-checks it against the suppression list.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={updateContactAction} submitLabel="Save changes" pendingLabel="Saving…">
            <input type="hidden" name="contactId" value={contact.id} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                name="email"
                label="Email"
                type="email"
                required
                defaultValue={contact.email_raw}
                maxLength={320}
              />
              <Field
                name="company"
                label="Company"
                defaultValue={contact.company ?? ''}
                maxLength={200}
              />
              <Field
                name="firstName"
                label="First name"
                defaultValue={contact.first_name ?? ''}
                maxLength={120}
              />
              <Field
                name="lastName"
                label="Last name"
                defaultValue={contact.last_name ?? ''}
                maxLength={120}
              />
              <Field
                name="website"
                label="Website"
                defaultValue={contact.website ?? ''}
                maxLength={300}
              />
              <Field name="phone" label="Phone" defaultValue={contact.phone ?? ''} maxLength={50} />
            </div>
          </ActionForm>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Lists</CardTitle>
          <CardDescription>Which lists this contact belongs to.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {current.length === 0 ? (
            <p className="text-sm text-[--color-muted-foreground]">Not on any list.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {current.map((list) => (
                <Link key={list.id} href={`/lists/${list.id}`}>
                  <Badge>{list.name}</Badge>
                </Link>
              ))}
            </div>
          )}

          {available.length > 0 && (
            <ActionForm
              action={addListMemberAction}
              submitLabel="Add to list"
              pendingLabel="Adding…"
              className="flex flex-col gap-3"
            >
              <input type="hidden" name="contactId" value={contact.id} />
              <div className="flex flex-col gap-1.5">
                <label htmlFor="listId" className="text-sm font-medium">
                  List
                </label>
                <Select id="listId" name="listId" required>
                  {available.map((list) => (
                    <option key={list.id} value={list.id}>
                      {list.name}
                    </option>
                  ))}
                </Select>
              </div>
            </ActionForm>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Delete contact</CardTitle>
          <CardDescription>
            Removes the contact and its list memberships. Any suppression for this address is kept —
            deleting a contact never makes a suppressed address emailable again.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={deleteContactAction}>
            <input type="hidden" name="contactId" value={contact.id} />
            <Button type="submit" variant="destructive" size="sm">
              Delete contact
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
