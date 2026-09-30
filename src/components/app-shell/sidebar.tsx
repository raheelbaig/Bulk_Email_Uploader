'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Ban,
  FileText,
  Globe,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Mail,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Send,
  Settings,
  Upload,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { SIDEBAR_COOKIE } from './constants';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

interface NavGroup {
  label: string | null;
  items: NavItem[];
}

/** Where the single floating tooltip of the collapsed sidebar should appear. */
interface TipState {
  label: string;
  top: number;
  left: number;
}

type ShowTip = (label: string, target: HTMLElement) => void;

/**
 * Grouped the way people think about the work, not the way the data is stored:
 * who you reach, what you send, and the one-off setup. The dashboard stands on
 * its own, without a heading (`label: null`).
 */
export const NAV_GROUPS: NavGroup[] = [
  { label: null, items: [{ href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard }] },
  {
    label: 'Audience',
    items: [
      { href: '/contacts', label: 'Contacts', icon: Users },
      { href: '/lists', label: 'Lists', icon: ListChecks },
      { href: '/imports', label: 'Imports', icon: Upload },
      { href: '/suppressions', label: 'Unsubscribed & blocked', icon: Ban },
    ],
  },
  {
    label: 'Email',
    items: [
      { href: '/campaigns', label: 'Campaigns', icon: Send },
      { href: '/templates', label: 'Templates', icon: FileText },
    ],
  },
  {
    label: 'Setup',
    items: [
      { href: '/senders', label: 'Senders', icon: Globe },
      { href: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];


function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function initials(email: string | undefined): string {
  if (email === undefined || email.length === 0) return '?';
  const local = email.split('@')[0] ?? email;
  const parts = local.split(/[._-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? `${parts[0]![0]}${parts[1]![0]}` : local.slice(0, 2);
  return letters.toUpperCase();
}

function Brand({ collapsed }: { collapsed: boolean }) {
  return (
    <Link
      href="/dashboard"
      className="flex min-w-0 items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring)"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-(--color-primary) text-(--color-primary-foreground) shadow-xs">
        <Mail className="size-4" aria-hidden />
      </span>
      <span className={cn('truncate text-[0.9375rem] font-semibold tracking-tight', collapsed && 'sr-only')}>
        Email Uploader
      </span>
    </Link>
  );
}

function NavList({
  pathname,
  collapsed,
  onNavigate,
  showTip,
  hideTip,
}: {
  pathname: string;
  collapsed: boolean;
  onNavigate?: () => void;
  showTip?: ShowTip;
  hideTip?: () => void;
}) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-5">
      {NAV_GROUPS.map((group) => (
        <div key={group.label ?? 'top'} className="flex flex-col gap-0.5">
          {group.label !== null && (
            <p
              className={cn(
                'px-2.5 pb-1 text-[0.6875rem] font-semibold tracking-wider text-(--color-muted-foreground) uppercase',
                collapsed && 'sr-only',
              )}
            >
              {group.label}
            </p>
          )}
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <li key={item.href} className="relative">
                  <Link
                    href={item.href}
                    {...(onNavigate !== undefined ? { onClick: onNavigate } : {})}
                    {...tipHandlers(collapsed, item.label, showTip, hideTip)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'relative flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring)',
                      active
                        ? 'bg-(--color-surface) text-(--color-foreground) shadow-xs ring-1 ring-(--color-border)'
                        : 'text-(--color-muted-foreground) hover:bg-(--color-sidebar-accent) hover:text-(--color-foreground)',
                      collapsed && 'justify-center px-0',
                    )}
                  >
                    {active && (
                      <span
                        aria-hidden
                        className="absolute top-1/2 -left-3 h-5 w-1 -translate-y-1/2 rounded-r-full bg-(--color-primary)"
                      />
                    )}
                    <item.icon
                      className={cn('size-4 shrink-0', active && 'text-(--color-primary)')}
                      aria-hidden
                    />
                    <span className={cn('truncate', collapsed && 'sr-only')}>{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/**
 * Hover/focus handlers that show a collapsed-sidebar control's label.
 *
 * The label is drawn by one `position: fixed` element (`FloatingTip`) rather
 * than inside each item, so the collapsed rail can keep `overflow-y-auto` and
 * scroll on short screens without clipping its tooltips. The label is also the
 * control's accessible name (an sr-only span), so the tooltip is decoration.
 */
function tipHandlers(
  collapsed: boolean,
  label: string,
  showTip: ShowTip | undefined,
  hideTip: (() => void) | undefined,
) {
  if (!collapsed || showTip === undefined || hideTip === undefined) return {};
  return {
    onMouseEnter: (event: React.MouseEvent<HTMLElement>) => showTip(label, event.currentTarget),
    onMouseLeave: hideTip,
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      if (event.currentTarget.matches(':focus-visible')) showTip(label, event.currentTarget);
    },
    onBlur: hideTip,
  };
}

function FloatingTip({ tip }: { tip: TipState | null }) {
  if (tip === null) return null;
  return (
    <span
      aria-hidden
      style={{ top: tip.top, left: tip.left }}
      className="pointer-events-none fixed z-50 -translate-y-1/2 rounded-md bg-(--color-foreground) px-2 py-1 text-xs font-medium whitespace-nowrap text-(--color-background) shadow-lg"
    >
      {tip.label}
    </span>
  );
}

function Account({
  email,
  workspaceName,
  collapsed,
  signOutAction,
  showTip,
  hideTip,
}: {
  email: string | undefined;
  workspaceName: string | null;
  collapsed: boolean;
  signOutAction: () => Promise<void>;
  showTip?: ShowTip;
  hideTip?: () => void;
}) {
  return (
    <div className={cn('flex flex-col gap-1 border-t border-(--color-sidebar-border) pt-3', collapsed && 'items-center')}>
      <div className={cn('flex min-w-0 items-center gap-2.5 px-1.5 py-1', collapsed && 'justify-center px-0')}>
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-(--color-primary-subtle) text-xs font-semibold text-(--color-primary-subtle-foreground)"
          aria-hidden
        >
          {initials(email)}
        </span>
        <div className={cn('min-w-0 flex-1', collapsed && 'sr-only')}>
          <p className="truncate text-sm font-medium" title={email}>
            {email ?? 'Signed in'}
          </p>
          {workspaceName !== null && (
            <p className="truncate text-xs text-(--color-muted-foreground)" title={workspaceName}>
              {workspaceName}
            </p>
          )}
        </div>
      </div>
      <form action={signOutAction} className="relative shrink-0">
        <button
          type="submit"
          {...tipHandlers(collapsed, 'Sign out', showTip, hideTip)}
          className={cn(
            'flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-sm font-medium text-(--color-muted-foreground) transition-colors',
            'hover:bg-(--color-sidebar-accent) hover:text-(--color-foreground)',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring)',
            collapsed && 'w-9 justify-center px-0',
          )}
        >
          <LogOut className="size-4 shrink-0" aria-hidden />
          <span className={cn(collapsed && 'sr-only')}>Sign out</span>
        </button>
      </form>
    </div>
  );
}

/**
 * The application's navigation.
 *
 * Desktop (lg and up): a sticky left sidebar that can collapse to icons; the
 * choice is kept in a cookie so the server renders it the same way next time.
 * Below lg: a top bar with a menu button that opens the same navigation in a
 * native <dialog> — which brings focus trapping, Escape to close and inert
 * background for free. It closes on navigation.
 */
export function Sidebar({
  email,
  workspaceName,
  initialCollapsed,
  bannerOffset,
  signOutAction,
}: {
  email: string | undefined;
  workspaceName: string | null;
  initialCollapsed: boolean;
  bannerOffset: boolean;
  signOutAction: () => Promise<void>;
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const drawerRef = useRef<HTMLDialogElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const [tip, setTip] = useState<TipState | null>(null);
  const showTip = useCallback<ShowTip>((label, target) => {
    const rect = target.getBoundingClientRect();
    setTip({ label, top: rect.top + rect.height / 2, left: rect.right + 12 });
  }, []);
  const hideTip = useCallback(() => setTip(null), []);

  const toggleCollapsed = () => {
    setTip(null);
    setCollapsed((value) => {
      const next = !value;
      try {
        document.cookie = `${SIDEBAR_COOKIE}=${next ? '1' : '0'}; path=/; max-age=31536000; samesite=lax`;
      } catch {
        // Cookies unavailable: the choice lasts for this page only.
      }
      return next;
    });
  };

  const closeDrawer = useCallback(() => {
    const dialog = drawerRef.current;
    if (dialog?.open === true) dialog.close();
  }, []);

  // Close the drawer whenever the route changes (including back/forward).
  useEffect(() => {
    closeDrawer();
  }, [pathname, closeDrawer]);

  // If the window grows past the breakpoint with the drawer open, close it.
  useEffect(() => {
    const query = window.matchMedia('(min-width: 1024px)');
    const onChange = () => {
      if (query.matches) closeDrawer();
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [closeDrawer]);

  const stickyTop = bannerOffset ? 'top-8' : 'top-0';
  const fullHeight = bannerOffset ? 'h-[calc(100dvh-2rem)]' : 'h-dvh';

  return (
    <>
      {/* Mobile and tablet top bar */}
      <div
        className={cn(
          'sticky z-40 flex h-14 items-center gap-3 border-b bg-(--color-surface)/95 px-4 backdrop-blur lg:hidden',
          stickyTop,
        )}
      >
        <button
          ref={menuButtonRef}
          type="button"
          onClick={() => drawerRef.current?.showModal()}
          aria-label="Open navigation"
          aria-haspopup="dialog"
          className="-ml-1.5 flex size-9 items-center justify-center rounded-md text-(--color-foreground) hover:bg-(--color-muted) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring)"
        >
          <Menu className="size-5" aria-hidden />
        </button>
        <Brand collapsed={false} />
      </div>

      <dialog
        ref={drawerRef}
        aria-label="Navigation"
        className="nav-drawer m-0 h-dvh max-h-dvh w-[18rem] max-w-[85vw] border-r bg-(--color-sidebar) p-0 text-(--color-foreground) shadow-lg"
        onClick={(event) => {
          // A click on the backdrop lands on the dialog element itself.
          if (event.target === event.currentTarget) closeDrawer();
        }}
        onClose={() => menuButtonRef.current?.focus()}
      >
        <div className="flex h-full flex-col gap-6 overflow-y-auto px-3 py-4">
          <div className="flex items-center justify-between gap-2 px-1">
            <Brand collapsed={false} />
            <button
              type="button"
              onClick={closeDrawer}
              aria-label="Close navigation"
              className="flex size-9 items-center justify-center rounded-md text-(--color-muted-foreground) hover:bg-(--color-sidebar-accent) hover:text-(--color-foreground) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring)"
            >
              <X className="size-5" aria-hidden />
            </button>
          </div>
          <div className="flex-1">
            <NavList pathname={pathname} collapsed={false} onNavigate={closeDrawer} />
          </div>
          <Account email={email} workspaceName={workspaceName} collapsed={false} signOutAction={signOutAction} />
        </div>
      </dialog>

      {/* Desktop sidebar */}
      <aside
        className={cn(
          'sticky hidden shrink-0 flex-col border-r border-(--color-sidebar-border) bg-(--color-sidebar) transition-[width] duration-200 lg:flex',
          stickyTop,
          fullHeight,
          collapsed ? 'w-17' : 'w-64',
        )}
      >
        <div className={cn('flex h-16 shrink-0 items-center px-4', collapsed && 'justify-center px-0')}>
          <Brand collapsed={collapsed} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2" onScroll={hideTip}>
          <NavList pathname={pathname} collapsed={collapsed} showTip={showTip} hideTip={hideTip} />
        </div>
        <div className="flex flex-col gap-1 px-3 pb-3">
          <div className="relative">
            <button
              type="button"
              onClick={toggleCollapsed}
              {...tipHandlers(collapsed, 'Expand sidebar', showTip, hideTip)}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-expanded={!collapsed}
              className={cn(
                'flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-sm text-(--color-muted-foreground) transition-colors',
                'hover:bg-(--color-sidebar-accent) hover:text-(--color-foreground)',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring)',
                collapsed && 'justify-center px-0',
              )}
            >
              {collapsed ? (
                <PanelLeftOpen className="size-4 shrink-0" aria-hidden />
              ) : (
                <PanelLeftClose className="size-4 shrink-0" aria-hidden />
              )}
              <span className={cn(collapsed && 'sr-only')}>Collapse</span>
            </button>
          </div>
          <Account
            email={email}
            workspaceName={workspaceName}
            collapsed={collapsed}
            signOutAction={signOutAction}
            showTip={showTip}
            hideTip={hideTip}
          />
        </div>
        <FloatingTip tip={collapsed ? tip : null} />
      </aside>
    </>
  );
}
