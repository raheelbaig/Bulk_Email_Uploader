'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Copies a DNS record value to the clipboard.
 *
 * The value is a prop, not something the component reads from the DOM, so what
 * is copied is exactly what the server rendered. Falls back silently when the
 * Clipboard API is unavailable — the value is selectable text either way.
 */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      // No clipboard permission, or an insecure context. Nothing to report:
      // the user can still select the text.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`Copy ${label}`}
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1 rounded-md border bg-(--color-surface) px-2 text-xs font-medium transition-colors',
        'hover:bg-(--color-muted) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring)',
        copied && 'border-(--color-success-border) text-(--color-success-foreground)',
      )}
    >
      {copied ? (
        <Check className="h-3 w-3" aria-hidden />
      ) : (
        <Copy className="h-3 w-3" aria-hidden />
      )}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
