-- =============================================================================
-- 0014 — The sender's postal address, for the footer of bulk mail
-- =============================================================================
-- Found by the second QA pass (2026-09-25).
--
-- Commercial email is commonly expected to identify the sender with a postal
-- address (CAN-SPAM in the US requires one), and mailbox providers look for the
-- same footer. The composer had nowhere to take one from, so it depended on each
-- template's author remembering to type it.
--
-- The address is workspace configuration, not template content. The composer
-- appends it, beside the unsubscribe link, to the HTML and the plain-text part
-- of every message of a campaign that requires unsubscribe — so no template edit
-- can remove it — and preflight blocks such a campaign while it is missing.
--
-- Owner/admin only: `workspace_settings_update` (0002) already requires one of
-- those roles; this adds the column to the authenticated UPDATE grant.
--
-- Stored as the person typed it (newlines allowed, other control characters
-- refused), because it is rendered as text into both parts and escaped there.
-- =============================================================================

alter table workspace_settings
  add column postal_address text
    check (
      postal_address is null
      or (
        length(btrim(postal_address)) between 10 and 300
        and postal_address !~ '[\x01-\x09\x0b-\x1f\x7f]'
      )
    );

comment on column workspace_settings.postal_address is
  'Sender postal address, appended to the footer of every bulk message (0014).';

grant update (postal_address) on workspace_settings to authenticated;
