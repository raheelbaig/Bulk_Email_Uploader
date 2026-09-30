'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

/**
 * An inline "create" form that opens from the page's primary action.
 *
 * The trigger is a plain link to `#<id>`, so the same
 * panel opens from the page header, from an empty state, or from another page
 * (`/lists#new` on the dashboard). It renders closed (unless `defaultOpen`) so
 * the page does not flash a form on load, and opens when the URL hash names it.
 */
export function CreatePanel({
  id = 'new',
  title,
  description,
  defaultOpen = false,
  children,
}: {
  id?: string;
  title: string;
  description?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const ref = useRef<HTMLElement>(null);

  const focusFirst = useCallback(() => {
    requestAnimationFrame(() => {
      ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      ref.current?.querySelector<HTMLElement>('input:not([type=hidden]), textarea, select')?.focus({
        preventScroll: true,
      });
    });
  }, []);

  useEffect(() => {
    if (window.location.hash === `#${id}`) {
      setOpen(true);
      focusFirst();
    }

    const onHash = () => {
      if (window.location.hash === `#${id}`) {
        setOpen(true);
        focusFirst();
      }
    };
    // Same-page links to the current hash do not fire hashchange, so listen for
    // clicks on triggers as well.
    const onClick = (event: MouseEvent) => {
      const link = (event.target as HTMLElement | null)?.closest?.(`a[href$="#${id}"]`);
      if (link !== null && link !== undefined) {
        setOpen(true);
        focusFirst();
      }
    };
    window.addEventListener('hashchange', onHash);
    document.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('hashchange', onHash);
      document.removeEventListener('click', onClick);
    };
  }, [id, focusFirst]);

  const close = () => {
    setOpen(false);
    if (window.location.hash === `#${id}`) {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  };

  return (
    <section
      ref={ref}
      id={id}
      aria-labelledby={`${id}-title`}
      hidden={!open}
      className="scroll-mt-24 rounded-xl border border-(--color-primary)/25 bg-(--color-card) shadow-sm ring-4 ring-(--color-primary-subtle)"
    >
      <div className="flex items-start justify-between gap-3 px-5 pt-5 sm:px-6">
        <div className="min-w-0">
          <h2 id={`${id}-title`} className="text-base font-semibold tracking-tight">
            {title}
          </h2>
          {description !== undefined && (
            <p className="mt-0.5 text-sm leading-relaxed text-(--color-muted-foreground)">{description}</p>
          )}
        </div>
        <button
          type="button"
          onClick={close}
          aria-label={`Close: ${title}`}
          className="-mt-1 -mr-2 flex size-8 shrink-0 items-center justify-center rounded-md text-(--color-muted-foreground) hover:bg-(--color-muted) hover:text-(--color-foreground) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring)"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <div className="px-5 pt-4 pb-5 sm:px-6 sm:pb-6">{children}</div>
    </section>
  );
}
