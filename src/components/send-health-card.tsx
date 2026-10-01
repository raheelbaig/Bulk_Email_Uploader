import { Alert } from '@/components/ui/alert';
import { SectionCard } from '@/components/section-card';
import {
  BOUNCE_PAUSE_RATE,
  COMPLAINT_PAUSE_RATE,
  HEALTH_MIN_SAMPLE,
  describeHealth,
  formatRate,
  type SendHealth,
} from '@/lib/sending/health';

/**
 * Bounce and spam-complaint rates over the workspace's recent live mail, next
 * to the thresholds at which sending pauses itself. Renders nothing until a
 * live message has reached Amazon SES — dry runs never count.
 */
export function SendHealthCard({ health }: { health: SendHealth | null }) {
  if (health === null) return null;
  const view = describeHealth(health);
  if (view.state === 'no_data') return null;

  const figures = [
    {
      label: 'Bounced',
      value: formatRate(view.bounceRate),
      detail: `${health.bounced.toLocaleString()} of ${health.sample.toLocaleString()} · pauses at ${formatRate(BOUNCE_PAUSE_RATE)}`,
      over: view.bounceOver,
    },
    {
      label: 'Marked as spam',
      value: formatRate(view.complaintRate),
      detail: `${health.complained.toLocaleString()} of ${health.sample.toLocaleString()} · pauses at ${formatRate(COMPLAINT_PAUSE_RATE)}`,
      over: view.complaintOver,
    },
  ];

  return (
    <SectionCard
      title="Sending health"
      description={`Based on your last ${health.sample.toLocaleString()} live ${health.sample === 1 ? 'message' : 'messages'}. Amazon SES reviews accounts whose rates run high.`}
    >
      <div className="flex flex-col gap-4">
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {figures.map((figure) => (
            <div
              key={figure.label}
              className={
                figure.over
                  ? 'rounded-lg border border-(--color-warning-border) bg-(--color-warning-subtle) px-3 py-2.5'
                  : 'rounded-lg border px-3 py-2.5'
              }
            >
              <dt className="text-xs text-(--color-muted-foreground)">{figure.label}</dt>
              <dd className="mt-0.5 text-lg font-semibold tabular-nums">{figure.value}</dd>
              <dd className="text-xs text-(--color-muted-foreground)">{figure.detail}</dd>
            </div>
          ))}
        </dl>
        {view.state === 'too_few' && (
          <p className="text-sm text-(--color-muted-foreground)">
            Automatic pausing starts after {HEALTH_MIN_SAMPLE} messages; until then a few bounces are not a reliable rate.
          </p>
        )}
        {view.state === 'over_threshold' && (
          <Alert tone="warning">
            These rates are above the level where sending pauses itself. Campaigns that were sending have been paused.
            Bounced and complaining addresses are already blocked; review where the list came from before resuming.
          </Alert>
        )}
      </div>
    </SectionCard>
  );
}
