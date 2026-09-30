import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Send } from 'lucide-react';
import { workspaceForPage } from '@/lib/auth/workspace';
import { isAppError } from '@/lib/errors';
import { getTemplate } from '@/lib/templates/service';
import { buildPreview } from '@/lib/templates/preview';
import { renderableFromTemplate } from '@/lib/campaigns/snapshot';
import {
  MAX_PREVIEW_TEXT_CHARS,
  MAX_SUBJECT_CHARS,
  MAX_TEMPLATE_NAME_CHARS,
} from '@/lib/templates/constants';
import { deleteTemplateAction, updateTemplateAction } from '../actions';
import { ActionForm } from '@/components/action-form';
import { Field } from '@/components/field';
import { PageHeader } from '@/components/page-header';
import { SectionCard } from '@/components/section-card';
import { TemplateBodyEditor } from '@/components/template-body-editor';
import { MessagePreview } from '@/components/template-preview';
import { buttonVariants } from '@/components/ui/button';

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
  const { workspaceId } = await workspaceForPage();
  const template = await getTemplate(workspaceId, id).catch((err: unknown) => {
    // Absent, not-yours and malformed are the same answer: not found.
    if (isAppError(err) && (err.code === 'FORBIDDEN' || err.code === 'NOT_FOUND' || err.code === 'VALIDATION_FAILED')) notFound();
    throw err;
  });

  const preview = buildPreview({ template: renderableFromTemplate(template) });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        back={{ href: '/templates', label: 'Templates' }}
        title={template.name}
        description="Edit your email and check how it looks in the preview. Campaigns that are already scheduled keep the email as it was when they were scheduled."
        actions={
          <Link href="/campaigns#new" className={buttonVariants({ variant: 'outline' })}>
            <Send aria-hidden />
            Use in a campaign
          </Link>
        }
      />

      <div className="grid gap-6 xl:grid-cols-2">
        <SectionCard title="Content" description="The subject line, preview text and your email.">
          <ActionForm action={updateTemplateAction} submitLabel="Save changes" pendingLabel="Saving…" size="default">
            <input type="hidden" name="templateId" value={template.id} />
            <Field
              name="name"
              label="Template name"
              required
              defaultValue={template.name}
              maxLength={MAX_TEMPLATE_NAME_CHARS}
              hint="Only your team sees this."
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
              hint="The short line shown after the subject in most inboxes."
            />
            <TemplateBodyEditor defaultHtml={template.html} defaultText={template.text} />
          </ActionForm>
        </SectionCard>

        <div className="flex flex-col gap-6">
          <SectionCard
            title="Preview"
            description="How your email looks, filled in with a sample contact."
          >
            <MessagePreview preview={preview} />
          </SectionCard>

          <SectionCard
            title="Delete template"
            description="Campaigns that already sent or are scheduled keep their own copy of this email."
            className="border-(--color-danger-border)"
          >
            <ActionForm
              action={deleteTemplateAction}
              submitLabel="Delete template"
              pendingLabel="Deleting…"
              variant="destructive"
              confirm={{
                title: `Delete “${template.name}”?`,
                description:
                  'The template is deleted. Campaigns that are scheduled or already sent keep their own copy of the email. A template that a draft campaign uses can’t be deleted — change that campaign first.',
                irreversible: true,
              }}
            >
              <input type="hidden" name="templateId" value={template.id} />
            </ActionForm>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
