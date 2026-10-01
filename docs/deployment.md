# Deployment — Vercel + Supabase

The application runs on **Vercel**, with functions in `bom1` (Mumbai, set in `vercel.json`). The database and auth are on **Supabase** project `okthffhjecrylqvlsoxj` (ap-south-1). The sending clock is **pg_cron** in that database (ARCHITECTURE §12), not Vercel Cron.

There is no staging environment. `vercel.json` therefore builds **production only**: its `ignoreCommand` skips every preview build, so no preview deployment can run against the production database.

Every step below is done by the operator. The application never creates cloud resources.

---

## 1. Before the first deploy

1. **Migrations.** Production must be at the newest migration before code that calls it is deployed:
   ```
   node --env-file=.env.prod-remote.local scripts/migrate.mjs --dry-run
   node --env-file=.env.prod-remote.local scripts/migrate.mjs --yes-production --project-ref=okthffhjecrylqvlsoxj --confirm-production
   ```
   `.env.prod-remote.local` holds `DATABASE_URL`, which is never set in Vercel. The rollback for each migration is in `supabase/ops/rollback_00NN.sql`.

2. **Generate two new secrets.** Do not reuse the development ones in `.env.local`. Run this twice, and paste each result straight into Vercel, nowhere else:
   ```
   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   ```

## 2. Vercel project

1. **Import** `github.com/raheelbaig/Bulk_Email_Uploader` as a new project. Vercel reads `vercel.json`, so leave the framework, build and install commands at their defaults.
2. **Settings → Environment Variables.** Scope every variable to **Production** only.

   | Variable | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Project Settings → API → `anon` key |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → `service_role` key (secret) |
   | `NEXT_PUBLIC_APP_URL` | `https://<app-host>` (the production domain, no trailing slash) |
   | `APP_ENVIRONMENT` | `production` |
   | `EMAIL_SENDING_MODE` | `disabled` |
   | `WORKER_HMAC_SECRET` | secret 1 from §1.2 |
   | `UNSUBSCRIBE_SECRET_V1` | secret 2 from §1.2 |
   | `LOG_LEVEL` | `info` |
   | `AWS_REGION` | `ap-south-1` — add with the AWS block (docs/aws-setup.md) |
   | `AWS_ACCOUNT_ID` | your 12-digit account id |
   | `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | the IAM user's access key (docs/aws-setup.md §2) |
   | `AWS_SES_CONFIGURATION_SET` | `email-uploader-production` |
   | `AWS_SNS_TOPIC_ARN` | `arn:aws:sns:ap-south-1:<account-id>:email-uploader-ses-events` |

   Do **not** set `DATABASE_URL`, because nothing at runtime uses it. Leave `SEND_*`, `CONTACT_COOLDOWN_HOURS` and the other policy variables unset to keep their defaults.

   With `APP_ENVIRONMENT=production`, the app **refuses to boot** if `NEXT_PUBLIC_APP_URL` or `NEXT_PUBLIC_SUPABASE_URL` is not a public https origin, or if either secret is missing. The error names the variable and never its value.

3. **Settings → Domains.** Add `<app-host>` and create the DNS record Vercel shows. This is a CNAME on the app's own host name. It never touches the root MX or SPF.
4. **Settings → Deployment Protection.** The production domain must **not** sit behind Vercel Authentication. SNS and the unsubscribe links cannot log in.
5. **Deploy** (Deployments → Redeploy, or push to `main`).

## 3. Supabase Auth settings

Authentication → URL Configuration:

- **Site URL:** `https://<app-host>`
- **Redirect URLs:** add `https://<app-host>/auth/confirm**`. Signup confirmation and password reset both return there.

Authentication → Providers → Email:

- **Confirm email:** on (already on).
- **Secure password change:** on. This is the real control on password changes (see `src/lib/auth/recovery.ts`).

Recommended for production: Authentication → Emails → **SMTP Settings**. Supabase's built-in mailer is heavily rate-limited, so point it at SES SMTP (a separate SMTP credential) once SES has production access. Auth emails are outside `EMAIL_SENDING_MODE`.

## 4. Verify the deployment (read-only)

```
curl -s https://<app-host>/api/health                # 200 {"status":"ok"}
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<app-host>/api/webhooks/ses   # 400 (no valid SNS envelope)
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<app-host>/api/internal/worker/tick  # 401 (no signature)
```

Then sign in, open each section, and confirm that the banner reads "Sending disabled".

## 5. The sending clock (later: before the first dry run)

Not needed for SES or SNS setup. While the mode is `disabled`, every tick is a no-op.

1. Supabase → Database → Extensions: enable `pg_cron` and `pg_net`.
2. In the Supabase SQL editor (values typed there, never committed or pasted elsewhere):
   ```sql
   select vault.create_secret('<WORKER_HMAC_SECRET value>', 'worker_hmac_secret');
   select vault.create_secret('https://<app-host>', 'app_url');
   ```
3. Run `supabase/ops/p5_schedule.sql` in the SQL editor. It schedules the tick, the pg_net and rate-ledger prunes, and the provider-event retention (`events_prune(90)`).

## 6. Going live (separate decision; not part of setup)

The gates are documented in README §"Sending" and `src/lib/sending/gate.ts`:

1. Dry run first: set `EMAIL_SENDING_MODE=dry_run` and schedule a small campaign.
2. Request SES production access.
3. Attach `docs/ses-iam-policy-live.json` in place of the no-send policy.
4. Set `EMAIL_SENDING_MODE=live`.

The live gate stays closed until every requirement holds, and the dashboard's "Technical details" lists any that do not.
