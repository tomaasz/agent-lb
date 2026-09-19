// The status dashboard: a single self-contained HTML page served at
// GET /agent-lb/dashboard, rendering /agent-lb/status for humans.
//
// The page itself contains NO data — it is a static asset whose script fetches
// /agent-lb/status (same origin) with the proxy key and re-renders every few
// seconds. That split is what lets the asset be served without the key (a
// browser address bar cannot send x-api-key) while every byte of actual status
// stays behind the existing gate. The key is asked for once and kept in
// localStorage; a 401 (wrong or rotated key) brings the prompt back.
//
// Self-contained on purpose: no external scripts, styles, or fonts, so the
// page works on air-gapped deployments and adds no third-party surface. All
// rendering uses textContent — status fields (account names, client names) are
// operator/OAuth-derived, but they still never reach innerHTML.

import { createHash } from 'node:crypto';
import { UNAVAILABLE_TEXT } from './status-renderer.js';

export function renderDashboardHtml() {
  return PAGE;
}

/**
 * Content-Security-Policy for the dashboard, sent by the server with the page.
 *
 * The page holds the proxy key in localStorage, so the policy is the backstop
 * for a script that should never run there: nothing loads from anywhere
 * (`default-src 'none'`), the one inline script is admitted by its hash rather
 * than by `'unsafe-inline'` — the page is static, so the hash is stable — and
 * the only network the script may touch is this origin, for status and switch.
 * Styles need `'unsafe-inline'` because the layout uses `style=` attributes,
 * which hashes do not cover; CSSOM writes (`el.style.width = …`) are not
 * governed by CSP at all. `frame-ancestors 'none'` keeps the page out of
 * another site's iframe, where a click on "switch" could be overlaid.
 */
export function dashboardCsp(html = PAGE) {
  const script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
  const hash = createHash('sha256').update(script, 'utf8').digest('base64');
  return [
    "default-src 'none'",
    `script-src 'sha256-${hash}'`,
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

// The page's pure logic lives here, not in the script string: these functions
// close over nothing and touch no DOM, so they are serialized into the page
// with toString() below AND exported for the test suite. One implementation,
// tested and served — a test against the string would only be a source grep.

// Model-scoped weekly buckets, one row per family upstream actually metered.
// `scopedWeekly` is learned from the usage payload's `limits` array, so it is
// the complete list when present; the two dedicated fields are the fallback for
// a payload that reported `seven_day_sonnet` without a `limits` array.
export function scopedWeeklyRows(quota) {
  var q = quota || {};
  var scoped = q.scopedWeekly || {};
  var rows = [];
  Object.keys(scoped).forEach(function (family) {
    var b = scoped[family] || {};
    rows.push({ family: family, label: family.charAt(0).toUpperCase() + family.slice(1), utilization: b.utilization, resetAt: b.resetAt });
  });
  [{ family: 'fable', label: 'Fable', u: q.unified7dFable, r: q.unified7dFableReset },
    { family: 'sonnet', label: 'Sonnet', u: q.unified7dSonnet, r: q.unified7dSonnetReset }].forEach(function (f) {
    if (Object.prototype.hasOwnProperty.call(scoped, f.family) || f.u == null) return;
    rows.push({ family: f.family, label: f.label, utilization: f.u, resetAt: f.r });
  });
  rows.sort(function (a, b) { return a.family < b.family ? -1 : a.family > b.family ? 1 : 0; });
  return rows;
}

// What an account has spent, cache included. `totalInputTokens` counts uncached
// input only, which on Claude Code traffic is ~0.05% of the input side — a
// total without the cache fields understates the account by orders of magnitude.
export function accountTokens(usage) {
  var u = usage || {};
  return (u.totalInputTokens || 0) + (u.totalOutputTokens || 0)
    + (u.totalCacheReadTokens || 0) + (u.totalCacheCreationTokens || 0);
}

// One row per session, from `sessions.items` (proxy.sessionDetail). The token
// columns are #192's numbers — what each response actually reported, cache
// included — summed across the weekly buckets the session touched. `pins` is a
// bucket→account map rather than one index, because a session spending two
// model families is served by two accounts at the same time.
export function sessionRows(sessions) {
  var items = (sessions && sessions.items) || [];
  return items.map(function (s) {
    var buckets = s.tokens || {};
    var row = {
      id: s.id,
      client: s.client || '',
      project: (s.dimensions || {}).project || '',
      active: !!s.active,
      requests: s.requests || 0,
      starved: s.starved || 0,
      cacheRead: 0, cacheCreation: 0, input: 0, output: 0, context: 0,
      accounts: Object.keys(s.pins || {}).map(function (b) { return s.pins[b]; }).join(', '),
      lastSeen: s.lastSeen || 0,
    };
    Object.keys(buckets).forEach(function (b) {
      var t = buckets[b] || {};
      row.cacheRead += t.cacheRead || 0;
      row.cacheCreation += t.cacheCreation || 0;
      row.input += t.input || 0;
      row.output += t.output || 0;
      row.context += t.context || 0;
    });
    row.total = row.cacheRead + row.cacheCreation + row.input + row.output;
    return row;
  });
}

export function filterSessionRows(rows, filters) {
  var f = filters || {};
  return (rows || []).filter(function (r) {
    if (f.project && r.project !== f.project) return false;
    if (f.client && r.client !== f.client) return false;
    return true;
  });
}

// Text sorts alphabetically, numbers numerically. A missing value sorts as
// empty/zero rather than dropping the row.
export function sortRows(rows, key, dir) {
  var sign = dir === 'asc' ? 1 : -1;
  return (rows || []).slice().sort(function (a, b) {
    var x = a[key], y = b[key];
    if (typeof x === 'string' || typeof y === 'string') {
      return sign * String(x == null ? '' : x).localeCompare(String(y == null ? '' : y));
    }
    return sign * ((x || 0) - (y || 0));
  });
}

export function uniqSorted(values) {
  var seen = Object.create(null);
  (values || []).forEach(function (v) { if (v) seen[v] = true; });
  return Object.keys(seen).sort();
}

// The request the switch button sends: POST /agent-lb/switch with the same
// key the status poll uses. Pure, so the test suite can send exactly this
// through a real proxy and prove the same-origin CSRF gate lets the page in.
export function switchRequest(name, key) {
  return {
    url: '/agent-lb/switch',
    init: {
      method: 'POST',
      headers: { 'x-api-key': key || '', 'content-type': 'application/json' },
      body: JSON.stringify({ account: name }),
    },
  };
}

// What to tell the operator afterwards. The endpoint answers `ok` for the choice
// being recorded and `eligible` for whether traffic will actually follow it —
// two different things, and a bare "done" would be a lie for a spent target.
export function switchOutcome(res) {
  if (!res || !res.ok) return { kind: 'error', text: 'switch failed' + (res && res.error ? ': ' + res.error : '') };
  if (res.eligible === false) return { kind: 'warn', text: 'switched to ' + res.account + ', but rotation will not use it' + (res.reason ? ': ' + res.reason : '') };
  return { kind: 'ok', text: 'switched to ' + res.account };
}

// One row per route the server reports — each model family the fleet meters
// separately, autocreated or configured — plus a trailing row for everything
// else, which goes to the current account. `target` is the server's own answer
// to "where does a request for this family land right now", so the page does
// not re-derive routing from quota bars; the eligible split says why a family
// is where it is.
export function routeRows(status) {
  var s = status || {};
  var blockedModels = s.blockedModels || [];
  var rows = (s.routes || []).map(function (r) {
    var accounts = r.accounts || [];
    var name = r.name || '';
    var match = r.match || [];
    var target = r.target || null;
    var pinned = r.pinned || null;
    return {
      kind: 'route',
      name: name,
      label: name.charAt(0).toUpperCase() + name.slice(1),
      match: match.join(', '),
      target: target,
      pinned: pinned,
      // A pin the server is not honouring (its account cannot serve the
      // family right now): routing went elsewhere, and the row must say so
      // rather than let "pinned" read as "this is the pin".
      pinMismatch: !!pinned && pinned !== target,
      // The blocklist answers 400 before selection, so a route whose every
      // glob is blocked has a target no request will reach. A literal glob
      // comparison covers the common case; the server's overlap logic is not
      // shipped to the page.
      blocked: match.length > 0 && match.every(function (g) { return blockedModels.indexOf(g) !== -1; }),
      autocreated: !!r.autocreated,
      eligible: accounts.filter(function (a) { return a.eligible; }).map(function (a) { return a.name; }),
      ineligible: accounts.filter(function (a) { return !a.eligible; }).map(function (a) { return a.name; }),
    };
  });
  if (rows.length) {
    // The default row is the server's answer too (`defaultTarget`), not an
    // assumption that unrouted traffic lands on the current account: a
    // blocked or outranked current account is skipped by the next request.
    var current = s.currentAccount || null;
    var cur = (s.accounts || []).filter(function (a) { return a.name === current; })[0];
    rows.push({
      kind: 'default', name: '', label: 'Everything else', match: '',
      target: s.defaultTarget || current, current: current,
      currentUnavailable: (cur && cur.unavailable) || null,
      pinned: null, pinMismatch: false, blocked: false, autocreated: false, eligible: [], ineligible: [],
    });
  }
  return rows;
}

// Consecutive client requests that ended with nothing usable. Claude Code has
// its own retry loop, so two or three in a row are ordinary during a seconds-long
// upstream wobble; five with no success in between is past any blip and past the
// client's own budget. No age floor is needed — unlike a token-based guess, a
// streak of five is true of no healthy session at any age, so a floor would only
// delay a true positive.
export var STARVED_MIN = 5;
// The failure that makes this fire is usually fleet-wide, so every active
// session starves at once. Naming all of them would bury the dashboard at the
// moment it matters most; the count carries the scale, three names carry enough
// to go and ask someone.
export var STARVED_LIST_MAX = 3;

/**
 * What is wrong right now, worst first, or an empty list. Only states that are
 * actionable and not ordinary operation: a spent weekly bucket, a rate-limit
 * back-off and an upstream refusal are rotation and back-off working, and
 * saying so every day would teach the reader to ignore the banner on the day it
 * matters.
 */
export function problems(status) {
  var s = status || {};
  var out = [];

  // Named when proxy.sessionDetail is on; otherwise the aggregate still says
  // that something is starving, which is the half that must not be opt-in.
  // When nothing can serve, every session starves and "it is failing" sends the
  // operator hunting for a broken token. Say which, if the fleet agrees on why.
  var accounts = s.accounts || [];
  var stalled = accounts.filter(function (a) { return a.unavailable === 'quota' || a.unavailable === 'throttled'; });
  var reasons = {};
  stalled.forEach(function (a) { reasons[a.unavailable] = true; });
  var why = accounts.length && stalled.length === accounts.length
    ? ' — every account is ' + (reasons.quota && reasons.throttled ? 'over its quota threshold or in a rate-limit hold'
      : reasons.quota ? 'over its quota threshold' : 'in a rate-limit hold') + '.'
    : ' — it is failing, not idle.';

  var sessions = s.sessions || {};
  var named = (sessions.items ? sessionRows(sessions) : []).filter(function (r) {
    return r.active && r.starved >= STARVED_MIN;
  }).sort(function (a, b) { return b.starved - a.starved; });
  named.slice(0, STARVED_LIST_MAX).forEach(function (r) {
    out.push({
      severity: 'bad', kind: 'starved-session',
      text: (r.client ? r.client + "'s session " : 'Session ') + String(r.id || '').slice(0, 8)
        + ' has had ' + r.starved + ' requests in a row come back with nothing'
        + (r.project ? ' (' + r.project + ')' : '') + why,
    });
  });
  if (named.length > STARVED_LIST_MAX) {
    out.push({
      severity: 'bad', kind: 'starved-more',
      text: 'and ' + (named.length - STARVED_LIST_MAX) + ' more sessions are getting nothing back.',
    });
  }
  if (!named.length && (sessions.starvedMax || 0) >= STARVED_MIN) {
    out.push({
      severity: 'bad', kind: 'starved-session',
      text: 'A session has had ' + sessions.starvedMax + ' requests in a row come back with nothing.'
        + ' Turn on proxy.sessionDetail to see which.',
    });
  }

  // Only the two states that do not clear themselves. `entitlement` is a
  // Only the states that do not clear themselves or require human attention.
  // `entitlement` is a short cooldown and `upstream-rejected` indicates a spent
  // shared bucket — both expire on their own. `identity-verification` requires
  // human action in the browser, and `error` needs re-login.
  var ATTENTION = {
    error: 'needs a re-login',
    disabled: 'is disabled',
    'identity-verification': 'requires identity verification in browser',
  };
  (s.accounts || []).forEach(function (a) {
    var why = ATTENTION[a.unavailable];
    if (why) out.push({
      severity: 'warn',
      kind: 'account',
      text: 'Account ' + a.name + ' ' + why + '.',
      accountName: a.name,
      reason: a.unavailable,
      type: a.type,
      priority: a.priority || 0
    });
  });

  // Deliberately no spend line. `usedMinor` is month-to-date overage, so on a
  // fleet that has overage switched on it is non-zero for most of the month —
  // an always-lit banner, which is the thing this is trying not to be. The
  // account card and `agentlb status` both carry it, with the amount.

  return out;
}

const SHARED_HELPERS = [
  scopedWeeklyRows, accountTokens, sessionRows, filterSessionRows, sortRows, uniqSorted,
  switchRequest, switchOutcome, routeRows, problems,
].map(fn => fn.toString()).join('\n\n');

// The threshold rides along: `problems` closes over it, so a page without it
// would ReferenceError on first render.
const SHARED_CONSTS = `var STARVED_MIN = ${STARVED_MIN};\nvar STARVED_LIST_MAX = ${STARVED_LIST_MAX};`;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent LB</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>⚖️</text></svg>">
<style>
  :root {
    --bg: #0d1117;
    --panel: #161b22;
    --card-bg: rgba(22, 27, 34, 0.65);
    --card-hover-border: rgba(255, 255, 255, 0.15);
    --card-col-bg: rgba(22, 27, 34, 0.35);
    --line: #262c36;
    --line-subtle: rgba(255, 255, 255, 0.06);
    --text: #c9d1d9;
    --heading: #f0f6fc;
    --dim: #8b949e;
    --accent: #58a6ff;
    --accent-glow: rgba(88, 166, 255, 0.12);
    --ok: #3fb950;
    --warn: #d29922;
    --bad: #f85149;
    --input-bg: #0d1117;
    --input-border: #30363d;
    --policy-card-bg: rgba(13, 17, 23, 0.65);
    --policy-card-border: rgba(255, 255, 255, 0.08);
    --shadow: 0 16px 36px rgba(0, 0, 0, 0.38), 0 2px 8px rgba(0, 0, 0, 0.2);
    --modal-backdrop: rgba(0, 0, 0, 0.78);
  }

  [data-theme="light"] {
    --bg: #f6f8fa;
    --panel: #ffffff;
    --card-bg: #ffffff;
    --card-hover-border: rgba(9, 105, 218, 0.35);
    --card-col-bg: #f0f2f5;
    --line: #d0d7de;
    --line-subtle: rgba(0, 0, 0, 0.08);
    --text: #24292f;
    --heading: #1f2328;
    --dim: #57606a;
    --accent: #0969da;
    --accent-glow: rgba(9, 105, 218, 0.12);
    --ok: #1a7f37;
    --warn: #9a6700;
    --bad: #cf222e;
    --input-bg: #ffffff;
    --input-border: #d0d7de;
    --policy-card-bg: #ffffff;
    --policy-card-border: #d0d7de;
    --shadow: 0 8px 24px rgba(140, 149, 159, 0.2), 0 2px 6px rgba(140, 149, 159, 0.12);
    --modal-backdrop: rgba(31, 35, 40, 0.6);
  }

  * { box-sizing: border-box; margin: 0; }
  body { background: var(--bg); color: var(--text); font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 14px 18px; transition: background-color .15s ease, color .15s ease; }
  main { max-width: 1720px; margin: 0 auto; width: 100%; }
  h1 { font-size: 18px; font-weight: 600; margin-bottom: 2px; display: inline-flex; align-items: center; gap: 8px; color: var(--heading); }
  h2 { font-size: 11.5px; color: var(--dim); text-transform: uppercase; letter-spacing: .06em; margin: 12px 0 6px; font-weight: 600; }
  .sub { color: var(--dim); margin-bottom: 10px; font-size: 12px; }
  .sub b { color: var(--text); font-weight: 500; }
  .header-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
  .header-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }

  /* Policy & Operations Panel */
  .policy-panel {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 12px 14px;
    margin-bottom: 14px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.03);
    transition: border-color .15s ease;
  }
  .policy-panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding-bottom: 10px;
    margin-bottom: 12px;
    border-bottom: 1px solid var(--line-subtle);
    flex-wrap: wrap;
  }
  .policy-head-left {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .policy-title-icon {
    font-size: 22px;
    line-height: 1;
  }
  .policy-title-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .policy-title {
    font-size: 13.5px;
    font-weight: 700;
    color: var(--heading);
    margin: 0;
    letter-spacing: -0.01em;
  }
  .policy-subtitle {
    font-size: 11.5px;
    color: var(--dim);
    margin: 2px 0 0;
  }
  .policy-head-right {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-left: auto;
  }
  .policy-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
  }
  @media (max-width: 1200px) {
    .policy-grid { grid-template-columns: repeat(2, 1fr); }
  }
  @media (max-width: 680px) {
    .policy-grid { grid-template-columns: 1fr; }
  }
  .policy-card {
    background: var(--policy-card-bg);
    border: 1px solid var(--policy-card-border);
    border-radius: 6px;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 8px;
    min-height: 118px;
    box-sizing: border-box;
    transition: border-color .15s ease, transform .15s ease, box-shadow .15s ease;
  }
  .policy-card:hover {
    border-color: var(--accent);
    box-shadow: 0 3px 12px rgba(0,0,0,0.06);
  }
  .policy-card-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }
  .policy-card-badge {
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: .06em;
    text-transform: uppercase;
    color: var(--accent);
    background: var(--accent-glow);
    padding: 1px 6px;
    border-radius: 3px;
    border: 1px solid rgba(88,166,255,0.25);
  }
  [data-theme="light"] .policy-card-badge {
    border-color: rgba(9,105,218,0.25);
  }
  .policy-card-icon {
    font-size: 14px;
  }
  .policy-card-head {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .policy-card-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--heading);
    margin: 0;
  }
  .policy-check-label {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    cursor: pointer;
    user-select: none;
  }
  .policy-checkbox {
    margin: 0;
    cursor: pointer;
    accent-color: var(--accent);
    width: 15px;
    height: 15px;
  }
  .policy-select {
    width: 100%;
    padding: 4px 8px;
    font-size: 11.5px;
    background: var(--input-bg);
    border: 1px solid var(--input-border);
    color: var(--text);
    border-radius: 4px;
    outline: none;
    cursor: pointer;
  }
  .policy-select:focus {
    border-color: var(--accent);
  }
  .policy-card-desc {
    font-size: 11px;
    color: var(--dim);
    line-height: 1.45;
    margin: 0;
    border-top: 1px solid var(--line-subtle);
    padding-top: 6px;
  }
  .policy-panel.policy-compact .policy-card-desc {
    display: none;
  }
  .policy-panel.policy-compact .policy-card {
    min-height: auto;
  }

  /* 3-column master dashboard grid: Col 1 Claude (1fr) | Col 2 Codex (1fr) | Col 3 Client Keys (compact 390px sidebar) */
  .dashboard-grid { display: grid; grid-template-columns: minmax(320px, 1fr) minmax(320px, 1fr) minmax(320px, 390px); gap: 14px; align-items: start; margin-top: 6px; }
  .grid-head-accounts { grid-column: 1 / 3; grid-row: 1; min-width: 0; }
  .grid-head-clients { grid-column: 3 / 4; grid-row: 1; min-width: 0; }
  #colClaude { grid-column: 1 / 2; grid-row: 2; min-width: 0; }
  #colCodex { grid-column: 2 / 3; grid-row: 2; min-width: 0; }
  .dash-col-side { grid-column: 3 / 4; grid-row: 2; min-width: 0; }
  @media (max-width: 1200px) {
    .dashboard-grid { grid-template-columns: 1fr 1fr; }
    .grid-head-accounts { grid-column: 1 / 3; grid-row: auto; }
    #colClaude { grid-column: 1 / 2; grid-row: auto; }
    #colCodex { grid-column: 2 / 3; grid-row: auto; }
    .grid-head-clients { grid-column: 1 / 3; grid-row: auto; }
    .dash-col-side { grid-column: 1 / 3; grid-row: auto; }
  }
  @media (max-width: 768px) {
    .dashboard-grid { grid-template-columns: 1fr; }
    .grid-head-accounts, .grid-head-clients, #colClaude, #colCodex, .dash-col-side { grid-column: 1 / 2; grid-row: auto; }
  }
  .account-col { background: var(--card-col-bg); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; min-width: 0; }
  .col-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid var(--line-subtle); }
  .col-title { font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; display: inline-flex; align-items: center; gap: 6px; }
  .col-title.claude { color: #d2a8ff; }
  .col-title.codex { color: #56d364; }
  .col-hint { font-size: 10.5px; color: var(--dim); font-weight: normal; }
  .account-list { display: flex; flex-direction: column; gap: 8px; }
  .client-keys-list { display: flex; flex-direction: column; gap: 8px; }
  .client-key-card { background: var(--card-bg); border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; box-sizing: border-box; transition: border-color .15s ease; }
  .client-key-card:hover { border-color: var(--card-hover-border); }
  .client-key-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .client-key-bottom { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-top: 6px; border-top: 1px solid var(--line-subtle); font-size: 11px; }
  .client-key-stats { font-size: 11px; color: var(--dim); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .card.draggable { cursor: grab; user-select: none; transition: opacity .15s ease, border-color .15s ease; }
  .card.draggable:active { cursor: grabbing; }
  .card.dragging { opacity: 0.35; border: 1px dashed var(--accent); }
  .card.drag-over-top { border-top: 2px solid var(--accent) !important; }
  .card.drag-over-bottom { border-bottom: 2px solid var(--accent) !important; }
  .drag-handle { cursor: grab; display: inline-flex; align-items: center; justify-content: center; color: var(--dim); font-size: 13px; padding: 0 2px 0 0; user-select: none; line-height: 1; opacity: 0.5; transition: opacity .15s ease; }
  .drag-handle:hover { opacity: 1; color: var(--text); }
  .drag-handle:active { cursor: grabbing; }
  .prio-badge { font-size: 10px; font-weight: 600; padding: 1px 5px; border-radius: 3px; background: rgba(88,166,255,0.1); border: 1px solid rgba(88,166,255,0.3); color: var(--accent); line-height: 1.2; }
  .prio-badge.prio-badge-top { font-weight: 700; background: rgba(56, 189, 248, 0.2); border-color: var(--accent); color: var(--accent); box-shadow: 0 0 6px rgba(56, 189, 248, 0.25); }

  .card { background: var(--card-bg); border: 1px solid var(--line); border-radius: 6px; padding: 8px 12px; margin-bottom: 0; box-sizing: border-box; transition: border-color .15s ease; }
  .account-list .card { display: flex; flex-direction: column; justify-content: space-between; min-height: 114px; }
  .card:hover { border-color: var(--card-hover-border); }
  .card-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
  .card-title-group { display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; min-width: 0; overflow: hidden; }
  .card-name-row { display: flex; align-items: center; margin: 2px 0 6px 0; min-height: 24px; width: 100%; }
  .card-name-display { display: flex; align-items: center; gap: 6px; width: 100%; min-width: 0; }
  .card-name-text { font-size: 13px; font-weight: 600; color: var(--heading); letter-spacing: -0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; transition: color .15s ease; }
  .card-name-text:hover { color: var(--accent); text-decoration: underline dotted; }
  .btn-rename { background: transparent; border: none; padding: 2px 4px; font-size: 11px; cursor: pointer; opacity: 0.45; transition: opacity .15s ease, transform .15s ease; border-radius: 3px; line-height: 1; color: var(--dim); }
  .btn-rename:hover { opacity: 1; transform: scale(1.12); color: var(--accent); background: var(--line-subtle); }
  .card-rename-form { display: flex; align-items: center; gap: 4px; width: 100%; }
  .card-rename-input { flex: 1; min-width: 0; background: var(--input-bg); border: 1px solid var(--accent); color: var(--heading); font-size: 12px; padding: 2px 6px; border-radius: 4px; outline: none; }
  .card-rename-input:focus { box-shadow: 0 0 0 2px var(--accent-glow); }
  .card-actions { display: flex; align-items: center; gap: 3px; margin-left: auto; flex-shrink: 0; }
  .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .name { font-size: 12.5px; font-weight: 600; color: var(--heading); letter-spacing: -0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tag { font-size: 11px; color: var(--dim); }
  .badge { font-size: 10px; padding: 1px 6px; border-radius: 3px; border: 1px solid var(--line-subtle); white-space: nowrap; line-height: 1.3; font-weight: 500; }
  .badge.active { color: var(--ok); border-color: rgba(63,185,80,0.3); background: rgba(63,185,80,0.06); }
  .badge.throttled { color: var(--warn); border-color: rgba(210,153,34,0.35); background: rgba(210,153,34,0.08); }
  .badge.error, .badge.exhausted, .badge.bad { color: var(--bad); border-color: rgba(248,81,73,0.35); background: rgba(248,81,73,0.08); }
  .badge.current { color: var(--accent); border-color: rgba(88,166,255,0.4); background: rgba(88,166,255,0.1); font-weight: 600; }
  .badge-healthy { color: #3fb950; border-color: rgba(63,185,80,0.4); background: rgba(63,185,80,0.12); font-weight: 600; }
  .card-healthy { border-color: rgba(63,185,80,0.25) !important; }
  .card-unhealthy { border-color: rgba(248,81,73,0.45) !important; background: rgba(248,81,73,0.03) !important; }
  .card-quota-exhausted { border-color: rgba(210,153,34,0.4) !important; background: rgba(210,153,34,0.03) !important; }
  .account-disabled { opacity: 0.6; filter: grayscale(0.5); }
  .btn-success { background: rgba(63,185,80,0.2) !important; color: #3fb950 !important; border-color: rgba(63,185,80,0.5) !important; }
  .btn-error { background: rgba(248,81,73,0.2) !important; color: #f85149 !important; border-color: rgba(248,81,73,0.5) !important; }
  .badge-plan { color: #d2a8ff; border-color: rgba(210,168,255,0.25); background: rgba(210,168,255,0.06); }
  .badge-codex { color: #56d364; border-color: rgba(86,211,100,0.25); background: rgba(86,211,100,0.06); }
  .badge-anthropic { color: #d2a8ff; border-color: rgba(210,168,255,0.25); background: rgba(210,168,255,0.06); }
  .badge-burn { color: #ff7b72; border-color: rgba(255,123,114,0.35); background: rgba(255,123,114,0.1); font-weight: 600; }
  .card-body { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 3px; margin: 3px 0; }
  .quota { display: grid; grid-template-columns: 48px 1fr auto; gap: 8px; align-items: center; }
  .quota .lbl { color: var(--dim); font-size: 10.5px; font-weight: 500; }
  .quota .val { color: var(--dim); font-size: 10.5px; text-align: right; font-variant-numeric: tabular-nums; }
  .bar { height: 4px; background: var(--line-subtle); border-radius: 2px; overflow: hidden; }
  .bar i { display: block; height: 100%; border-radius: 2px; background: var(--ok); transition: width .3s ease; }
  .bar i.warn { background: var(--warn); }
  .bar i.bad { background: var(--bad); }
  .card-meta { display: flex; align-items: center; flex-wrap: nowrap; gap: 4px 10px; margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--line-subtle); font-size: 11px; color: var(--dim); overflow: hidden; }
  .card-meta-item { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; }
  .card-meta-item.ok { color: var(--ok); }
  .card-meta-item.warn { color: var(--warn); }
  .card-meta-item.bad { color: var(--bad); }
  .card-meta-item.dim { opacity: 0.7; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 6px 8px; font-variant-numeric: tabular-nums; }
  th { color: var(--dim); font-size: 11px; font-weight: 600; border-bottom: 1px solid var(--line); }
  td { border-bottom: 1px solid var(--line); }
  tr:last-child td { border-bottom: none; }
  td.num, th.num { text-align: right; }
  .table-responsive { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .usage { color: var(--dim); font-size: 11px; }
  .blocked { color: var(--warn); font-size: 11px; margin: 2px 0; }
  .act { font: inherit; font-size: 11px; padding: 2px 8px; border-radius: 4px; border: 1px solid var(--accent); background: transparent; color: var(--accent); cursor: pointer; margin-left: auto; }
  .act:hover { background: var(--accent); color: var(--bg); }
  .act:disabled { opacity: .5; cursor: default; }

  /* Light theme component overrides */
  [data-theme="light"] .col-title.claude { color: #8250df; }
  [data-theme="light"] .col-title.codex { color: #1a7f37; }
  [data-theme="light"] .badge-plan { color: #8250df; border-color: rgba(130, 80, 223, 0.3); background: rgba(130, 80, 223, 0.08); }
  [data-theme="light"] .badge.current { color: #0969da; border-color: rgba(9, 105, 218, 0.35); background: rgba(9, 105, 218, 0.1); }
  [data-theme="light"] .badge.active { color: #1a7f37; border-color: rgba(26, 127, 55, 0.35); background: rgba(26, 127, 55, 0.08); }
  [data-theme="light"] .badge.throttled { color: #9a6700; border-color: rgba(154, 103, 0, 0.35); background: rgba(154, 103, 0, 0.08); }
  [data-theme="light"] .badge.error, [data-theme="light"] .badge.bad { color: #cf222e; border-color: rgba(207, 34, 46, 0.35); background: rgba(207, 34, 46, 0.08); }
  [data-theme="light"] .badge-healthy { color: #1a7f37; border-color: rgba(26, 127, 55, 0.4); background: rgba(26, 127, 55, 0.1); }
  [data-theme="light"] .card-healthy { border-color: rgba(26, 127, 55, 0.35) !important; background: rgba(26, 127, 55, 0.02) !important; }
  [data-theme="light"] .card-unhealthy { border-color: rgba(207, 34, 46, 0.45) !important; background: rgba(207, 34, 46, 0.03) !important; }
  [data-theme="light"] .card-quota-exhausted { border-color: rgba(154, 103, 0, 0.4) !important; background: rgba(154, 103, 0, 0.03) !important; }
  [data-theme="light"] .prio-badge { background: rgba(9, 105, 218, 0.08); border-color: rgba(9, 105, 218, 0.25); color: #0969da; }
  [data-theme="light"] .prio-badge.prio-badge-top { background: rgba(9, 105, 218, 0.16); border-color: #0969da; color: #0969da; box-shadow: 0 0 6px rgba(9, 105, 218, 0.2); }
  [data-theme="light"] .btn-icon:hover { background: rgba(0, 0, 0, 0.06); }
  [data-theme="light"] .btn-rename:hover { background: rgba(0, 0, 0, 0.06); }
  [data-theme="light"] .quick-station-box { background: rgba(9, 105, 218, 0.05) !important; border-color: rgba(9, 105, 218, 0.2) !important; }
  [data-theme="light"] .quick-cmd-wrap { background: #ffffff !important; border-color: #d0d7de !important; }
  [data-theme="light"] #quickCmdText { color: #0969da !important; }
  [data-theme="light"] #keybox button#go { color: #ffffff !important; }
  [data-theme="light"] .btn-accent { color: #ffffff !important; }
  [data-theme="light"] .tab-btn.active { color: #ffffff !important; }
  [data-theme="light"] .btn-xs.btn-accent { color: #ffffff !important; }
  #note { font-size: 12px; margin: 8px 0; padding: 6px 10px; border-radius: 5px; display: none; }
  #note.ok { background: rgba(63,185,80,.12); color: var(--ok); border: 1px solid var(--ok); }
  #note.warn { background: rgba(210,153,34,.12); color: var(--warn); border: 1px solid var(--warn); }
  #note.error { background: rgba(248,81,73,.12); color: var(--bad); border: 1px solid var(--bad); }
  .filters { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  .filters label { color: var(--dim); font-size: 11.5px; display: flex; align-items: center; gap: 4px; }
  .filters select { background: var(--bg); border: 1px solid var(--line); border-radius: 4px; color: var(--text); font: inherit; font-size: 11.5px; padding: 3px 6px; }
  .hint { color: var(--dim); font-size: 11.5px; margin-left: auto; }
  th.sortable { cursor: pointer; user-select: none; }
  th.sortable:hover { color: var(--text); }
  td.dim { color: var(--dim); }
  .ok { color: var(--ok); }
  .no { color: var(--dim); text-decoration: line-through; }
  .pin { color: var(--accent); font-size: 11.5px; }
  .warnt { color: var(--warn); font-size: 11.5px; }
  .badt { color: var(--bad); }
  #err { color: var(--bad); margin: 8px 0; display: none; font-size: 12px; }
  #problems { display: none; margin: 0 0 10px; }
  #problems div { border-radius: 5px; padding: 6px 10px; margin-bottom: 4px; font-size: 12px; }
  #problems .bad { background: rgba(248,81,73,.1); border: 1px solid var(--bad); color: var(--bad); }
  #problems .warn { background: rgba(210,153,34,.1); border: 1px solid var(--warn); color: var(--warn); }
  .sec-head { display: flex; align-items: center; justify-content: space-between; margin: 16px 0 6px; flex-wrap: wrap; gap: 8px; }
  .sec-head h2 { margin: 0; }
  .btn { font: inherit; font-size: 11.5px; padding: 3px 8px; min-height: 25px; border-radius: 4px; cursor: pointer; border: 1px solid var(--line); background: var(--panel); color: var(--text); display: inline-flex; align-items: center; justify-content: center; gap: 4px; transition: all .12s ease; }
  .btn:hover { background: var(--line); }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn-accent { background: var(--accent); color: #06121f; border-color: var(--accent); font-weight: 600; }
  .btn-accent:hover { filter: brightness(1.1); }
  .btn-sm { padding: 2px 6px; font-size: 11px; min-height: 22px; border-radius: 4px; }
  .btn-xs { font: inherit; font-size: 10.5px; padding: 1px 7px; min-height: 20px; border-radius: 3px; font-weight: 600; cursor: pointer; border: 1px solid var(--line); background: var(--panel); color: var(--text); display: inline-flex; align-items: center; justify-content: center; gap: 3px; transition: all .12s ease; }
  .btn-xs.btn-accent { background: var(--accent); color: #06121f; border-color: var(--accent); }
  .btn-xs.btn-accent:hover { filter: brightness(1.1); }
  .btn-icon { background: transparent; border: none; width: 22px; height: 22px; padding: 0; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; line-height: 1; color: var(--dim); border-radius: 4px; cursor: pointer; opacity: 0.65; transition: all .12s ease; }
  .btn-icon:hover { opacity: 1; background: rgba(255,255,255,0.08); color: var(--text); }
  .btn-icon.active { opacity: 1; color: #ff7b72; background: rgba(255,123,114,0.12); }
  .btn-icon-del:hover { background: rgba(248,81,73,0.15); color: var(--bad); }
  .btn-warn { border-color: rgba(210,153,34,0.5); color: var(--warn); background: transparent; }
  .btn-warn:hover { background: var(--warn); color: var(--bg); }
  .btn-bad { border-color: rgba(248,81,73,0.5); color: var(--bad); background: transparent; }
  .btn-bad:hover { background: var(--bad); color: var(--bg); }
  .btn-ok { border-color: rgba(63,185,80,0.5); color: var(--ok); background: transparent; }
  .btn-ok:hover { background: var(--ok); color: var(--bg); }
  .actions-group { display: flex; gap: 4px; align-items: center; margin-left: auto; flex-wrap: wrap; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 11.5px; }

  #keybox {
    display: none;
    margin: 50px auto 20px;
    max-width: 440px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 32px 28px;
    box-shadow: 0 16px 36px rgba(0,0,0,0.38), 0 2px 8px rgba(0,0,0,0.2);
    text-align: left;
  }
  .login-card-head { text-align: center; margin-bottom: 24px; }
  .login-card-icon {
    display: inline-flex; align-items: center; justify-content: center;
    width: 52px; height: 52px; border-radius: 12px;
    background: rgba(83,177,253,0.12); border: 1px solid rgba(83,177,253,0.3);
    color: var(--accent); margin-bottom: 14px;
  }
  .login-card-head h1 { font-size: 20px; font-weight: 700; margin-bottom: 6px; color: var(--text); }
  .login-card-head p { color: var(--dim); font-size: 13.5px; line-height: 1.5; margin: 0; }
  .login-field { margin-bottom: 18px; }
  .login-field label { display: block; font-size: 13px; font-weight: 600; color: var(--text); margin-bottom: 7px; }
  #keybox input {
    width: 100%; min-height: 42px; padding: 10px 14px;
    background: var(--bg); border: 1px solid var(--line); border-radius: 8px;
    color: var(--text); font: inherit; font-size: 14px; outline: none;
    box-sizing: border-box; transition: border-color 0.2s, box-shadow 0.2s;
  }
  #keybox input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(83,177,253,0.15); }
  #keybox button#go {
    width: 100%; min-height: 42px; padding: 10px 16px;
    background: var(--accent); border: 0; border-radius: 8px;
    color: #06121f; font: inherit; font-size: 14px; font-weight: 600;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    gap: 8px; transition: filter 0.15s;
  }
  #keybox button#go:hover { filter: brightness(1.1); }
  #keybox button#go:disabled { opacity: 0.6; cursor: not-allowed; }
  .login-card-foot {
    margin-top: 22px; padding-top: 14px; border-top: 1px solid var(--line);
    text-align: center; font-size: 12px; color: var(--dim);
  }

  /* Modal Overlay & Tabs */
  .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.78); backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; z-index: 9999; padding: 14px; }
  .modal-box { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; width: 100%; max-width: 580px; max-height: 90vh; overflow-y: auto; padding: 16px 18px; box-shadow: 0 16px 40px rgba(0,0,0,0.6); }
  .tabs-bar { display: flex; gap: 4px; border-bottom: 1px solid var(--line); padding-bottom: 8px; margin-bottom: 12px; flex-wrap: wrap; }
  .tab-btn { font: inherit; font-size: 11.5px; padding: 4px 10px; border-radius: 5px; border: 1px solid var(--line); background: transparent; color: var(--dim); cursor: pointer; white-space: nowrap; flex: 1 1 auto; text-align: center; }
  .tab-btn.active { background: var(--accent); color: #06121f; border-color: var(--accent); font-weight: 600; }
  .form-grid { display: grid; gap: 10px; grid-template-columns: 1fr; }
  .form-row { display: flex; gap: 8px; align-items: flex-end; }
  .form-grid label { display: block; font-size: 11.5px; color: var(--dim); margin-bottom: 4px; }
  .form-grid input, .form-grid textarea, .form-grid select { width: 100%; background: var(--bg); border: 1px solid var(--line); border-radius: 5px; color: var(--text); font: inherit; font-size: 12.5px; padding: 6px 9px; box-sizing: border-box; }
  .form-grid input:focus, .form-grid textarea:focus, .form-grid select:focus { border-color: var(--accent); outline: none; }
  footer { color: var(--dim); font-size: 11.5px; margin-top: 20px; }

  /* Mobile queries */
  @media (max-width: 768px) {
    body { padding: 10px 8px; font-size: 12.5px; }
    main { max-width: 100%; }
    .header-row { flex-direction: column; align-items: flex-start; gap: 8px; }
    .header-actions { width: 100%; flex-wrap: wrap; }
    .header-actions .btn { flex: 1 1 auto; min-height: 28px; }
    .sec-head { flex-direction: column; align-items: flex-start; gap: 8px; }
    .card { padding: 8px 10px; }
    .quota { grid-template-columns: 48px 1fr 90px; gap: 6px; font-size: 11px; }
    .quota .lbl, .quota .val { font-size: 11px; }
    .actions-group { width: 100%; justify-content: flex-start; flex-wrap: wrap; margin-top: 6px; margin-left: 0; }
    .actions-group .btn { flex: 1 1 auto; text-align: center; }
    .form-row { flex-direction: column; gap: 6px; }
    .form-row > div { width: 100% !important; }
    .modal-box { padding: 12px 10px; width: 100%; max-height: 94vh; }
    .tabs-bar { padding-bottom: 6px; flex-wrap: wrap; }
    .tab-btn { padding: 5px 8px; font-size: 11px; flex: 1 1 calc(50% - 4px); text-align: center; }
    #keybox { width: 100%; max-width: 100%; padding: 20px 14px; margin: 16px auto; }
    #keybox input { min-height: 38px; font-size: 14px; }
    #keybox button#go { width: 100%; min-height: 38px; }
    table { font-size: 11.5px; }
    th, td { padding: 6px 6px; }
  }
</style>
</head>
<body>
<main>
  <div id="keybox" style="display:none">
    <div style="display:flex; justify-content:flex-end; gap:6px; margin-bottom:10px;">
      <button class="btn btn-xs" id="btnLoginThemeToggle" type="button" title="Przełącz motyw / Switch theme">☀️ Jasny</button>
      <button class="btn btn-xs" id="btnLoginLangToggle" type="button" title="Przełącz język / Switch language">🇬🇧 EN</button>
    </div>
    <div class="login-card-head">
      <div class="login-card-icon">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        </svg>
      </div>
      <h1 data-i18n="loginTitle">Panel Zarządzania</h1>
      <p data-i18n="loginSubtitle">Wprowadź hasło, klucz administracyjny lub dowolny klucz stacji roboczej, aby uzyskać dostęp.</p>
    </div>
    <div id="keyboxErr" style="display:none;margin-bottom:16px;padding:10px 14px;border-radius:8px;background:rgba(239,68,68,0.12);border:1px solid var(--bad);color:var(--bad);font-size:13px;text-align:left"></div>
    <div id="keyboxInfo" style="display:none;margin-bottom:16px;padding:10px 14px;border-radius:8px;background:rgba(63,185,80,0.12);border:1px solid var(--ok);color:var(--ok);font-size:13px;text-align:left"></div>
    <div class="login-field">
      <label for="key" data-i18n="loginKeyLabel">Klucz dostępu (administracyjny lub stacji roboczej)</label>
      <input id="key" type="password" placeholder="tc-..." autocomplete="current-password" data-i18n-placeholder="loginKeyPlaceholder">
    </div>
    <button id="go" data-i18n="loginButton">Zaloguj się</button>
    <div class="login-card-foot" data-i18n="loginFoot">
      Agent LB &bull; Zabezpieczony dostęp administracyjny
    </div>
  </div>
  <div id="app" style="display:none">
    <div class="header-row">
      <div>
        <h1>Agent LB</h1>
        <p class="sub" id="summary"></p>
      </div>

      <div class="header-actions">
        <button class="btn btn-sm" id="btnThemeToggle" type="button" title="Przełącz motyw (Ciemny / Jasny)">☀️ Jasny</button>
        <button class="btn btn-sm" id="btnLangToggle" type="button" title="Przełącz język (Polski / English)">🇬🇧 EN</button>
        <button class="btn btn-sm btn-outline" id="btnTestFleet" title="Wyślij szybkie zapytanie testowe do wszystkich kont i zweryfikuj ich stan" data-i18n="btnTestFleet" data-i18n-title="btnTestFleetTitle">🩺 Testuj flotę</button>
        <button class="btn btn-sm btn-accent" id="btnOpenTestChat" title="Otwórz interaktywny czat testowy dla Claude i Codex" data-i18n="btnOpenTestChat" data-i18n-title="btnOpenTestChatTitle">💬 Test Chat</button>
        <button class="btn btn-sm" id="btnProbeQuota" title="Odpytaj o aktualne zużycie limitów i salda kont" data-i18n="btnProbeQuota" data-i18n-title="btnProbeQuotaTitle">⚡ Odśwież salda</button>
        <button class="btn btn-sm" id="btnReloadFleet" title="Przeładuj flotę kont z dysku" data-i18n="btnReloadFleet" data-i18n-title="btnReloadFleetTitle">🔄 Przeładuj flotę</button>
        <button class="btn btn-sm btn-bad" id="btnLogout" title="Wyloguj z panelu" data-i18n="btnLogout" data-i18n-title="btnLogoutTitle">🚪 Wyloguj</button>
      </div>
    </div>
    <div id="err"></div>
    <div id="problems"></div>
    <div id="note"></div>
    <div id="routesWrap" style="display:none">
      <h2 data-i18n="routesHeading">Routing</h2>
      <div class="card table-responsive" style="padding:4px 6px"><table id="routes"></table></div>
    </div>

    <div id="accounts" style="display:none"></div>
    <!-- Fleet Policy & Graceful Operations Panel -->
    <div class="policy-panel" id="fleetPolicyPanel">
      <div class="policy-panel-head">
        <div class="policy-head-left">
          <span class="policy-title-icon">⚖️</span>
          <div>
            <div class="policy-title-row">
              <h3 class="policy-title" data-i18n="policyTitle">Polityka routingu i działania floty</h3>
              <button class="btn btn-xs" id="btnTogglePolicyHelp" type="button" data-i18n="btnPolicyHelp">ℹ️ Wyjaśnienia</button>
            </div>
            <p class="policy-subtitle" data-i18n="policySubtitle">Inteligentny podział obciążenia, pamięć podręczna promptów i odporność na limity API.</p>
          </div>
        </div>
        <div class="policy-head-right">
          <span id="drainStatusBadge" class="badge error" style="display:none; font-size:11px;"></span>
          <button id="btnDrainToggle" class="btn btn-sm" data-i18n="btnDrainMode" data-i18n-title="btnDrainModeTitle" title="Przełącz tryb drain — dokończ aktywne żądania bez przyjmowania nowych">🛑 Drain Mode</button>
        </div>
      </div>

      <div class="policy-grid">
        <!-- Card 1: Session Affinity (Prompt Cache) -->
        <div class="policy-card">
          <div class="policy-card-top">
            <span class="policy-card-badge">PROMPT CACHE</span>
            <span class="policy-card-icon">⚡</span>
          </div>
          <div class="policy-card-head">
            <label for="selDistributeSessions" class="policy-card-label" data-i18n="policyCardAffinityTitle">Affinity (Prompt Cache)</label>
            <select id="selDistributeSessions" class="policy-select">
              <option value="adaptive" data-i18n="optAffinityAdaptive">Adaptive (Cache reuse + load balancing)</option>
              <option value="even" data-i18n="optAffinityEven">Even (Rozkładanie sesji wg liczby)</option>
              <option value="off" data-i18n="optAffinityOff">Off (Czysta rotacja)</option>
            </select>
          </div>
          <p class="policy-card-desc" id="descAffinity" data-i18n="policyCardAffinityDesc">
            Kieruje kolejne zapytania tej samej sesji (projektu) do tego samego konta, aby wykorzystać pamięć podręczną Anthropic Prompt Cache (-90% kosztów tokenów wejściowych i 3-5x szybsza odpowiedź).
          </p>
        </div>

        <!-- Card 2: Earliest-Reset-First -->
        <div class="policy-card">
          <div class="policy-card-top">
            <span class="policy-card-badge">SMART ROTATION</span>
            <span class="policy-card-icon">🕒</span>
          </div>
          <div class="policy-card-head">
            <label class="policy-check-label" title="Kieruj nowe sesje do kont, których 5h limit resetuje się najszybciej">
              <input type="checkbox" id="chkExpiryRouting" class="policy-checkbox">
              <span class="policy-card-label" data-i18n="policyCardResetTitle">Earliest-Reset-First</span>
            </label>
          </div>
          <p class="policy-card-desc" id="descReset" data-i18n="policyCardResetDesc">
            Gdy rozpoczyna się nowa sesja, wybiera konto, którego limit 5h lub 7d zresetuje się najszybciej. Zapobiega blokowaniu floty i maksymalizuje łączną dostępność.
          </p>
        </div>

        <!-- Card 3: Cross-Provider Fallback -->
        <div class="policy-card">
          <div class="policy-card-top">
            <span class="policy-card-badge">ZERO DOWNTIME</span>
            <span class="policy-card-icon">🔄</span>
          </div>
          <div class="policy-card-head">
            <label class="policy-check-label" title="Gdy wszystkie konta Claude są wyczerpane, przekieruj zapytanie do OpenAI Codex">
              <input type="checkbox" id="chkCrossProviderFallback" class="policy-checkbox">
              <span class="policy-card-label" data-i18n="policyCardFallbackTitle">Cross-Provider Fallback</span>
            </label>
          </div>
          <p class="policy-card-desc" id="descFallback" data-i18n="policyCardFallbackDesc">
            W przypadku wyczerpania limitów wszystkich kont Claude lub blokady upstreamu, automatycznie przekierowuje zapytania do OpenAI Codex (i odwrotnie), zapewniając zerowy przestój.
          </p>
        </div>

        <!-- Card 4: Auto-Health -->
        <div class="policy-card">
          <div class="policy-card-top">
            <span class="policy-card-badge">DIAGNOSTICS</span>
            <span id="autoHealthBadge" class="badge" style="font-size:10px; padding:1px 6px; display:none;"></span>
          </div>
          <div class="policy-card-head">
            <label class="policy-check-label" title="Inteligentne okresowe sprawdzanie dostępności (0 tokenów dla aktywnych, 1 token dla bezczynnych)">
              <input type="checkbox" id="chkAutoHealthCheck" class="policy-checkbox">
              <span class="policy-card-label" data-i18n="policyCardHealthTitle">Auto-Health</span>
            </label>
          </div>
          <p class="policy-card-desc" id="descHealth" data-i18n="policyCardHealthDesc">
            Okresowe badanie stanu kont w tle (co 15 min). Bezpieczne dla limitów: 0 tokenów dla aktywnych kont, 1 mikro-token dla kont bezczynnych. Błyskawicznie wykrywa odblokowanie kont.
          </p>
        </div>
      </div>
    </div>
    <div class="dashboard-grid" id="accountsGrid">
      <!-- Sekcja nagłówka kont -->
      <div class="grid-head-accounts">
        <div class="sec-head" style="margin:0 0 4px; justify-content:flex-start; gap:12px;">
          <h2 data-i18n="accountsHeading">Konta Claude & Codex</h2>
          <span style="font-size:11px; color:var(--dim);" data-i18n="accountsHint">💡 Przeciągnij kartę ⠿ w kolumnie, aby zmienić priorytet</span>
        </div>
      </div>

      <!-- Sekcja nagłówka kluczy klientów -->
      <div class="grid-head-clients">
        <div class="sec-head" style="margin:0 0 4px;">
          <h2 data-i18n="clientsHeading">Stacje robocze & Klucze</h2>
        </div>
      </div>

      <!-- Column 1: Claude (Anthropic) -->
      <div class="account-col" id="colClaude">
        <div class="col-head">
          <div class="row" style="gap:6px; align-items:center;">
            <span class="col-title claude" data-i18n="colClaudeTitle">🟣 Claude (Anthropic)</span>
            <span class="col-hint" id="countClaude">0 kont</span>
          </div>
          <button class="btn btn-sm btn-accent" id="btnAddClaudeCol" style="padding:2px 8px; font-size:11px;" title="Dodaj konto Claude (Anthropic)" data-i18n="btnAddAccount">➕ Dodaj konto</button>
        </div>
        <div class="account-list" id="listClaude" data-provider="anthropic"></div>
      </div>

      <!-- Column 2: OpenAI Codex -->
      <div class="account-col" id="colCodex">
        <div class="col-head">
          <div class="row" style="gap:6px; align-items:center;">
            <span class="col-title codex" data-i18n="colCodexTitle">🟢 OpenAI Codex</span>
            <span class="col-hint" id="countCodex">0 kont</span>
          </div>
          <button class="btn btn-sm btn-accent" id="btnAddCodexCol" style="padding:2px 8px; font-size:11px;" title="Dodaj konto OpenAI Codex" data-i18n="btnAddAccount">➕ Dodaj konto</button>
        </div>
        <div class="account-list" id="listCodex" data-provider="codex"></div>
      </div>

      <!-- Column 3: Klucze klientów & Narzędzia -->
      <div class="account-col dash-col-side" id="colClients">
        <div class="col-head">
          <div class="row" style="gap:6px; align-items:center;">
            <span class="col-title" style="color:#58a6ff;" data-i18n="colClientsTitle">🔑 Klucze klientów</span>
            <span class="col-hint" id="countClientKeys">0 kluczy</span>
          </div>
          <div class="row" style="gap:4px;">
            <button class="btn btn-sm" id="btnPullSetupRepo" style="padding:2px 7px; font-size:11px;" title="Pobierz najnowsze skrypty instalatora z GitHub (git pull)" data-i18n="btnUpdate" data-i18n-title="btnUpdateTitle">🔄 Aktualizuj</button>
            <button class="btn btn-sm btn-accent" id="btnShowAddClientKey" style="padding:2px 7px; font-size:11px;" title="Utwórz nowy klucz klienta" data-i18n="btnNewKey">➕ Nowy klucz</button>
          </div>
        </div>

        <div class="card quick-station-box" style="margin-bottom:8px; background:rgba(83,177,253,0.06); border-color:rgba(83,177,253,0.2); padding:8px 10px;">
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:5px;">
            <span style="font-weight:600; font-size:11.5px; color:var(--heading);" data-i18n="quickConnectTitle">⚡ Szybkie podłączenie stacji:</span>
            <div style="display:flex; gap:3px;">
              <button class="btn btn-xs active" id="btnQuickTabBash" type="button" style="padding:1px 7px; font-size:10px;" title="Skrypt instalacyjny Linux, macOS, WSL (Bash)">Linux / macOS</button>
              <button class="btn btn-xs" id="btnQuickTabPS" type="button" style="padding:1px 7px; font-size:10px;" title="Skrypt instalacyjny Windows (PowerShell)">Windows</button>
            </div>
          </div>
          <div class="quick-cmd-wrap" style="display:flex; align-items:center; gap:6px; background:rgba(13,17,23,0.85); border:1px solid var(--line); border-radius:4px; padding:4px 7px;">
            <code id="quickCmdText" class="mono" style="flex:1; font-size:10.5px; color:#58a6ff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:pointer;" title="Kliknij, aby skopiować pełną komendę"></code>
            <button class="btn btn-xs btn-accent" id="btnQuickCopyCmd" type="button" style="flex-shrink:0; padding:1px 7px;" title="Kopiuj polecenie do schowka" data-i18n="copyCmd">📋 Kopiuj</button>
          </div>
          <div style="display:flex; align-items:center; justify-content:space-between; margin-top:4px; font-size:10.5px; color:var(--dim);">
            <label style="display:inline-flex; align-items:center; gap:4px; cursor:pointer; user-select:none; color:var(--text);" title="Odznacz, jeśli chcesz uruchomić czystą komendę — instalator sam zapyta o wklejenie klucza">
              <input type="checkbox" id="chkIncludeKeyInCmd" checked style="margin:0; cursor:pointer;"> <span data-i18n="includeKey">Dołącz klucz</span>
            </label>
            <a href="https://github.com/tomaasz/agent-lb" target="_blank" rel="noopener" style="color:var(--accent); text-decoration:none; font-size:10.5px;" data-i18n="githubGuide">instrukcja GitHub ↗</a>
          </div>
        </div>

        <div id="clientKeysTable" class="client-keys-list"></div>

        <div id="clientsWrap" style="display:none; margin-top:8px;">
          <h2>Clients</h2>
          <div class="card table-responsive" style="padding:4px 6px"><table id="clients"></table></div>
        </div>
        <div id="dimensionsWrap"></div>
        <div id="sessionsWrap" style="display:none">
          <h2>Sessions</h2>
          <div class="card" style="padding:0">
            <div class="filters">
              <label>Project <select id="fProject"></select></label>
              <label>Client <select id="fClient"></select></label>
              <span class="hint" id="sessionCount"></span>
            </div>
            <div class="table-responsive" style="padding:4px 6px"><table id="sessions"></table></div>
          </div>
        </div>
      </div>
    </div>
    <footer id="foot"></footer>
  </div>

  <!-- MODAL: TEST CHAT -->
  <div id="modalTestChat" class="modal-backdrop" style="display:none;">
    <div class="modal-box" style="max-width:700px; width:95%; display:flex; flex-direction:column; max-height:92vh;">
      <div class="row" style="justify-content:space-between; align-items:center; margin-bottom:12px; padding-bottom:8px; border-bottom:1px solid var(--line);">
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="font-weight:700; font-size:16px;">💬 Test Chat — Claude & Codex Playground</span>
          <span class="badge" style="background:rgba(88,166,255,0.15); color:var(--accent); font-size:10.5px;">Live Upstream Test</span>
        </div>
        <div style="display:flex; align-items:center; gap:6px;">
          <button class="btn btn-sm" id="btnTestChatHeaderCopy" title="Skopiuj całą historię rozmowy do schowka">📋 Kopiuj czat</button>
          <button class="btn btn-sm" id="btnCloseTestChat">✕ Zamknij</button>
        </div>
      </div>

      <!-- Controls row -->
      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:10px; margin-bottom:10px; background:rgba(13,17,23,0.6); padding:10px 12px; border:1px solid var(--line); border-radius:6px;">
        <div>
          <label for="selTestProvider" style="display:block; font-size:11px; font-weight:600; color:var(--dim); margin-bottom:4px;">Dostawca (Provider):</label>
          <select id="selTestProvider" class="btn btn-sm" style="width:100%; text-align:left; background:var(--bg); color:var(--text); border:1px solid var(--line); border-radius:4px; padding:4px 8px;">
            <option value="anthropic">🟣 Claude (Anthropic)</option>
            <option value="codex">🟢 Codex (ChatGPT / OpenAI)</option>
          </select>
        </div>
        <div>
          <label for="selTestModel" style="display:block; font-size:11px; font-weight:600; color:var(--dim); margin-bottom:4px;">Model:</label>
          <select id="selTestModel" class="btn btn-sm" style="width:100%; text-align:left; background:var(--bg); color:var(--text); border:1px solid var(--line); border-radius:4px; padding:4px 8px;">
            <!-- populated dynamically according to provider -->
          </select>
        </div>
        <div id="colTestEffort" style="display:none;">
          <label for="selTestEffort" style="display:block; font-size:11px; font-weight:600; color:var(--dim); margin-bottom:4px;">Rozumowanie (Effort):</label>
          <select id="selTestEffort" class="btn btn-sm" style="width:100%; text-align:left; background:var(--bg); color:var(--text); border:1px solid var(--line); border-radius:4px; padding:4px 8px;">
            <option value="">⚡ Domyślne (Default)</option>
            <option value="minimal">🟢 Minimalne (Minimal)</option>
            <option value="low">🟢 Niskie (Low)</option>
            <option value="medium" selected>🟡 Średnie (Medium)</option>
            <option value="high">🔴 Wysokie (High)</option>
            <option value="max">🔥 Maksymalne (Max)</option>
          </select>
        </div>
        <div>
          <label for="selTestAccount" style="display:block; font-size:11px; font-weight:600; color:var(--dim); margin-bottom:4px;">Konto (Routing):</label>
          <select id="selTestAccount" class="btn btn-sm" style="width:100%; text-align:left; background:var(--bg); color:var(--text); border:1px solid var(--line); border-radius:4px; padding:4px 8px;">
            <option value="">⚡ Auto (Agent-LB Policy)</option>
            <!-- populated with account list -->
          </select>
        </div>
      </div>

      <!-- Quick prompts pills -->
      <div style="display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin-bottom:10px;">
        <span style="font-size:11px; color:var(--dim);">Szybkie testy:</span>
        <button type="button" class="btn btn-xs quick-prompt-btn" data-prompt="Cześć! Przedstaw się w jednym zdaniu i potwierdź, że połączenie działa." style="border-radius:12px; font-size:10.5px; padding:2px 8px; background:rgba(88,166,255,0.1); border-color:rgba(88,166,255,0.3); color:#79c0ff;">👋 Przedstaw się</button>
        <button type="button" class="btn btn-xs quick-prompt-btn" data-prompt="Odpowiedz jednym słowem: PONG" style="border-radius:12px; font-size:10.5px; padding:2px 8px; background:rgba(88,166,255,0.1); border-color:rgba(88,166,255,0.3); color:#79c0ff;">⚡ Ping</button>
        <button type="button" class="btn btn-xs quick-prompt-btn" data-prompt="Oblicz 256 * 64 i podaj sam wynik liczbowy." style="border-radius:12px; font-size:10.5px; padding:2px 8px; background:rgba(88,166,255,0.1); border-color:rgba(88,166,255,0.3); color:#79c0ff;">🧮 256 * 64</button>
        <button type="button" class="btn btn-xs quick-prompt-btn" data-prompt="Napisz zwięzłe dwuwersowe haiku o load balancerze Claude." style="border-radius:12px; font-size:10.5px; padding:2px 8px; background:rgba(88,166,255,0.1); border-color:rgba(88,166,255,0.3); color:#79c0ff;">📝 Haiku</button>
      </div>

      <!-- Chat History Box -->
      <div id="testChatHistory" style="flex:1; min-height:240px; max-height:380px; overflow-y:auto; background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:12px; margin-bottom:12px; display:flex; flex-direction:column; gap:12px;">
        <div id="testChatPlaceholder" style="margin:auto; text-align:center; color:var(--dim); font-size:12px;">
          <div style="font-size:26px; margin-bottom:6px;">💬</div>
          Wybierz dostawcę i model, a następnie wpisz wiadomość lub kliknij szybki test.<br>
          Żądanie zostanie wysłane przez silnik Agent-LB bezpośrednio do wybranego upstreamu.
        </div>
      </div>

      <!-- Chat Input and Actions -->
      <div style="display:flex; flex-direction:column; gap:8px;">
        <textarea id="testChatMessage" rows="2" placeholder="Wpisz treść wiadomości testowej (Enter wysyła, Shift+Enter nowa linia)..." style="width:100%; box-sizing:border-box; background:var(--bg); color:var(--text); border:1px solid var(--line); border-radius:6px; padding:8px 10px; font-family:inherit; font-size:12.5px; resize:vertical;"></textarea>
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
          <div style="display:flex; gap:6px; align-items:center;">
            <button class="btn btn-sm" id="btnTestChatCopy" type="button" style="font-size:11px; padding:4px 10px;" title="Skopiuj całą historię rozmowy do schowka">📋 Kopiuj czat</button>
            <button class="btn btn-sm" id="btnTestChatClear" type="button" style="font-size:11px; padding:4px 10px;" title="Wyczyść historię czatu">🗑️ Wyczyść historię</button>
          </div>
          <div style="display:flex; gap:8px; align-items:center;">
            <span id="testChatStatus" style="font-size:11.5px; color:var(--dim);"></span>
            <button class="btn btn-sm btn-accent" id="btnTestChatSend" type="button" style="font-weight:600; padding:5px 16px;">Wyślij zapytanie 🚀</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- MODAL: ADD ACCOUNT -->
  <div id="modalAddAccount" class="modal-backdrop" style="display:none;">
    <div class="modal-box">
      <div class="row" style="justify-content:space-between; margin-bottom:12px;">
        <span id="modalAddAccountTitle" style="font-weight:600; font-size:15px;">➕ Dodaj konto</span>
        <button class="btn btn-sm" id="btnCloseAddAccount">✕ Zamknij</button>
      </div>
      <div style="margin-bottom:12px; display:flex; align-items:center; gap:14px; background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:8px 12px;">
        <span style="font-size:13px; color:var(--dim); font-weight:600;">Dostawca:</span>
        <label style="display:flex; align-items:center; gap:6px; cursor:pointer; font-size:13px;">
          <input type="radio" name="addAccountProvider" value="anthropic" checked id="radioProvAnthropic"> 🟣 Anthropic (Claude)
        </label>
        <label style="display:flex; align-items:center; gap:6px; cursor:pointer; font-size:13px;">
          <input type="radio" name="addAccountProvider" value="codex" id="radioProvCodex"> 🟢 OpenAI (Codex / ChatGPT)
        </label>
      </div>
      <div class="tabs-bar">
        <button class="tab-btn active" id="tabBtnApiKey">Klucz API Console</button>
        <button class="tab-btn" id="tabBtnOAuth">Wklej sesję OAuth</button>
        <button class="tab-btn" id="tabBtnImport">Import ze ścieżki</button>
        <button class="tab-btn" id="tabBtnBrowserOAuth">Logowanie w przeglądarce</button>
      </div>

      <!-- Tab 1: API Key -->
      <div id="tabContentApiKey" class="tab-content">
        <div class="form-grid">
          <div>
            <label id="lblApiKey">Klucz API Anthropic Console (sk-ant-...) *</label>
            <input id="inApiKey" type="password" placeholder="sk-ant-api03-..." autocomplete="off">
          </div>
          <div class="form-row">
            <div style="flex:1;">
              <label>Nazwa konta (opcjonalnie)</label>
              <input id="inApiKeyName" type="text" placeholder="np. api-console-1">
            </div>
            <div style="width:110px;">
              <label>Priorytet</label>
              <input id="inApiKeyPrio" type="number" value="0">
            </div>
          </div>
          <div style="margin-top:8px;">
            <button class="btn btn-accent" id="btnSubmitApiKey">Dodaj konto API</button>
          </div>
        </div>
      </div>

      <!-- Tab 2: OAuth paste JSON/tokens -->
      <div id="tabContentOAuth" class="tab-content" style="display:none;">
        <div class="form-grid">
          <p id="pOAuthHelp" style="color:var(--dim); font-size:12px;">
            Wklej zawartość pliku <code>~/.claude/.credentials.json</code> lub podaj tokeny z sesji OAuth:
          </p>
          <div>
            <label>Wklej cały JSON poświadczeń (.credentials.json)</label>
            <textarea id="inOAuthJson" rows="4" placeholder='{"claudeAiOauth":{"accessToken":"...","refreshToken":"...","expiresAt":...}}' class="mono"></textarea>
          </div>
          <div class="form-row">
            <div style="flex:1;">
              <label>AccessToken (jeśli nie wklejasz JSON)</label>
              <input id="inOAuthAccess" type="password" placeholder="ey..." autocomplete="off">
            </div>
            <div style="flex:1;">
              <label>RefreshToken (opcjonalnie)</label>
              <input id="inOAuthRefresh" type="password" placeholder="ey..." autocomplete="off">
            </div>
          </div>
          <div class="form-row">
            <div style="flex:1;">
              <label>Nazwa konta (opcjonalnie)</label>
              <input id="inOAuthName" type="text" placeholder="np. dev@firma.pl">
            </div>
            <div style="width:110px;">
              <label>Priorytet</label>
              <input id="inOAuthPrio" type="number" value="0">
            </div>
          </div>
          <div style="margin-top:8px;">
            <button class="btn btn-accent" id="btnSubmitOAuth">Zapisz sesję OAuth</button>
          </div>
        </div>
      </div>

      <!-- Tab 3: Import from server file path -->
      <div id="tabContentImport" class="tab-content" style="display:none;">
        <div class="form-grid">
          <p style="color:var(--dim); font-size:12px;">
            Wczytaj poświadczenia bezpośrednio z pliku na serwerze:
          </p>
          <div>
            <label>Ścieżka do pliku na serwerze *</label>
            <input id="inImportPath" type="text" value="~/.claude/.credentials.json" class="mono">
          </div>
          <div class="form-row">
            <div style="flex:1;">
              <label>Nazwa konta (opcjonalnie)</label>
              <input id="inImportPathName" type="text" placeholder="np. claude-local">
            </div>
            <div style="width:110px;">
              <label>Priorytet</label>
              <input id="inImportPathPrio" type="number" value="0">
            </div>
          </div>
          <div style="margin-top:8px;">
            <button class="btn btn-accent" id="btnSubmitImportPath">Importuj z pliku</button>
          </div>
        </div>
      </div>

      <!-- Tab 4: Browser OAuth -->
      <div id="tabContentBrowserOAuth" class="tab-content" style="display:none;">
        <div class="form-grid">
          <div id="oauthStep1">
            <p id="pBrowserOAuthHelp" style="color:var(--dim); font-size:12px; margin-bottom:10px;">
              Zaloguj się na konto Claude w przeglądarce za pomocą bezpiecznego przepływu PKCE.
            </p>
            <button class="btn btn-accent" id="btnStartOAuth">Rozpocznij logowanie Claude</button>
          </div>
          <div id="oauthStep2" style="display:none;">
            <p style="font-size:12px; margin-bottom:6px;">
              1. Jeśli okno logowania się nie otworzyło, <a id="oauthLink" href="#" target="_blank" style="color:var(--accent); text-decoration:underline;">kliknij tutaj ↗</a>.
            </p>
            <p id="pOAuthStep2Help" style="font-size:12px; color:var(--dim); margin-bottom:8px;">
              2. Zaloguj się w Claude.ai i skopiuj kod autoryzacyjny lub pełny adres URL:
            </p>
            <div>
              <label>Kod autoryzacyjny lub callback URL *</label>
              <input id="inOAuthCode" type="text" placeholder="Wklej kod lub URL callback..." class="mono">
            </div>
            <div class="form-row" style="margin-top:8px;">
              <div style="flex:1;">
                <label>Nazwa konta (opcjonalnie)</label>
                <input id="inOAuthFlowName" type="text" placeholder="np. konto-osobiste">
              </div>
              <div style="width:110px;">
                <label>Priorytet</label>
                <input id="inOAuthFlowPrio" type="number" value="0">
              </div>
            </div>
            <div class="row" style="gap:8px; margin-top:10px;">
              <button class="btn btn-accent" id="btnCompleteOAuth">Dokończ autoryzację</button>
              <button class="btn" id="btnCancelOAuth">Wróć</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- MODAL: RE-LOGIN ACCOUNT -->
  <div id="modalRelogin" class="modal-backdrop" style="display:none;">
    <div class="modal-box" style="max-width:620px;">
      <div class="row" style="justify-content:space-between; margin-bottom:12px;">
        <span style="font-weight:600; font-size:16px;">🔐 Ponowne logowanie: <span id="reloginAccountTitle" class="mono" style="color:var(--accent);"></span></span>
        <button class="btn btn-sm" id="btnCloseReloginModal">✕ Zamknij</button>
      </div>
      <p style="color:var(--dim); font-size:13px; margin-bottom:14px;">
        Sesja tego konta wygasła lub token został odrzucony przez serwery Claude. Zaloguj się ponownie w Claude.ai, aby odnowić poświadczenia i natychmiast przywrócić konto do rotacji.
      </p>

      <div class="tabs-bar" style="margin-bottom:14px;">
        <button class="tab-btn active" id="tabBtnReloginBrowser" type="button">🌐 Przeglądarka (OAuth)</button>
        <button class="tab-btn" id="tabBtnReloginJson" type="button">📋 Wklej JSON / Token</button>
        <button class="tab-btn" id="tabBtnReloginImport" type="button">📂 Plik na serwerze</button>
      </div>

      <!-- Tab 1: Browser OAuth -->
      <div id="tabContentReloginBrowser">
        <div id="reloginOAuthStep1">
          <div style="background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:12px 14px; margin-bottom:14px;">
            <div style="font-weight:600; font-size:13.5px; margin-bottom:4px;">Krok 1: Otwórz stronę logowania Claude.ai</div>
            <div style="font-size:12.5px; color:var(--dim); line-height:1.4;">
              Kliknij poniższy przycisk. Otworzy się nowa karta z oficjalną stroną autoryzacji Claude.ai. Upewnij się, że logujesz się na właściwe konto (<b id="reloginStep1Email" style="color:var(--text);"></b>).
            </div>
          </div>
          <button class="btn btn-accent" id="btnStartReloginOAuth" style="width:100%; justify-content:center; padding:10px 14px; font-weight:600;">
            🌐 Otwórz logowanie Claude.ai w nowej karcie
          </button>
        </div>

        <div id="reloginOAuthStep2" style="display:none;">
          <div style="background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:12px 14px; margin-bottom:12px;">
            <div style="font-weight:600; font-size:13px; margin-bottom:4px;">Krok 2: Skopiuj i wklej kod autoryzacyjny</div>
            <div style="font-size:12.5px; color:var(--dim); line-height:1.4;">
              Po zalogowaniu i zatwierdzeniu w Claude.ai, skopiuj wyświetlony kod autoryzacyjny (lub cały adres URL callback z paska adresu) i wklej poniżej:
              Po zalogowaniu i zatwierdzeniu na koncie (<b id="reloginStep2Email" style="color:var(--text);"></b>) w Claude.ai, skopiuj wyświetlony kod autoryzacyjny (lub cały adres URL callback z paska adresu) i wklej poniżej:
            </div>
            <div style="font-size:12px; margin-top:6px;">
              <span style="color:var(--dim);">Okno logowania się nie otworzyło? </span>
              <a id="reloginOAuthLink" href="#" target="_blank" rel="noopener" style="color:var(--accent); text-decoration:underline;">Kliknij tutaj, aby otworzyć ↗</a>
            </div>
          </div>

          <div style="margin-bottom:12px;">
            <label style="font-size:12px; color:var(--dim); display:block; margin-bottom:4px;">Kod autoryzacyjny lub callback URL *</label>
            <input id="inReloginOAuthCode" type="text" placeholder="Wklej kod lub URL callback (https://claude.ai/oauth/callback?code=...)" class="mono" style="width:100%;">
          </div>

          <div class="row" style="gap:8px;">
            <button class="btn btn-accent" id="btnCompleteReloginOAuth">✅ Odnów sesję i zaloguj</button>
            <button class="btn" id="btnRestartReloginOAuth">↺ Uruchom ponownie logowanie</button>
          </div>
        </div>
      </div>

      <!-- Tab 2: Paste JSON -->
      <div id="tabContentReloginJson" style="display:none;">
        <div style="font-size:12.5px; color:var(--dim); margin-bottom:8px;">
          Wklej zawartość pliku <code>~/.claude/.credentials.json</code> lub JSON z tokenami sesji OAuth:
        </div>
        <textarea id="inReloginJson" rows="4" placeholder='{"claudeAiOauth":{"accessToken":"...","refreshToken":"..."}}' class="mono" style="width:100%; margin-bottom:10px;"></textarea>
        <button class="btn btn-accent" id="btnSubmitReloginJson">Zapisz poświadczenia</button>
      </div>

      <!-- Tab 3: Import from file -->
      <div id="tabContentReloginImport" style="display:none;">
        <div style="font-size:12.5px; color:var(--dim); margin-bottom:8px;">
          Wczytaj nowe poświadczenia z pliku zapisanego na serwerze (np. po <code>claude login</code> w konsoli):
        </div>
        <div style="margin-bottom:10px;">
          <label style="font-size:12px; color:var(--dim); display:block; margin-bottom:4px;">Ścieżka do pliku *</label>
          <input id="inReloginImportPath" type="text" value="~/.claude/.credentials.json" class="mono" style="width:100%;">
        </div>
        <button class="btn btn-accent" id="btnSubmitReloginImport">Importuj z pliku</button>
      </div>
    </div>
  </div>

  <!-- MODAL: ADD CLIENT KEY -->
  <div id="modalAddClientKey" class="modal-backdrop" style="display:none;">
    <div class="modal-box">
      <div class="row" style="justify-content:space-between; margin-bottom:12px;">
        <span style="font-weight:600; font-size:15px;">➕ Utwórz klucz klienta</span>
        <button class="btn btn-sm" id="btnCloseAddClientKey">✕ Zamknij</button>
      </div>
      <div class="form-grid">
        <p style="color:var(--dim); font-size:12px;">
          Wygeneruj dedykowany klucz dostępu dla maszyny, developera lub agenta. Statystyki zapytań i tokenów będą zliczane dla tej nazwy.
        </p>
        <div>
          <label>Nazwa użytkownika / urządzenia *</label>
          <input id="inClientName" type="text" placeholder="np. Laptop Tomasz, Jan Kowalski, CI Worker" required>
        </div>
        <div>
          <label>Własny klucz (opcjonalnie)</label>
          <input id="inClientCustomKey" type="text" placeholder="Pozostaw puste dla losowego tc-..." class="mono">
        </div>
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
          <div>
            <label>Dzienny limit tokenów (opcjonalnie)</label>
            <input id="inClientDailyTokens" type="number" min="1" placeholder="np. 500000 (puste = bez limitu)">
          </div>
          <div>
            <label>Miesięczny limit tokenów (opcjonalnie)</label>
            <input id="inClientMonthlyTokens" type="number" min="1" placeholder="np. 10000000 (puste = bez limitu)">
          </div>
        </div>
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
          <div>
            <label>Ważny do (data wygaśnięcia, opcjonalnie)</label>
            <input id="inClientExpiresAt" type="date">
          </div>
          <div>
            <label>Dozwolone modele (opcjonalnie)</label>
            <input id="inClientAllowedModels" type="text" placeholder="np. claude-*, gpt-4o">
          </div>
        </div>
        <div style="margin-top:8px;">
          <button class="btn btn-accent" id="btnSubmitClientKey">Utwórz klucz</button>
        </div>
      </div>
    </div>
  </div>

  <!-- MODAL: CLIENT KEY SETUP & CONNECT -->
  <div id="modalKeyCreated" class="modal-backdrop" style="display:none;">
    <div class="modal-box" style="max-width:700px;">
      <div class="row" style="justify-content:space-between; margin-bottom:12px;">
        <span style="font-weight:600; color:var(--ok); font-size:16px;">🚀 Podłączanie klienta Claude</span>
        <button class="btn btn-sm" id="btnCloseKeyModal">✕ Zamknij</button>
      </div>

      <div style="background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:12px 14px; margin-bottom:14px;">
        <div class="row" style="justify-content:space-between; align-items:center;">
          <div>
            <div style="color:var(--dim); font-size:12px;">Urządzenie / Klient: <b id="createdClientName" style="color:var(--text); font-size:13.5px;"></b></div>
            <div class="mono" id="createdClientKey" style="font-size:13.5px; word-break:break-all; color:var(--accent); font-weight:600; margin-top:3px;"></div>
          </div>
          <button class="btn btn-sm btn-accent" id="btnCopyCreatedKey">📋 Kopiuj klucz</button>
        </div>
      </div>

      <div style="margin-bottom:10px;">
        <div class="tabs-bar" style="margin-bottom:12px;">
          <button class="tab-btn active" id="tabSetupBash" type="button">🐧 Linux / macOS / WSL</button>
          <button class="tab-btn" id="tabSetupPowershell" type="button">🪟 Windows (PowerShell)</button>
          <button class="tab-btn" id="tabSetupNode" type="button">⚡ Node.js</button>
          <button class="tab-btn" id="tabSetupGit" type="button">📦 Git Clone</button>
          <button class="tab-btn" id="tabSetupManual" type="button">⚙️ Ręcznie</button>
        </div>

        <div id="contentSetupBash">
          <div style="font-size:13px; color:var(--dim); margin-bottom:6px;">1. Claude Code CLI & VS Code:</div>
          <div style="background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:8px 12px; margin-bottom:8px;">
            <code class="mono" id="cmdSetupBash" style="display:block; word-break:break-all; font-size:12.5px; color:#e6edf3;"></code>
          </div>
          <button class="btn btn-sm btn-accent" id="btnCopySetupBash" style="margin-bottom:14px;">📋 Kopiuj polecenie Claude</button>

          <div style="font-size:13px; color:var(--dim); margin-bottom:6px;">2. OpenAI Codex CLI & VS Code (codexlb-setup):</div>
          <div style="background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:8px 12px; margin-bottom:8px;">
            <code class="mono" id="cmdSetupCodexBash" style="display:block; word-break:break-all; font-size:12.5px; color:#e6edf3;"></code>
          </div>
          <button class="btn btn-sm btn-accent" id="btnCopySetupCodexBash">📋 Kopiuj polecenie Codex</button>
        </div>

        <div id="contentSetupPowershell" style="display:none;">
          <div style="font-size:13px; color:var(--dim); margin-bottom:6px;">1. Claude Code na Windows (PowerShell):</div>
          <div style="background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:8px 12px; margin-bottom:8px;">
            <code class="mono" id="cmdSetupPowershell" style="display:block; word-break:break-all; font-size:12.5px; color:#e6edf3;"></code>
          </div>
          <button class="btn btn-sm btn-accent" id="btnCopySetupPowershell" style="margin-bottom:14px;">📋 Kopiuj polecenie Claude (PS)</button>

          <div style="font-size:13px; color:var(--dim); margin-bottom:6px;">2. OpenAI Codex na Windows (PowerShell):</div>
          <div style="background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:8px 12px; margin-bottom:8px;">
            <code class="mono" id="cmdSetupCodexPowershell" style="display:block; word-break:break-all; font-size:12.5px; color:#e6edf3;"></code>
          </div>
          <button class="btn btn-sm btn-accent" id="btnCopySetupCodexPowershell">📋 Kopiuj polecenie Codex (PS)</button>
        </div>

        <div id="contentSetupNode" style="display:none;">
          <div style="font-size:13px; color:var(--dim); margin-bottom:6px;">Uniwersalny skrypt Node.js dla każdego systemu:</div>
          <div style="background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:10px 12px; margin-bottom:10px;">
            <code class="mono" id="cmdSetupNode" style="display:block; word-break:break-all; font-size:12.5px; color:#e6edf3;"></code>
          </div>
          <button class="btn btn-sm btn-accent" id="btnCopySetupNode">📋 Kopiuj komendę Node.js</button>
        </div>

        <div id="contentSetupGit" style="display:none;">
          <div style="font-size:13px; color:var(--dim); margin-bottom:6px;">Klonowanie repozytorium GitHub (<a href="https://github.com/tomaasz/agent-lb" target="_blank" rel="noopener" style="color:var(--accent);">tomaasz/agent-lb</a>):</div>
          <div style="background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:10px 12px; margin-bottom:10px;">
            <code class="mono" id="cmdSetupGit" style="display:block; word-break:break-all; font-size:12.5px; color:#e6edf3;"></code>
          </div>
          <button class="btn btn-sm btn-accent" id="btnCopySetupGit">📋 Kopiuj komendę Git</button>
        </div>

        <div id="contentSetupManual" style="display:none;">
          <div style="font-size:13px; color:var(--dim); margin-bottom:8px;">Ręczna konfiguracja zmiennych środowiskowych i rozszerzenia VS Code:</div>
          <div class="row" style="gap:8px; margin-bottom:10px;">
            <button class="btn btn-sm" id="btnCopyShellEnv">📋 Kopiuj export ENV</button>
            <button class="btn btn-sm" id="btnCopyVSCode">📋 Kopiuj VS Code JSON</button>
          </div>
          <div style="background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:10px 12px;">
            <pre class="mono" id="boxManualConfig" style="margin:0; font-size:12px; color:#e6edf3; overflow-x:auto;"></pre>
          </div>
        </div>
      </div>

      <div class="row" style="justify-content:space-between; align-items:center; margin-top:16px; border-top:1px solid var(--line); padding-top:12px;">
        <span style="font-size:12px; color:var(--dim);">Repozytorium: <a href="https://github.com/tomaasz/agent-lb" target="_blank" rel="noopener" style="color:var(--accent);">tomaasz/agent-lb ↗</a></span>
        <button class="btn" id="btnDoneKeyModal">Zamknij</button>
      </div>
    </div>
  </div>
</main>
<script>
(function () {
  'use strict';
  var KEY = 'agentlb-dashboard-key';
  var POLL_MS = 5000;
  var timer = null;
  var lastStatus = null;
  var sessionFilters = { project: '', client: '' };
  var sortState = { sessions: { key: 'lastSeen', dir: 'desc' } };
  var UNAVAILABLE_TEXT = ${JSON.stringify(UNAVAILABLE_TEXT)};

  var currentTheme = 'dark';
  try { currentTheme = localStorage.getItem('agentlb-theme') || 'dark'; } catch (e) {}
  document.documentElement.setAttribute('data-theme', currentTheme);

  var currentLang = 'pl';
  try { currentLang = localStorage.getItem('agentlb-lang') || 'pl'; } catch (e) {}
  document.documentElement.lang = currentLang;

  var I18N = {
    pl: {
      appTitle: 'Agent LB',
      themeDark: '🌙 Ciemny',
      themeLight: '☀️ Jasny',
      langBtn: '🇬🇧 EN',
      loginTitle: 'Panel Zarządzania',
      loginSubtitle: 'Wprowadź hasło, klucz administracyjny lub dowolny klucz stacji roboczej, aby uzyskać dostęp.',
      loginKeyLabel: 'Klucz dostępu (administracyjny lub stacji roboczej)',
      loginKeyPlaceholder: 'tc-...',
      loginButton: 'Zaloguj się',
      loginFoot: 'Agent LB • Zabezpieczony dostęp administracyjny',
      btnTestFleet: '🩺 Testuj flotę',
      btnTestFleetTitle: 'Wyślij szybkie zapytanie testowe do wszystkich kont i zweryfikuj ich stan',
      btnOpenTestChat: '💬 Test Chat',
      btnOpenTestChatTitle: 'Otwórz interaktywny czat testowy dla Claude i Codex',
      btnProbeQuota: '⚡ Odśwież salda',
      btnProbeQuotaTitle: 'Odpytaj o aktualne zużycie limitów i salda kont',
      btnReloadFleet: '🔄 Przeładuj flotę',
      btnReloadFleetTitle: 'Przeładuj flotę kont z dysku',
      btnLogout: '🚪 Wyloguj',
      btnLogoutTitle: 'Wyloguj z panelu',
      routesHeading: 'Routing',
      policyTitle: 'Polityka routingu i działania floty',
      policySubtitle: 'Inteligentny podział obciążenia, pamięć podręczna promptów i odporność na limity API.',
      btnPolicyHelp: 'ℹ️ Wyjaśnienia',
      btnPolicyHelpCompact: '⚡ Zwiń opisy',
      btnDrainMode: '🛑 Drain Mode',
      btnDrainModeTitle: 'Przełącz tryb drain — dokończ aktywne żądania bez przyjmowania nowych',
      btnDrainCancel: '▶️ Anuluj Drain',
      drainActive: '🛑 Draining ({count} req in flight)',
      policyCardAffinityTitle: 'Affinity (Prompt Cache)',
      optAffinityAdaptive: 'Adaptive (Cache + Balancing)',
      optAffinityEven: 'Even (Rozkładanie sesji wg liczby)',
      optAffinityOff: 'Off (Czysta rotacja)',
      policyCardAffinityDesc: 'Kieruje kolejne zapytania tej samej sesji (projektu) do tego samego konta, aby wykorzystać pamięć podręczną Anthropic Prompt Cache (-90% kosztów tokenów wejściowych i 3-5x szybsza odpowiedź).',
      policyCardResetTitle: 'Earliest-Reset-First',
      policyCardResetDesc: 'Gdy rozpoczyna się nowa sesja, wybiera konto, którego limit 5h lub 7d zresetuje się najszybciej. Zapobiega blokowaniu floty i maksymalizuje łączną dostępność.',
      policyCardFallbackTitle: 'Cross-Provider Fallback',
      policyCardFallbackDesc: 'W przypadku wyczerpania limitów wszystkich kont Claude lub blokady upstreamu, automatycznie przekierowuje zapytania do OpenAI Codex (i odwrotnie), zapewniając zerowy przestój.',
      policyCardHealthTitle: 'Auto-Health',
      policyCardHealthDesc: 'Okresowe badanie stanu kont w tle (co 15 min). Bezpieczne dla limitów: 0 tokenów dla aktywnych kont, 1 mikro-token dla kont bezczynnych. Błyskawicznie wykrywa odblokowanie kont.',
      autoHealthActive: 'Aktywny',
      autoHealthDisabled: 'Wyłączony',
      accountsHeading: 'Konta Claude & Codex',
      accountsHint: '💡 Przeciągnij kartę ⠿ w kolumnie, aby zmienić priorytet',
      clientsHeading: 'Stacje robocze & Klucze',
      colClaudeTitle: '🟣 Claude (Anthropic)',
      colCodexTitle: '🟢 OpenAI Codex',
      colClientsTitle: '🔑 Klucze klientów',
      btnAddAccount: '➕ Dodaj konto',
      btnNewKey: '➕ Nowy klucz',
      btnUpdate: '🔄 Aktualizuj',
      btnUpdateTitle: 'Pobierz najnowsze skrypty instalatora z GitHub (git pull)',
      quickConnectTitle: '⚡ Szybkie podłączenie stacji:',
      copyCmd: '📋 Kopiuj',
      includeKey: 'Dołącz klucz',
      githubGuide: 'instrukcja GitHub ↗',
      countAccounts: '{n} kont',
      countAccountsSingle: '1 konto',
      countKeys: '{n} kluczy',
      countKeysSingle: '1 klucz',
      badgeActive: '● Aktywne',
      badgeActiveRotation: '● Aktywne (rotacja)',
      badgeHealthy: '🟢 SPRAWNE',
      badgeHealthyTitle: 'Konto w pełni sprawne i gotowe do obsługi zapytań',
      badgeDisabled: '⚪ Wyłączone',
      btnQuickTest: '⚡ Test',
      btnMoveTop: '▲ Na górę',
      btnMoveTopTitle: 'Przenieś to konto na 1. miejsce (ustaw jako główne konto w kolejce)',
      btnRelogin: '🔐 Zaloguj',
      btnProbe: 'Odśwież salda i limity (Probe)',
      btnEnable: 'Włącz konto do rotacji',
      btnDisable: 'Wyłącz konto z rotacji',
      btnExport: 'Eksportuj konfigurację i tokeny konta do pliku JSON',
      btnDelete: 'Usuń konto z konfiguracji Agent LB',
      renameAccount: 'Zmień nazwę konta',
      renameAccountDblClick: 'Kliknij dwukrotnie lub użyj ikony ołówka ✏️, aby zmienić nazwę konta',
      prioBadgeTopTitle: 'Pozycja #1 — główne konto obsługujące zapytania w pierwszej kolejności',
      prioBadgeOtherTitle: 'Pozycja #{rank} — konto zapasowe w kolejce (kliknij „▲ Na górę” lub przeciągnij ⠿, aby zmienić)',
      dragHandleTitle: 'Przeciągnij myszką, aby zmienić priorytet w kolumnie',
      summaryActiveAccount: 'aktywne konto ',
      summaryNone: 'brak',
      summarySessions: ' · {active} aktywnych / {known} znanych sesji',
      summaryRefreshes: 'odświeżanie co {sec}s · {time}',
      emptyNoAccountsClaude: 'Brak kont Claude. Kliknij „➕ Dodaj konto” u góry.',
      emptyNoAccountsCodex: 'Brak kont OpenAI Codex. Kliknij „➕ Dodaj konto” u góry.',
      emptyNoKeys: 'Brak kluczy klientów. Kliknij „➕ Nowy klucz”, aby podłączyć stację roboczą.',
      primaryAdminKeyName: 'Główny klucz administratora (proxy.apiKey)',
      btnKeyConnect: '🚀 Podłącz',
      keyShow: 'Pokaż',
      keyHide: 'Ukryj'
    },
    en: {
      appTitle: 'Agent LB',
      themeDark: '🌙 Dark',
      themeLight: '☀️ Light',
      langBtn: '🇵🇱 PL',
      loginTitle: 'Management Dashboard',
      loginSubtitle: 'Enter password, administrative key, or any workstation client key to gain access.',
      loginKeyLabel: 'Access Key (administrative or workstation)',
      loginKeyPlaceholder: 'tc-...',
      loginButton: 'Log In',
      loginFoot: 'Agent LB • Secured administrative access',
      btnTestFleet: '🩺 Test Fleet',
      btnTestFleetTitle: 'Send quick test query to all accounts and verify their status',
      btnOpenTestChat: '💬 Test Chat',
      btnOpenTestChatTitle: 'Open interactive test chat playground for Claude and Codex',
      btnProbeQuota: '⚡ Refresh Quotas',
      btnProbeQuotaTitle: 'Query upstream for latest quota utilization and balances',
      btnReloadFleet: '🔄 Reload Fleet',
      btnReloadFleetTitle: 'Reload account fleet from disk configuration',
      btnLogout: '🚪 Logout',
      btnLogoutTitle: 'Sign out from dashboard',
      routesHeading: 'Routing',
      policyTitle: 'Fleet Routing & Operations Policy',
      policySubtitle: 'Smart load balancing, prompt cache reuse, and upstream quota resilience.',
      btnPolicyHelp: 'ℹ️ Explanations',
      btnPolicyHelpCompact: '⚡ Collapse descriptions',
      btnDrainMode: '🛑 Drain Mode',
      btnDrainModeTitle: 'Toggle drain mode — finish in-flight requests without taking new ones',
      btnDrainCancel: '▶️ Cancel Drain',
      drainActive: '🛑 Draining ({count} req in flight)',
      policyCardAffinityTitle: 'Affinity (Prompt Cache)',
      optAffinityAdaptive: 'Adaptive (Cache + Balancing)',
      optAffinityEven: 'Even (Equal session distribution)',
      optAffinityOff: 'Off (Pure round-robin)',
      policyCardAffinityDesc: 'Pins requests of the same session to the same account, saving up to 90% in input token costs and answering 3-5x faster using Anthropic Prompt Cache.',
      policyCardResetTitle: 'Earliest-Reset-First',
      policyCardResetDesc: 'New sessions prioritize the account whose 5h or 7d quota window resets earliest. Prevents full fleet lockups and steadily recycles available quota.',
      policyCardFallbackTitle: 'Cross-Provider Fallback',
      policyCardFallbackDesc: 'When all Claude accounts hit quota limits or upstream errors, requests seamlessly fail over to OpenAI Codex (and vice-versa), ensuring zero agent downtime.',
      policyCardHealthTitle: 'Auto-Health',
      policyCardHealthDesc: 'Silent background diagnostics every 15 minutes. Consumes 0 tokens for active accounts and only 1 micro-token for idle accounts, auto-recovering cleared accounts.',
      autoHealthActive: 'Active',
      autoHealthDisabled: 'Disabled',
      accountsHeading: 'Claude & Codex Accounts',
      accountsHint: '💡 Drag card ⠿ in column to adjust queue priority',
      clientsHeading: 'Workstations & Keys',
      colClaudeTitle: '🟣 Claude (Anthropic)',
      colCodexTitle: '🟢 OpenAI Codex',
      colClientsTitle: '🔑 Client Keys',
      btnAddAccount: '➕ Add Account',
      btnNewKey: '➕ New Key',
      btnUpdate: '🔄 Update',
      btnUpdateTitle: 'Pull latest installer scripts from GitHub (git pull)',
      quickConnectTitle: '⚡ Quick Workstation Connect:',
      copyCmd: '📋 Copy',
      includeKey: 'Include key',
      githubGuide: 'GitHub guide ↗',
      countAccounts: '{n} accounts',
      countAccountsSingle: '1 account',
      countKeys: '{n} keys',
      countKeysSingle: '1 key',
      badgeActive: '● Active',
      badgeActiveRotation: '● Active (rotation)',
      badgeHealthy: '🟢 HEALTHY',
      badgeHealthyTitle: 'Account is fully healthy and ready to handle requests',
      badgeDisabled: '⚪ Disabled',
      btnQuickTest: '⚡ Test',
      btnMoveTop: '▲ Move to Top',
      btnMoveTopTitle: 'Move this account to 1st place (set as primary queue account)',
      btnRelogin: '🔐 Login',
      btnProbe: 'Refresh quota & balances (Probe)',
      btnEnable: 'Enable account for rotation',
      btnDisable: 'Disable account from rotation',
      btnExport: 'Export account config and tokens to JSON file',
      btnDelete: 'Remove account from Agent LB config',
      renameAccount: 'Rename account',
      renameAccountDblClick: 'Double-click or click pencil ✏️ icon to rename account',
      prioBadgeTopTitle: 'Rank #1 — primary account handling requests first',
      prioBadgeOtherTitle: 'Rank #{rank} — fallback account in queue (click "▲ Move to Top" or drag ⠿ to reorder)',
      dragHandleTitle: 'Drag with mouse to reorder queue priority in column',
      summaryActiveAccount: 'active account ',
      summaryNone: 'none',
      summarySessions: ' · {active} active / {known} known sessions',
      summaryRefreshes: 'refreshes every {sec}s · {time}',
      emptyNoAccountsClaude: 'No Claude accounts. Click “➕ Add Account” above.',
      emptyNoAccountsCodex: 'No OpenAI Codex accounts. Click “➕ Add Account” above.',
      emptyNoKeys: 'No client keys configured. Click “➕ New Key” to connect a workstation.',
      primaryAdminKeyName: 'Primary administrator key (proxy.apiKey)',
      btnKeyConnect: '🚀 Connect',
      keyShow: 'Show',
      keyHide: 'Hide'
    }
  };

  function t(key, params) {
    var dict = I18N[currentLang] || I18N.pl;
    var str = dict[key] != null ? dict[key] : (I18N.pl[key] != null ? I18N.pl[key] : (I18N.en[key] != null ? I18N.en[key] : key));
    if (params && typeof params === 'object') {
      for (var k in params) {
        str = str.replace(new RegExp('\\{' + k + '\\}', 'g'), params[k]);
      }
    }
    return str;
  }

  function updateI18nDOM() {
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var k = n.getAttribute('data-i18n');
      if (k) n.textContent = t(k);
    }
    var titleNodes = document.querySelectorAll('[data-i18n-title]');
    for (var j = 0; j < titleNodes.length; j++) {
      var tn = titleNodes[j];
      var tk = tn.getAttribute('data-i18n-title');
      if (tk) tn.title = t(tk);
    }
    var phNodes = document.querySelectorAll('[data-i18n-placeholder]');
    for (var m = 0; m < phNodes.length; m++) {
      var pn = phNodes[m];
      var pk = pn.getAttribute('data-i18n-placeholder');
      if (pk) pn.placeholder = t(pk);
    }
    var langBtn = document.getElementById('btnLangToggle');
    if (langBtn) langBtn.textContent = currentLang === 'pl' ? '🇬🇧 EN' : '🇵🇱 PL';
    var loginLangBtn = document.getElementById('btnLoginLangToggle');
    if (loginLangBtn) loginLangBtn.textContent = currentLang === 'pl' ? '🇬🇧 EN' : '🇵🇱 PL';

    var themeBtn = document.getElementById('btnThemeToggle');
    if (themeBtn) themeBtn.textContent = currentTheme === 'dark' ? t('themeLight') : t('themeDark');
    var loginThemeBtn = document.getElementById('btnLoginThemeToggle');
    if (loginThemeBtn) loginThemeBtn.textContent = currentTheme === 'dark' ? t('themeLight') : t('themeDark');

    var pHelp = document.getElementById('btnTogglePolicyHelp');
    if (pHelp) {
      var panel = document.getElementById('fleetPolicyPanel');
      var isCompact = panel && panel.classList.contains('policy-compact');
      pHelp.textContent = isCompact ? t('btnPolicyHelp') : t('btnPolicyHelpCompact');
    }
  }

  function setLang(lang) {
    if (lang !== 'pl' && lang !== 'en') lang = 'pl';
    currentLang = lang;
    try { localStorage.setItem('agentlb-lang', lang); } catch (e) {}
    document.documentElement.lang = lang;
    updateI18nDOM();
    if (typeof updateTestModelsAndAccounts === 'function') {
      try { updateTestModelsAndAccounts(); } catch (e) {}
    }
    if (lastStatus) {
      render(lastStatus);
    }
  }

  function setTheme(theme) {
    if (theme !== 'light' && theme !== 'dark') theme = 'dark';
    currentTheme = theme;
    try { localStorage.setItem('agentlb-theme', theme); } catch (e) {}
    document.documentElement.setAttribute('data-theme', theme);
    var label = theme === 'dark' ? t('themeLight') : t('themeDark');
    var b = document.getElementById('btnThemeToggle');
    if (b) b.textContent = label;
    var bl = document.getElementById('btnLoginThemeToggle');
    if (bl) bl.textContent = label;
  }

${SHARED_CONSTS}

${SHARED_HELPERS}

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function fmtNum(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'm';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
  }

  // Status timestamps arrive in both shapes: epoch milliseconds (account
  // quota resets, account usage.lastUsed) and ISO strings (client lastUsed).
  // Date.parse() only handles strings, so numbers must pass through as-is —
  // feeding it a number silently yields NaN and the field just never renders.
  function parseTs(v) {
    if (v == null) return NaN;
    if (typeof v === 'number') return v;
    return Date.parse(v);
  }

  function fmtAgo(ts) {
    var t = parseTs(ts);
    if (isNaN(t)) return '';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }

  function fmtIn(sec) {
    if (sec == null) return '';
    var s = Math.max(0, Math.round(sec));
    if (s < 3600) return Math.round(s / 60) + 'm';
    if (s < 86400) return (s / 3600).toFixed(1) + 'h';
    return (s / 86400).toFixed(1) + 'd';
  }

  // Absolute wall-clock of a future timestamp: "17:30" today, "Wed 09:00"
  // beyond 24h — the countdown says how long, this says when.
  function fmtClock(ts) {
    var d = new Date(ts);
    var time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (ts - Date.now() >= 86400000) {
      return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + time;
    }
    return time;
  }

  function fmtMoneyVal(minor, currency, exponent) {
    if (minor == null) return null;
    var exp = exponent != null ? exponent : 2;
    var v = minor / Math.pow(10, exp);
    var text = v.toFixed(exp);
    var cur = (currency || '').toUpperCase();
    var sym = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', PLN: 'zł' }[cur];
    if (sym === 'zł') return text + ' zł';
    if (sym) return sym + text;
    return text + (cur ? ' ' + cur : '');
  }

  function spendQuotaRow(label, ratio, detailText) {
    var row = el('div', 'quota');
    row.appendChild(el('span', 'lbl', label));
    var bar = el('div', 'bar');
    var fill = el('i');
    var pct = ratio == null ? null : Math.max(0, Math.min(1, Number(ratio)));
    fill.style.width = (pct == null ? 0 : pct * 100) + '%';
    if (pct != null && pct >= 0.9) fill.className = 'bad';
    else if (pct != null && pct >= 0.7) fill.className = 'warn';
    bar.appendChild(fill);
    row.appendChild(bar);
    row.appendChild(el('span', 'val', detailText));
    return row;
  }

  function quotaRow(label, ratio, resetAt) {
    var row = el('div', 'quota');
    row.appendChild(el('span', 'lbl', label));
    var bar = el('div', 'bar');
    var fill = el('i');
    var pct = ratio == null ? null : Math.max(0, Math.min(1, Number(ratio)));
    fill.style.width = (pct == null ? 0 : pct * 100) + '%';
    if (pct != null && pct >= 0.9) fill.className = 'bad';
    else if (pct != null && pct >= 0.7) fill.className = 'warn';
    bar.appendChild(fill);
    row.appendChild(bar);
    var resetTs = parseTs(resetAt);
    var reset = !isNaN(resetTs) && resetTs > Date.now()
      ? ' · ' + fmtIn((resetTs - Date.now()) / 1000) + ' · ' + fmtClock(resetTs)
      : '';
    row.appendChild(el('span', 'val', (pct == null ? '?' : Math.round(pct * 100) + '%') + reset));
    return row;
  }

  var draggedCard = null;

  function attachCardDragListeners(card) {
    card.addEventListener('dragstart', function (e) {
      if (e.target && (e.target.tagName === 'BUTTON' || (e.target.closest && e.target.closest('button')))) {
        e.preventDefault();
        return;
      }
      draggedCard = card;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', card.dataset.accountName || '');
    });

    card.addEventListener('dragend', function () {
      card.classList.remove('dragging');
      draggedCard = null;
      var indicators = document.querySelectorAll('.drag-over-top, .drag-over-bottom');
      for (var i = 0; i < indicators.length; i++) {
        indicators[i].classList.remove('drag-over-top', 'drag-over-bottom');
      }
    });

    card.addEventListener('dragover', function (e) {
      if (!draggedCard || draggedCard === card) return;
      if (draggedCard.dataset.provider !== card.dataset.provider) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';

      var rect = card.getBoundingClientRect();
      var midY = rect.top + rect.height / 2;
      if (e.clientY < midY) {
        card.classList.add('drag-over-top');
        card.classList.remove('drag-over-bottom');
      } else {
        card.classList.add('drag-over-bottom');
        card.classList.remove('drag-over-top');
      }
    });

    card.addEventListener('dragleave', function (e) {
      if (e.relatedTarget && card.contains(e.relatedTarget)) return;
      card.classList.remove('drag-over-top', 'drag-over-bottom');
    });

    card.addEventListener('drop', function (e) {
      if (!draggedCard || draggedCard === card) return;
      if (draggedCard.dataset.provider !== card.dataset.provider) return;
      e.preventDefault();
      e.stopPropagation();

      var isTop = card.classList.contains('drag-over-top');
      card.classList.remove('drag-over-top', 'drag-over-bottom');

      var parent = card.parentNode;
      if (!parent) return;
      if (isTop) {
        parent.insertBefore(draggedCard, card);
      } else {
        parent.insertBefore(draggedCard, card.nextSibling);
      }
      saveReorderedList(parent);
    });
  }

  function attachListDropTarget(listEl) {
    if (!listEl || listEl._dndAttached) return;
    listEl._dndAttached = true;

    listEl.addEventListener('dragover', function (e) {
      if (!draggedCard) return;
      if (draggedCard.dataset.provider !== listEl.dataset.provider) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });

    listEl.addEventListener('drop', function (e) {
      if (!draggedCard) return;
      if (draggedCard.dataset.provider !== listEl.dataset.provider) return;
      e.preventDefault();
      if (e.target === listEl) {
        listEl.appendChild(draggedCard);
        saveReorderedList(listEl);
      }
    });
  }

  function saveReorderedList(listEl) {
    var cards = Array.prototype.slice.call(listEl.querySelectorAll('.card.draggable'));
    var names = cards.map(function (c) { return c.dataset.accountName; }).filter(Boolean);
    if (!names.length) return;

    // Optimistically update badges in the DOM
    cards.forEach(function (c, idx) {
      var pb = c.querySelector('.prio-badge');
      if (pb) {
        pb.textContent = '#' + (idx + 1);
        if (idx === 0) {
          pb.classList.add('prio-badge-top');
          pb.title = 'Pozycja #1 — główne konto obsługujące zapytania w pierwszej kolejności';
        } else {
          pb.classList.remove('prio-badge-top');
          pb.title = 'Pozycja #' + (idx + 1) + ' — konto zapasowe w kolejce';
        }
      }
      var prioTag = c.querySelector('.card-prio-tag');
      if (prioTag) {
        var typeStr = c.dataset.accountType || '';
        prioTag.textContent = (typeStr ? typeStr + ' · ' : '') + 'prio ' + idx;
      }
      var prioBtn = c.querySelector('.btn-prio');
      if (prioBtn) prioBtn.textContent = 'prio ' + idx;
    });

    note('ok', 'Zapisywanie nowego priorytetu kont...');
    apiCall('/agent-lb/api/accounts/reorder', 'POST', { order: names })
      .then(function (res) {
        if (res && res.ok) {
          note('ok', 'Zapisano nowy priorytet kont (' + names.length + ' kont)');
          poll();
        } else {
          note('error', 'Błąd zapisu priorytetów: ' + (res && res.error ? res.error : 'nieznany błąd'));
          poll();
        }
      })
      .catch(function (e) {
        note('error', 'Błąd: ' + e.message);
        poll();
      });
  }

  function moveToTop(name, card) {
    var parent = card.parentNode;
    if (!parent) return;
    parent.insertBefore(card, parent.firstChild);
    saveReorderedList(parent);
  }

  function startInlineRename(currentName, nameRow, nameDisplay, card) {
    nameRow.innerHTML = '';
    var form = el('form', 'card-rename-form');
    var input = el('input', 'card-rename-input');
    input.type = 'text';
    input.value = currentName;
    input.placeholder = 'Wpisz nową nazwę konta...';
    input.required = true;

    var btnSave = el('button', 'btn btn-xs btn-accent', '✓ Zapisz');
    btnSave.type = 'submit';
    btnSave.title = 'Zapisz nową nazwę konta';

    var btnCancel = el('button', 'btn btn-xs btn-outline', '✕');
    btnCancel.type = 'button';
    btnCancel.title = 'Anuluj';

    form.appendChild(input);
    form.appendChild(btnSave);
    form.appendChild(btnCancel);
    nameRow.appendChild(form);

    input.focus();
    input.select();

    function cancel() {
      nameRow.innerHTML = '';
      nameRow.appendChild(nameDisplay);
    }

    btnCancel.addEventListener('click', function (e) {
      e.stopPropagation();
      cancel();
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        cancel();
      }
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var val = input.value.trim();
      if (!val) {
        note('warn', 'Nazwa konta nie może być pusta');
        input.focus();
        return;
      }
      if (val === currentName) {
        cancel();
        return;
      }
      btnSave.disabled = true;
      btnCancel.disabled = true;
      input.disabled = true;

      apiCall('/agent-lb/api/accounts/rename', 'POST', { oldName: currentName, newName: val })
        .then(function (res) {
          if (!res) {
            cancel();
            return;
          }
          if (res.ok) {
            note('ok', 'Zmieniono nazwę konta z "' + currentName + '" na "' + res.newName + '"');
            if (card) {
              card.dataset.accountName = res.newName;
            }
            poll();
          } else {
            note('error', 'Błąd zmiany nazwy: ' + (res.error || 'nieznany błąd'));
            btnSave.disabled = false;
            btnCancel.disabled = false;
            input.disabled = false;
            input.focus();
          }
        })
        .catch(function (err) {
          note('error', 'Błąd: ' + err.message);
          btnSave.disabled = false;
          btnCancel.disabled = false;
          input.disabled = false;
        });
    });
  }

  function renderAccount(a, current, rankIndex) {
    var prov = (a.provider || 'anthropic').toLowerCase();
    var card = el('div', 'card draggable');
    card.draggable = true;
    card.dataset.accountName = a.name || '';
    card.dataset.provider = prov;
    card.dataset.accountType = a.type || '';

    var head = el('div', 'card-header');
    var titleGroup = el('div', 'card-title-group');

    // Drag handle
    var dragHandle = el('span', 'drag-handle', '⠿');
    dragHandle.title = t('dragHandleTitle');
    titleGroup.appendChild(dragHandle);

    // Rank badge (#1, #2, #3...)
    if (rankIndex != null) {
      var isTop = rankIndex === 0;
      var prioBadge = el('span', 'prio-badge' + (isTop ? ' prio-badge-top' : ''), '#' + (rankIndex + 1));
      prioBadge.title = isTop
        ? t('prioBadgeTopTitle')
        : t('prioBadgeOtherTitle', { rank: rankIndex + 1 });
      if (!isTop) {
        prioBadge.style.cursor = 'pointer';
        prioBadge.addEventListener('click', function (e) {
          e.stopPropagation();
          moveToTop(a.name, card);
        });
      }
      titleGroup.appendChild(prioBadge);
    }

    // Subscription plan badge
    var planName = a.hasClaudeMax ? 'Claude Max' : (a.hasClaudePro || a.organizationType === 'claude_pro' ? 'Pro' : (a.planType ? (a.planType.toLowerCase() === 'plus' ? 'Plus' : a.planType.toUpperCase()) : (a.organizationType ? a.organizationType.replace(/_/g, ' ') : null)));
    if (planName) {
      titleGroup.appendChild(el('span', 'badge badge-plan', planName));
    }

    if (a.name === current) {
      var isTopActive = rankIndex === 0;
      titleGroup.appendChild(el('span', 'badge current', isTopActive ? t('badgeActive') : t('badgeActiveRotation')));
    }
    var hasFailedTest = Boolean(a.lastTest && !a.lastTest.ok);
    var hasActiveError = Boolean(a.lastError && a.lastError.reason);
    var isUnavail = Boolean(a.unavailable || hasActiveError || hasFailedTest);

    if (a.disabled) {
      titleGroup.appendChild(el('span', 'badge bad', t('badgeDisabled')));
      card.classList.add('account-disabled');
    } else if (isUnavail) {
      var unavailKey = a.unavailable
        || (a.lastError ? a.lastError.reason : null)
        || (hasFailedTest ? (a.lastTest.reason || 'error') : null);
      var badgeText = '⚠️ ' + (UNAVAILABLE_TEXT[unavailKey] || unavailKey);
      var badgeClass = 'throttled';
      var cardClass = 'card-quota-exhausted';

      if (unavailKey === 'identity-verification') {
        badgeText = currentLang === 'pl' ? '🔴 Wymagana weryfikacja SMS' : '🔴 SMS Verification Required';
        badgeClass = 'error';
        cardClass = 'card-unhealthy';
      } else if (unavailKey === 'entitlement') {
        badgeText = currentLang === 'pl' ? '🔴 Blokada organizacji (OAuth 403)' : '🔴 Org Block (OAuth 403)';
        badgeClass = 'error';
        cardClass = 'card-unhealthy';
      } else if (unavailKey === 'auth') {
        badgeText = currentLang === 'pl' ? '🔴 Błąd autoryzacji (401/403)' : '🔴 Auth Error (401/403)';
        badgeClass = 'error';
        cardClass = 'card-unhealthy';
      } else if (unavailKey === 'circuit-breaker') {
        badgeText = '🔴 Circuit Breaker (60s)';
        badgeClass = 'error';
        cardClass = 'card-unhealthy';
      } else if (unavailKey === 'error' || a.status === 'error' || unavailKey === 'server_error' || (typeof unavailKey === 'string' && unavailKey.startsWith('http_'))) {
        badgeText = currentLang === 'pl' ? '🔴 Błąd konta / upstream' : '🔴 Account / Upstream Error';
        badgeClass = 'error';
        cardClass = 'card-unhealthy';
      } else if (unavailKey === 'quota' || unavailKey === 'upstream-rejected' || unavailKey === 'exhausted') {
        badgeText = currentLang === 'pl' ? '🟡 Quota 100% (Wyczerpany)' : '🟡 Quota 100% (Exhausted)';
        badgeClass = 'throttled';
        cardClass = 'card-quota-exhausted';
      } else if (unavailKey === 'throttled' || unavailKey === 'rate-limit') {
        var rlHoldSec = a.rateLimitedUntil ? Math.max(0, Math.round((parseTs(a.rateLimitedUntil) - Date.now()) / 1000)) : 0;
        badgeText = rlHoldSec > 0 ? ('🟡 Rate Limit (' + fmtIn(rlHoldSec) + ')') : '🟡 Rate Limit (429)';
        badgeClass = 'throttled';
        cardClass = 'card-quota-exhausted';
      } else if (unavailKey === 'capped' || unavailKey === 'advisor-capped') {
        badgeText = currentLang === 'pl' ? '🟡 Przekroczono limit użycia' : '🟡 Usage limit capped';
        badgeClass = 'throttled';
        cardClass = 'card-quota-exhausted';
      }

      var unavailBadge = el('span', 'badge ' + badgeClass, badgeText);
      unavailBadge.title = 'Status: ' + (UNAVAILABLE_TEXT[unavailKey] || unavailKey);
      titleGroup.appendChild(unavailBadge);
      card.classList.add(cardClass);
    } else {
      // Fully healthy and operational account
      var healthyBadge = el('span', 'badge badge-healthy', t('badgeHealthy'));
      healthyBadge.title = t('badgeHealthyTitle');
      titleGroup.appendChild(healthyBadge);
      card.classList.add('card-healthy');
    }

    head.appendChild(titleGroup);

    // Action buttons group (right aligned in header)
    var acts = el('div', 'card-actions');

    // Quick Test ping button
    var btnQuickTest = el('button', 'btn btn-xs btn-outline', '⚡ Test');
    if (a.lastTest) {
      if (a.lastTest.ok) {
        btnQuickTest.textContent = '🟢 ' + (a.lastTest.durationMs ? a.lastTest.durationMs + 'ms' : 'OK');
        btnQuickTest.title = (currentLang === 'pl' ? 'Ostatni test: SUKCES (' : 'Last test: SUCCESS (') + (a.lastTest.durationMs || 0) + 'ms).';
        btnQuickTest.style.borderColor = 'rgba(34, 197, 94, 0.4)';
        btnQuickTest.style.color = '#22c55e';
      } else {
        btnQuickTest.textContent = '🔴 ' + (currentLang === 'pl' ? 'Błąd' : 'Error');
        btnQuickTest.title = (currentLang === 'pl' ? 'Ostatni test: BŁĄD (' : 'Last test: ERROR (') + (a.lastTest.status || a.lastTest.error || '') + ').';
        btnQuickTest.style.borderColor = 'rgba(239, 68, 68, 0.5)';
        btnQuickTest.style.color = '#ef4444';
      }
    } else {
      btnQuickTest.title = currentLang === 'pl' ? 'Przetestuj to konto natychmiast zapytaniem próbnym' : 'Test this account immediately with a probe query';
    }
    btnQuickTest.addEventListener('click', function (e) {
      e.stopPropagation();
      runQuickAccountTest(a.name, prov, btnQuickTest);
    });
    acts.appendChild(btnQuickTest);

    if (rankIndex > 0 && !a.disabled) {
      var btnMoveTop = el('button', 'btn btn-xs btn-accent', t('btnMoveTop'));
      btnMoveTop.title = t('btnMoveTopTitle');
      btnMoveTop.addEventListener('click', function (e) {
        e.stopPropagation();
        moveToTop(a.name, card);
      });
      acts.appendChild(btnMoveTop);
    }

    if (a.type === 'oauth') {
      var isErr = a.status === 'error' || a.unavailable === 'error';
      if (isErr) {
        var btnRelogin = el('button', 'btn btn-xs btn-accent', t('btnRelogin'));
        btnRelogin.title = (currentLang === 'pl' ? 'Odnów sesję przez ' : 'Renew session via ') + (prov === 'codex' ? 'OpenAI Codex' : 'Claude') + ' OAuth';
        btnRelogin.addEventListener('click', function () { startReLogin(a.name, a.priority, a.provider); });
        acts.appendChild(btnRelogin);
      } else {
        var btnReloginIcon = el('button', 'btn-icon', '🔐');
        btnReloginIcon.title = currentLang === 'pl' ? 'Zaloguj ponownie konto przez OAuth' : 'Re-login account via OAuth';
        btnReloginIcon.addEventListener('click', function () { startReLogin(a.name, a.priority, a.provider); });
        acts.appendChild(btnReloginIcon);
      }
    }

    var btnProbe = el('button', 'btn-icon', '⟳');
    btnProbe.title = t('btnProbe');
    btnProbe.addEventListener('click', function () { doProbeSingle(a.name, btnProbe); });
    acts.appendChild(btnProbe);

    var btnToggle = el('button', 'btn-icon', a.disabled ? '▶️' : '⏸️');
    btnToggle.title = a.disabled ? t('btnEnable') : t('btnDisable');
    btnToggle.addEventListener('click', function () { doToggleDisabled(a.name, !!a.disabled, btnToggle); });
    acts.appendChild(btnToggle);

    var btnExport = el('button', 'btn-icon', '💾');
    btnExport.title = t('btnExport');
    btnExport.addEventListener('click', function () { doExportAccount(a.name); });
    acts.appendChild(btnExport);

    var btnDel = el('button', 'btn-icon btn-icon-del', '🗑️');
    btnDel.title = t('btnDelete');
    btnDel.addEventListener('click', function () { doRemoveAccount(a.name, btnDel); });
    acts.appendChild(btnDel);

    head.appendChild(acts);
    card.appendChild(head);
    attachCardDragListeners(card);

    // Account name row (dedicated row with inline edit capability)
    var nameRow = el('div', 'card-name-row');
    var nameDisplay = el('div', 'card-name-display');
    var nameText = el('span', 'card-name-text', a.name || (currentLang === 'pl' ? '(bez nazwy)' : '(unnamed)'));
    nameText.title = t('renameAccountDblClick');
    nameDisplay.appendChild(nameText);

    var btnRename = el('button', 'btn-rename', '✏️');
    btnRename.title = t('renameAccount');
    btnRename.setAttribute('aria-label', t('renameAccount') + ' ' + (a.name || ''));
    nameDisplay.appendChild(btnRename);
    nameRow.appendChild(nameDisplay);

    if (a.name) {
      btnRename.addEventListener('click', function (e) {
        e.stopPropagation();
        startInlineRename(a.name, nameRow, nameDisplay, card);
      });
      nameText.addEventListener('dblclick', function (e) {
        e.stopPropagation();
        startInlineRename(a.name, nameRow, nameDisplay, card);
      });
    }
    card.appendChild(nameRow);

    // Body: quota rows
    var qBody = el('div', 'card-body');
    var q = a.quota || {};
    if (q.unified5h != null || q.unified7d != null) {
      qBody.appendChild(quotaRow('Session', q.unified5h, q.unified5hReset));
      qBody.appendChild(quotaRow('Weekly', q.unified7d, q.unified7dReset));
      scopedWeeklyRows(q).forEach(function (r) { qBody.appendChild(quotaRow(r.label, r.utilization, r.resetAt)); });
    } else if (q.tokensLimit != null && q.tokensRemaining != null) {
      qBody.appendChild(quotaRow('Tokens', 1 - q.tokensRemaining / q.tokensLimit, q.resetsAt));
    } else {
      qBody.appendChild(el('div', 'usage', 'quota unknown (no traffic observed yet)'));
    }

    // Saldo / Spend quota bar if limits exist
    if (q.spend && q.spend.limitMinor != null && q.spend.limitMinor > 0) {
      var sp = q.spend;
      var ratio = (sp.usedMinor || 0) / sp.limitMinor;
      var usedStr = fmtMoneyVal(sp.usedMinor || 0, sp.currency, sp.exponent);
      var limitStr = fmtMoneyVal(sp.limitMinor, sp.currency, sp.exponent);
      var remMinor = Math.max(0, sp.limitMinor - (sp.usedMinor || 0));
      var remStr = fmtMoneyVal(remMinor, sp.currency, sp.exponent);
      qBody.appendChild(spendQuotaRow('Saldo', ratio, Math.round(ratio * 100) + '% · wydano ' + usedStr + ' / ' + limitStr + ' (wolne: ' + remStr + ')'));
    }
    card.appendChild(qBody);

    var activeError = (a.lastError && a.lastError.error) ? a.lastError : (hasFailedTest && a.lastTest.error ? a.lastTest : null);
    if (activeError && activeError.error) {
      var isWarn = activeError.reason === 'rate-limit' || activeError.reason === 'throttled';
      var errDiv = el('div', 'card-error-banner');
      errDiv.style.margin = '4px 10px 8px 10px';
      errDiv.style.padding = '6px 8px';
      errDiv.style.borderRadius = '4px';
      errDiv.style.backgroundColor = isWarn ? 'rgba(234, 179, 8, 0.12)' : 'rgba(239, 68, 68, 0.12)';
      errDiv.style.border = isWarn ? '1px solid rgba(234, 179, 8, 0.35)' : '1px solid rgba(239, 68, 68, 0.35)';
      errDiv.style.color = isWarn ? '#eab308' : '#ef4444';
      errDiv.style.fontSize = '11px';
      errDiv.style.lineHeight = '1.35';
      errDiv.style.wordBreak = 'break-word';

      var errIcon = activeError.reason === 'identity-verification' ? '📱 ' : (isWarn ? '⏳ ' : '⚠️ ');
      errDiv.textContent = errIcon + activeError.error;
      card.appendChild(errDiv);
    }

    // Footer meta
    var meta = el('div', 'card-meta');

    // Saldo text if no limit progress bar
    if (q.spend && !(q.spend.limitMinor != null && q.spend.limitMinor > 0)) {
      var sp2 = q.spend;
      var usedVal = sp2.usedMinor ? fmtMoneyVal(sp2.usedMinor, sp2.currency, sp2.exponent) : null;
      if (sp2.disabledReason === 'out_of_credits') {
        meta.appendChild(el('span', 'card-meta-item bad', '⚠️ Brak środków'));
      } else if (sp2.disabledReason) {
        meta.appendChild(el('span', 'card-meta-item warn', '⚠️ ' + sp2.disabledReason));
      } else if (sp2.enabled) {
        meta.appendChild(el('span', 'card-meta-item ok', '💳 Extra: ok' + (usedVal ? ' · ' + usedVal : '')));
      } else if (planName) {
        meta.appendChild(el('span', 'card-meta-item', '💳 ' + planName + (usedVal ? ' · ' + usedVal : '')));
      } else {
        meta.appendChild(el('span', 'card-meta-item', '💳 Nielimitowany' + (usedVal ? ' · ' + usedVal : '')));
      }
    } else if (q.backend && (q.backend.text || q.backend.label)) {
      meta.appendChild(el('span', 'card-meta-item', '💳 ' + (q.backend.label || 'Saldo') + ': ' + q.backend.text));
    } else if (a.type === 'api') {
      meta.appendChild(el('span', 'card-meta-item', '💳 Anthropic API Key'));
    }

    // Codex Reset Credits
    if (prov === 'codex') {
      var rc = q.resetCredits;
      var rcAvail = rc && typeof rc.available === 'number' ? rc.available : 0;
      if (rcAvail > 0) {
        var rcSpan = el('span', 'card-meta-item ok');
        var expStr = rc.nearestExpiresAt ? ' (' + fmtAgo(rc.nearestExpiresAt) + ')' : '';
        rcSpan.appendChild(el('span', '', '⚡ Reset 5h: ' + rcAvail + expStr + ' '));
        var btnReset = el('button', 'btn-xs btn-accent', '🔄 Reset');
        btnReset.title = 'Zużyj kredyt resetu OpenAI i natychmiast wyzeruj limit 5h';
        btnReset.style.padding = '0 4px';
        btnReset.style.fontSize = '9.5px';
        btnReset.style.minHeight = '16px';
        btnReset.addEventListener('click', function () { doConsumeResetCredit(a.name, btnReset); });
        rcSpan.appendChild(btnReset);
        meta.appendChild(rcSpan);
      } else {
        meta.appendChild(el('span', 'card-meta-item dim', '⚡ Reset 5h: 0'));
      }
    }

    // Token status
    if (a.type === 'oauth') {
      var tokenParts = [];
      if (a.expiresAt) {
        var msLeft = a.expiresAt - Date.now();
        var daysLeft = Math.round(msLeft / 86400000);
        if (daysLeft > 1) tokenParts.push('Token ~' + daysLeft + 'd');
        else if (msLeft > 0) tokenParts.push('Token <24h');
        else tokenParts.push('Wygasł');
      }
      if (a.hasRefreshToken) tokenParts.push('Refresh OK');
      if (tokenParts.length) {
        meta.appendChild(el('span', 'card-meta-item', '🔑 ' + tokenParts.join(' · ')));
      }
    }

    if (a.circuitBreakerUntil && parseTs(a.circuitBreakerUntil) > Date.now()) {
      var cbSec = (parseTs(a.circuitBreakerUntil) - Date.now()) / 1000;
      meta.appendChild(el('span', 'card-meta-item bad', '⚡ Circuit Breaker: ' + fmtIn(cbSec)));
    }

    if (a.identityVerificationUntil && parseTs(a.identityVerificationUntil) > Date.now()) {
      var idSec = (parseTs(a.identityVerificationUntil) - Date.now()) / 1000;
      meta.appendChild(el('span', 'card-meta-item bad', '⚠️ Weryfikacja: cooldown ' + fmtIn(idSec)));
    } else if (a.entitlementDeniedUntil && parseTs(a.entitlementDeniedUntil) > Date.now()) {
      var entSec = (parseTs(a.entitlementDeniedUntil) - Date.now()) / 1000;
      meta.appendChild(el('span', 'card-meta-item warn', '⏳ Entitlement: ' + fmtIn(entSec)));
    } else if (a.rateLimitedUntil && parseTs(a.rateLimitedUntil) > Date.now()) {
      var rlSec = (parseTs(a.rateLimitedUntil) - Date.now()) / 1000;
      meta.appendChild(el('span', 'card-meta-item warn', '⏳ Rate Limit hold: ' + fmtIn(rlSec)));
    }

    if (a.sessions) {
      meta.appendChild(el('span', 'card-meta-item', '📡 ' + a.sessions + ' ses' + (a.sessions > 1 ? 'ji' : 'ja')));
      meta.appendChild(el('span', 'card-meta-item ok', '⚡ ' + a.sessions + ' ses' + (a.sessions > 1 ? 'ji' : 'ja') + ' (cache)'));
    }

    // Usage & request counts (pushed to right)
    var u = a.usage || {};
    var last = u.lastUsed ? ' · ' + fmtAgo(u.lastUsed) : '';
    var usageSpan = el('span', 'card-meta-item', (u.totalRequests || 0) + ' req · ' + fmtNum(accountTokens(u)) + ' tok' + last);
    usageSpan.style.marginLeft = 'auto';
    meta.appendChild(usageSpan);

    card.appendChild(meta);
    return card;
  }

  function renderClients(clients) {
    var wrap = document.getElementById('clientsWrap');
    var names = Object.keys(clients || {});
    if (!names.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    names.sort(function (a, b) {
      var ca = clients[a], cb = clients[b];
      return ((cb.inputTokens || 0) + (cb.outputTokens || 0)) - ((ca.inputTokens || 0) + (ca.outputTokens || 0));
    });
    var table = document.getElementById('clients');
    table.textContent = '';
    var hr = el('tr');
    ['Client', 'Requests', 'WebSockets', 'Input tok', 'Output tok', 'Last used'].forEach(function (h, i) {
      hr.appendChild(el('th', i ? 'num' : '', h));
    });
    table.appendChild(hr);
    names.forEach(function (n) {
      var c = clients[n];
      var tr = el('tr');
      tr.appendChild(el('td', '', n));
      tr.appendChild(el('td', 'num', fmtNum(c.requests)));
      tr.appendChild(el('td', 'num', fmtNum(c.connections || 0)));
      tr.appendChild(el('td', 'num', fmtNum(c.inputTokens)));
      tr.appendChild(el('td', 'num', fmtNum(c.outputTokens)));
      tr.appendChild(el('td', 'num', c.lastUsed ? fmtAgo(c.lastUsed) : '—'));
      table.appendChild(tr);
    });
  }

  // Header cells that re-sort in place. The sort is state, not a re-fetch, so
  // it survives the 5s poll: re-rendering re-reads sortState below.
  function addSortableHeader(tr, table, label, key, numeric) {
    var th = el('th', (numeric ? 'num ' : '') + 'sortable', label + (sortState[table].key === key ? (sortState[table].dir === 'asc' ? ' ▲' : ' ▼') : ''));
    th.addEventListener('click', function () {
      var st = sortState[table];
      if (st.key === key) st.dir = st.dir === 'asc' ? 'desc' : 'asc';
      else { st.key = key; st.dir = numeric ? 'desc' : 'asc'; }
      if (lastStatus) render(lastStatus);
    });
    tr.appendChild(th);
  }

  var SESSION_COLUMNS = [
    { key: 'id', label: 'Session' },
    { key: 'client', label: 'Client' },
    { key: 'project', label: 'Project' },
    { key: 'accounts', label: 'Accounts' },
    { key: 'requests', label: 'Req', num: true },
    { key: 'cacheRead', label: 'Cache read', num: true },
    { key: 'cacheCreation', label: 'Cache write', num: true },
    { key: 'input', label: 'Input', num: true },
    { key: 'output', label: 'Output', num: true },
    { key: 'context', label: 'Context', num: true },
    { key: 'lastSeen', label: 'Last seen', num: true },
  ];

  function renderSessions(sessions) {
    var wrap = document.getElementById('sessionsWrap');
    // Absent unless proxy.sessionDetail is on — the aggregate counts in the
    // summary line stay either way.
    if (!sessions || !sessions.items) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';

    var all = sessionRows(sessions);
    var projectSel = document.getElementById('fProject');
    var clientSel = document.getElementById('fClient');
    fillFilter(projectSel, uniqSorted(all.map(function (r) { return r.project; })), sessionFilters.project);
    fillFilter(clientSel, uniqSorted(all.map(function (r) { return r.client; })), sessionFilters.client);
    sessionFilters.project = projectSel.value;
    sessionFilters.client = clientSel.value;

    var rows = sortRows(filterSessionRows(all, sessionFilters), sortState.sessions.key, sortState.sessions.dir);
    document.getElementById('sessionCount').textContent = rows.length + ' of ' + all.length + ' sessions';

    var table = document.getElementById('sessions');
    table.textContent = '';
    var hr = el('tr');
    SESSION_COLUMNS.forEach(function (c) { addSortableHeader(hr, 'sessions', c.label, c.key, !!c.num); });
    table.appendChild(hr);
    rows.forEach(function (r) {
      var tr = el('tr');
      tr.appendChild(el('td', r.active ? '' : 'dim', r.id));
      tr.appendChild(el('td', '', r.client || '—'));
      tr.appendChild(el('td', '', r.project || '—'));
      tr.appendChild(el('td', '', r.accounts || '—'));
      ['requests', 'cacheRead', 'cacheCreation', 'input', 'output', 'context'].forEach(function (k) {
        tr.appendChild(el('td', 'num', fmtNum(r[k])));
      });
      tr.appendChild(el('td', 'num', r.lastSeen ? fmtAgo(r.lastSeen) : '—'));
      table.appendChild(tr);
    });
  }

  function fillFilter(select, values, value) {
    select.textContent = '';
    var all = el('option', '', 'All');
    all.value = '';
    select.appendChild(all);
    values.forEach(function (v) {
      var option = el('option', '', v);
      option.value = v;
      select.appendChild(option);
    });
    select.value = values.indexOf(value) === -1 ? '' : value;
  }

  // One table per configured usage dimension (proxy.usageDimensions).
  function renderDimensions(dimensions) {
    var wrap = document.getElementById('dimensionsWrap');
    wrap.textContent = '';
    Object.keys(dimensions || {}).forEach(function (name) {
      var entries = dimensions[name] || {};
      var rows = Object.keys(entries).map(function (key) {
        var e = entries[key] || {};
        return {
          name: key,
          requests: e.requests || 0,
          inputTokens: e.inputTokens || 0,
          outputTokens: e.outputTokens || 0,
          lastUsed: e.lastUsed ? Date.parse(e.lastUsed) : 0,
        };
      });
      if (!rows.length) return;
      sortState[name] = sortState[name] || { key: 'inputTokens', dir: 'desc' };
      rows = sortRows(rows, sortState[name].key, sortState[name].dir);

      wrap.appendChild(el('h2', '', name.charAt(0).toUpperCase() + name.slice(1)));
      var card = el('div', 'card');
      card.style.padding = '4px 6px';
      var table = el('table');
      var hr = el('tr');
      [{ key: 'name', label: name.charAt(0).toUpperCase() + name.slice(1) },
        { key: 'requests', label: 'Req', num: true },
        { key: 'inputTokens', label: 'Input tok', num: true },
        { key: 'outputTokens', label: 'Output tok', num: true },
        { key: 'lastUsed', label: 'Last used', num: true }].forEach(function (c) {
        addSortableHeader(hr, name, c.label, c.key, !!c.num);
      });
      table.appendChild(hr);
      rows.forEach(function (r) {
        var tr = el('tr');
        tr.appendChild(el('td', '', r.name));
        tr.appendChild(el('td', 'num', fmtNum(r.requests)));
        tr.appendChild(el('td', 'num', fmtNum(r.inputTokens)));
        tr.appendChild(el('td', 'num', fmtNum(r.outputTokens)));
        tr.appendChild(el('td', 'num', r.lastUsed ? fmtAgo(r.lastUsed) : '—'));
        table.appendChild(tr);
      });
      card.appendChild(table);
      wrap.appendChild(card);
    });
  }

  // Where each metered family goes right now, and which accounts could take
  // it. The last row is the default: everything without its own route lands
  // on the current account.
  function renderRoutes(s) {
    var wrap = document.getElementById('routesWrap');
    var rows = routeRows(s);
    if (!rows.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    var table = document.getElementById('routes');
    table.textContent = '';
    var hr = el('tr');
    ['Family', 'Goes to', 'Can serve it'].forEach(function (h) { hr.appendChild(el('th', '', h)); });
    table.appendChild(hr);
    rows.forEach(function (r) {
      var tr = el('tr');
      var fam = el('td', '', r.label + (r.match ? ' ' : ''));
      if (r.match) fam.appendChild(el('span', 'tag', r.match));
      tr.appendChild(fam);
      var to = el('td', r.blocked ? 'badt' : '', r.blocked ? 'blocked' : (r.target || '—'));
      if (r.pinned) to.appendChild(el('span', 'pin', ' · pinned to ' + r.pinned));
      if (r.pinMismatch) to.appendChild(el('span', 'warnt', ' (not eligible)'));
      if (r.kind === 'default' && r.target !== r.current) {
        to.appendChild(el('span', 'warnt', r.currentUnavailable
          ? ' · current account ' + r.current + ' is blocked: ' + (UNAVAILABLE_TEXT[r.currentUnavailable] || r.currentUnavailable)
          : ' · outranks the current account ' + r.current));
      }
      tr.appendChild(to);
      var can = el('td', r.kind === 'default' ? 'dim' : '');
      if (r.kind === 'default') can.textContent = 'no route of its own';
      else if (r.blocked) can.textContent = '—';
      else if (!r.eligible.length && !r.ineligible.length) can.textContent = '—';
      else {
        can.appendChild(el('span', 'ok', r.eligible.length + ' of ' + (r.eligible.length + r.ineligible.length) + (r.ineligible.length ? ' ' : '')));
        if (r.ineligible.length) can.appendChild(el('span', 'no', r.ineligible.join(', ')));
      }
      tr.appendChild(can);
      table.appendChild(tr);
    });
  }

  // Top of the page and only when something is wrong: a banner that is always
  // on is a banner nobody reads.
  function renderProblems(s) {
    var wrap = document.getElementById('problems');
    var list = problems(s);
    wrap.textContent = '';
    if (!list.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'block';
    list.forEach(function (p) {
      var box = el('div', p.severity);
      box.style.display = 'flex';
      box.style.alignItems = 'center';
      box.style.justifyContent = 'space-between';
      box.style.flexWrap = 'wrap';
      box.style.gap = '10px';

      var msg = el('span', '', p.text);
      box.appendChild(msg);

      if (p.kind === 'account' && (p.reason === 'error' || (p.text && p.text.indexOf('needs a re-login') !== -1))) {
        var btn = el('button', 'btn btn-sm btn-accent', '🔐 Zaloguj ponownie (Re-login)');
        btn.style.whiteSpace = 'nowrap';
        btn.title = 'Zaloguj ponownie konto ' + (p.accountName || '');
        btn.addEventListener('click', function () {
          startReLogin(p.accountName, p.priority, p.provider);
        });
        box.appendChild(btn);
      } else if (p.kind === 'account' && p.reason === 'disabled') {
        var btn = el('button', 'btn btn-sm btn-ok', '▶️ Włącz konto');
        btn.style.whiteSpace = 'nowrap';
        btn.addEventListener('click', function () {
          doToggleDisabled(p.accountName, true, btn);
        });
        box.appendChild(btn);
      }
      wrap.appendChild(box);
    });
  }

  function renderAccountsGrid(s) {
    var listClaude = document.getElementById('listClaude');
    var listCodex = document.getElementById('listCodex');
    if (!listClaude || !listCodex) return;

    attachListDropTarget(listClaude);
    attachListDropTarget(listCodex);

    listClaude.textContent = '';
    listCodex.textContent = '';

    var accts = s.accounts || [];
    var claudeAccts = [];
    var codexAccts = [];

    accts.forEach(function (a) {
      if ((a.provider || '').toLowerCase() === 'codex') {
        codexAccts.push(a);
      } else {
        claudeAccts.push(a);
      }
    });

    // Sort by priority ascending (0 = highest priority)
    claudeAccts.sort(function (a, b) {
      return (a.priority || 0) - (b.priority || 0);
    });
    codexAccts.sort(function (a, b) {
      return (a.priority || 0) - (b.priority || 0);
    });

    // Column counters
    var countClaude = document.getElementById('countClaude');
    if (countClaude) {
      countClaude.textContent = claudeAccts.length + (claudeAccts.length === 1 ? (currentLang === 'pl' ? ' konto' : ' account') : (currentLang === 'pl' ? ' kont' : ' accounts'));
    }
    var countCodex = document.getElementById('countCodex');
    if (countCodex) {
      countCodex.textContent = codexAccts.length + (codexAccts.length === 1 ? (currentLang === 'pl' ? ' konto' : ' account') : (currentLang === 'pl' ? ' kont' : ' accounts'));
    }

    // Render Claude accounts
    if (claudeAccts.length === 0) {
      var emptyC = el('div', '', t('emptyNoAccountsClaude'));
      emptyC.style.cssText = 'padding:16px; text-align:center; color:var(--dim); font-size:12px; border:1px dashed var(--line); border-radius:6px;';
      listClaude.appendChild(emptyC);
    } else {
      claudeAccts.forEach(function (a, idx) {
        listClaude.appendChild(renderAccount(a, s.currentAccount, idx));
      });
    }

    // Render Codex accounts
    if (codexAccts.length === 0) {
      var emptyX = el('div', '', t('emptyNoAccountsCodex'));
      emptyX.style.cssText = 'padding:16px; text-align:center; color:var(--dim); font-size:12px; border:1px dashed var(--line); border-radius:6px;';
      listCodex.appendChild(emptyX);
    } else {
      codexAccts.forEach(function (a, idx) {
        listCodex.appendChild(renderAccount(a, s.currentAccount, idx));
      });
    }
  }

  function render(s) {
    if (draggedCard) return; // Prevent DOM replacement during drag
    lastStatus = s;
    var sess = s.sessions || {};
    var up = s.server && s.server.uptimeSeconds != null ? 'up ' + fmtIn(s.server.uptimeSeconds) : '';
    var sum = document.getElementById('summary');
    sum.textContent = '';
    sum.appendChild(el('span', '', t('summaryActiveAccount')));
    sum.appendChild(el('b', '', s.currentAccount || t('summaryNone')));
    sum.appendChild(el('span', '', t('summarySessions', { active: sess.active || 0, known: sess.known || 0 }) + (up ? ' · ' + up : '')));
    var acc = document.getElementById('accounts');
    if (acc) acc.textContent = '';

    renderFleetPolicy(s);
    renderAccountsGrid(s);
    renderProblems(s);
    renderRoutes(s);
    renderClientKeys(s.clientKeys, s.clients);
    renderClients(s.clients);
    renderDimensions(s.usageDimensions);
    renderSessions(s.sessions);
    var foot = document.getElementById('foot');
    if (foot) {
      foot.textContent = t('summaryRefreshes', { sec: (POLL_MS / 1000), time: new Date().toLocaleTimeString() });
    }
  }

  function renderFleetPolicy(s) {
    var sel = document.getElementById('selDistributeSessions');
    if (sel && document.activeElement !== sel) {
      sel.value = (s.sessions && s.sessions.distribute) || 'adaptive';
    }
    var chkExp = document.getElementById('chkExpiryRouting');
    if (chkExp && document.activeElement !== chkExp) {
      chkExp.checked = !!(s.expiryRouting && s.expiryRouting.enabled);
    }
    var chkFb = document.getElementById('chkCrossProviderFallback');
    if (chkFb && document.activeElement !== chkFb) {
      chkFb.checked = !!s.crossProviderFallback;
    }
    var chkHealth = document.getElementById('chkAutoHealthCheck');
    var badgeHealth = document.getElementById('autoHealthBadge');
    var ah = s.autoHealthCheck;
    if (chkHealth && document.activeElement !== chkHealth) {
      chkHealth.checked = !ah || ah.enabled !== false;
    }
    if (badgeHealth && ah) {
      if (ah.enabled) {
        badgeHealth.style.display = '';
        badgeHealth.className = 'badge ok';
        var nextMin = ah.nextRunAt ? Math.max(0, Math.round((ah.nextRunAt - Date.now()) / 60000)) : null;
        badgeHealth.textContent = t('autoHealthActive') + (nextMin != null ? ' (~' + nextMin + 'm)' : '');
        badgeHealth.title = currentLang === 'pl' ? 'Sprawdzanie co ' + (ah.intervalSeconds || 900) + 's (0 tokenów dla aktywnych, 1 token dla bezczynnych)' : 'Checking every ' + (ah.intervalSeconds || 900) + 's (0 tokens for active, 1 token for idle)';
      } else {
        badgeHealth.style.display = '';
        badgeHealth.className = 'badge dim';
        badgeHealth.textContent = t('autoHealthDisabled');
        badgeHealth.title = currentLang === 'pl' ? 'Automatyczna diagnostyka w tle jest wyłączona' : 'Automatic background diagnostics are disabled';
      }
    }

    var btnDrain = document.getElementById('btnDrainToggle');
    var badgeDrain = document.getElementById('drainStatusBadge');
    if (btnDrain && badgeDrain) {
      if (s.draining) {
        btnDrain.textContent = t('btnDrainCancel');
        btnDrain.className = 'btn btn-sm btn-bad';
        badgeDrain.style.display = '';
        badgeDrain.textContent = t('drainActive', { count: s.activeRequests || 0 });
      } else {
        btnDrain.textContent = t('btnDrainMode');
        btnDrain.className = 'btn btn-sm';
        btnDrain.title = t('btnDrainModeTitle');
        badgeDrain.style.display = 'none';
      }
    }
  }

  function updateFleetRouting() {
    var sel = document.getElementById('selDistributeSessions');
    var chkExp = document.getElementById('chkExpiryRouting');
    var chkFb = document.getElementById('chkCrossProviderFallback');
    var payload = {
      distributeSessions: sel ? sel.value : 'adaptive',
      expiryRouting: {
        enabled: chkExp ? chkExp.checked : true,
        tolerance: 1.5,
        preempt: true,
      },
      crossProviderFallback: chkFb ? chkFb.checked : false,
    };
    apiCall('/agent-lb/api/routing', 'POST', payload)
      .then(function (res) {
        if (res && res.ok) {
          note('ok', 'Zaktualizowano politykę floty (Routing / Cache)');
          poll();
        } else {
          note('error', 'Błąd zapisu polityki: ' + (res && res.error ? res.error : 'nieznany'));
        }
      })
      .catch(function (e) {
        note('error', 'Błąd zapisu polityki: ' + e.message);
      });
  }

  function toggleDrain() {
    var isDraining = lastStatus && lastStatus.draining;
    var endpoint = isDraining ? '/agent-lb/api/drain/cancel' : '/agent-lb/api/drain';
    apiCall(endpoint, 'POST')
      .then(function (res) {
        if (res && res.ok) {
          note('ok', isDraining ? 'Wznowiono normalną pracę floty (anulowano drain)' : 'Włączono tryb Drain (dokańczanie aktywnych zapytań)');
          poll();
        } else {
          note('error', 'Błąd przełączania drain: ' + (res && res.error ? res.error : 'nieznany'));
        }
      })
      .catch(function (e) {
        note('error', 'Błąd: ' + e.message);
      });
  }

  function note(kind, text) {
    var n = document.getElementById('note');
    n.className = kind;
    n.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' · ' + text;
    n.style.display = 'block';
  }

  var revealedKeys = Object.create(null);
  var cachedClientKeys = Object.create(null);
  var primaryAdminKey = '';
  var pendingOAuthState = null;

  function apiCall(url, method, body) {
    var key = localStorage.getItem(KEY) || '';
    var headers = {
      'content-type': 'application/json',
    };
    if (key) headers['x-api-key'] = key;
    var init = {
      method: method || 'GET',
      headers: headers,
    };
    if (body != null) init.body = JSON.stringify(body);
    return fetch(url, init).then(function (res) {
      if (res.status === 401 || res.status === 403) {
        if (key) localStorage.removeItem(KEY);
        showKeybox('Wymagana autoryzacja administracyjna. Wprowadź klucz proxy (proxy.apiKey).');
        return null;
      }
      return res.json().catch(function () {
        return { ok: false, error: 'status ' + res.status };
      });
    });
  }

  function copyToClipboard(text, label) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        note('ok', (label || 'Text') + ' copied to clipboard');
      }).catch(function () {
        fallbackCopy(text, label);
      });
    } else {
      fallbackCopy(text, label);
    }
  }

  function fallbackCopy(text, label) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      note('ok', (label || 'Text') + ' copied to clipboard');
    } catch (e) {
      note('error', 'Could not copy to clipboard: ' + e.message);
    }
    document.body.removeChild(ta);
  }

  function openModal(id) {
    var m = document.getElementById(id);
    if (m) m.style.display = 'flex';
  }

  function closeModal(id) {
    var m = document.getElementById(id);
    if (m) m.style.display = 'none';
  }

  function doToggleDisabled(name, currentDisabled, btn) {
    btn.disabled = true;
    apiCall('/agent-lb/api/accounts/toggle', 'POST', { id: name, account: name, disabled: !currentDisabled })
      .then(function (res) {
        if (!res) return;
        if (res.ok) {
          note('ok', 'Konto "' + name + '" ' + (res.disabled ? 'wyłączone' : 'włączone'));
          poll();
        } else {
          note('error', 'Błąd przełączania: ' + (res.error || 'nieznany błąd'));
          btn.disabled = false;
        }
      })
      .catch(function (e) {
        note('error', 'Błąd: ' + e.message);
        btn.disabled = false;
      });
  }

  function doSetPriority(name, currentPrio) {
    var input = prompt('Podaj nowy priorytet dla konta "' + name + '" (liczba całkowita, niższa wartość = wyższy priorytet):', currentPrio || 0);
    if (input == null) return;
    var prio = parseInt(input.trim(), 10);
    if (isNaN(prio)) {
      note('error', 'Priorytet musi być liczbą całkowitą');
      return;
    }
    apiCall('/agent-lb/api/accounts/priority', 'POST', { id: name, account: name, priority: prio })
      .then(function (res) {
        if (!res) return;
        if (res.ok) {
          note('ok', 'Zmieniono priorytet konta "' + name + '" na ' + res.priority);
          poll();
        } else {
          note('error', 'Błąd zmiany priorytetu: ' + (res.error || 'nieznany błąd'));
        }
      })
      .catch(function (e) {
        note('error', 'Błąd: ' + e.message);
      });
  }

  function doRenameAccount(oldName) {
    var input = prompt('Podaj nową nazwę dla konta "' + oldName + '":', oldName);
    if (input == null) return;
    var newName = input.trim();
    if (!newName || newName === oldName) return;
    apiCall('/agent-lb/api/accounts/rename', 'POST', { oldName: oldName, newName: newName })
      .then(function (res) {
        if (!res) return;
        if (res.ok) {
          note('ok', 'Zmieniono nazwę konta z "' + oldName + '" na "' + res.newName + '"');
          poll();
        } else {
          note('error', 'Błąd zmiany nazwy: ' + (res.error || 'nieznany błąd'));
        }
      })
      .catch(function (e) {
        note('error', 'Błąd: ' + e.message);
      });
  }

  function doRemoveAccount(name, btn) {
    if (!confirm('Czy na pewno chcesz usunąć konto "' + name + '" z konfiguracji Agent LB?')) return;
    if (btn) btn.disabled = true;
    apiCall('/agent-lb/api/accounts/remove', 'POST', { id: name, account: name })
      .then(function (res) {
        if (!res) return;
        if (res.ok) {
          note('ok', 'Usunięto konto "' + name + '"');
          poll();
        } else {
          note('error', 'Błąd usuwania konta: ' + (res.error || 'nieznany błąd'));
          if (btn) btn.disabled = false;
        }
      })
      .catch(function (e) {
        note('error', 'Błąd: ' + e.message);
        if (btn) btn.disabled = false;
      });
  }

  function doProbeSingle(name, btn) {
    if (btn) btn.disabled = true;
    note('ok', 'Odpytywanie limitów konta "' + name + '"...');
    apiCall('/agent-lb/api/accounts/probe-single', 'POST', { account: name })
      .then(function (res) {
        if (!res) return;
        if (res.ok) {
          note('ok', 'Zaktualizowano limity konta "' + name + '"');
          poll();
        } else {
          note('error', 'Błąd odświeżania: ' + (res.error || 'nieznany błąd'));
        }
      })
      .catch(function (e) {
        note('error', 'Błąd: ' + e.message);
      })
      .finally(function () {
        if (btn) btn.disabled = false;
      });
  }

  function runQuickAccountTest(name, provider, btn) {
    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ ...';
    }
    var model = provider === 'codex' ? 'gpt-5.6-sol' : 'claude-haiku-4-5-20251001';
    note('ok', 'Wysyłanie zapytania testowego do konta "' + name + '"...');
    apiCall('/api/test/chat', 'POST', {
      provider: provider,
      account: name,
      model: model,
      message: 'Ping test konta. Odpowiedz jednym słowem "OK".'
    })
      .then(function (res) {
        if (!res) return;
        if (res.ok) {
          if (btn) {
            btn.textContent = '🟢 OK (' + (res.durationMs || 0) + 'ms)';
            btn.className = 'btn btn-xs btn-success';
          }
          note('ok', 'Konto "' + name + '" działa poprawnie! Czas odpowiedzi: ' + (res.durationMs || 0) + 'ms. Model: ' + (res.model || model));
          poll();
        } else {
          if (btn) {
            btn.textContent = '🔴 Błąd';
            btn.className = 'btn btn-xs btn-error';
          }
          note('error', 'Konto "' + name + '" zwróciło błąd: ' + (res.error || 'nieznany błąd'));
          poll();
        }
      })
      .catch(function (e) {
        if (btn) {
          btn.textContent = '🔴 Błąd';
          btn.className = 'btn btn-xs btn-error';
        }
        note('error', 'Błąd sieci podczas testowania konta: ' + e.message);
      })
      .finally(function () {
        setTimeout(function () {
          if (btn) {
            btn.disabled = false;
            btn.textContent = '⚡ Test';
            btn.className = 'btn btn-xs btn-outline';
          }
        }, 6000);
      });
  }

  function doSetPolicy(name, policy, btn) {
    if (btn) btn.disabled = true;
    apiCall('/agent-lb/api/accounts/policy', 'POST', { account: name, policy: policy })
      .then(function (res) {
        if (!res) return;
        if (res.ok) {
          note('ok', 'Ustawiono politykę konta "' + name + '" na: ' + (policy === 'burn-first' ? 'Burn first' : 'Normal'));
          poll();
        } else {
          note('error', 'Błąd zmiany polityki: ' + (res.error || 'nieznany błąd'));
        }
      })
      .catch(function (e) {
        note('error', 'Błąd: ' + e.message);
      })
      .finally(function () {
        if (btn) btn.disabled = false;
      });
  }

  function doConsumeResetCredit(name, btn) {
    if (!confirm('UWAGA: Czy na pewno chcesz zużyć 1 kredyt resetu OpenAI dla konta "' + name + '"?\\n\\nSpowoduje to natychmiastowe wyzerowanie okna 5h (blokady limitu) w ChatGPT. Ta operacja jest nieodwracalna.')) return;
    if (btn) btn.disabled = true;

    note('ok', 'Wysyłanie żądania resetu limitu do OpenAI...');
    apiCall('/agent-lb/api/accounts/consume-reset-credit', 'POST', { account: name })
      .then(function (res) {
        if (!res) return;
        if (res.ok) {
          note('ok', 'Pomyślnie zresetowano limit 5h dla konta "' + name + '"!');
          poll();
        } else {
          note('error', 'Błąd resetowania: ' + (res.error || 'nieznany błąd'));
        }
      })
      .catch(function (e) {
        note('error', 'Błąd: ' + e.message);
      })
      .finally(function () {
        if (btn) btn.disabled = false;
      });
  }

  function doExportAccount(name) {
    var key = localStorage.getItem(KEY) || '';
    var url = '/agent-lb/api/accounts/export?account=' + encodeURIComponent(name);
    var headers = {};
    if (key) headers['x-api-key'] = key;
    fetch(url, { headers: headers })
      .then(function (res) {
        if (!res.ok) throw new Error('Status ' + res.status);
        return res.blob();
      })
      .then(function (blob) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name + '-export.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
        note('ok', 'Wyeksportowano konto "' + name + '"');
      })
      .catch(function (e) {
        note('error', 'Błąd eksportu: ' + e.message);
      });
  }

  function doTestFleet(btn) {
    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ Diagnozowanie...';
    }
    note('ok', 'Rozpoczęto diagnostykę floty (weryfikacja aktywnych kont)...');
    apiCall('/agent-lb/api/health-check/run', 'POST', { force: true })
      .then(function (res) {
        if (!res) return;
        var sum = res.summary || {};
        var msg = 'Zakończono diagnostykę: ' + (sum.ok || 0) + ' sprawnych, ' + (sum.errors || 0) + ' z błędami, ' + (sum.skipped || 0) + ' pominiętych, zużyto łącznie ' + (sum.tokensUsed || 0) + ' tokenów.';
        note(sum.errors > 0 ? 'warn' : 'ok', msg);
        poll();
      })
      .catch(function (e) {
        note('error', 'Błąd podczas diagnostyki floty: ' + e.message);
      })
      .finally(function () {
        if (btn) {
          btn.disabled = false;
          btn.textContent = '🩺 Testuj flotę';
        }
      });
  }

  function doReloadFleet(btn) {

    if (btn) btn.disabled = true;
    apiCall('/agent-lb/reload', 'POST')
      .then(function (res) {
        if (btn) btn.disabled = false;
        if (!res) return;
        if (res.ok) {
          note('ok', 'Przeładowano flotę kont z dysku (' + (res.added || 0) + ' nowych kont)');
          poll();
        } else {
          note('error', 'Błąd przeładowania: ' + (res.error || 'nieznany błąd'));
        }
      })
      .catch(function (e) {
        if (btn) btn.disabled = false;
        note('error', 'Błąd przeładowania: ' + e.message);
      });
  }

  function doProbeQuota(btn) {
    if (btn) btn.disabled = true;
    note('ok', 'Sprawdzanie sald i limitów kont w Anthropic...');
    apiCall('/agent-lb/probe', 'POST')
      .then(function (res) {
        if (btn) btn.disabled = false;
        if (!res) return;
        if (res.ok) {
          note('ok', 'Pomyślnie zaktualizowano salda i limity floty kont');
          poll();
        } else {
          note('error', 'Błąd sprawdzania sald: ' + (res.error || 'nieznany błąd'));
        }
      })
      .catch(function (e) {
        if (btn) btn.disabled = false;
        note('error', 'Błąd sprawdzania sald: ' + e.message);
      });
  }

  function getSelectedAddProvider() {
    var codexRadio = document.getElementById('radioProvCodex');
    return (codexRadio && codexRadio.checked) ? 'codex' : 'anthropic';
  }

  function doAddApiKey(btn) {
    var key = document.getElementById('inApiKey').value.trim();
    var name = document.getElementById('inApiKeyName').value.trim();
    var prio = parseInt(document.getElementById('inApiKeyPrio').value.trim(), 10) || 0;
    if (!key) {
      note('error', 'Klucz API jest wymagany');
      return;
    }
    btn.disabled = true;
    apiCall('/agent-lb/api/accounts/add', 'POST', {
      type: 'api',
      apiKey: key,
      name: name,
      priority: prio,
      provider: getSelectedAddProvider(),
    })
      .then(function (res) {
        btn.disabled = false;
        if (!res) return;
        if (res.ok) {
          note('ok', 'Dodano konto API "' + res.account + '"');
          document.getElementById('inApiKey').value = '';
          document.getElementById('inApiKeyName').value = '';
          closeModal('modalAddAccount');
          poll();
        } else {
          note('error', 'Błąd dodawania konta: ' + (res.error || 'nieznany błąd'));
        }
      })
      .catch(function (e) {
        btn.disabled = false;
        note('error', 'Błąd dodawania konta: ' + e.message);
      });
  }

  function doAddOAuth(btn) {
    var jsonStr = document.getElementById('inOAuthJson').value.trim();
    var access = document.getElementById('inOAuthAccess').value.trim();
    var refresh = document.getElementById('inOAuthRefresh').value.trim();
    var name = document.getElementById('inOAuthName').value.trim();
    var prio = parseInt(document.getElementById('inOAuthPrio').value.trim(), 10) || 0;

    if (!jsonStr && !access) {
      note('error', 'Podaj token AccessToken lub wklej JSON poświadczeń');
      return;
    }
    btn.disabled = true;
    apiCall('/agent-lb/api/accounts/add', 'POST', {
      type: 'oauth',
      credentialsJson: jsonStr || null,
      accessToken: access || null,
      refreshToken: refresh || null,
      name: name,
      priority: prio,
      provider: getSelectedAddProvider(),
    })
      .then(function (res) {
        btn.disabled = false;
        if (!res) return;
        if (res.ok) {
          note('ok', 'Dodano konto OAuth "' + res.account + '"');
          document.getElementById('inOAuthJson').value = '';
          document.getElementById('inOAuthAccess').value = '';
          document.getElementById('inOAuthRefresh').value = '';
          document.getElementById('inOAuthName').value = '';
          closeModal('modalAddAccount');
          poll();
        } else {
          note('error', 'Błąd dodawania konta: ' + (res.error || 'nieznany błąd'));
        }
      })
      .catch(function (e) {
        btn.disabled = false;
        note('error', 'Błąd dodawania konta: ' + e.message);
      });
  }

  function doAddImportPath(btn) {
    var path = document.getElementById('inImportPath').value.trim();
    var name = document.getElementById('inImportPathName').value.trim();
    var prio = parseInt(document.getElementById('inImportPathPrio').value.trim(), 10) || 0;
    if (!path) {
      note('error', 'Ścieżka do pliku poświadczeń jest wymagana');
      return;
    }
    btn.disabled = true;
    apiCall('/agent-lb/api/accounts/add', 'POST', {
      type: 'import',
      importFrom: path,
      name: name,
      priority: prio,
      provider: getSelectedAddProvider(),
    })
      .then(function (res) {
        btn.disabled = false;
        if (!res) return;
        if (res.ok) {
          note('ok', 'Zaimportowano konto "' + res.account + '" z pliku ' + path);
          document.getElementById('inImportPathName').value = '';
          closeModal('modalAddAccount');
          poll();
        } else {
          note('error', 'Błąd importu: ' + (res.error || 'nieznany błąd'));
        }
      })
      .catch(function (e) {
        btn.disabled = false;
        note('error', 'Błąd importu: ' + e.message);
      });
  }

  function updateAddAccountProviderUI() {
    var isCodex = getSelectedAddProvider() === 'codex';

    var titleEl = document.getElementById('modalAddAccountTitle');
    if (titleEl) {
      titleEl.textContent = isCodex ? '➕ Dodaj konto OpenAI Codex' : '➕ Dodaj konto Claude (Anthropic)';
    }

    var lblApiKey = document.getElementById('lblApiKey');
    if (lblApiKey) lblApiKey.textContent = isCodex ? 'Klucz API OpenAI (sk-...) *' : 'Klucz API Anthropic Console (sk-ant-...) *';
    var inApiKey = document.getElementById('inApiKey');
    if (inApiKey) inApiKey.placeholder = isCodex ? 'sk-proj-...' : 'sk-ant-api03-...';

    var pOAuth = document.getElementById('pOAuthHelp');
    if (pOAuth) {
      pOAuth.innerHTML = isCodex
        ? 'Wklej zawartość pliku <code>~/.codex/auth.json</code> lub podaj tokeny z sesji OAuth:'
        : 'Wklej zawartość pliku <code>~/.claude/.credentials.json</code> lub podaj tokeny z sesji OAuth:';
    }
    var inOAuthJson = document.getElementById('inOAuthJson');
    if (inOAuthJson) {
      inOAuthJson.placeholder = isCodex
        ? '{"tokens":{"access_token":"...","refresh_token":"...","account_id":"..."}}'
        : '{"claudeAiOauth":{"accessToken":"...","refreshToken":"...","expiresAt":...}}';
    }

    var inImportPath = document.getElementById('inImportPath');
    if (inImportPath) {
      if (!inImportPath.dataset.customized) {
        inImportPath.value = isCodex ? '~/.codex/auth.json' : '~/.claude/.credentials.json';
      }
    }

    var pBrowser = document.getElementById('pBrowserOAuthHelp');
    if (pBrowser) {
      pBrowser.textContent = isCodex
        ? 'Zaloguj się na konto OpenAI Codex / ChatGPT w przeglądarce za pomocą bezpiecznego przepływu PKCE.'
        : 'Zaloguj się na konto Claude w przeglądarce za pomocą bezpiecznego przepływu PKCE.';
    }
    var btnStart = document.getElementById('btnStartOAuth');
    if (btnStart) {
      btnStart.textContent = isCodex ? 'Rozpocznij logowanie OpenAI Codex' : 'Rozpocznij logowanie Claude';
    }
    var pStep2 = document.getElementById('pOAuthStep2Help');
    if (pStep2) {
      pStep2.textContent = isCodex
        ? '2. Zaloguj się w OpenAI / ChatGPT i skopiuj kod autoryzacyjny lub adres URL (http://localhost:1455/auth/callback?code=...):'
        : '2. Zaloguj się w Claude.ai i skopiuj kod autoryzacyjny lub pełny adres URL:';
    }
  }

  function doStartOAuth(btn) {
    if (btn) btn.disabled = true;
    var authWindow = null;
    try {
      authWindow = window.open('about:blank', '_blank');
    } catch (e) {
      authWindow = null;
    }

    var prov = getSelectedAddProvider();
    note('ok', 'Inicjowanie logowania w przeglądarce (' + (prov === 'codex' ? 'OpenAI Codex' : 'Claude') + ')...');
    apiCall('/agent-lb/oauth/start?provider=' + encodeURIComponent(prov), 'GET')
      .then(function (res) {
        if (btn) btn.disabled = false;
        if (!res || !res.ok) {
          if (authWindow) authWindow.close();
          note('error', 'Nie można zainicjować logowania: ' + (res ? res.error : 'nieznany błąd'));
          return;
        }
        pendingOAuthState = res.state;
        if (authWindow) {
          authWindow.location.href = res.authUrl;
        }
        var link = document.getElementById('oauthLink');
        if (link) link.href = res.authUrl;
        document.getElementById('oauthStep1').style.display = 'none';
        document.getElementById('oauthStep2').style.display = 'block';
        note('ok', 'Otwarto stronę logowania ' + (prov === 'codex' ? 'OpenAI' : 'Claude') + '. Po zatwierdzeniu wklej kod poniżej.');
      })
      .catch(function (e) {
        if (btn) btn.disabled = false;
        if (authWindow) authWindow.close();
        note('error', 'Błąd logowania OAuth: ' + e.message);
      });
  }
  var doStartBrowserOAuth = doStartOAuth;


  function doCompleteOAuth(btn) {
    var code = document.getElementById('inOAuthCode').value.trim();
    var name = document.getElementById('inOAuthFlowName').value.trim();
    var prio = parseInt(document.getElementById('inOAuthFlowPrio').value.trim(), 10) || 0;
    if (!code) {
      note('error', 'Wklej kod autoryzacyjny lub pełny adres URL');
      return;
    }
    if (!pendingOAuthState) {
      note('error', 'Brak aktywnej sesji logowania. Rozpocznij logowanie ponownie.');
      return;
    }
    btn.disabled = true;
    apiCall('/agent-lb/oauth/complete', 'POST', {
      code: code,
      state: pendingOAuthState,
      name: name,
      priority: prio,
      provider: getSelectedAddProvider(),
    })
      .then(function (res) {
        btn.disabled = false;
        if (!res) return;
        if (res.ok) {
          note('ok', 'Zautoryzowano konto "' + res.account + '"' + (res.email ? ' (' + res.email + ')' : ''));
          document.getElementById('inOAuthCode').value = '';
          document.getElementById('inOAuthFlowName').value = '';
          document.getElementById('oauthStep1').style.display = 'block';
          document.getElementById('oauthStep2').style.display = 'none';
          closeModal('modalAddAccount');
          pendingOAuthState = null;
          poll();
        } else {
          note('error', 'Błąd autoryzacji: ' + (res.error || 'nieznany błąd'));
        }
      })
      .catch(function (e) {
        btn.disabled = false;
        note('error', 'Błąd autoryzacji: ' + e.message);
      });
  }

  var currentReloginAccount = null;
  var currentReloginPriority = 0;
  var currentReloginProvider = 'anthropic';

  function selectReloginTab(tab) {
    var tabs = ['Browser', 'Json', 'Import'];
    tabs.forEach(function (t) {
      var btn = document.getElementById('tabBtnRelogin' + t);
      var content = document.getElementById('tabContentRelogin' + t);
      if (btn && content) {
        if (t === tab) {
          btn.className = 'tab-btn active';
          content.style.display = 'block';
        } else {
          btn.className = 'tab-btn';
          content.style.display = 'none';
        }
      }
    });
  }

  function startReLogin(accountName, priority, provider) {
    currentReloginAccount = accountName || '';
    currentReloginPriority = priority != null ? priority : 0;
    currentReloginProvider = provider || 'anthropic';
    var isCodex = currentReloginProvider === 'codex';

    var titleEl = document.getElementById('reloginAccountTitle');
    if (titleEl) titleEl.textContent = accountName + (isCodex ? ' (OpenAI Codex)' : ' (Claude)');
    var email1 = document.getElementById('reloginStep1Email');
    if (email1) email1.textContent = accountName;
    var email2 = document.getElementById('reloginStep2Email');
    if (email2) email2.textContent = accountName;

    var s1Btn = document.getElementById('btnStartReloginOAuth');
    if (s1Btn) s1Btn.textContent = isCodex ? '🌐 Otwórz logowanie OpenAI Codex w nowej karcie' : '🌐 Otwórz logowanie Claude.ai w nowej karcie';

    var inImportPath = document.getElementById('inReloginImportPath');
    if (inImportPath) inImportPath.value = isCodex ? '~/.codex/auth.json' : '~/.claude/.credentials.json';

    var inJson = document.getElementById('inReloginJson');
    if (inJson) {
      inJson.value = '';
      inJson.placeholder = isCodex ? '{"tokens":{"access_token":"...","refresh_token":"...","account_id":"..."}}' : '{"claudeAiOauth":{"accessToken":"...","refreshToken":"..."}}';
    }

    var inCode = document.getElementById('inReloginOAuthCode');
    if (inCode) {
      inCode.value = '';
      inCode.placeholder = isCodex ? 'Wklej kod lub URL callback (http://localhost:1455/auth/callback?code=...)' : 'Wklej kod lub URL callback (https://claude.ai/oauth/callback?code=...)';
    }

    var step1 = document.getElementById('reloginOAuthStep1');
    if (step1) step1.style.display = 'block';
    var step2 = document.getElementById('reloginOAuthStep2');
    if (step2) step2.style.display = 'none';

    selectReloginTab('Browser');
    openModal('modalRelogin');
  }

  function doStartReloginOAuth(btn) {
    if (btn) btn.disabled = true;
    var authWindow = null;
    try {
      authWindow = window.open('about:blank', '_blank');
    } catch {}

    var startUrl = '/agent-lb/oauth/start?provider=' + encodeURIComponent(currentReloginProvider || 'anthropic');
    apiCall(startUrl, 'GET')
      .then(function (res) {
        if (btn) btn.disabled = false;
        if (!res || !res.ok) {
          if (authWindow) authWindow.close();
          note('error', 'Nie można zainicjować logowania: ' + (res ? res.error : 'nieznany błąd'));
          return;
        }
        pendingOAuthState = res.state;
        if (authWindow) {
          authWindow.location.href = res.authUrl;
        }
        var link = document.getElementById('reloginOAuthLink');
        if (link) link.href = res.authUrl;
        var step1 = document.getElementById('reloginOAuthStep1');
        if (step1) step1.style.display = 'none';
        var step2 = document.getElementById('reloginOAuthStep2');
        if (step2) step2.style.display = 'block';
      })
      .catch(function (e) {
        if (btn) btn.disabled = false;
        if (authWindow) authWindow.close();
        note('error', 'Błąd logowania OAuth: ' + e.message);
      });
  }

  function doCompleteReloginOAuth(btn) {
    var code = document.getElementById('inReloginOAuthCode').value.trim();
    if (!code) {
      note('error', 'Wklej kod autoryzacyjny lub pełny adres URL');
      return;
    }
    if (!pendingOAuthState) {
      note('error', 'Brak aktywnej sesji logowania. Rozpocznij logowanie ponownie.');
      return;
    }
    if (btn) btn.disabled = true;
    apiCall('/agent-lb/oauth/complete', 'POST', {
      code: code,
      state: pendingOAuthState,
      name: currentReloginAccount,
      priority: currentReloginPriority,
      provider: currentReloginProvider,
    })
      .then(function (res) {
        if (btn) btn.disabled = false;
        if (!res) return;
        if (res.ok) {
          note('ok', 'Zalogowano pomyślnie! Sesja konta "' + res.account + '" została odnowiona.');
          closeModal('modalRelogin');
          pendingOAuthState = null;
          poll();
        } else {
          note('error', 'Błąd logowania: ' + (res.error || 'nieznany błąd'));
        }
      })
      .catch(function (e) {
        if (btn) btn.disabled = false;
        note('error', 'Błąd autoryzacji: ' + e.message);
      });
  }

  function doSubmitReloginJson(btn) {
    var raw = document.getElementById('inReloginJson').value.trim();
    if (!raw) {
      note('error', 'Wklej treść JSON poświadczeń');
      return;
    }
    if (btn) btn.disabled = true;
    apiCall('/agent-lb/api/accounts/add', 'POST', {
      type: 'oauth',
      credentialsJson: raw,
      name: currentReloginAccount,
      priority: currentReloginPriority,
      provider: currentReloginProvider,
    })
      .then(function (res) {
        if (btn) btn.disabled = false;
        if (!res) return;
        if (res.ok) {
          note('ok', 'Zaktualizowano poświadczenia dla konta "' + res.account + '"');
          closeModal('modalRelogin');
          poll();
        } else {
          note('error', 'Błąd aktualizacji konta: ' + (res.error || 'nieznany błąd'));
        }
      })
      .catch(function (e) {
        if (btn) btn.disabled = false;
        note('error', 'Błąd: ' + e.message);
      });
  }

  function doSubmitReloginImport(btn) {
    var path = document.getElementById('inReloginImportPath').value.trim();
    if (!path) {
      note('error', 'Podaj ścieżkę do pliku na serwerze');
      return;
    }
    if (btn) btn.disabled = true;
    apiCall('/agent-lb/api/accounts/add', 'POST', {
      type: 'import',
      importFrom: path,
      name: currentReloginAccount,
      priority: currentReloginPriority,
      provider: currentReloginProvider,
    })
      .then(function (res) {
        if (btn) btn.disabled = false;
        if (!res) return;
        if (res.ok) {
          note('ok', 'Zaimportowano nowe poświadczenia dla konta "' + res.account + '"');
          closeModal('modalRelogin');
          poll();
        } else {
          note('error', 'Błąd importu: ' + (res.error || 'nieznany błąd'));
        }
      })
      .catch(function (e) {
        if (btn) btn.disabled = false;
        note('error', 'Błąd: ' + e.message);
      });
  }

  function showKeyModal(name, key) {
    var realKey = (key && !key.includes('...')) ? key : (cachedClientKeys[name] || key || '');
    if (realKey && !realKey.includes('...')) {
      cachedClientKeys[name] = realKey;
    }
    document.getElementById('createdClientName').textContent = name;
    document.getElementById('createdClientKey').textContent = realKey;
    var hostUrl = window.location.origin;

    var cmdBash = 'curl -fsSL ' + hostUrl + '/setup.sh | bash -s -- --key ' + realKey;
    var cmdCodexBash = 'curl -fsSL ' + hostUrl + '/codexlb-setup.sh | bash -s -- --key ' + realKey;
    var cmdPs = '& ([scriptblock]::Create((irm ' + hostUrl + '/setup.ps1))) -Key "' + realKey + '"';
    var cmdCodexPs = '& ([scriptblock]::Create((irm ' + hostUrl + '/codexlb-setup.ps1))) -Key "' + realKey + '"';
    var cmdNode = 'curl -fsSL ' + hostUrl + '/setup.js | node - --key ' + realKey;
    var cmdGit = 'git clone https://github.com/tomaasz/agent-lb.git && cd agent-lb && ./setup/setup.sh --key ' + realKey;
    var manualText = [
      '# Claude Code CLI (OAuth / subscription — zalecane):',
      'export ANTHROPIC_BASE_URL="' + hostUrl + '"',
      'unset ANTHROPIC_API_KEY  # zachowaj sesje OAuth Claude Code',
      'export ANTHROPIC_CUSTOM_HEADERS="x-api-key: ' + realKey + '"',
      '',
      '# Claude Code CLI (tryb API key — gdy nie korzystasz z logowania Claude.ai):',
      'export ANTHROPIC_BASE_URL="' + hostUrl + '"',
      'export ANTHROPIC_API_KEY="' + realKey + '"',
      'unset ANTHROPIC_CUSTOM_HEADERS',
      '',
      '# OpenAI Codex CLI:',
      'export CODEX_BASE_URL="' + hostUrl + '/backend-api/codex"',
      'export CODEX_LB_API_KEY="' + realKey + '"',
      'export OPENAI_BASE_URL="' + hostUrl + '/v1"'
    ].join('\\n');

    document.getElementById('cmdSetupBash').textContent = cmdBash;
    document.getElementById('cmdSetupCodexBash').textContent = cmdCodexBash;
    document.getElementById('cmdSetupPowershell').textContent = cmdPs;
    document.getElementById('cmdSetupCodexPowershell').textContent = cmdCodexPs;
    document.getElementById('cmdSetupNode').textContent = cmdNode;
    document.getElementById('cmdSetupGit').textContent = cmdGit;
    document.getElementById('boxManualConfig').textContent = manualText;

    selectSetupTab('Bash');
    openModal('modalKeyCreated');
  }

  function selectSetupTab(tab) {
    var tabs = ['Bash', 'Powershell', 'Node', 'Git', 'Manual'];
    tabs.forEach(function (t) {
      var btn = document.getElementById('tabSetup' + t);
      var content = document.getElementById('contentSetup' + t);
      if (btn && content) {
        if (t === tab) {
          btn.classList.add('active');
          content.style.display = 'block';
        } else {
          btn.classList.remove('active');
          content.style.display = 'none';
        }
      }
    });
  }

  function doAddClientKey(btn) {
    var name = document.getElementById('inClientName').value.trim();
    var customKey = document.getElementById('inClientCustomKey').value.trim();
    var maxDailyStr = (document.getElementById('inClientDailyTokens')?.value || '').trim();
    var maxMonthlyStr = (document.getElementById('inClientMonthlyTokens')?.value || '').trim();
    var expiresAtStr = (document.getElementById('inClientExpiresAt')?.value || '').trim();
    var allowedModelsStr = (document.getElementById('inClientAllowedModels')?.value || '').trim();

    if (!name) {
      note('error', 'Nazwa klienta / urządzenia jest wymagana');
      return;
    }
    var payload = { name: name, key: customKey };
    if (maxDailyStr) {
      var d = parseInt(maxDailyStr, 10);
      if (!isNaN(d) && d > 0) payload.maxDailyTokens = d;
    }
    if (maxMonthlyStr) {
      var m = parseInt(maxMonthlyStr, 10);
      if (!isNaN(m) && m > 0) payload.maxMonthlyTokens = m;
    }
    if (expiresAtStr) payload.expiresAt = expiresAtStr;
    if (allowedModelsStr) {
      payload.allowedModels = allowedModelsStr.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    }

    btn.disabled = true;
    apiCall('/agent-lb/api/keys/create', 'POST', { name: name, key: customKey })
    apiCall('/agent-lb/api/keys/create', 'POST', payload)
      .then(function (res) {
        btn.disabled = false;
        if (!res) return;
        if (res.ok) {
          note('ok', 'Utworzono klucz klienta dla "' + res.name + '"');
          if (res.key) cachedClientKeys[res.name] = res.key;
          closeModal('modalAddClientKey');
          document.getElementById('inClientName').value = '';
          document.getElementById('inClientCustomKey').value = '';
          if (document.getElementById('inClientDailyTokens')) document.getElementById('inClientDailyTokens').value = '';
          if (document.getElementById('inClientMonthlyTokens')) document.getElementById('inClientMonthlyTokens').value = '';
          if (document.getElementById('inClientExpiresAt')) document.getElementById('inClientExpiresAt').value = '';
          if (document.getElementById('inClientAllowedModels')) document.getElementById('inClientAllowedModels').value = '';
          showKeyModal(res.name, res.key);
          poll();
        } else {
          note('error', 'Błąd tworzenia klucza: ' + (res.error || 'nieznany błąd'));
        }
      })
      .catch(function (e) {
        btn.disabled = false;
        note('error', 'Błąd tworzenia klucza: ' + e.message);
      });
  }

  function doRemoveClientKey(name, btn) {
    if (!confirm('Czy na pewno chcesz unieważnić klucz klienta dla "' + name + '"? Ruch z tego urządzenia zostanie natychmiast odrzucony.')) return;
    if (btn) btn.disabled = true;
    apiCall('/agent-lb/api/keys/delete', 'POST', { name: name })
      .then(function (res) {
        if (btn) btn.disabled = false;
        if (!res) return;
        if (res.ok) {
          note('ok', 'Unieważniono klucz klienta "' + name + '"');
          delete cachedClientKeys[name];
          poll();
        } else {
          note('error', 'Błąd unieważniania klucza: ' + (res.error || 'nieznany błąd'));
        }
      })
      .catch(function (e) {
        if (btn) btn.disabled = false;
        note('error', 'Błąd unieważniania klucza: ' + e.message);
      });
  }

  var currentQuickTab = 'bash';
  var currentQuickKey = '';

  function updateQuickCmd(keys) {
    var hostUrl = window.location.origin;
    var list = keys || (lastStatus && lastStatus.clientKeys) || [];
    var key = currentQuickKey;
    if ((!key || key.includes('...')) && primaryAdminKey && !primaryAdminKey.includes('...')) {
      key = primaryAdminKey;
    }
    if ((!key || key.includes('...')) && list.length) {
      var first = list[0];
      key = (first.rawKey && !first.rawKey.includes('...')) ? first.rawKey : ((first.key && !first.key.includes('...')) ? first.key : (cachedClientKeys[first.name] || first.rawKey || first.key || ''));
    }
    if ((!key || key.includes('...')) && list.length) {
      for (var i = 0; i < list.length; i++) {
        var cand = cachedClientKeys[list[i].name];
        if (cand && !cand.includes('...')) {
          key = cand;
          break;
        }
      }
    }
    if (!key) key = '<KLUCZ_KLIENTA>';

    var chk = document.getElementById('chkIncludeKeyInCmd');
    var withKey = chk ? chk.checked : true;

    var cmd = '';
    if (currentQuickTab === 'ps') {
      cmd = withKey
        ? '& ([scriptblock]::Create((irm ' + hostUrl + '/setup.ps1))) -Key "' + key + '"'
        : 'irm ' + hostUrl + '/setup.ps1 | iex';
    } else {
      cmd = withKey
        ? 'curl -fsSL ' + hostUrl + '/setup.sh | bash -s -- --key ' + key
        : 'curl -fsSL ' + hostUrl + '/setup.sh | bash';
    }

    var codeEl = document.getElementById('quickCmdText');
    if (codeEl) {
      codeEl.textContent = cmd;
      codeEl.dataset.fullCmd = cmd;
    }
  }

  function setQuickTab(tab) {
    currentQuickTab = tab;
    var tabs = [
      { id: 'btnQuickTabBash', name: 'bash' },
      { id: 'btnQuickTabPS', name: 'ps' }
    ];
    tabs.forEach(function (t) {
      var btn = document.getElementById(t.id);
      if (btn) {
        if (t.name === tab) btn.classList.add('active');
        else btn.classList.remove('active');
      }
    });
    updateQuickCmd();
  }

  function copyQuickCmd() {
    var codeEl = document.getElementById('quickCmdText');
    var cmd = (codeEl && codeEl.dataset.fullCmd) || (codeEl && codeEl.textContent) || '';
    if (!cmd) return;
    copyToClipboard(cmd, 'Polecenie instalatora stacji');
    var btn = document.getElementById('btnQuickCopyCmd');
    if (btn) {
      var old = btn.textContent;
      btn.textContent = '✔ Skopiowano!';
      setTimeout(function () { btn.textContent = old; }, 1800);
    }
  }

  function renderClientKeys(keys, clients) {
    var list = keys || [];
    list.forEach(function (k) {
      var unmasked = (k.rawKey && !k.rawKey.includes('...')) ? k.rawKey : ((k.key && !k.key.includes('...')) ? k.key : '');
      if (unmasked) {
        cachedClientKeys[k.name] = unmasked;
      }
    });
    updateQuickCmd(keys);
    var container = document.getElementById('clientKeysTable');
    if (!container) return;
    container.textContent = '';

    var totalCount = list.length + (primaryAdminKey ? 1 : 0);
    var countEl = document.getElementById('countClientKeys');
    if (countEl) {
      countEl.textContent = totalCount + (totalCount === 1 ? (currentLang === 'pl' ? ' klucz' : ' key') : (currentLang === 'pl' ? ' kluczy' : ' keys'));
    }

    // Pinned primary admin key card at top
    if (primaryAdminKey) {
      var pCard = el('div', 'client-key-card primary-key-card');
      pCard.style.cssText = 'border-left: 3px solid #3b82f6; background: rgba(59, 130, 246, 0.04);';
      var isPRevealed = !!revealedKeys['__primary__'];

      var pTopRow = el('div', 'client-key-top');
      var pNameWrap = el('div', 'row');
      pNameWrap.style.gap = '6px';
      var pIcon = el('span', '', '👑');
      pIcon.style.fontSize = '13px';
      pNameWrap.appendChild(pIcon);
      var pName = el('span', 'name', t('primaryAdminKeyName'));
      pName.style.fontWeight = '600';
      pNameWrap.appendChild(pName);
      var pBadge = el('span', 'badge', 'Admin & CLI');
      pBadge.style.cssText = 'font-size:10px; padding:1px 6px; background:rgba(59, 130, 246, 0.15); color:#60a5fa; border-radius:4px; border:1px solid rgba(59, 130, 246, 0.3);';
      pNameWrap.appendChild(pBadge);
      pTopRow.appendChild(pNameWrap);

      var pActs = el('div', 'card-actions');
      var btnPSetup = el('button', 'btn btn-xs btn-accent', t('btnKeyConnect'));
      btnPSetup.title = currentLang === 'pl' ? 'Pokaż gotowe komendy instalatora (Linux, Windows, VS Code) dla tego klucza' : 'Show installer commands (Linux, Windows, VS Code) for this key';
      btnPSetup.addEventListener('click', function () {
        currentQuickKey = primaryAdminKey;
        updateQuickCmd();
        showKeyModal('Główny klucz (proxy.apiKey)', primaryAdminKey);
      });
      pActs.appendChild(btnPSetup);
      pTopRow.appendChild(pActs);
      pCard.appendChild(pTopRow);

      var pBottomRow = el('div', 'client-key-bottom');
      var pKeyWrap = el('div', 'row');
      pKeyWrap.style.gap = '5px';
      var pMasked = isPRevealed ? primaryAdminKey : (primaryAdminKey.length > 8 ? primaryAdminKey.slice(0, 5) + '••••••••' + primaryAdminKey.slice(-4) : '••••••••');
      var pKeySpan = el('span', 'mono', pMasked);
      pKeySpan.style.fontSize = '11px';
      pKeyWrap.appendChild(pKeySpan);

      if (primaryAdminKey && primaryAdminKey !== pMasked) {
        var btnPToggle = el('button', 'btn btn-xs', isPRevealed ? t('keyHide') : t('keyShow'));
        btnPToggle.addEventListener('click', function () {
          revealedKeys['__primary__'] = !revealedKeys['__primary__'];
          renderClientKeys(keys, clients);
        });
        pKeyWrap.appendChild(btnPToggle);
      }

      var btnPCopy = el('button', 'btn btn-xs', t('copyCmd'));
      btnPCopy.addEventListener('click', function () {
        copyToClipboard(primaryAdminKey, 'Główny klucz administratora');
      });
      pKeyWrap.appendChild(btnPCopy);
      pBottomRow.appendChild(pKeyWrap);

      var pDesc = el('span', 'client-key-stats', currentLang === 'pl' ? 'Logowanie do panelu + pełny dostęp CLI' : 'Dashboard login + full CLI access');
      pBottomRow.appendChild(pDesc);
      pCard.appendChild(pBottomRow);

      container.appendChild(pCard);
    }

    if (!list.length && !primaryAdminKey) {
      var empty = el('div', '', t('emptyNoKeys'));
      empty.style.cssText = 'padding:14px; text-align:center; color:var(--dim); font-size:12px; border:1px dashed var(--line); border-radius:6px;';
      container.appendChild(empty);
      return;
    }

    list.forEach(function (k) {
      var card = el('div', 'client-key-card');
      var raw = (k.rawKey && !k.rawKey.includes('...')) ? k.rawKey : ((k.key && !k.key.includes('...')) ? k.key : (cachedClientKeys[k.name] || k.rawKey || k.key || ''));
      if (raw && !raw.includes('...')) {
        cachedClientKeys[k.name] = raw;
      }
      var isRevealed = !!revealedKeys[k.name];

      // Top row: Name on left, Action buttons on right
      var topRow = el('div', 'client-key-top');

      var nameWrap = el('div', 'row');
      nameWrap.style.gap = '5px';
      var keyIcon = el('span', '', '🔑');
      keyIcon.style.fontSize = '12px';
      nameWrap.appendChild(keyIcon);
      var nameEl = el('span', 'name', k.name);
      nameWrap.appendChild(nameEl);
      var cBadge = el('span', 'badge', 'Panel & CLI');
      cBadge.style.cssText = 'font-size:10px; padding:1px 5px; background:rgba(16, 185, 129, 0.12); color:#34d399; border-radius:4px; border:1px solid rgba(16, 185, 129, 0.25);';
      nameWrap.appendChild(cBadge);

      if (k.expiresAt) {
        var expMs = parseTs(k.expiresAt);
        var isExp = expMs < Date.now();
        var expBadge = el('span', 'badge ' + (isExp ? 'bad' : 'ok'), isExp ? (currentLang === 'pl' ? '⚠️ Wygasł' : '⚠️ Expired') : '📅 ' + (typeof k.expiresAt === 'string' ? k.expiresAt.split('T')[0] : new Date(k.expiresAt).toLocaleDateString()));
        expBadge.style.fontSize = '9.5px';
        nameWrap.appendChild(expBadge);
      }

      if (Array.isArray(k.allowedModels) && k.allowedModels.length) {
        var mBadge = el('span', 'badge', '🎯 ' + k.allowedModels.join(', '));
        mBadge.style.cssText = 'font-size:9.5px; padding:1px 4px; background:rgba(255,255,255,0.06); border-radius:3px;';
        nameWrap.appendChild(mBadge);
      }

      topRow.appendChild(nameWrap);

      var acts = el('div', 'card-actions');

      var btnSetup = el('button', 'btn btn-xs btn-accent', t('btnKeyConnect'));
      btnSetup.title = currentLang === 'pl' ? 'Pokaż gotowe komendy instalatora (Linux, Windows, VS Code) dla tego klienta' : 'Show installer commands (Linux, Windows, VS Code) for this client';
      btnSetup.addEventListener('click', function () {
        currentQuickKey = raw;
        updateQuickCmd();
        showKeyModal(k.name, raw);
      });
      acts.appendChild(btnSetup);

      var btnDel = el('button', 'btn btn-xs btn-bad', currentLang === 'pl' ? 'Unieważnij' : 'Revoke');
      btnDel.title = currentLang === 'pl' ? 'Unieważnij i usuń ten klucz' : 'Revoke and delete this key';
      btnDel.addEventListener('click', function () {
        doRemoveClientKey(k.name, btnDel);
      });
      acts.appendChild(btnDel);

      topRow.appendChild(acts);
      card.appendChild(topRow);

      // Bottom row: Key + Show + Copy on left, Usage metrics on right
      var bottomRow = el('div', 'client-key-bottom');

      var keyWrap = el('div', 'row');
      keyWrap.style.gap = '5px';
      var masked = isRevealed ? raw : (raw.length > 8 ? raw.slice(0, 5) + '••••••••' + raw.slice(-4) : '••••••••');
      var keySpan = el('span', 'mono', masked);
      keySpan.style.fontSize = '11px';
      keyWrap.appendChild(keySpan);

      if (raw && raw !== masked) {
        var btnToggle = el('button', 'btn btn-xs', isRevealed ? t('keyHide') : t('keyShow'));
        btnToggle.addEventListener('click', function () {
          revealedKeys[k.name] = !revealedKeys[k.name];
          renderClientKeys(keys, clients);
        });
        keyWrap.appendChild(btnToggle);
      }

      var btnCopy = el('button', 'btn btn-xs', t('copyCmd'));
      btnCopy.addEventListener('click', function () {
        copyToClipboard(raw, 'Klucz klienta ' + k.name);
      });
      keyWrap.appendChild(btnCopy);
      bottomRow.appendChild(keyWrap);

      var stat = (k.stats) || (clients && clients[k.name]) || {};
      var inT = stat.inputTokens || 0;
      var outT = stat.outputTokens || 0;
      var tokText = (inT || outT) ? (fmtNum(inT) + ' / ' + fmtNum(outT)) : '0 tok';
      var statSpan = el('span', 'client-key-stats', (stat.requests || 0) + ' req · ' + tokText);
      bottomRow.appendChild(statSpan);
      card.appendChild(bottomRow);

      card.appendChild(bottomRow);
      if (k.maxDailyTokens || k.maxMonthlyTokens) {
        var limitWrap = el('div', 'client-key-limits');
        limitWrap.style.cssText = 'font-size:10.5px; color:var(--dim); margin-top:5px; padding-top:4px; border-top:1px dashed rgba(255,255,255,0.07); display:flex; gap:12px; flex-wrap:wrap;';
        if (k.maxDailyTokens) {
          var dUsed = k.dailyTokens || 0;
          var dPct = Math.min(100, Math.round((dUsed / k.maxDailyTokens) * 100));
          var dColor = dPct >= 90 ? '#f85149' : (dPct >= 70 ? '#d29922' : 'var(--text)');
          var dEl = el('span', '', 'Dziś: ');
          var dVal = el('b', '', fmtNum(dUsed) + ' / ' + fmtNum(k.maxDailyTokens) + ' (' + dPct + '%)');
          dVal.style.color = dColor;
          dEl.appendChild(dVal);
          limitWrap.appendChild(dEl);
        }
        if (k.maxMonthlyTokens) {
          var mUsed = k.monthlyTokens || 0;
          var mPct = Math.min(100, Math.round((mUsed / k.maxMonthlyTokens) * 100));
          var mColor = mPct >= 90 ? '#f85149' : (mPct >= 70 ? '#d29922' : 'var(--text)');
          var mEl = el('span', '', 'Miesiąc: ');
          var mVal = el('b', '', fmtNum(mUsed) + ' / ' + fmtNum(k.maxMonthlyTokens) + ' (' + mPct + '%)');
          mVal.style.color = mColor;
          mEl.appendChild(mVal);
          limitWrap.appendChild(mEl);
        }
        card.appendChild(limitWrap);
      }

      container.appendChild(card);
    });
  }

  function doPullSetup(btn) {
    if (btn) btn.disabled = true;
    note('ok', 'Pobieranie aktualizacji repozytorium agent-lb z GitHub...');
    apiCall('/agent-lb/api/setup/pull', 'POST')
      .then(function (res) {
        if (btn) btn.disabled = false;
        if (!res) return;
        if (res.ok) {
          note('ok', 'Zaktualizowano repozytorium agent-lb: ' + (res.output || 'Już aktualne.'));
        } else {
          note('error', 'Błąd git pull: ' + (res.error || 'nieznany błąd'));
        }
      })
      .catch(function (e) {
        if (btn) btn.disabled = false;
        note('error', 'Błąd aktualizacji repozytorium: ' + e.message);
      });
  }

  // One manual switch. The endpoint is a nudge, not a pin: it sets the current
  // account and normal rotation resumes from there (see the handler's comment
  // in server.js for what "eligible" means).
  function doSwitch(name, btn) {
    btn.disabled = true;
    var r = switchRequest(name, localStorage.getItem(KEY));
    fetch(r.url, r.init)
      .then(function (res) {
        if (res.status === 401 || res.status === 403) {
          if (localStorage.getItem(KEY)) localStorage.removeItem(KEY);
          showKeybox('Wymagana autoryzacja administracyjna. Wprowadź klucz proxy (proxy.apiKey).');
          return null;
        }
        return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
      })
      .then(function (json) {
        if (!json) return;
        var out = switchOutcome(json);
        note(out.kind, out.text);
        if (out.kind !== 'ok') btn.disabled = false;
        poll();
      })
      .catch(function (e) { note('error', 'switch failed: ' + e.message); btn.disabled = false; });
  }

  function showKeybox(errMsg, infoMsg) {
    if (timer) { clearInterval(timer); timer = null; }
    document.getElementById('app').style.display = 'none';
    document.getElementById('keybox').style.display = 'block';
    updateI18nDOM();
    var kErr = document.getElementById('keyboxErr');
    if (kErr) {
      if (errMsg) {
        kErr.textContent = errMsg;
        kErr.style.display = 'block';
      } else {
        kErr.style.display = 'none';
      }
    }
    var kInfo = document.getElementById('keyboxInfo');
    if (kInfo) {
      if (infoMsg) {
        kInfo.textContent = infoMsg;
        kInfo.style.display = 'block';
      } else {
        kInfo.style.display = 'none';
      }
    }
    var keyIn = document.getElementById('key');
    if (keyIn) {
      keyIn.value = '';
      setTimeout(function () { keyIn.focus(); }, 50);
    }
  }

  function poll() {
    var apiKey = localStorage.getItem(KEY) || '';
    var headers = {};
    if (apiKey) headers['x-api-key'] = apiKey;
    fetch('/agent-lb/status', { headers: headers })
      .then(function (res) {
        if (res.status === 401 || res.status === 403) {
          if (apiKey) {
            localStorage.removeItem(KEY);
            showKeybox('Nieprawidłowy klucz proxy API. Upewnij się, że podajesz klucz administracyjny (proxy.apiKey).');
          } else {
            showKeybox();
          }
          return null;
        }
        if (!res.ok) throw new Error('status ' + res.status);
        return res.json();
      })
      .then(function (s) {
        if (!s) return;
        document.getElementById('keybox').style.display = 'none';
        document.getElementById('app').style.display = '';
        document.getElementById('err').style.display = 'none';
        render(s);

        // Also fetch full client keys info with live stats
        var apiHeaders = {};
        if (apiKey) apiHeaders['x-api-key'] = apiKey;
        fetch('/agent-lb/api/keys', { headers: apiHeaders })
          .then(function (kr) { return kr.ok ? kr.json() : null; })
          .then(function (kd) {
            if (kd) {
              if (kd.primaryKey && !kd.primaryKey.includes('...')) {
                primaryAdminKey = kd.primaryKey;
              }
              if (Array.isArray(kd.keys)) {
                kd.keys.forEach(function (k) {
                  var r = (k.rawKey && !k.rawKey.includes('...')) ? k.rawKey : ((k.key && !k.key.includes('...')) ? k.key : '');
                  if (r) cachedClientKeys[k.name] = r;
                });
                renderClientKeys(kd.keys, s.clients);
              }
            }
          })
          .catch(function () { /* best effort */ });
      })
      .catch(function (e) {
        var err = document.getElementById('err');
        err.style.display = 'block';
        err.textContent = 'Cannot reach the proxy: ' + e.message;
      });
  }

  function start() {
    poll();
    if (!timer) timer = setInterval(poll, POLL_MS);
  }

  function checkAuthAndStart() {
    var apiKey = localStorage.getItem(KEY) || '';
    if (!apiKey) {
      fetch('/agent-lb/api/auth/verify')
        .then(function (res) {
          if (res.status === 200) {
            document.getElementById('keybox').style.display = 'none';
            document.getElementById('app').style.display = '';
            start();
          } else {
            showKeybox();
          }
        })
        .catch(function () {
          showKeybox();
        });
      return;
    }

    fetch('/agent-lb/api/auth/verify', {
      headers: { 'x-api-key': apiKey }
    })
      .then(function (res) {
        if (res.ok) {
          document.getElementById('keybox').style.display = 'none';
          document.getElementById('app').style.display = '';
          start();
        } else {
          localStorage.removeItem(KEY);
          return res.json().then(function (errData) {
            showKeybox(errData && errData.error ? errData.error : 'Sesja wygasła lub klucz API jest nieprawidłowy.');
          }).catch(function () {
            showKeybox('Sesja wygasła lub klucz API jest nieprawidłowy.');
          });
        }
      })
      .catch(function () {
        start();
      });
  }

  document.getElementById('go').addEventListener('click', function () {
    var btn = document.getElementById('go');
    var v = document.getElementById('key').value.trim();
    v = v.replace(/^export\s+ANTHROPIC_API_KEY\s*=\s*/i, '')
         .replace(/^ANTHROPIC_API_KEY\s*=\s*/i, '')
         .replace(/^["']|["']$/g, '')
         .trim();
    if (!v) {
      showKeybox('Wprowadź hasło lub klucz API przed połączeniem.');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Logowanie...';

    fetch('/agent-lb/api/auth/verify', {
      headers: { 'x-api-key': v }
    })
      .then(function (res) {
        if (res.ok) {
          localStorage.setItem(KEY, v);
          document.getElementById('keybox').style.display = 'none';
          document.getElementById('app').style.display = '';
          start();
        } else {
          return res.json().then(function (errData) {
            showKeybox(errData && errData.error ? errData.error : 'Nieprawidłowe hasło lub klucz administracyjny.');
          }).catch(function () {
            showKeybox('Nieprawidłowe hasło lub klucz administracyjny.');
          });
        }
      })
      .catch(function (e) {
        showKeybox('Błąd połączenia: ' + e.message);
      })
      .finally(function () {
        btn.disabled = false;
        btn.textContent = 'Zaloguj się';
      });
  });

  document.getElementById('key').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') document.getElementById('go').click();
  });

  var btnLogout = document.getElementById('btnLogout');
  if (btnLogout) {
    btnLogout.addEventListener('click', function () {
      localStorage.removeItem(KEY);
      showKeybox(null, currentLang === 'pl' ? 'Zostałeś pomyślnie wylogowany.' : 'You have been logged out successfully.');
    });
  }

  ['fProject', 'fClient'].forEach(function (id) {
    document.getElementById(id).addEventListener('change', function () {
      sessionFilters[id === 'fProject' ? 'project' : 'client'] = this.value;
      if (lastStatus) render(lastStatus);
    });
  });

  // Header button: Test fleet
  var btnTestFleet = document.getElementById('btnTestFleet');
  if (btnTestFleet) {
    btnTestFleet.addEventListener('click', function () { doTestFleet(this); });
  }

  // Header button: Reload fleet
  var btnReloadFleet = document.getElementById('btnReloadFleet');
  if (btnReloadFleet) {
    btnReloadFleet.addEventListener('click', function () { doReloadFleet(this); });
  }

  // Header button: Probe quota & balances
  var btnProbeQuota = document.getElementById('btnProbeQuota');
  if (btnProbeQuota) {
    btnProbeQuota.addEventListener('click', function () { doProbeQuota(this); });
  }

  function openAddAccountModal(provider) {
    var isCodex = provider === 'codex';
    var rAnthropic = document.getElementById('radioProvAnthropic');
    var rCodex = document.getElementById('radioProvCodex');
    if (isCodex) {
      if (rCodex) rCodex.checked = true;
      if (rAnthropic) rAnthropic.checked = false;
    } else {
      if (rAnthropic) rAnthropic.checked = true;
      if (rCodex) rCodex.checked = false;
    }

    updateAddAccountProviderUI();
    document.getElementById('oauthStep1').style.display = 'block';
    document.getElementById('oauthStep2').style.display = 'none';
    openModal('modalAddAccount');
  }

  // Modals opening/closing
  ['btnShowAddClaude', 'btnAddClaudeCol'].forEach(function (id) {
    var b = document.getElementById(id);
    if (b) b.addEventListener('click', function () { openAddAccountModal('anthropic'); });
  });

  ['btnShowAddCodex', 'btnAddCodexCol'].forEach(function (id) {
    var b = document.getElementById(id);
    if (b) b.addEventListener('click', function () { openAddAccountModal('codex'); });
  });

  var bGenericAdd = document.getElementById('btnShowAddAccount');
  if (bGenericAdd) {
    bGenericAdd.addEventListener('click', function () { openAddAccountModal(getSelectedAddProvider()); });
  }

  document.getElementById('btnCloseAddAccount').addEventListener('click', function () {
    closeModal('modalAddAccount');
  });

  ['radioProvAnthropic', 'radioProvCodex'].forEach(function (id) {
    var r = document.getElementById(id);
    if (r) {
      r.addEventListener('change', function () {
        updateAddAccountProviderUI();
      });
    }
  });

  var inImportPath = document.getElementById('inImportPath');
  if (inImportPath) {
    inImportPath.addEventListener('input', function () {
      this.dataset.customized = 'true';
    });
  }

  document.getElementById('btnShowAddClientKey').addEventListener('click', function () {
    openModal('modalAddClientKey');
  });
  document.getElementById('btnCloseAddClientKey').addEventListener('click', function () {
    closeModal('modalAddClientKey');
  });

  document.getElementById('btnCloseKeyModal').addEventListener('click', function () {
    closeModal('modalKeyCreated');
  });
  document.getElementById('btnDoneKeyModal').addEventListener('click', function () {
    closeModal('modalKeyCreated');
  });

  // Tab switching in modalAddAccount
  function selectTab(tab) {
    var tabs = ['ApiKey', 'OAuth', 'Import', 'BrowserOAuth'];
    tabs.forEach(function (t) {
      var btn = document.getElementById('tabBtn' + t);
      var content = document.getElementById('tabContent' + t);
      if (btn && content) {
        if (t === tab) {
          btn.className = 'tab-btn active';
          content.style.display = 'block';
        } else {
          btn.className = 'tab-btn';
          content.style.display = 'none';
        }
      }
    });
  }

  document.getElementById('tabBtnApiKey').addEventListener('click', function () { selectTab('ApiKey'); });
  document.getElementById('tabBtnOAuth').addEventListener('click', function () { selectTab('OAuth'); });
  document.getElementById('tabBtnImport').addEventListener('click', function () { selectTab('Import'); });
  document.getElementById('tabBtnBrowserOAuth').addEventListener('click', function () { selectTab('BrowserOAuth'); });

  // Add Account submissions
  document.getElementById('btnSubmitApiKey').addEventListener('click', function () { doAddApiKey(this); });
  document.getElementById('btnSubmitOAuth').addEventListener('click', function () { doAddOAuth(this); });
  document.getElementById('btnSubmitImportPath').addEventListener('click', function () { doAddImportPath(this); });
  document.getElementById('btnStartOAuth').addEventListener('click', function () { doStartOAuth(this); });
  document.getElementById('btnCompleteOAuth').addEventListener('click', function () { doCompleteOAuth(this); });
  document.getElementById('btnCancelOAuth').addEventListener('click', function () {
    document.getElementById('oauthStep1').style.display = 'block';
    document.getElementById('oauthStep2').style.display = 'none';
  });

  // Create Client Key submission
  document.getElementById('btnSubmitClientKey').addEventListener('click', function () { doAddClientKey(this); });

  // Setup tabs switching
  ['Bash', 'Powershell', 'Node', 'Git', 'Manual'].forEach(function (t) {
    var b = document.getElementById('tabSetup' + t);
    if (b) {
      b.addEventListener('click', function () {
        selectSetupTab(t);
      });
    }
  });

  // Setup commands copy actions
  var bindCopy = function (btnId, textId, label) {
    var b = document.getElementById(btnId);
    if (b) {
      b.addEventListener('click', function () {
        var el = document.getElementById(textId);
        if (el) copyToClipboard(el.textContent, label);
      });
    }
  };

  bindCopy('btnCopyCreatedKey', 'createdClientKey', 'Klucz klienta');
  bindCopy('btnCopySetupBash', 'cmdSetupBash', 'Polecenie Claude (Bash)');
  bindCopy('btnCopySetupCodexBash', 'cmdSetupCodexBash', 'Polecenie Codex (Bash)');
  bindCopy('btnCopySetupPowershell', 'cmdSetupPowershell', 'Polecenie Claude (PowerShell)');
  bindCopy('btnCopySetupCodexPowershell', 'cmdSetupCodexPowershell', 'Polecenie Codex (PowerShell)');
  bindCopy('btnCopySetupNode', 'cmdSetupNode', 'Polecenie Node.js');
  bindCopy('btnCopySetupGit', 'cmdSetupGit', 'Polecenie Git');

  var btnCopyShellEnv = document.getElementById('btnCopyShellEnv');
  if (btnCopyShellEnv) {
    btnCopyShellEnv.addEventListener('click', function () {
      var k = document.getElementById('createdClientKey').textContent;
      var hostUrl = window.location.origin;
      var shellText = [
        '# Claude Code CLI (OAuth / subscription):',
        'export ANTHROPIC_BASE_URL="' + hostUrl + '"',
        'unset ANTHROPIC_API_KEY',
        'export ANTHROPIC_CUSTOM_HEADERS="x-api-key: ' + k + '"',
        '',
        '# OpenAI Codex CLI:',
        'export CODEX_BASE_URL="' + hostUrl + '/backend-api/codex"',
        'export CODEX_LB_API_KEY="' + k + '"',
        'export OPENAI_BASE_URL="' + hostUrl + '/v1"'
      ].join('\\n');
      copyToClipboard(shellText, 'Shell env');
    });
  }

  var btnCopyVSCode = document.getElementById('btnCopyVSCode');
  if (btnCopyVSCode) {
    btnCopyVSCode.addEventListener('click', function () {
      var k = document.getElementById('createdClientKey').textContent;
      var hostUrl = window.location.origin;
      var snippet = JSON.stringify([
        { name: 'ANTHROPIC_BASE_URL', value: hostUrl },
        { name: 'ANTHROPIC_CUSTOM_HEADERS', value: 'x-api-key: ' + k }
      ], null, 2);
      copyToClipboard(snippet, 'VS Code JSON');
    });
  }

  // Pull setup repo button in Client Keys header
  var btnPullSetupRepo = document.getElementById('btnPullSetupRepo');
  if (btnPullSetupRepo) {
    btnPullSetupRepo.addEventListener('click', function () {
      doPullSetup(this);
    });
  }

  // Quick copy setup command listeners
  var btnQuickCopy = document.getElementById('btnQuickCopyCmd');
  if (btnQuickCopy) btnQuickCopy.addEventListener('click', copyQuickCmd);
  var quickCode = document.getElementById('quickCmdText');
  if (quickCode) quickCode.addEventListener('click', copyQuickCmd);
  ['Bash', 'PS'].forEach(function (t) {
    var b = document.getElementById('btnQuickTab' + t);
    if (b) {
      b.addEventListener('click', function () { setQuickTab(t.toLowerCase()); });
    }
  });
  var chkKey = document.getElementById('chkIncludeKeyInCmd');
  if (chkKey) {
    chkKey.addEventListener('change', function () {
      updateQuickCmd();
    });
  }

  // Re-login modal listeners
  var btnCloseRelogin = document.getElementById('btnCloseReloginModal');
  if (btnCloseRelogin) {
    btnCloseRelogin.addEventListener('click', function () { closeModal('modalRelogin'); });
  }
  ['Browser', 'Json', 'Import'].forEach(function (t) {
    var b = document.getElementById('tabBtnRelogin' + t);
    if (b) {
      b.addEventListener('click', function () { selectReloginTab(t); });
    }
  });
  var btnStartRelogin = document.getElementById('btnStartReloginOAuth');
  if (btnStartRelogin) {
    btnStartRelogin.addEventListener('click', function () { doStartReloginOAuth(this); });
  }
  var btnCompleteRelogin = document.getElementById('btnCompleteReloginOAuth');
  if (btnCompleteRelogin) {
    btnCompleteRelogin.addEventListener('click', function () { doCompleteReloginOAuth(this); });
  }
  var btnRestartRelogin = document.getElementById('btnRestartReloginOAuth');
  if (btnRestartRelogin) {
    btnRestartRelogin.addEventListener('click', function () {
      var s1 = document.getElementById('reloginOAuthStep1');
      var s2 = document.getElementById('reloginOAuthStep2');
      if (s1 && s2) { s1.style.display = 'block'; s2.style.display = 'none'; }
    });
  }
  var btnSubmitReloginJson = document.getElementById('btnSubmitReloginJson');
  if (btnSubmitReloginJson) {
    btnSubmitReloginJson.addEventListener('click', function () { doSubmitReloginJson(this); });
  }
  var btnSubmitReloginImport = document.getElementById('btnSubmitReloginImport');
  if (btnSubmitReloginImport) {
    btnSubmitReloginImport.addEventListener('click', function () { doSubmitReloginImport(this); });
  }

  // Close modals on Escape key or clicking backdrop
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      closeModal('modalAddAccount');
      closeModal('modalAddClientKey');
      closeModal('modalKeyCreated');
      closeModal('modalRelogin');
      closeModal('modalTestChat');
    }
  });

  ['modalAddAccount', 'modalAddClientKey', 'modalKeyCreated', 'modalRelogin', 'modalTestChat'].forEach(function (id) {
    var m = document.getElementById(id);
    if (m) {
      m.addEventListener('click', function (e) {
        if (e.target === m) closeModal(id);
      });
    }
  });

  // Fleet Policy Bar Listeners
  var selDist = document.getElementById('selDistributeSessions');
  if (selDist) selDist.addEventListener('change', updateFleetRouting);
  var chkExp = document.getElementById('chkExpiryRouting');
  if (chkExp) chkExp.addEventListener('change', updateFleetRouting);
  var chkFb = document.getElementById('chkCrossProviderFallback');
  if (chkFb) chkFb.addEventListener('change', updateFleetRouting);
  var chkHealth = document.getElementById('chkAutoHealthCheck');
  if (chkHealth) {
    chkHealth.addEventListener('change', function () {
      apiCall('/agent-lb/api/health-check/config', 'POST', { enabled: chkHealth.checked })
        .then(function () {
          note('ok', 'Zaktualizowano tryb auto-diagnostyki');
          poll();
        })
        .catch(function (e) {
          note('error', 'Błąd konfiguracji auto-diagnostyki: ' + e.message);
        });
    });
  }
  var btnDrain = document.getElementById('btnDrainToggle');
  if (btnDrain) btnDrain.addEventListener('click', toggleDrain);

  // --- Test Chat (Playground) ---
  function getClaudeModels() {
    var isEn = currentLang === 'en';
    return [
      { id: 'claude-sonnet-5', name: isEn ? 'Claude Sonnet 5 (Default Claude Code)' : 'Claude Sonnet 5 (Domyślny Claude Code)' },
      { id: 'claude-haiku-4-5-20251001', name: isEn ? 'Claude Haiku 4.5 (Fast / Light ping)' : 'Claude Haiku 4.5 (Szybki / Lekki ping)' },
      { id: 'claude-opus-5', name: isEn ? 'Claude Opus 5 (Flagship / Primary)' : 'Claude Opus 5 (Flagowy / Główny)' },
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
    ];
  }

  function getCodexModels() {
    var isEn = currentLang === 'en';
    return [
      { id: 'gpt-5.6-sol', name: isEn ? 'GPT-5.6 Sol (Default / Recommended)' : 'GPT-5.6 Sol (Domyślny / Polecany)' },
      { id: 'gpt-6-astra', name: 'GPT-6 Astra' },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
      { id: 'gpt-5.5', name: 'GPT-5.5' },
      { id: 'o3-mini', name: isEn ? 'o3-mini (OpenAI API key)' : 'o3-mini (Tylko klucz OpenAI API)' },
      { id: 'o1', name: isEn ? 'o1 (OpenAI API key)' : 'o1 (Tylko klucz OpenAI API)' },
      { id: 'gpt-4o', name: isEn ? 'GPT-4o (OpenAI API key)' : 'GPT-4o (Tylko klucz OpenAI API)' },
    ];
  }

  function updateTestModelsAndAccounts() {
    var provEl = document.getElementById('selTestProvider');
    var selModel = document.getElementById('selTestModel');
    var selAccount = document.getElementById('selTestAccount');
    if (!provEl || !selModel || !selAccount) return;

    var prov = provEl.value;
    var prevModel = selModel.value;
    var prevAccount = selAccount.value;

    var colEffort = document.getElementById('colTestEffort');
    if (colEffort) {
      colEffort.style.display = prov === 'codex' ? 'block' : 'none';
    }

    selModel.innerHTML = '';
    selAccount.innerHTML = '<option value="">' + (currentLang === 'pl' ? '⚡ Auto (Polityka Agent-LB)' : '⚡ Auto (Agent-LB Policy)') + '</option>';

    var models = prov === 'codex' ? getCodexModels() : getClaudeModels();
    models.forEach(function (m) {
      var opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name;
      selModel.appendChild(opt);
    });
    if (prevModel) {
      selModel.value = prevModel;
      if (!selModel.value && selModel.options.length > 0) selModel.selectedIndex = 0;
    }

    var accounts = (lastStatus && lastStatus.accounts) || [];
    accounts.forEach(function (a) {
      var aProv = a.provider || 'anthropic';
      if (aProv === prov) {
        var opt = document.createElement('option');
        opt.value = a.name;
        var icon = '🟢';
        var note = '';
        if (a.disabled) {
          icon = '⚪';
          note = currentLang === 'pl' ? ' [wyłączone]' : ' [disabled]';
        } else if (a.unavailable === 'identity-verification') {
          icon = '🔴';
          note = currentLang === 'pl' ? ' [Weryfikacja SMS]' : ' [SMS Verification]';
        } else if (a.unavailable === 'entitlement') {
          icon = '🔴';
          note = currentLang === 'pl' ? ' [Blokada 403]' : ' [Blocked 403]';
        } else if (a.unavailable === 'circuit-breaker') {
          icon = '🔴';
          note = ' [Circuit Breaker]';
        } else if (a.unavailable === 'error' || a.status === 'error') {
          icon = '🔴';
          note = currentLang === 'pl' ? ' [Błąd]' : ' [Error]';
        } else if (a.unavailable === 'quota' || a.unavailable === 'upstream-rejected') {
          icon = '🟡';
          note = ' [Quota 100%]';
        } else if (a.unavailable === 'throttled') {
          icon = '🟡';
          note = ' [Rate Limit]';
        } else if (a.unavailable) {
          icon = '🟡';
          note = ' [' + a.unavailable + ']';
        }
        opt.textContent = icon + ' ' + a.name + note;
        selAccount.appendChild(opt);
      }
    });
    if (prevAccount) {
      selAccount.value = prevAccount;
    }
  }

  var testChatLog = [];

  function copyTextToClipboard(text, cb) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        if (cb) cb(true);
      }).catch(function () {
        fallbackCopy(text, cb);
      });
    } else {
      fallbackCopy(text, cb);
    }
  }

  function fallbackCopy(text, cb) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (cb) cb(ok);
    } catch (e) {
      if (cb) cb(false);
    }
  }

  function copyFullTestChat(btn) {
    if (!testChatLog || testChatLog.length === 0) {
      var statusEl = document.getElementById('testChatStatus');
      if (statusEl) {
        statusEl.textContent = 'Brak wiadomości do skopiowania.';
        setTimeout(function () { statusEl.textContent = ''; }, 2000);
      }
      return;
    }

    var lines = [];
    testChatLog.forEach(function (m) {
      var timeStr = m.time ? ('[' + m.time.toLocaleTimeString() + '] ') : '';
      if (m.role === 'user') {
        lines.push(timeStr + 'Użytkownik:\\n' + m.text);
      } else {
        var details = [];
        if (m.meta) {
          if (m.meta.account) details.push('Konto: ' + m.meta.account);
          if (m.meta.model) details.push('Model: ' + m.meta.model);
          if (m.meta.durationMs != null) details.push('Czas: ' + m.meta.durationMs + ' ms');
          if (m.meta.error) details.push('Status: Błąd upstreamu');
        }
        var detStr = details.length > 0 ? (' (' + details.join(', ') + ')') : '';
        lines.push(timeStr + 'Asystent' + detStr + ':\\n' + m.text);
      }
      lines.push('');
    });

    var fullText = lines.join('\\n').trim();
    copyTextToClipboard(fullText, function (ok) {
      if (btn) {
        var orig = btn.textContent;
        btn.textContent = ok ? '✓ Skopiowano!' : '⚠️ Błąd';
        setTimeout(function () { btn.textContent = orig; }, 2000);
      }
      var statusEl = document.getElementById('testChatStatus');
      if (statusEl) {
        statusEl.textContent = ok ? '✓ Skopiowano historię do schowka' : 'Błąd dostępu do schowka';
        setTimeout(function () { statusEl.textContent = ''; }, 2500);
      }
    });
  }

  function addTestChatBubble(role, text, meta) {
    testChatLog.push({ role: role, text: text, meta: meta, time: new Date() });
    var history = document.getElementById('testChatHistory');
    var placeholder = document.getElementById('testChatPlaceholder');
    if (placeholder) placeholder.style.display = 'none';

    var wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.maxWidth = '85%';
    wrap.style.gap = '4px';

    if (role === 'user') {
      wrap.style.alignSelf = 'flex-end';
      wrap.style.alignItems = 'flex-end';
    } else {
      wrap.style.alignSelf = 'flex-start';
      wrap.style.alignItems = 'flex-start';
    }

    var bubble = document.createElement('div');
    bubble.style.padding = '8px 12px';
    bubble.style.borderRadius = '8px';
    bubble.style.fontSize = '12.5px';
    bubble.style.lineHeight = '1.45';
    bubble.style.wordBreak = 'break-word';
    bubble.style.whiteSpace = 'pre-wrap';

    if (role === 'user') {
      bubble.style.background = 'rgba(88, 166, 255, 0.2)';
      bubble.style.border = '1px solid rgba(88, 166, 255, 0.4)';
      bubble.style.color = '#f0f6fc';
    } else if (meta && meta.error) {
      bubble.style.background = 'rgba(248, 81, 73, 0.15)';
      bubble.style.border = '1px solid rgba(248, 81, 73, 0.35)';
      bubble.style.color = '#f85149';
    } else {
      bubble.style.background = 'rgba(22, 27, 34, 0.9)';
      bubble.style.border = '1px solid var(--line)';
      bubble.style.color = 'var(--text)';
    }

    bubble.textContent = text;
    wrap.appendChild(bubble);

    if (meta) {
      var metaRow = document.createElement('div');
      metaRow.style.display = 'flex';
      metaRow.style.flexWrap = 'wrap';
      metaRow.style.gap = '6px';
      metaRow.style.fontSize = '10px';
      metaRow.style.color = 'var(--dim)';
      metaRow.style.marginTop = '2px';

      if (meta.account) {
        var accBadge = document.createElement('span');
        accBadge.className = 'badge';
        accBadge.style.fontSize = '10px';
        accBadge.textContent = (meta.isFallback ? '🔄 Fallback: ' : '👤 Konto: ') + meta.account;
        metaRow.appendChild(accBadge);
      }
      if (meta.model) {
        var modBadge = document.createElement('span');
        modBadge.className = 'badge';
        modBadge.style.fontSize = '10px';
        modBadge.textContent = '🤖 ' + meta.model;
        metaRow.appendChild(modBadge);
      }
      if (meta.effort) {
        var effBadge = document.createElement('span');
        effBadge.className = 'badge';
        effBadge.style.fontSize = '10px';
        effBadge.textContent = '🧠 Effort: ' + meta.effort;
        metaRow.appendChild(effBadge);
      }
      if (meta.durationMs != null) {
        var timeBadge = document.createElement('span');
        timeBadge.className = 'badge';
        timeBadge.style.fontSize = '10px';
        timeBadge.textContent = '⏱️ ' + meta.durationMs + ' ms';
        metaRow.appendChild(timeBadge);
      }
      if (meta.usage) {
        var inTok = meta.usage.input_tokens || meta.usage.prompt_tokens || 0;
        var outTok = meta.usage.output_tokens || meta.usage.completion_tokens || 0;
        var tokBadge = document.createElement('span');
        tokBadge.className = 'badge';
        tokBadge.style.fontSize = '10px';
        tokBadge.textContent = '⚡ In: ' + inTok + ' | Out: ' + outTok;
        metaRow.appendChild(tokBadge);
      }

      var copySingleBtn = document.createElement('button');
      copySingleBtn.type = 'button';
      copySingleBtn.className = 'btn btn-xs';
      copySingleBtn.style.padding = '1px 7px';
      copySingleBtn.style.fontSize = '9.5px';
      copySingleBtn.style.marginLeft = 'auto';
      copySingleBtn.textContent = '📋 Kopiuj';
      copySingleBtn.title = 'Skopiuj tę odpowiedź do schowka';
      copySingleBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        copyTextToClipboard(text, function (ok) {
          copySingleBtn.textContent = ok ? '✓ Skopiowano' : 'Błąd';
          setTimeout(function () { copySingleBtn.textContent = '📋 Kopiuj'; }, 1500);
        });
      });
      metaRow.appendChild(copySingleBtn);
      wrap.appendChild(metaRow);
    } else if (role === 'user') {
      var userMetaRow = document.createElement('div');
      userMetaRow.style.display = 'flex';
      userMetaRow.style.gap = '6px';
      userMetaRow.style.fontSize = '10px';
      userMetaRow.style.color = 'var(--dim)';
      userMetaRow.style.marginTop = '2px';
      userMetaRow.style.alignItems = 'center';

      var copyUserBtn = document.createElement('button');
      copyUserBtn.type = 'button';
      copyUserBtn.className = 'btn btn-xs';
      copyUserBtn.style.padding = '1px 7px';
      copyUserBtn.style.fontSize = '9.5px';
      copyUserBtn.textContent = '📋 Kopiuj';
      copyUserBtn.title = 'Skopiuj treść zapytania';
      copyUserBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        copyTextToClipboard(text, function (ok) {
          copyUserBtn.textContent = ok ? '✓ Skopiowano' : 'Błąd';
          setTimeout(function () { copyUserBtn.textContent = '📋 Kopiuj'; }, 1500);
        });
      });
      userMetaRow.appendChild(copyUserBtn);
      wrap.appendChild(userMetaRow);
    }

    history.appendChild(wrap);
    history.scrollTop = history.scrollHeight;
  }

  function sendTestChatMessage() {
    var ta = document.getElementById('testChatMessage');
    var msg = (ta.value || '').trim();
    if (!msg) return;

    var prov = document.getElementById('selTestProvider').value;
    var model = document.getElementById('selTestModel').value;
    var account = document.getElementById('selTestAccount').value;
    var effortEl = document.getElementById('selTestEffort');
    var effort = (prov === 'codex' && effortEl && effortEl.value) ? effortEl.value : undefined;
    var btnSend = document.getElementById('btnTestChatSend');
    var statusEl = document.getElementById('testChatStatus');

    addTestChatBubble('user', msg);
    ta.value = '';
    ta.disabled = true;
    btnSend.disabled = true;
    statusEl.textContent = '⏳ Łączenie z upstreamem (' + (prov === 'codex' ? 'Codex' : 'Claude') + ')...';

    apiCall('/api/test/chat', 'POST', {
      provider: prov,
      model: model,
      effort: effort,
      message: msg,
      account: account || undefined,
    }).then(function (res) {
      ta.disabled = false;
      btnSend.disabled = false;
      statusEl.textContent = '';
      ta.focus();

      if (!res) {
        addTestChatBubble('assistant', 'Brak odpowiedzi z serwera lub błąd autoryzacji.', { error: true });
        return;
      }

      if (res.ok) {
        addTestChatBubble('assistant', res.reply || '(Pusta odpowiedź)', {
          account: res.account,
          model: res.model,
          effort: res.effort || effort,
          isFallback: res.isFallback,
          durationMs: res.durationMs,
          usage: res.usage,
        });
      } else {
        var errText = res.error || ('Błąd HTTP ' + (res.status || '500'));
        addTestChatBubble('assistant', '⚠️ Błąd upstreamu: ' + errText, {
          error: true,
          account: res.account,
          model: res.model,
          durationMs: res.durationMs,
        });
      }
    }).catch(function (err) {
      ta.disabled = false;
      btnSend.disabled = false;
      statusEl.textContent = '';
      ta.focus();
      addTestChatBubble('assistant', 'Błąd sieciowy klienta: ' + err.message, { error: true });
    });
  }

  var btnOpenTestChat = document.getElementById('btnOpenTestChat');
  if (btnOpenTestChat) {
    btnOpenTestChat.addEventListener('click', function () {
      updateTestModelsAndAccounts();
      openModal('modalTestChat');
      var ta = document.getElementById('testChatMessage');
      if (ta) ta.focus();
    });
  }

  var btnCloseTestChat = document.getElementById('btnCloseTestChat');
  if (btnCloseTestChat) {
    btnCloseTestChat.addEventListener('click', function () {
      closeModal('modalTestChat');
    });
  }

  var selTestProv = document.getElementById('selTestProvider');
  if (selTestProv) {
    selTestProv.addEventListener('change', updateTestModelsAndAccounts);
  }

  var btnTestSend = document.getElementById('btnTestChatSend');
  if (btnTestSend) {
    btnTestSend.addEventListener('click', sendTestChatMessage);
  }

  var testChatTa = document.getElementById('testChatMessage');
  if (testChatTa) {
    testChatTa.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendTestChatMessage();
      }
    });
  }

  var btnTestClear = document.getElementById('btnTestChatClear');
  if (btnTestClear) {
    btnTestClear.addEventListener('click', function () {
      testChatLog = [];
      var history = document.getElementById('testChatHistory');
      if (history) {
        history.innerHTML = '<div id="testChatPlaceholder" style="margin:auto; text-align:center; color:var(--dim); font-size:12px;"><div style="font-size:26px; margin-bottom:6px;">💬</div>Wybierz dostawcę i model, a następnie wpisz wiadomość lub kliknij szybki test.<br>Żądanie zostanie wysłane przez silnik Agent-LB bezpośrednio do wybranego upstreamu.</div>';
      }
      var statusEl = document.getElementById('testChatStatus');
      if (statusEl) statusEl.textContent = '';
    });
  }

  var btnTestCopy = document.getElementById('btnTestChatCopy');
  if (btnTestCopy) {
    btnTestCopy.addEventListener('click', function () {
      copyFullTestChat(btnTestCopy);
    });
  }

  var btnTestHeaderCopy = document.getElementById('btnTestChatHeaderCopy');
  if (btnTestHeaderCopy) {
    btnTestHeaderCopy.addEventListener('click', function () {
      copyFullTestChat(btnTestHeaderCopy);
    });
  }

  document.querySelectorAll('.quick-prompt-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var prompt = this.getAttribute('data-prompt');
      var ta = document.getElementById('testChatMessage');
      if (ta && prompt) {
        ta.value = prompt;
        ta.focus();
      }
    });
  });

  // Language & theme switchers
  ['btnThemeToggle', 'btnLoginThemeToggle'].forEach(function (id) {
    var b = document.getElementById(id);
    if (b) {
      b.addEventListener('click', function () {
        setTheme(currentTheme === 'dark' ? 'light' : 'dark');
      });
    }
  });

  ['btnLangToggle', 'btnLoginLangToggle'].forEach(function (id) {
    var b = document.getElementById(id);
    if (b) {
      b.addEventListener('click', function () {
        setLang(currentLang === 'pl' ? 'en' : 'pl');
      });
    }
  });

  // Fleet policy help / explanations toggle
  var btnTogglePolicyHelp = document.getElementById('btnTogglePolicyHelp');
  if (btnTogglePolicyHelp) {
    var panel = document.getElementById('fleetPolicyPanel');
    var isCompact = false;
    try { isCompact = localStorage.getItem('agentlb-policy-compact') === 'true'; } catch (e) {}
    if (isCompact && panel) {
      panel.classList.add('policy-compact');
      btnTogglePolicyHelp.textContent = t('btnPolicyHelp');
    } else {
      btnTogglePolicyHelp.textContent = t('btnPolicyHelpCompact');
    }
    btnTogglePolicyHelp.addEventListener('click', function () {
      if (!panel) return;
      var nowCompact = panel.classList.toggle('policy-compact');
      try { localStorage.setItem('agentlb-policy-compact', nowCompact ? 'true' : 'false'); } catch (e) {}
      btnTogglePolicyHelp.textContent = nowCompact ? t('btnPolicyHelp') : t('btnPolicyHelpCompact');
    });
  }

  // Initial theme and i18n DOM update
  setTheme(currentTheme);
  updateI18nDOM();

  checkAuthAndStart();
})();
</script>
</body>
</html>
`;
