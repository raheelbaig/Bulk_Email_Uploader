import Link from 'next/link';
import { Search, UserPlus } from 'lucide-react';
import { currentWorkspace } from '@/lib/auth/workspace';
import {
  listContacts,
  CONTACT_STATUSES,
  MIN_SEARCH_LENGTH,
  type ContactStatus,
} from '@/lib/contacts/service';
import { decodeCursor, encodeCursor, type PageDirection } from '@/lib/pagination';
import { createContactAction } from '../actions';
import { ActionForm } from '@/components/action-form';
import { Field } from '@/components/field';
import { Pager } from '@/components/pager';
import { Table, THead, TBody, TR, TH, TD, EmptyState } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';

export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<ContactStatus, 'positive' | 'danger' | 'warning'> = {
  active: 'positive',
  suppressed: 'danger',
  invalid: 'warning',
};

function asStatus(value: string | undefined): ContactStatus | undefined {
  return CONTACT_STATUSES.includes(value as ContactStatus) ? (value as ContactStatus) : undefined;
}

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (key: string): string | undefined => {
    const value = params[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };

  const { workspaceId } = await currentWorkspace();

  const search = one('q');
  const status = asStatus(one('status'));
  const direction: PageDirection = one('dir') === 'backward' ? 'backward' : 'forward';

  const page = await listContacts(workspaceId, {
    search,
    status,
    cursor: decodeCursor(one('cursor')),
    direction,
  });

  const searchTooShort = search !== undefined && search.trim().length < MIN_SEARCH_LENGTH;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Contacts</h1>
          <p className="text-sm text-[--color-muted-foreground]">
            People you can email from this workspace.
          </p>
        </div>
      </div>

      <details className="rounded-lg border">
        <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-medium">
          <UserPlus className="h-4 w-4" aria-hidden />
          Add a contact
        </summary>
        <div className="border-t px-4 py-4">
          <ActionForm action={createContactAction} submitLabel="Add contact" pendingLabel="Adding…">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field name="email" label="Email" type="email" required maxLength={320} />
              <Field name="company" label="Company" maxLength={200} />
              <Field name="firstName" label="First name" maxLength={120} />
              <Field name="lastName" label="Last name" maxLength={120} />
              <Field name="website" label="Website" maxLength={300} />
              <Field name="phone" label="Phone" maxLength={50} />
            </div>
          </ActionForm>
        </div>
      </details>

      <form method="get" className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="q" className="text-xs font-medium text-[--color-muted-foreground]">
            Search
          </label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-[--color-muted-foreground]"
              aria-hidden
            />
            <Input
              id="q"
              name="q"
              defaultValue={search ?? ''}
              placeholder="Email, name or company"
              className="w-64 pl-8"
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="status" className="text-xs font-medium text-[--color-muted-foreground]">
            Status
          </label>
          <Select id="status" name="status" defaultValue={status ?? ''}>
            <option value="">All statuses</option>
            {CONTACT_STATUSES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" variant="outline" size="sm">
          Apply
        </Button>
        {(search !== undefined || status !== undefined) && (
          <Link href="/contacts" className="px-2 py-1.5 text-sm underline underline-offset-4">
            Clear
          </Link>
        )}
      </form>

      {searchTooShort && (
        <p className="text-sm text-[--color-muted-foreground]">
          Type at least {MIN_SEARCH_LENGTH} characters to search. Showing all contacts.
        </p>
      )}

      {page.items.length === 0 ? (
        <EmptyState>
          {search !== undefined || status !== undefined
            ? 'No contacts match those filters.'
            : 'No contacts yet. Add one above to get started.'}
        </EmptyState>
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH>Email</TH>
                <TH>Name</TH>
                <TH>Company</TH>
                <TH>Status</TH>
                <TH>Created</TH>
                <TH className="text-right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {page.items.map((contact) => {
                const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ');
                return (
                  <TR key={contact.id}>
                    <TD className="font-medium">{contact.email_normalized}</TD>
                    <TD>{name.length > 0 ? name : <Muted>—</Muted>}</TD>
                    <TD>{contact.company ?? <Muted>—</Muted>}</TD>
                    <TD>
                      <Badge tone={STATUS_TONE[contact.status]}>{contact.status}</Badge>
                    </TD>
                    <TD className="whitespace-nowrap text-[--color-muted-foreground]">
                      {new Date(contact.created_at).toLocaleDateString()}
                    </TD>
                    <TD className="text-right">
                      <Link
                        href={`/contacts/${contact.id}`}
                        className="text-sm underline underline-offset-4"
                      >
                        Edit
                      </Link>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>

          <Pager
            basePath="/contacts"
            params={{ q: search, status }}
            nextCursor={page.nextCursor === null ? null : encodeCursor(page.nextCursor)}
            prevCursor={page.prevCursor === null ? null : encodeCursor(page.prevCursor)}
            showing={page.items.length}
          />
        </>
      )}
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-[--color-muted-foreground]">{children}</span>;
}
