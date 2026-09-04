import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { currentWorkspace } from '@/lib/auth/workspace';
import { getTemplate } from '@/lib/templates/service';
import { buildPreview } from '@/lib/templates/preview';
import { renderableFromTemplate } from '@/lib/campaigns/snapshot';
import {
  MAX_PREVIEW_TEXT_CHARS,
  MAX_SUBJECT_CHARS,
  MAX_TEMPLATE_NAME_CHARS,
} from '@/lib/templates/constants';
import { STANDARD_VARIABLES } from '@/lib/templates/variables';
import { deleteTemplateAction, updateTemplateAction } from '../actions';
import { ActionForm } from '@/components/action-form';
import { Field } from '@/components/field';
import { MessagePreview } from '@/components/template-preview';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

export const dynamic = 'force-dynamic';

/**
 * Template editor and preview.
 *
 * The preview is rendered against the sample contact, inside a sandboxed iframe.
 * The stored HTML is already sanitised; the sandbox is what holds if that is
 * ever wrong. See `components/template-preview.tsx`.
 */
export default async function TemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { workspaceId } = await currentWorkspace();
  const template = await getTemplate(workspaceId, id);

  const preview = buildPreview({ template: renderableFromTemplate(template) });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link
            href="/templates"
            className="flex items-center gap-1 text-sm text-[--color-muted-foreground]"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            Templates
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{template.name}</h1>
          <p className="text-sm text-[--color-muted-foreground]">
            Version {template.version}
            {template.variables.length > 0 && ` · uses ${template.variables.join(', ')}`}
          </p>
        </div>
        <form action={deleteTemplateAction}>
          <input type="hidden" name="templateId" value={template.id} />
          <Button type="submit" variant="destructive" size="sm">
            Delete
          </Button>
        </form>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">Content</h2>
          <ActionForm action={updateTemplateAction} submitLabel="Save changes" pendingLabel="Saving…">
            <input type="hidden" name="templateId" value={template.id} />
            <Field
              name="name"
              label="Template name"
              required
              defaultValue={template.name}
              maxLength={MAX_TEMPLATE_NAME_CHARS}
            />
            <Field
              name="subject"
              label="Subject line"
              required
              defaultValue={template.subject}
              maxLength={MAX_SUBJECT_CHARS}
            />
            <Field
              name="previewText"
              label="Preview text"
              defaultValue={template.preview_text ?? ''}
              maxLength={MAX_PREVIEW_TEXT_CHARS}
            />
            <div className="flex flex-col gap-1.5">
              <label htmlFor="html" className="text-sm font-medium">
                HTML body
              </label>
              <Textarea id="html" name="html" required rows={16} defaultValue={template.html} />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="text" className="text-sm font-medium">
                Plain-text version
              </label>
              <Textarea id="text" name="text" rows={8} defaultValue={template.text} />
              <p className="text-xs text-[--color-muted-foreground]">
                Clear this box and save to regenerate it from the HTML.
              </p>
            </div>
          </ActionForm>

          <div className="rounded-lg border px-4 py-3">
            <p className="text-sm font-medium">Available fields</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {STANDARD_VARIABLES.map((name) => (
                <Badge key={name}>{`{{${name}}}`}</Badge>
              ))}
              <Badge>{'{{custom.field}}'}</Badge>
            </div>
            <p className="mt-2 text-xs text-[--color-muted-foreground]">
              Anything else is rejected when the template is saved. Templates substitute field
              names only — they cannot contain logic or expressions.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">Preview</h2>
          <MessagePreview preview={preview} />
        </div>
      </div>
    </div>
  );
}
