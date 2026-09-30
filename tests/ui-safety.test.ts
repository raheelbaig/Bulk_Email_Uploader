import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * UI safety invariants that are cheap to check from source.
 *
 *   1. Every form bound to a destructive or irreversible action asks first
 *      (ActionForm's `confirm`, a native modal dialog — never `window.confirm`).
 *   2. The campaign builder never offers "Schedule" while the campaign is not
 *      ready, and counts the send time as part of "ready".
 *   3. The Simple template editor still hands its HTML to the server, where the
 *      sanitiser runs — it must not set the stored HTML any other way.
 */

const SRC = join(__dirname, '..', 'src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.tsx') ? [path] : [];
  });
}

const DESTRUCTIVE_ACTIONS = [
  'deleteCampaignAction',
  'cancelCampaignAction',
  'deleteListAction',
  'removeListMemberAction',
  'deleteTemplateAction',
  'deleteContactAction',
  'removeDomainAction',
  'deleteIdentityAction',
  'addSuppressionAction',
  'removeSuppressionAction',
];

describe('destructive actions ask for confirmation', () => {
  const sources = files(SRC).map((path) => ({ path, text: readFileSync(path, 'utf8') }));

  it.each(DESTRUCTIVE_ACTIONS)('%s is only ever bound to an ActionForm with `confirm`', (name) => {
    const uses: string[] = [];
    for (const { path, text } of sources) {
      const pattern = new RegExp(`<ActionForm[^>]*?action=\\{${name}\\}[\\s\\S]*?>`, 'g');
      for (const match of text.matchAll(pattern)) {
        uses.push(path);
        expect(match[0], `${name} in ${path} has no confirm`).toMatch(/confirm=\{/);
      }
    }
    expect(uses.length, `${name} is not rendered anywhere`).toBeGreaterThan(0);
  });

  it('nothing uses the browser confirm() dialog', () => {
    for (const { path, text } of sources) {
      expect(text, path).not.toMatch(/\bwindow\.confirm\(|[^.\w]confirm\(\s*['"`]/);
    }
  });
});

describe('campaign builder scheduling', () => {
  const page = readFileSync(join(SRC, 'app', '(app)', 'campaigns', '[id]', 'page.tsx'), 'utf8');

  it('disables Schedule until the campaign can actually be scheduled, send time included', () => {
    expect(page).toMatch(/const canSchedule = editable && result\.ready && timeDone;/);
    expect(page).toMatch(/const timeDone = !timeMissing && !scheduleProblem;/);
    expect(page).toMatch(/submitDisabled=\{!canSchedule\}/);
    expect(page).toContain('Choose when this campaign should be sent.');
  });

  it('saves each choice through the draft action rather than asking for separate Save buttons', () => {
    for (const field of ['listId', 'templateId', 'senderIdentityId', 'scheduledAtLocal', 'name']) {
      expect(page).toMatch(new RegExp(`<AutoSaveForm action=\\{updateCampaignAction\\}[\\s\\S]{0,400}name="${field}"`));
    }
    expect(page).not.toMatch(/submitLabel="Save (audience|email|sender|time|name)"/);
  });
});

/**
 * Regression (pre-production QA, found in the production build with a real
 * browser): with a `loading.tsx` in the app shell, a server action that ends in
 * `redirect()` — Create campaign, Delete campaign, Delete template — never
 * navigated. The server committed the write and answered 303 with
 * `x-action-redirect`; the client then aborted the action request and stayed on
 * "Creating…". A second click created a second campaign. Removing the loading
 * boundary fixed every case. Unit tests cannot see this, so it is pinned here.
 */
describe('server-action redirects', () => {
  it('no loading.tsx boundary inside the app shell (it breaks action redirects)', () => {
    const loading = (function walk(dir: string): string[] {
      return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : /^loading\.(t|j)sx?$/.test(name) ? [path] : [];
      });
    })(join(SRC, 'app', '(app)'));
    expect(loading).toEqual([]);
  });
});

describe('Simple template editor', () => {
  const editor = readFileSync(join(SRC, 'components', 'template-body-editor.tsx'), 'utf8');

  it('submits its HTML as the ordinary `html` field, for the server to sanitise', () => {
    expect(editor).toMatch(/<input type="hidden" name="html" value=\{generated\} \/>/);
    expect(editor).toMatch(/const generated = mode === 'simple' \? toSimpleHtml\(simpleText\) : '';/);
    expect(editor).not.toMatch(/dangerouslySetInnerHTML/);
  });
});
