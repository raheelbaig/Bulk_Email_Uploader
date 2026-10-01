# AWS and DNS setup — SES (outbound only) and the SNS event pipeline

You do every step here by hand, in the AWS console and at the DNS provider. Nothing in the repository creates AWS resources, and no credential is ever pasted anywhere except Vercel's environment-variable form.

Throughout:

| Placeholder | Meaning |
|---|---|
| `ap-south-1` | the region for SES, SNS and everything below. It is the Supabase project's region, and Vercel runs in `bom1` (Mumbai). |
| `<account-id>` | your 12-digit AWS account id (top-right menu in the console) |
| `<domain>` | the sending domain, e.g. `example.com` |
| `<app-host>` | the app's public host, e.g. `mail.example.com` (docs/deployment.md) |

**Inbound mail is not touched.** SES here sends only. Do not change the root MX records or the root SPF record. The custom MAIL FROM lives on its own subdomain, `bounce.<domain>`.

---

## 1. SES account basics (region ap-south-1)

1. Open the console and switch the region selector to **Asia Pacific (Mumbai) ap-south-1**.
2. **Amazon SES → Configuration → Suppression list → Account-level suppression list → Edit.** Turn it on for **Bounces** and **Complaints**, then Save. Do this before any send, ever.
3. Leave the account in the **sandbox** for now. Production access is requested later, when going live (docs/deployment.md §6).

## 2. IAM user for the app (cannot send)

1. **IAM → Users → Create user** named `email-uploader-app`. Do not give it console access.
2. **Permissions → Attach policies directly → Create inline policy → JSON.** Paste `docs/ses-iam-policy.json`, replacing `<region>` with `ap-south-1` and `<account-id>` with yours. Name it `email-uploader-ses-no-send`.
   This policy can create and read identities and set MAIL FROM. It explicitly **denies** every send action and identity deletion.
3. **Security credentials → Create access key → "Application running outside AWS".** Copy the two values **directly into Vercel** as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (Production scope), and nowhere else.

## 3. Configuration set

1. **SES → Configuration → Configuration sets → Create set.** Name: `email-uploader-production`. Under Reputation options, tick **Reputation metrics**. Leave the rest at the defaults (no open or click tracking).
2. Vercel: set `AWS_SES_CONFIGURATION_SET=email-uploader-production`.

## 4. SNS topic

1. **SNS → Topics → Create topic.** Type **Standard**, name `email-uploader-ses-events`. Leave encryption off. With SSE-KMS, the key policy would also have to allow SES and SNS.
2. **Topic → Edit → Access policy.** Keep the existing default statement and **add** this one to its `Statement` array:
   ```json
   {
     "Sid": "AllowSesEventPublishing",
     "Effect": "Allow",
     "Principal": { "Service": "ses.amazonaws.com" },
     "Action": "sns:Publish",
     "Resource": "arn:aws:sns:ap-south-1:<account-id>:email-uploader-ses-events",
     "Condition": {
       "StringEquals": { "AWS:SourceAccount": "<account-id>" },
       "StringLike": { "AWS:SourceArn": "arn:aws:ses:ap-south-1:<account-id>:configuration-set/email-uploader-production" }
     }
   }
   ```
3. **Signature version 2.** SNS defaults to version 1, and the webhook refuses version 1. Open **CloudShell** (the terminal icon in the console's top bar; it uses your console session, so no access key is involved) and run:
   ```
   aws sns set-topic-attributes --region ap-south-1 \
     --topic-arn arn:aws:sns:ap-south-1:<account-id>:email-uploader-ses-events \
     --attribute-name SignatureVersion --attribute-value 2

   aws sns get-topic-attributes --region ap-south-1 \
     --topic-arn arn:aws:sns:ap-south-1:<account-id>:email-uploader-ses-events \
     --query Attributes.SignatureVersion
   ```
   The second command must print `"2"`.
4. Vercel: set `AWS_SNS_TOPIC_ARN=arn:aws:sns:ap-south-1:<account-id>:email-uploader-ses-events` and `AWS_ACCOUNT_ID=<account-id>`. The live gate checks that the ARN's region equals `AWS_REGION` and that its account equals `AWS_ACCOUNT_ID`.

## 5. Event destination

**SES → Configuration sets → `email-uploader-production` → Event destinations → Add destination.**

- Event types: **Sends, Rejects, Hard bounces (Bounces), Complaints, Deliveries, Delivery delays, Rendering failures.** Leave Opens, Clicks and Subscriptions off.
- Destination: **Amazon SNS**, topic `email-uploader-ses-events`. Turn the destination on.

What the app does with each event: Send confirms an attempt (ADR-0001 §3.2). Delivery marks the message delivered. Reject marks it failed. A permanent bounce or a complaint suppresses the address and can pause sending (ADR-0006). The others are recorded only.

## 6. Redeploy, then subscribe the webhook

1. Redeploy in Vercel so it picks up the AWS variables from §2–§4.
2. **SNS → Topics → `email-uploader-ses-events` → Create subscription.**
   - Protocol: **HTTPS**
   - Endpoint: `https://<app-host>/api/webhooks/ses`
   - **Enable raw message delivery: OFF**, because the signed envelope is needed.
3. The app confirms the subscription by itself, and within a minute its status becomes **Confirmed**. If it stays "Pending confirmation", look in Vercel's function logs for `ses webhook rejected` and its `reason`:
   - `bad_signature_version`: step 4.3 was not applied.
   - `wrong_topic`: `AWS_SNS_TOPIC_ARN` does not match the topic.
   - `cert_unavailable`: SNS's certificate host was unreachable. Retry with "Request confirmation".

## 7. Sending domain (through the app), then DNS

1. In the app: **Senders → Add domain → `<domain>`**. The app calls SES `CreateEmailIdentity` (Easy DKIM) and sets the custom MAIL FROM `bounce.<domain>`. It then lists the exact records.
2. At the DNS provider, add **exactly the records the Senders page shows**. They have these shapes. In most DNS panels the host field omits `.<domain>`, so enter `xxxx._domainkey`, not the full name.

   | Type | Host / name | Value | TTL |
   |---|---|---|---|
   | CNAME | `<token1>._domainkey` | `<token1>.dkim.amazonses.com` | 3600 |
   | CNAME | `<token2>._domainkey` | `<token2>.dkim.amazonses.com` | 3600 |
   | CNAME | `<token3>._domainkey` | `<token3>.dkim.amazonses.com` | 3600 |
   | MX | `bounce` | `feedback-smtp.ap-south-1.amazonses.com`, priority `10` | 3600 |
   | TXT | `bounce` | `v=spf1 include:amazonses.com ~all` | 3600 |
   | TXT | `_dmarc` | `v=DMARC1; p=none;` (add only if **no** DMARC record exists; if one exists, leave it) | 3600 |

   The three DKIM tokens are issued by SES when the domain is added, so copy them from the app or from SES → Identities → `<domain>` → DKIM. Do **not** edit the root MX or the root SPF record.
3. Back in the app, use **Senders → `<domain>` → Check again**. SES usually verifies DKIM within an hour, and occasionally takes up to 72 hours. The page shows DKIM, MAIL FROM, SPF and DMARC separately.
4. **Senders → Identities → Add sender address** `news@<domain>` (or your chosen From address), with a From name and a reply-to address.

## 8. Checks once everything above is done

- SES → Identities → `<domain>`: **Identity status Verified**, **DKIM Successful**, **MAIL FROM Successful**.
- SNS → subscription: **Confirmed**.
- The app's Senders page: every required record green.
- The app's dashboard → Technical details: with `EMAIL_SENDING_MODE` still `disabled`, the only unmet live requirement is `mode_is_live`.

Live sending stays off until the separate go-live steps in docs/deployment.md §6.
