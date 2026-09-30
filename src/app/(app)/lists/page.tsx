import Link from 'next/link';
import { ChevronRight, ListChecks, Plus, Users } from 'lucide-react';
import { workspaceForPage } from '@/lib/auth/workspace';
import { listContactLists } from '@/lib/lists/service';
import { decodeCursor, encodeCursor, type PageDirection } from '@/lib/pagination';
import { createListAction } from '../actions';
import { ActionForm } from '@/components/action-form';
import { CreatePanel } from '@/components/create-panel';
import { Field } from '@/components/field';
import { PageHeader } from '@/components/page-header';
import { Pager } from '@/components/pager';
import { buttonVariants } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';

export const dynamic = 'force-dynamic';

export default async function ListsPage({
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
  const direction: PageDirection = one('dir') === 'backward' ? 'backward' : 'forward';

  const page = await listContactLists(workspaceId, {
    cursor: decodeCursor(one('cursor')),
    direction,
  });
  const firstPage = one('cursor') === undefined;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Lists"
        description="Organize contacts into audiences. Each campaign is sent to one list."
        actions={
          <Link href="#new" className={buttonVariants()}>
            <Plus aria-hidden />
            Create list
          </Link>
        }
      />

      <CreatePanel
        title="Create a list"
        description="Give it a name that describes who’s on it. You can add contacts from a contact’s page or while importing."
      >
        <ActionForm
          action={createListAction}
          submitLabel="Create list"
          pendingLabel="Creating…"
          size="default"
          className="flex flex-col gap-4 sm:max-w-md"
        >
          <Field name="name" label="List name" required maxLength={120} placeholder="e.g. Newsletter subscribers" />
        </ActionForm>
      </CreatePanel>

      {page.items.length === 0 && firstPage ? (
        <EmptyState
          icon={ListChecks}
          title="No lists yet"
          description="Lists help you organize contacts so you can choose exactly who receives a campaign — for example “Newsletter” or “Customers in London”."
          action={
            <Link href="#new" className={buttonVariants()}>
              <Plus aria-hidden />
              Create your first list
            </Link>
          }
          secondaryAction={
            <Link href="/imports" className={buttonVariants({ variant: 'outline' })}>
              Import contacts into a list
            </Link>
          }
        />
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH>List</TH>
                <TH className="text-right">Contacts</TH>
                <TH className="hidden sm:table-cell">Created</TH>
                <TH className="w-10">
                  <span className="sr-only">Open</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {page.items.map((list) => (
                <TR key={list.id} className="group relative">
                  <TD>
                    <Link
                      href={`/lists/${list.id}`}
                      className="flex items-center gap-3 font-medium after:absolute after:inset-0 focus-visible:outline-none after:focus-visible:ring-2 after:focus-visible:ring-(--color-ring) after:focus-visible:ring-inset"
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-(--color-surface-subtle) text-(--color-muted-foreground)">
                        <ListChecks className="size-4" aria-hidden />
                      </span>
                      <span className="min-w-0 truncate">{list.name}</span>
                    </Link>
                  </TD>
                  <TD className="text-right tabular-nums">
                    <span className="inline-flex items-center gap-1.5">
                      <Users className="size-3.5 text-(--color-muted-foreground)" aria-hidden />
                      {list.contact_count.toLocaleString()}
                    </span>
                  </TD>
                  <TD className="hidden whitespace-nowrap text-(--color-muted-foreground) sm:table-cell">
                    {new Date(list.created_at).toLocaleDateString(undefined, {
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
              ))}
            </TBody>
          </Table>

          <Pager
            basePath="/lists"
            params={{}}
            nextCursor={page.nextCursor === null ? null : encodeCursor(page.nextCursor)}
            prevCursor={page.prevCursor === null ? null : encodeCursor(page.prevCursor)}
            showing={page.items.length}
            noun="list"
          />
        </>
      )}
    </div>
  );
}
