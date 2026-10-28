import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installAccountDetails } from '../src/dashboard-account-details.js';
import { accountTokens, scopedWeeklyRows, renderDashboardHtml, dashboardCsp } from '../src/dashboard.js';
import { AccountManager } from '../src/account-manager.js';
import { createHash } from 'node:crypto';

// Small DOM for controller behavior; visual/keyboard integration also checked in Chromium.
function harness() {
  let document;
  class Element {
    constructor() { this.children = []; this.style = {}; this.events = {}; this.hidden = false; this.attrs = {}; this.isConnected = true; this._text = ''; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(c => c.textContent).join(' '); }
    appendChild(child) { this.children.push(child); return child; }
    setAttribute(key, value) { this.attrs[key] = value; }
    addEventListener(type, callback) { this.events[type] = callback; }
    focus() { document.activeElement = this; }
    querySelectorAll() { return [nodes.accountDetailsClose, ...(!nodes.accountDetailsHistory.hidden ? [nodes.accountDetailsHistory] : [])]; }
  }
  const nodes = Object.fromEntries(['accountDetailsBackdrop', 'accountDetailsDialog', 'accountDetailsBody', 'accountDetailsClose', 'accountDetailsHistory', 'accountDetailsTitle', 'accountDetailsUpdated'].map(id => [id, new Element()]));
  nodes.accountDetailsBackdrop.hidden = true;
  document = { body: new Element(), activeElement: null, querySelectorAll: () => [opener], getElementById: id => nodes[id], createElement: () => new Element() };
  const accounts = { anthropic: [], codex: [], agy: [] };
  let locale = 'pl';
  const history = [];
  const opener = new Element();
  const time = Date.parse('2026-10-28T20:00:00Z');
  const controller = installAccountDetails({ document, getAccounts: provider => accounts[provider], getLanguage: () => locale,
    getAgyEvents: () => [], formatNumber: n => String(n), formatAgo: () => 'przed chwilą',
    accountTokens, scopedWeeklyRows, accountError: a => a.lastError, openHistory: a => history.push(a), now: () => time });
  return { document, nodes, accounts, history, opener, controller, time, language: value => { locale = value; },
    text: () => nodes.accountDetailsBody.textContent,
    fire: (id, type, event = {}) => nodes[id].events[type](event) };
}

test('Claude details show measured limits, cache-inclusive usage and an honest missing-quota state', () => {
  const f = harness();
  f.accounts.anthropic = [{ id: 'a', name: 'Claude', provider: 'anthropic', hasClaudePro: true, sessions: 2,
    quota: { unified5h: .29, unified7d: .7, unified5hReset: f.time + 3600000 },
    usage: { totalRequests: 42, totalInputTokens: 10, totalOutputTokens: 20, totalCacheReadTokens: 70,
      recent: [{ model: 'claude-latest', timestamp: f.time }], byModel: { 'claude-latest': { totalTokens: 100 } } } }];
  f.controller.open('anthropic', 'a', f.opener);
  assert.match(f.text(), /29% zużyte/);
  assert.match(f.text(), /71% pozostało/);
  assert.match(f.text(), /100/);
  assert.match(f.text(), /Claude Pro/);
  assert.match(f.text(), /Odczyt cache/);
  assert.match(f.text(), /Historia ruchu, nie katalog/);
  assert.equal(f.nodes.accountDetailsHistory.hidden, false);
  f.accounts.anthropic[0].quota = {};
  f.controller.refresh();
  assert.match(f.text(), /Brak pomiaru limitów/);
  assert.doesNotMatch(f.text(), /29% zużyte/);
});

test('refresh tracks stable account ID through rename and removal instead of displaying another account', () => {
  const f = harness();
  f.accounts.codex = [{ id: 'a', name: 'same', usage: { totalRequests: 1 } }, { id: 'b', name: 'same', usage: { totalRequests: 999 } }];
  f.controller.open('codex', 'a', f.opener);
  f.accounts.codex[0].name = 'renamed';
  f.accounts.codex[0].quota = { unified5h: .42 };
  f.controller.refresh();
  assert.match(f.text(), /renamed/);
  assert.match(f.text(), /42% zużyte/);
  assert.doesNotMatch(f.text(), /999/);
  f.accounts.codex.shift(); f.controller.refresh();
  assert.match(f.text(), /usunięte/);
  assert.doesNotMatch(f.text(), /999/);
  assert.equal(f.nodes.accountDetailsHistory.hidden, true);
});

test('Gemini details use per-account model access and measured quota separately, including stale/expired readings', () => {
  const f = harness();
  f.accounts.agy = [{ id: 'pro', email: 'pro@example.invalid', enabled: true, subscription: { name: 'Google AI Pro' },
    modelCatalog: { models: ['gemini-flash-low'], updatedAt: f.time, stale: false },
    stats: { requests: 8, inputTokens: 100, outputTokens: 30 },
    diagnostics: { status: 'available', telemetry: { models: { observedAt: f.time - 600000, stale: true,
      data: [{ id: 'gemini-flash-low', remainingFraction: .25, resetAt: f.time - 1 }] } } } }];
  f.controller.open('agy', 'pro', f.opener);
  assert.match(f.text(), /Włączone do obsługi/);
  assert.doesNotMatch(f.text(), /Dostępność niepotwierdzona/);
  assert.match(f.text(), /75% zużyte/);
  assert.match(f.text(), /25% pozostało/);
  assert.match(f.text(), /dane mogą być nieaktualne/);
  assert.match(f.text(), /Termin resetu minął/);
  assert.match(f.text(), /gemini-flash-low/);
  assert.doesNotMatch(f.text(), /argon/);
  assert.equal(f.nodes.accountDetailsHistory.hidden, true);
  delete f.accounts.agy[0].diagnostics;
  f.controller.refresh();
  assert.match(f.text(), /Brak pomiaru limitów/);
  assert.doesNotMatch(f.text(), /0% zużyte/);
});

test('untrusted content is text, English locale works, and opening details never exposes credential fields', () => {
  const f = harness(); f.language('en');
  f.accounts.codex = [{ id: 'a', name: '<img src=x onerror=alert(1)>', status: 'error',
    credential: 'never-render-secret', refreshToken: 'never-render-refresh', lastError: { error: '<b>token revoked</b>' } }];
  f.controller.open('codex', 'a', f.opener);
  assert.match(f.text(), /<img src=x/);
  assert.match(f.text(), /<b>token revoked<\/b>/);
  assert.match(f.text(), /Needs attention/);
  assert.doesNotMatch(f.text(), /never-render/);
  assert.equal(f.nodes.accountDetailsTitle.textContent, 'Account details');
});

test('Escape, backdrop, focus trapping, scroll restoration and full history preserve predictable navigation', () => {
  const f = harness(); f.accounts.anthropic = [{ id: 'a', name: 'Claude' }];
  f.document.body.style.overflow = 'auto';
  f.controller.open('anthropic', 'a', f.opener);
  assert.equal(f.document.activeElement, f.nodes.accountDetailsClose);
  assert.equal(f.document.body.style.overflow, 'hidden');
  let prevented = false;
  f.fire('accountDetailsDialog', 'keydown', { key: 'Tab', shiftKey: true, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(f.document.activeElement, f.nodes.accountDetailsHistory);
  f.fire('accountDetailsDialog', 'keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(f.nodes.accountDetailsBackdrop.hidden, true);
  assert.equal(f.document.activeElement, f.opener);
  assert.equal(f.document.body.style.overflow, 'auto');
  f.controller.open('anthropic', 'a', f.opener);
  f.fire('accountDetailsHistory', 'click');
  assert.equal(f.history[0].id, 'a');
  assert.equal(f.nodes.accountDetailsBackdrop.hidden, true);
  f.controller.open('anthropic', 'a', f.opener);
  f.fire('accountDetailsBackdrop', 'click', { target: f.nodes.accountDetailsBackdrop });
  assert.equal(f.nodes.accountDetailsBackdrop.hidden, true);
});

test('Gemini selects the newest quota source and detects aged telemetry', () => {
  const f = harness();
  const account = { id: 'g', enabled: true,
    diagnostics: { status: 'available', routingStatus: 'available', telemetry: { models: {
      observedAt: f.time - 3600000, stale: false, data: [{ id: 'flash', remainingFraction: .8 }],
    } } }, usage: { updatedAt: f.time - 60000, models: [{ id: 'flash', remainingFraction: 0 }] } };
  f.accounts.agy = [account];
  f.controller.open('agy', 'g', f.opener);
  assert.match(f.text(), /100% zużyte/);
  assert.doesNotMatch(f.text(), /20% zużyte/);
  assert.doesNotMatch(f.text(), /dane mogą być nieaktualne/);
  account.usage = {};
  f.controller.refresh();
  assert.match(f.text(), /20% zużyte/);
  assert.match(f.text(), /dane mogą być nieaktualne/);
});

test('closing restores focus to the replacement trigger after account polling', () => {
  const f = harness();
  f.accounts.anthropic = [{ id: 'a', name: 'Account' }];
  f.controller.open('anthropic', 'a', f.opener);
  f.opener.isConnected = false;
  const replacement = { dataset: { detailsProvider: 'anthropic', detailsKey: 'a' }, focus: () => { f.document.activeElement = replacement; } };
  f.document.querySelectorAll = () => [replacement];
  f.controller.close();
  assert.equal(f.document.activeElement, replacement);
});

test('status exposes a stable non-secret account ID for selecting duplicate names', () => {
  const am = new AccountManager([{ id: 'one', name: 'duplicate', accessToken: 'synthetic-a' }, { id: 'two', name: 'duplicate', accessToken: 'synthetic-b' }]);
  const accounts = am.getStatus().accounts;
  assert.deepEqual(accounts.map(a => a.id), ['one', 'two']);
  assert.doesNotMatch(JSON.stringify(accounts), /synthetic-a|synthetic-b/);
});

test('embedded details controller remains covered by the dashboard CSP hash', () => {
  const html = renderDashboardHtml();
  const script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
  assert.ok(script.includes('function installAccountDetails'));
  const hash = createHash('sha256').update(script).digest('base64');
  assert.ok(dashboardCsp().includes(`'sha256-${hash}'`));
});
