import Link from 'next/link';
import { FileText, Plus } from 'lucide-react';
import { currentWorkspace } from '@/lib/auth/workspace';
import { listTemplates } from '@/lib/templates/service';
import { STANDARD_VARIABLES } from '@/lib/templates/variables';
import { MAX_SUBJECT_CHARS, MAX_TEMPLATE_NAME_CHARS, MAX_PREVIEW_TEXT_CHARS } from '@/lib/templates/constants';
import { createTemplateAction } from './actions';
import { ActionForm } from '@/components/action-form';
import { Field } from '@/components/field';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState, Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';

export const dynamic = 'force-dynamic';

/**
 * Templates.
 *
 * The HTML a person writes here is sanitised before it is stored, and nothing on
 * this page renders it — the list shows names and metadata only. The preview
 * lives on the detail page, inside a sandboxed frame.
 */
export default async function TemplatesPage() {
  const { workspaceId } = await currentWorkspace();
  const page = await listTemplates(workspaceId, { limit: 50 });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Templates</h1>
        <p className="text-sm text-[--color-muted-foreground]">
          Reusable message content. Personalization uses whitelisted fields only —{' '}
          {STANDARD_VARIABLES.map((name) => `{{${name}}}`).join(', ')}, and{' '}
          <code>{'{{custom.field}}'}</code> for imported columns.
        </p>
      </div>

      <details className="rounded-lg border" open={page.items.length === 0}>
        <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-medium">
          <Plus className="h-4 w-4" aria-hidden />
          New template
        </summary>
        <div className="border-t px-4 py-4">
          <ActionForm action={createTemplateAction} submitLabel="Create template" pendingLabel="Saving…">
            <Field
              name="name"
              label="Template name"
              required
              maxLength={MAX_TEMPLATE_NAME_CHARS}
              placeholder="Monthly newsletter"
            />
            <Field
              name="subject"
              label="Subject line"
              required
              maxLength={MAX_SUBJECT_CHARS}
              placeholder="Hello {{first_name}}, here is this month's update"
            />
            <Field
              name="previewText"
              label="Preview text"
              maxLength={MAX_PREVIEW_TEXT_CHARS}
              hint="Shown beside the subject in the inbox list."
            />
            <div className="flex flex-col gap-1.5">
              <label htmlFor="html" className="text-sm font-medium">
                HTML body
              </label>
              <Textarea
                id="html"
                name="html"
                required
                rows={12}
                placeholder={'<p>Hello {{first_name}},</p>\n<p>…</p>'}
              />
              <p className="text-xs text-[--color-muted-foreground]">
                Scripts, embedded frames, event handlers and unsafe links are removed on save.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="text" className="text-sm font-medium">
                Plain-text version
                <span className="ml-1 text-xs text-[--color-muted-foreground]">optional</span>
              </label>
              <Textarea id="text" name="text" rows={5} />
              <p className="text-xs text-[--color-muted-foreground]">
                Leave blank to generate it from the HTML. Every message needs one.
              </p>
            </div>
          </ActionForm>
        </div>
      </details>

      {page.items.length === 0 ? (
        <EmptyState>No templates yet. Create one to start building a campaign.</EmptyState>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Name</TH>
              <TH>Subject</TH>
              <TH>Fields</TH>
              <TH>Version</TH>
            </TR>
          </THead>
          <TBody>
            {page.items.map((template) => (
              <TR key={template.id}>
                <TD>
                  <Link
                    href={`/templates/${template.id}`}
                    className="flex items-center gap-2 underline underline-offset-4"
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    {template.name}
                  </Link>
                </TD>
                <TD className="max-w-xs truncate text-[--color-muted-foreground]">
                  {template.subject}
                </TD>
                <TD>
                  {template.variables.length === 0 ? (
                    <span className="text-xs text-[--color-muted-foreground]">none</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {template.variables.map((name) => (
                        <Badge key={name}>{name}</Badge>
                      ))}
                    </div>
                  )}
                </TD>
                <TD className="text-[--color-muted-foreground]">v{template.version}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}
