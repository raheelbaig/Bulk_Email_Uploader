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
        <Alert tone="destructive" title="This email can’t be used yet">
          <ul className="mt-1 list-disc pl-4">
            {preview.issues.map((issue) => (
              <li key={issue.message}>{issue.message}</li>
            ))}
          </ul>
        </Alert>
      )}

      <div className="overflow-hidden rounded-lg border bg-(--color-surface) shadow-xs">
        <div className="flex items-center gap-1.5 border-b bg-(--color-surface-subtle) px-3 py-2" aria-hidden>
          <span className="size-2.5 rounded-full bg-(--color-border-strong)" />
          <span className="size-2.5 rounded-full bg-(--color-border-strong)" />
          <span className="size-2.5 rounded-full bg-(--color-border-strong)" />
        </div>
        <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-b px-4 py-3 text-sm">
          <dt className="text-(--color-muted-foreground)">From</dt>
          <dd className="truncate">
            {preview.fromEmail === null ? (
              <span className="text-(--color-muted-foreground)">No sender chosen yet</span>
            ) : (
              <>
                {preview.fromName} &lt;{preview.fromEmail}&gt;
              </>
            )}
          </dd>

          {preview.replyTo !== null && (
            <>
              <dt className="text-(--color-muted-foreground)">Reply-to</dt>
              <dd className="truncate">{preview.replyTo}</dd>
            </>
          )}

          <dt className="text-(--color-muted-foreground)">To</dt>
          <dd className="flex min-w-0 items-center gap-2">
            <span className="truncate">{preview.contactEmail}</span>
            {preview.usedSampleContact && <Badge tone="info">Sample contact</Badge>}
          </dd>

          <dt className="text-(--color-muted-foreground)">Subject</dt>
          <dd className="font-semibold break-words">{preview.subject}</dd>

          {preview.previewText !== null && (
            <>
              <dt className="text-(--color-muted-foreground)">Preview</dt>
              <dd className="text-(--color-muted-foreground) break-words">{preview.previewText}</dd>
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
          className="block h-[28rem] w-full bg-white"
        />
      </div>

      {preview.missing.length > 0 && (
        <Alert tone="info">
          This contact has no {preview.missing.map((name) => name.replace(/_/g, ' ')).join(', ')}. People
          missing these details will see a blank where the value would be.
        </Alert>
      )}

      <details className="rounded-lg border bg-(--color-surface)">
        <summary className="cursor-pointer rounded-lg px-4 py-2.5 text-sm font-medium hover:bg-(--color-muted) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring)">
          Plain-text version
        </summary>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap border-t px-4 py-3 text-xs leading-relaxed">
          {preview.text}
        </pre>
      </details>
    </div>
  );
}
