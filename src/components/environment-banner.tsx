import { serverEnv } from '@/lib/env';
import { APP_ENVIRONMENT_LABEL } from '@/lib/environment';
import { SENDING_MODE_LABEL } from '@/lib/sending/gate';

/**
 * A strip across every page of a non-production deployment, so a development
 * checkout is never mistaken for production (and the reverse is conspicuous by
 * its absence).
 *
 * It names the environment and the sending mode only. It does not claim the data
 * is not production data: which database a deployment points at is not known
 * here, and a development build may run against the one real project.
 * Server component: it reads the server environment, which the browser never sees.
 */
export function EnvironmentBanner() {
  const env = serverEnv();
  if (env.APP_ENVIRONMENT === 'production') return null;

  return (
    <div
      role="status"
      className="bg-amber-400 px-4 py-1 text-center text-xs font-semibold uppercase tracking-wide text-amber-950"
    >
      {APP_ENVIRONMENT_LABEL[env.APP_ENVIRONMENT]} environment ·{' '}
      {SENDING_MODE_LABEL[env.EMAIL_SENDING_MODE]}
    </div>
  );
}
