import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { PREVIEW_SANDBOX, type TemplatePreview } from '@/lib/templates/preview';

/**
 * The message preview.
 *
 * The body is rendered into an iframe with `sandbox=""` — the empty value, which
 * enables every restriction: no scripts, no forms, no navigation, no popups, and
 * an opaque origin that shares nothing with this application. The document
 * arrives through `srcDoc`, so nothing is fetched, and it carries its own
 * `Content-Security-Policy` denying everything except images and inline styles.
 *
 * The content was already sanitised twice before it reached here — once when the
 * template was saved, once after personalization substituted values into it. The
 * sandbox is the layer that holds even if both of those fail. See
 * `lib/templates/preview.ts` for the reasoning in full.
 *
 * A Server Component: it renders a string into an attribute and needs no client
 * JavaScript at all.
 */
export function MessagePreview({ preview }: { preview: TemplatePreview }) {
  return (
    <div className="flex flex-col gap-3">
      {preview.issues.length > 0 && (
        <Alert tone="destructive">
          <p className="font-medium">This template cannot be used yet.</p>
          <ul className="mt-1 list-disc pl-4">
            {preview.issues.map((issue) => (
              <li key={issue.message}>{issue.message}</li>
            ))}
          </ul>
        </Alert>
      )}

      <div className="rounded-lg border">
        <dl className="grid gap-x-4 gap-y-1 border-b px-4 py-3 text-sm sm:grid-cols-[7rem_1fr]">
          <dt className="text-[--color-muted-foreground]">From</dt>
          <dd className="truncate">
            {preview.fromEmail === null ? (
              <span className="text-[--color-muted-foreground]">No sender selected</span>
            ) : (
              <>
                {preview.fromName} &lt;{preview.fromEmail}&gt;
              </>
            )}
          </dd>

          {preview.replyTo !== null && (
            <>
              <dt className="text-[--color-muted-foreground]">Reply-to</dt>
              <dd className="truncate">{preview.replyTo}</dd>
            </>
          )}

          <dt className="text-[--color-muted-foreground]">To</dt>
          <dd className="flex items-center gap-2 truncate">
            {preview.contactEmail}
            {preview.usedSampleContact && <Badge>sample</Badge>}
          </dd>

          <dt className="text-[--color-muted-foreground]">Subject</dt>
          <dd className="font-medium">{preview.subject}</dd>

          {preview.previewText !== null && (
            <>
              <dt className="text-[--color-muted-foreground]">Preview text</dt>
              <dd className="text-[--color-muted-foreground]">{preview.previewText}</dd>
            </>
          )}
        </dl>

        <iframe
          // Every restriction on. Do not add `allow-scripts`: it would give
          // author-supplied markup a JavaScript context, and combined with
          // `allow-same-origin` it would give it this application's origin.
          sandbox={PREVIEW_SANDBOX}
          srcDoc={preview.document}
          title="Message preview"
          referrerPolicy="no-referrer"
          className="h-[28rem] w-full rounded-b-lg bg-white"
        />
      </div>

      {preview.missing.length > 0 && (
        <p className="text-xs text-[--color-muted-foreground]">
          Empty for this contact: {preview.missing.join(', ')}. Recipients missing these fields will
          see a gap where the value would be.
        </p>
      )}

      <details className="rounded-lg border">
        <summary className="cursor-pointer px-4 py-2 text-sm font-medium">
          Plain-text version
        </summary>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap border-t px-4 py-3 text-xs">
          {preview.text}
        </pre>
      </details>
    </div>
  );
}
