import Link from 'next/link';
import { ChevronRight, Search, Upload, UserPlus, Users } from 'lucide-react';
import { workspaceForPage } from '@/lib/auth/workspace';
import {
  listContacts,
  CONTACT_STATUSES,
  MIN_SEARCH_LENGTH,
  type ContactStatus,
} from '@/lib/contacts/service';
import { decodeCursor, encodeCursor, type PageDirection } from '@/lib/pagination';
import { createContactAction } from '../actions';
import { ActionForm } from '@/components/action-form';
import { CreatePanel } from '@/components/create-panel';
import { Field } from '@/components/field';
import { PageHeader } from '@/components/page-header';
import { Pager } from '@/components/pager';
import { ContactStatusBadge } from '@/components/status-badge';
import { Alert } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';

export const dynamic = 'force-dynamic';

const STATUS_OPTION_LABEL: Record<ContactStatus, string> = {
  active: 'Active',
  suppressed: 'Unsubscribed or blocked',
  invalid: 'Invalid address',
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

  const { workspaceId } = await workspaceForPage();

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
  const filtered = search !== undefined || status !== undefined;
  const firstPage = one('cursor') === undefined;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Contacts"
        description="The people you can reach with your campaigns."
        actions={
          <>
            <Link href="#new" className={buttonVariants({ variant: 'outline' })}>
              <UserPlus aria-hidden />
              Add contact
            </Link>
            <Link href="/imports" className={buttonVariants()}>
              <Upload aria-hidden />
              Import contacts
            </Link>
          </>
        }
      />

      <CreatePanel
        title="Add a contact"
        description="Add one person by hand. To add many at once, import a spreadsheet instead."
      >
        <ActionForm action={createContactAction} submitLabel="Add contact" pendingLabel="Adding…" size="default">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field name="email" label="Email address" type="email" required maxLength={320} autoComplete="off" />
            <Field name="company" label="Company" maxLength={200} />
            <Field name="firstName" label="First name" maxLength={120} />
            <Field name="lastName" label="Last name" maxLength={120} />
            <Field name="website" label="Website" maxLength={300} />
            <Field name="phone" label="Phone" maxLength={50} />
          </div>
        </ActionForm>
      </CreatePanel>

      {page.items.length === 0 && !filtered && firstPage ? (
        <EmptyState
          icon={Users}
          title="No contacts yet"
          description="Contacts are the people who receive your campaigns. The quickest way to start is to import a spreadsheet (CSV or Excel) you already have."
          action={
            <Link href="/imports" className={buttonVariants()}>
              <Upload aria-hidden />
              Import contacts
            </Link>
          }
          secondaryAction={
            <Link href="#new" className={buttonVariants({ variant: 'outline' })}>
              <UserPlus aria-hidden />
              Add one by hand
            </Link>
          }
        />
      ) : (
        <>
          <form
            method="get"
            role="search"
            aria-label="Filter contacts"
            className="flex flex-col gap-3 rounded-xl border bg-(--color-card) p-3 shadow-xs sm:flex-row sm:items-center"
          >
            <div className="relative min-w-0 flex-1">
              <label htmlFor="q" className="sr-only">
                Search contacts
              </label>
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-(--color-muted-foreground)"
                aria-hidden
              />
              <Input
                id="q"
                name="q"
                type="search"
                defaultValue={search ?? ''}
                placeholder="Search by email, name or company"
                className="pl-9"
              />
            </div>
            <div className="flex items-center gap-2">
              <label htmlFor="status" className="sr-only">
                Status
              </label>
              <Select id="status" name="status" defaultValue={status ?? ''} className="min-w-0 flex-1 sm:w-44 sm:flex-none">
                <option value="">All statuses</option>
                {CONTACT_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {STATUS_OPTION_LABEL[value]}
                  </option>
                ))}
              </Select>
              <Button type="submit" variant="secondary">
                Search
              </Button>
              {filtered && (
                <Link href="/contacts" className={buttonVariants({ variant: 'ghost' })}>
                  Clear
                </Link>
              )}
            </div>
          </form>

          {searchTooShort && (
            <Alert tone="info">Type at least {MIN_SEARCH_LENGTH} characters to search. Showing all contacts.</Alert>
          )}

          {page.items.length === 0 ? (
            <EmptyState
              compact
              icon={Search}
              title="No matching contacts"
              description="Try a different search, or clear the filters to see everyone."
              action={
                <Link href="/contacts" className={buttonVariants({ variant: 'outline' })}>
                  Clear filters
                </Link>
              }
            />
          ) : (
            <>
              <Table>
                <THead>
                  <TR>
                    <TH>Contact</TH>
                    <TH className="hidden md:table-cell">Company</TH>
                    <TH>Status</TH>
                    <TH className="hidden sm:table-cell">Added</TH>
                    <TH className="w-10">
                      <span className="sr-only">Open</span>
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {page.items.map((contact) => {
                    const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ');
                    return (
                      <TR key={contact.id} className="group relative">
                        <TD className="max-w-[14rem] sm:max-w-none">
                          <Link
                            href={`/contacts/${contact.id}`}
                            className="flex min-w-0 items-center gap-3 after:absolute after:inset-0 focus-visible:outline-none after:focus-visible:ring-2 after:focus-visible:ring-(--color-ring) after:focus-visible:ring-inset"
                          >
                            <span
                              aria-hidden
                              className="hidden size-8 shrink-0 items-center justify-center rounded-full bg-(--color-muted) text-xs font-semibold text-(--color-muted-foreground) sm:flex"
                            >
                              {(name.length > 0 ? name : contact.email_normalized).slice(0, 1).toUpperCase()}
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate font-medium">
                                {name.length > 0 ? name : contact.email_normalized}
                              </span>
                              {name.length > 0 && (
                                <span className="block truncate text-sm text-(--color-muted-foreground)">
                                  {contact.email_normalized}
                                </span>
                              )}
                            </span>
                          </Link>
                        </TD>
                        <TD className="hidden text-(--color-muted-foreground) md:table-cell">
                          {contact.company ?? '—'}
                        </TD>
                        <TD>
                          <ContactStatusBadge status={contact.status} />
                        </TD>
                        <TD className="hidden whitespace-nowrap text-(--color-muted-foreground) sm:table-cell">
                          {new Date(contact.created_at).toLocaleDateString(undefined, {
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                          })}
                        </TD>
                        <TD className="text-(--color-muted-foreground)">
                          <ChevronRight
                            className="size-4 transition-transform group-hover:translate-x-0.5"
                            aria-hidden
                          />
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
                noun="contact"
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
