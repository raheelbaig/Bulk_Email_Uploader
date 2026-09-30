import Link from 'next/link';
import { ChevronRight, FileText, Plus } from 'lucide-react';
import { workspaceForPage } from '@/lib/auth/workspace';
import { listTemplates } from '@/lib/templates/service';
import { MAX_SUBJECT_CHARS, MAX_TEMPLATE_NAME_CHARS, MAX_PREVIEW_TEXT_CHARS } from '@/lib/templates/constants';
import { createTemplateAction } from './actions';
import { ActionForm } from '@/components/action-form';
import { CreatePanel } from '@/components/create-panel';
import { Field } from '@/components/field';
import { PageHeader } from '@/components/page-header';
import { TemplateBodyEditor } from '@/components/template-body-editor';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';

export const dynamic = 'force-dynamic';

/**
 * Templates.
 *
 * The content a person writes here — in Simple mode or as HTML — is sanitised
 * before it is stored, and nothing on this page renders it — the list shows names and metadata only. The preview
 * lives on the detail page, inside a sandboxed frame.
 */
export default async function TemplatesPage() {
  const { workspaceId } = await workspaceForPage();
  const page = await listTemplates(workspaceId, { limit: 50 });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Templates"
        description="Reusable email designs. Write an email once, then pick it for any campaign."
        actions={
          <Link href="#new" className={buttonVariants()}>
            <Plus aria-hidden />
            Create template
          </Link>
        }
      />

      <CreatePanel
        title="Create a template"
        description="Write your email in plain words, or start from a layout. You’ll see a preview after you save it."
      >
        <ActionForm action={createTemplateAction} submitLabel="Create template" pendingLabel="Saving…" size="default">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              name="name"
              label="Template name"
              required
              maxLength={MAX_TEMPLATE_NAME_CHARS}
              placeholder="e.g. Monthly newsletter"
              hint="Only your team sees this."
            />
            <Field
              name="subject"
              label="Subject line"
              required
              maxLength={MAX_SUBJECT_CHARS}
              placeholder="Hello {{first_name}}, here’s this month’s update"
              hint="What recipients see in their inbox."
            />
          </div>
          <Field
            name="previewText"
            label="Preview text"
            maxLength={MAX_PREVIEW_TEXT_CHARS}
            hint="The short line shown after the subject in most inboxes."
          />
          <TemplateBodyEditor showStarters />
        </ActionForm>
      </CreatePanel>

      {page.items.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No email templates yet"
          description="Create a reusable email design so you don’t have to start from scratch every time. You’ll choose a template when you create a campaign."
          action={
            <Link href="#new" className={buttonVariants()}>
              <Plus aria-hidden />
              Create template
            </Link>
          }
        />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Template</TH>
              <TH className="hidden md:table-cell">Personalization</TH>
              <TH className="hidden sm:table-cell">Last saved</TH>
              <TH className="w-10">
                <span className="sr-only">Open</span>
              </TH>
            </TR>
          </THead>
          <TBody>
            {page.items.map((template) => (
              <TR key={template.id} className="group relative">
                <TD className="max-w-[16rem] sm:max-w-md">
                  <Link
                    href={`/templates/${template.id}`}
                    className="flex min-w-0 items-center gap-3 after:absolute after:inset-0 focus-visible:outline-none after:focus-visible:ring-2 after:focus-visible:ring-(--color-ring) after:focus-visible:ring-inset"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-(--color-surface-subtle) text-(--color-muted-foreground)">
                      <FileText className="size-4" aria-hidden />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{template.name}</span>
                      <span className="block truncate text-sm text-(--color-muted-foreground)">
                        {template.subject}
                      </span>
                    </span>
                  </Link>
                </TD>
                <TD className="hidden md:table-cell">
                  {template.variables.length === 0 ? (
                    <span className="text-sm text-(--color-muted-foreground)">None</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {template.variables.slice(0, 3).map((name) => (
                        <Badge key={name}>{name.replace(/_/g, ' ')}</Badge>
                      ))}
                      {template.variables.length > 3 && <Badge>+{template.variables.length - 3}</Badge>}
                    </div>
                  )}
                </TD>
                <TD className="hidden whitespace-nowrap text-(--color-muted-foreground) sm:table-cell">
                  {new Date(template.updated_at ?? template.created_at).toLocaleDateString(undefined, {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })}
                </TD>
                <TD className="text-(--color-muted-foreground)">
                  <ChevronRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}
