import Link from 'next/link';
import { ListPlus } from 'lucide-react';
import { currentWorkspace } from '@/lib/auth/workspace';
import { listContactLists } from '@/lib/lists/service';
import { decodeCursor, encodeCursor, type PageDirection } from '@/lib/pagination';
import { createListAction } from '../actions';
import { ActionForm } from '@/components/action-form';
import { Field } from '@/components/field';
import { Pager } from '@/components/pager';
import { Table, THead, TBody, TR, TH, TD, EmptyState } from '@/components/ui/table';

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

  const { workspaceId } = await currentWorkspace();
  const direction: PageDirection = one('dir') === 'backward' ? 'backward' : 'forward';

  const page = await listContactLists(workspaceId, {
    cursor: decodeCursor(one('cursor')),
    direction,
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Lists</h1>
        <p className="text-sm text-[--color-muted-foreground]">
          Groups of contacts. A list is who a campaign will go to, once campaigns exist.
        </p>
      </div>

      <details className="rounded-lg border">
        <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-medium">
          <ListPlus className="h-4 w-4" aria-hidden />
          Create a list
        </summary>
        <div className="border-t px-4 py-4">
          <ActionForm action={createListAction} submitLabel="Create list" pendingLabel="Creating…">
            <Field name="name" label="Name" required maxLength={120} placeholder="Newsletter" />
          </ActionForm>
        </div>
      </details>

      {page.items.length === 0 ? (
        <EmptyState>No lists yet. Create one above.</EmptyState>
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH>Name</TH>
                <TH>Contacts</TH>
                <TH>Created</TH>
                <TH className="text-right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {page.items.map((list) => (
                <TR key={list.id}>
                  <TD className="font-medium">{list.name}</TD>
                  <TD>{list.contact_count}</TD>
                  <TD className="whitespace-nowrap text-[--color-muted-foreground]">
                    {new Date(list.created_at).toLocaleDateString()}
                  </TD>
                  <TD className="text-right">
                    <Link
                      href={`/lists/${list.id}`}
                      className="text-sm underline underline-offset-4"
                    >
                      View members
                    </Link>
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
          />
        </>
      )}
    </div>
  );
}
