/**
 * The launch-time preflight.
 *
 * ARCHITECTURE §19.1: preflight runs again when a scheduled campaign becomes
 * due, and again on resume. This module adapts a `CampaignContext` to the one
 * preflight engine (`lib/campaigns/preflight`) — it adds no rule of its own.
 *
 * At launch the thing being judged is the *frozen snapshot*: that is what will
 * be sent. The snapshot is presented to the engine in the template's shape, so
 * every content check (empty subject, empty text part, personalization that does
 * not resolve) runs against exactly the bytes the recipients will get.
 *
 * Sender readiness comes from the readiness authority, evaluated from the
 * records just read — never from a status column read directly.
 *
 * Deliberately free of `server-only`: pure.
 */

import { evaluateCampaignPreflight, type PreflightResult } from '@/lib/campaigns/preflight';
import { parseTemplateSnapshot, renderableFromSnapshot, type TemplateSnapshot } from '@/lib/campaigns/snapshot';
import { evaluateSenderReadiness } from '@/lib/sender/readiness';
import type { TemplateRecord } from '@/lib/templates/ports';
import { renderTemplate, contactVariableValues, SAMPLE_CONTACT } from '@/lib/templates/render';
import type { SendingMode } from './gate';
import type { CampaignContext } from './ports';

function templateFromSnapshot(snapshot: TemplateSnapshot, workspaceId: string): TemplateRecord {
  return {
    id: snapshot.template_id,
    workspace_id: workspaceId,
    name: snapshot.name,
    subject: snapshot.subject,
    preview_text: snapshot.preview_text,
    html: snapshot.html,
    text: snapshot.text,
    variables: snapshot.variables,
    version: snapshot.version,
    created_at: snapshot.frozen_at,
    updated_at: null,
  };
}

export function evaluateLaunchPreflight(
  context: CampaignContext,
  options: { sendingMode: SendingMode; unsubscribeAvailable: boolean; now?: Date },
): PreflightResult {
  const snapshot = parseTemplateSnapshot(context.campaign.template_snapshot);
  const template = snapshot === null ? null : templateFromSnapshot(snapshot, context.campaign.workspace_id);
  const sampleRender =
    snapshot === null ? null : renderTemplate(renderableFromSnapshot(snapshot), contactVariableValues(SAMPLE_CONTACT));

  const senderReadiness =
    context.campaign.sender_identity_id === null
      ? null
      : evaluateSenderReadiness({
          identity: context.senderIdentity,
          domain: context.senderDomain,
          ...(options.now === undefined ? {} : { now: options.now }),
        });

  return evaluateCampaignPreflight({
    campaign: context.campaign,
    intent: 'launch',
    list: context.list,
    audience: context.audience,
    senderIdentity:
      context.senderIdentity === null
        ? null
        : {
            id: context.senderIdentity.id,
            from_email: context.senderIdentity.from_email,
            from_name: context.senderIdentity.from_name,
          },
    senderReadiness,
    template,
    snapshot,
    sampleRender,
    unsubscribe: { mechanismAvailable: options.unsubscribeAvailable },
    sendingMode: options.sendingMode,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}
