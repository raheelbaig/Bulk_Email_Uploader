import Link from 'next/link';
import {
  ArrowRight,
  CheckCircle2,
  Clock,
  FileText,
  ListChecks,
  MailWarning,
  Plus,
  Send,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { workspaceForPage } from '@/lib/auth/workspace';
import { sendingConfig } from '@/lib/sending/config';
import { LIVE_REQUIREMENT_MESSAGE, SENDING_MODE_NOTICE } from '@/lib/sending/gate';
import { formatInZone } from '@/lib/campaigns/schedule';
import { loadDashboard } from './load';
import { PageHeader } from '@/components/page-header';
import { SectionCard } from '@/components/section-card';
import { StatCard } from '@/components/stat-card';
import { SendHealthCard } from '@/components/send-health-card';
import { Checklist, ProgressSummary, type ChecklistItem } from '@/components/checklist';
import { CampaignStatusBadge } from '@/components/status-badge';
import { activityLabel, relativeTime } from '@/components/activity-labels';
import { SENDING_MODE_EXPLANATION, SENDING_MODE_HEADLINE } from '@/components/sending-copy';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

function greeting(timeZone: string): string {
  let hour = new Date().getUTCHours();
  try {
    hour = Number(
      new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(new Date()),
    );
  } catch {
    // Unknown zone: fall back to UTC.
  }
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/**
 * The dashboard answers, in order: what this is for, what's done, what to do
 * next, and whether an email can be sent — and if not, exactly why.
 *
 * Setup and "can I send?" are one card, because they are one question: the
 * checklist lists what the workspace still needs, and the headline above it
 * says what that means for sending. Sender setup comes first because domain
 * verification waits on DNS, which can take hours.
 */
export default async function DashboardPage() {
  const access = await workspaceForPage();
  const sending = sendingConfig();
  const data = await loadDashboard(access.workspaceId);
  const { counts } = data;
  const isAdmin = access.role === 'owner' || access.role === 'admin';

  const hasSender = (data.senders?.ready ?? 0) > 0;
  const hasAddress = data.postalAddressSet === true;

  const senderDescription =
    (counts.domains ?? 0) === 0
      ? 'Add and verify the domain your emails will come from, like yourcompany.com. Verification can take a few hours, so start with this.'
      : (data.senders?.total ?? 0) === 0
        ? 'Your domain is added. Now add the address your emails will be sent from.'
        : 'Your sender address is waiting for its domain to finish verifying. Check its DNS records on the Senders page.';

  const setup: ChecklistItem[] = [
    {
      key: 'sender',
      done: hasSender,
      title: 'Set up a sender',
      description: senderDescription,
      doneLabel: 'A verified sender address is ready',
      action: {
        href: (counts.domains ?? 0) > 0 ? ((data.senders?.total ?? 0) === 0 ? '/senders/identities' : '/senders') : '/senders#new',
        label:
          (counts.domains ?? 0) === 0
            ? 'Add domain'
            : (data.senders?.total ?? 0) === 0
              ? 'Add sender address'
              : 'Check verification',
      },
    },
    {
      key: 'address',
      done: hasAddress,
      title: 'Add your business address',
      description: 'It appears in the footer of your emails — required before sending marketing email.',
      doneLabel: 'Business address added',
      action: { href: '/settings#business-address', label: 'Add address' },
    },
    {
      key: 'contacts',
      done: (counts.contacts ?? 0) > 0,
      title: 'Add your contacts',
      description: 'Import a spreadsheet of the people you want to reach.',
      doneLabel: `${(counts.contacts ?? 0).toLocaleString()} contacts in your workspace`,
      action: { href: '/imports', label: 'Import contacts' },
    },
    {
      key: 'lists',
      done: (counts.lists ?? 0) > 0,
      title: 'Create a list',
      description: 'Group contacts into an audience you can send a campaign to.',
      doneLabel: `${(counts.lists ?? 0).toLocaleString()} ${counts.lists === 1 ? 'list' : 'lists'} created`,
      action: { href: '/lists#new', label: 'Create list' },
    },
    {
      key: 'templates',
      done: (counts.templates ?? 0) > 0,
      title: 'Write an email',
      description: 'Create a template with the email you want to send. You can reuse it across campaigns.',
      doneLabel: `${(counts.templates ?? 0).toLocaleString()} ${counts.templates === 1 ? 'template' : 'templates'} ready`,
      action: { href: '/templates#new', label: 'Create template' },
    },
    {
      key: 'campaign',
      done: (counts.campaigns ?? 0) > 0,
      title: 'Create your first campaign',
      description: 'Choose who receives it, which email to send, who it comes from, and when.',
      doneLabel: `${(counts.campaigns ?? 0).toLocaleString()} ${counts.campaigns === 1 ? 'campaign' : 'campaigns'} created`,
      action: { href: '/campaigns#new', label: 'Create campaign' },
    },
  ];
  const setupDone = setup.filter((item) => item.done).length;
  const setupComplete = setupDone === setup.length;
  const nextStep = setup.find((item) => !item.done);

  // "Can I send an email?" — the workspace's own requirements first, then the
  // installation's sending setting.
  const workspaceReady = hasSender && hasAddress;
  const liveBlocked = sending.mode === 'live' && !sending.live.allowed;
  const canSend = workspaceReady && sending.mode === 'live' && sending.live.allowed;

  let sendTitle: string;
  let sendBody: string;
  if (!workspaceReady) {
    const needs = [!hasSender && 'a verified sender', !hasAddress && 'your business address'].filter(Boolean);
    sendTitle = 'Not yet';
    sendBody = `Before any campaign can be sent, add ${needs.join(' and ')}. The steps are below.`;
  } else if (liveBlocked) {
    sendTitle = 'Almost — email delivery isn’t switched on yet';
    sendBody = isAdmin
      ? 'Your workspace is ready. The last step is switching on email delivery in this installation’s server settings, which isn’t done in the app. Technical details below list exactly what’s missing.'
      : 'Your workspace is ready. Email delivery still needs to be switched on for this installation — ask your workspace owner.';
  } else if (sending.mode === 'live') {
    sendTitle = 'Yes — you’re ready to send';
    sendBody = SENDING_MODE_EXPLANATION.live;
  } else {
    sendTitle = `Not yet — ${SENDING_MODE_HEADLINE[sending.mode].charAt(0).toLowerCase()}${SENDING_MODE_HEADLINE[sending.mode].slice(1)}`;
    sendBody = `Your workspace is ready. ${SENDING_MODE_EXPLANATION[sending.mode]}`;
  }

  const title = greeting(data.timeZone);
  const subtitle = setupComplete
    ? `Here’s what’s happening in ${data.workspaceName ?? 'your workspace'}.`
    : 'Send email campaigns to your contacts: import the people you want to reach, write an email, and schedule it. Here’s what to do next.';

  const stats = [
    { label: 'Contacts', value: counts.contacts, hint: 'People in your audience', icon: Users, href: '/contacts' },
    { label: 'Lists', value: counts.lists, hint: 'Audiences you can send to', icon: ListChecks, href: '/lists' },
    { label: 'Templates', value: counts.templates, hint: 'Reusable emails', icon: FileText, href: '/templates' },
    { label: 'Campaigns', value: counts.campaigns, hint: 'Drafts, scheduled and sent', icon: Send, href: '/campaigns' },
  ].filter((stat) => (stat.value ?? 0) > 0);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={title}
        description={subtitle}
        actions={
          nextStep !== undefined && nextStep.action !== undefined ? (
            <Link href={nextStep.action.href} className={buttonVariants()}>
              {nextStep.action.label}
              <ArrowRight aria-hidden />
            </Link>
          ) : (
            <Link href="/campaigns#new" className={buttonVariants()}>
              <Plus aria-hidden />
              Create campaign
            </Link>
          )
        }
      />

      {/* Can I send an email? + what's left to do */}
      <section
        aria-labelledby="send-status-title"
        className={cn(
          'overflow-hidden rounded-xl border bg-(--color-card) shadow-xs',
          canSend ? 'border-(--color-success-border)' : !workspaceReady && 'border-(--color-warning-border)',
        )}
      >
        <div
          className={cn(
            'flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:p-6',
            canSend
              ? 'bg-(--color-success-subtle)'
              : !workspaceReady
                ? 'bg-(--color-warning-subtle)'
                : 'bg-(--color-surface-subtle)',
          )}
        >
          <div
            className={cn(
              'flex size-10 shrink-0 items-center justify-center rounded-lg border bg-(--color-surface)',
              canSend
                ? 'text-(--color-success)'
                : !workspaceReady
                  ? 'text-(--color-warning-foreground)'
                  : 'text-(--color-muted-foreground)',
            )}
          >
            {canSend ? (
              <CheckCircle2 className="size-5" aria-hidden />
            ) : !workspaceReady ? (
              <MailWarning className="size-5" aria-hidden />
            ) : (
              <ShieldCheck className="size-5" aria-hidden />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold tracking-wider text-(--color-muted-foreground) uppercase">
              Can I send an email?
            </p>
            <h2 id="send-status-title" className="mt-1 text-lg font-semibold tracking-tight">
              {sendTitle}
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-(--color-foreground)/80">{sendBody}</p>
            {isAdmin && workspaceReady && !canSend && (
              <details className="group mt-3 text-sm">
                <summary className="w-fit cursor-pointer rounded text-(--color-muted-foreground) underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring)">
                  Technical details
                </summary>
                <div className="mt-2 flex max-w-2xl flex-col gap-1.5 rounded-lg border bg-(--color-surface) p-3 break-words text-(--color-muted-foreground)">
                  <p>{SENDING_MODE_NOTICE[sending.mode]}</p>
                  {liveBlocked && (
                    <ul className="list-disc pl-5">
                      {sending.live.unmet.map((requirement) => (
                        <li key={requirement}>{LIVE_REQUIREMENT_MESSAGE[requirement]}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </details>
            )}
          </div>
          {!setupComplete && (
            <div className="w-full sm:w-52 sm:shrink-0">
              <ProgressSummary done={setupDone} total={setup.length} label="Setup" />
            </div>
          )}
        </div>
        {!setupComplete && (
          <div className="border-t">
            <Checklist items={setup} />
          </div>
        )}
      </section>

      <SendHealthCard health={data.health} />

      {stats.length > 0 && (
        <section aria-labelledby="overview-title" className="flex flex-col gap-4">
          <h2 id="overview-title" className="text-base font-semibold tracking-tight">
            Overview
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            {stats.map((stat) => (
              <StatCard
                key={stat.label}
                label={stat.label}
                value={stat.value}
                hint={stat.hint}
                icon={stat.icon}
                href={stat.href}
              />
            ))}
          </div>
        </section>
      )}

      {(data.recentCampaigns.length > 0 || data.recentActivity.length > 0) && (
        <div className="grid gap-6 lg:grid-cols-5">
          {data.recentCampaigns.length > 0 && (
            <SectionCard
              title="Recent campaigns"
              description="Your latest campaigns and where they are."
              className="lg:col-span-3"
              bodyClassName="px-0 pb-0 sm:px-0 sm:pb-0"
              actions={
                <Link href="/campaigns" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
                  View all
                  <ArrowRight aria-hidden />
                </Link>
              }
            >
              <ul className="divide-y border-t">
                {data.recentCampaigns.map((campaign) => (
                  <li key={campaign.id}>
                    <Link
                      href={`/campaigns/${campaign.id}`}
                      className="flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-(--color-surface-subtle) focus-visible:bg-(--color-surface-subtle) focus-visible:outline-none sm:px-6"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{campaign.name}</p>
                        <p className="mt-0.5 flex items-center gap-1 text-xs text-(--color-muted-foreground)">
                          <Clock className="size-3" aria-hidden />
                          {campaign.scheduled_at === null
                            ? `Created ${formatInZone(campaign.created_at, data.timeZone)}`
                            : `Scheduled for ${formatInZone(campaign.scheduled_at, data.timeZone)}`}
                        </p>
                      </div>
                      <CampaignStatusBadge status={campaign.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            </SectionCard>
          )}

          <SectionCard
            title="Recent activity"
            description="What’s happened in your workspace lately."
            className={data.recentCampaigns.length > 0 ? 'lg:col-span-2' : 'lg:col-span-5'}
          >
            {data.recentActivity.length === 0 ? (
              <p className="text-sm text-(--color-muted-foreground)">
                Nothing yet. Activity such as imports, new lists and scheduled campaigns will appear here.
              </p>
            ) : (
              <ol className="relative flex flex-col gap-4 border-l pl-5">
                {data.recentActivity.map((row, i) => (
                  <li key={i} className="relative">
                    <span
                      aria-hidden
                      className="absolute top-1.5 left-[-1.4rem] size-2 rounded-full border-2 border-(--color-card) bg-(--color-border-strong) ring-1 ring-(--color-border-strong)"
                    />
                    <p className="text-sm font-medium">{activityLabel(row.action)}</p>
                    <time
                      dateTime={row.created_at}
                      title={new Date(row.created_at).toLocaleString()}
                      className="text-xs text-(--color-muted-foreground)"
                    >
                      {relativeTime(row.created_at)}
                    </time>
                  </li>
                ))}
              </ol>
            )}
          </SectionCard>
        </div>
      )}
    </div>
  );
}
