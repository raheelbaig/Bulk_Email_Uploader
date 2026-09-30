import { serverEnv } from '@/lib/env';
import { APP_ENVIRONMENT_LABEL } from '@/lib/environment';
import { SENDING_MODE_LABEL } from '@/lib/sending/gate';
import { SENDING_MODE_SHORT } from '@/components/sending-copy';

/**
 * A strip across every page of a non-production deployment, so a development
 * checkout is never mistaken for production (and the reverse is conspicuous by
 * its absence).
 *
 * It names the environment and the sending mode only. It does not claim the data
 * is not production data: which database a deployment points at is not known
 * here, and a development build may run against the one real project.
 * Server component: it reads the server environment, which the browser never sees.
 *
 * Styled as a system status indicator rather than an error: it is always on in
 * development, so it must stay legible without shouting. It is sticky so it can
 * never scroll out of view.
 */
export function EnvironmentBanner() {
  const env = serverEnv();
  if (env.APP_ENVIRONMENT === 'production') return null;

  return (
    <div
      role="status"
      aria-label={`${APP_ENVIRONMENT_LABEL[env.APP_ENVIRONMENT]} environment, ${SENDING_MODE_LABEL[env.EMAIL_SENDING_MODE]}`}
      className="sticky top-0 z-50 flex h-8 items-center justify-center gap-2 border-b border-amber-500/40 bg-amber-100 px-4 text-xs font-medium text-amber-950 dark:bg-amber-950 dark:text-amber-100"
    >
      <span className="size-1.5 shrink-0 rounded-full bg-amber-600 dark:bg-amber-400" aria-hidden />
      <span className="truncate">
        <span className="font-semibold tracking-wide uppercase">
          {APP_ENVIRONMENT_LABEL[env.APP_ENVIRONMENT]} environment
        </span>
        <span className="mx-2 opacity-50" aria-hidden>
          •
        </span>
        {SENDING_MODE_SHORT[env.EMAIL_SENDING_MODE]}
      </span>
    </div>
  );
}

/** Height of the banner when it renders, so sticky chrome below it can offset. */
export function environmentBannerVisible(): boolean {
  return serverEnv().APP_ENVIRONMENT !== 'production';
}
