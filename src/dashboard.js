// The status dashboard: a single self-contained HTML page served at
// GET /teamclaude/dashboard, rendering /teamclaude/status for humans.
//
// The page itself contains NO data — it is a static asset whose script fetches
// /teamclaude/status (same origin) with the proxy key and re-renders every few
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

// The request the switch button sends: POST /teamclaude/switch with the same
// key the status poll uses. Pure, so the test suite can send exactly this
// through a real proxy and prove the same-origin CSRF gate lets the page in.
export function switchRequest(name, key) {
  return {
    url: '/teamclaude/switch',
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
  // five-minute cooldown and `upstream-rejected` is upstream's way of saying a
  // shared bucket is spent — both expire on their own, like `quota` and
  // `throttled`, and none of them wants a person.
  var ATTENTION = { error: 'needs a re-login', disabled: 'is disabled' };
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
  // account card and `teamclaude status` both carry it, with the amount.

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
    --bg: #0d1117; --panel: #161b22; --line: #262c36;
    --text: #c9d1d9; --dim: #8b949e; --accent: #58a6ff;
    --ok: #3fb950; --warn: #d29922; --bad: #f85149;
  }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--bg); color: var(--text); font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 14px 18px; }
  main { max-width: 1720px; margin: 0 auto; width: 100%; }
  h1 { font-size: 18px; font-weight: 600; margin-bottom: 2px; display: inline-flex; align-items: center; gap: 8px; color: #f0f6fc; }
  h2 { font-size: 11.5px; color: var(--dim); text-transform: uppercase; letter-spacing: .06em; margin: 12px 0 6px; font-weight: 600; }
  .sub { color: var(--dim); margin-bottom: 10px; font-size: 12px; }
  .sub b { color: var(--text); font-weight: 500; }
  .header-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
  .header-actions { display: flex; gap: 6px; align-items: center; }

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
  .account-col { background: rgba(22, 27, 34, 0.35); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; min-width: 0; }
  .col-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid rgba(255, 255, 255, 0.06); }
  .col-title { font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; display: inline-flex; align-items: center; gap: 6px; }
  .col-title.claude { color: #d2a8ff; }
  .col-title.codex { color: #56d364; }
  .col-hint { font-size: 10.5px; color: var(--dim); font-weight: normal; }
  .account-list { display: flex; flex-direction: column; gap: 8px; }
  .client-keys-list { display: flex; flex-direction: column; gap: 8px; }
  .client-key-card { background: rgba(22, 27, 34, 0.65); border: 1px solid rgba(255, 255, 255, 0.07); border-radius: 6px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; box-sizing: border-box; transition: border-color .15s ease; }
  .client-key-card:hover { border-color: rgba(255, 255, 255, 0.15); }
  .client-key-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .client-key-bottom { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-top: 6px; border-top: 1px solid rgba(255, 255, 255, 0.04); font-size: 11px; }
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

  .card { background: rgba(22, 27, 34, 0.65); border: 1px solid rgba(255, 255, 255, 0.07); border-radius: 6px; padding: 8px 12px; margin-bottom: 0; box-sizing: border-box; transition: border-color .15s ease; }
  .account-list .card { display: flex; flex-direction: column; justify-content: space-between; min-height: 114px; }
  .card:hover { border-color: rgba(255, 255, 255, 0.15); }
  .card-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 5px; }
  .card-title-group { display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; min-width: 0; overflow: hidden; }
  .card-actions { display: flex; align-items: center; gap: 3px; margin-left: auto; flex-shrink: 0; }
  .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .name { font-size: 12.5px; font-weight: 600; color: #f0f6fc; letter-spacing: -0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tag { font-size: 11px; color: var(--dim); }
  .badge { font-size: 10px; padding: 1px 6px; border-radius: 3px; border: 1px solid rgba(255, 255, 255, 0.08); white-space: nowrap; line-height: 1.3; font-weight: 500; }
  .badge.active { color: var(--ok); border-color: rgba(63,185,80,0.3); background: rgba(63,185,80,0.06); }
  .badge.throttled { color: var(--warn); border-color: rgba(210,153,34,0.35); background: rgba(210,153,34,0.08); }
  .badge.error, .badge.exhausted, .badge.bad { color: var(--bad); border-color: rgba(248,81,73,0.35); background: rgba(248,81,73,0.08); }
  .badge.current { color: var(--accent); border-color: rgba(88,166,255,0.4); background: rgba(88,166,255,0.1); font-weight: 600; }
  .badge-plan { color: #d2a8ff; border-color: rgba(210,168,255,0.25); background: rgba(210,168,255,0.06); }
  .badge-codex { color: #56d364; border-color: rgba(86,211,100,0.25); background: rgba(86,211,100,0.06); }
  .badge-anthropic { color: #d2a8ff; border-color: rgba(210,168,255,0.25); background: rgba(210,168,255,0.06); }
  .badge-burn { color: #ff7b72; border-color: rgba(255,123,114,0.35); background: rgba(255,123,114,0.1); font-weight: 600; }
  .card-body { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 3px; margin: 3px 0; }
  .quota { display: grid; grid-template-columns: 48px 1fr auto; gap: 8px; align-items: center; }
  .quota .lbl { color: var(--dim); font-size: 10.5px; font-weight: 500; }
  .quota .val { color: var(--dim); font-size: 10.5px; text-align: right; font-variant-numeric: tabular-nums; }
  .bar { height: 4px; background: rgba(255, 255, 255, 0.06); border-radius: 2px; overflow: hidden; }
  .bar i { display: block; height: 100%; border-radius: 2px; background: var(--ok); transition: width .3s ease; }
  .bar i.warn { background: var(--warn); }
  .bar i.bad { background: var(--bad); }
  .card-meta { display: flex; align-items: center; flex-wrap: nowrap; gap: 4px 10px; margin-top: 4px; padding-top: 4px; border-top: 1px solid rgba(255, 255, 255, 0.04); font-size: 11px; color: var(--dim); overflow: hidden; }
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
    <div class="login-card-head">
      <div class="login-card-icon">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        </svg>
      </div>
      <h1>Panel Zarządzania</h1>
      <p>Wprowadź hasło, klucz administracyjny lub dowolny klucz stacji roboczej, aby uzyskać dostęp.</p>
    </div>
    <div id="keyboxErr" style="display:none;margin-bottom:16px;padding:10px 14px;border-radius:8px;background:rgba(239,68,68,0.12);border:1px solid var(--bad);color:var(--bad);font-size:13px;text-align:left"></div>
    <div id="keyboxInfo" style="display:none;margin-bottom:16px;padding:10px 14px;border-radius:8px;background:rgba(63,185,80,0.12);border:1px solid var(--ok);color:var(--ok);font-size:13px;text-align:left"></div>
    <div class="login-field">
      <label for="key">Klucz dostępu (administracyjny lub stacji roboczej)</label>
      <input id="key" type="password" placeholder="tc-..." autocomplete="current-password">
    </div>
    <button id="go">Zaloguj się</button>
    <div class="login-card-foot">
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
        <button class="btn btn-sm" id="btnProbeQuota" title="Odpytaj o aktualne zużycie limitów i salda kont">⚡ Odśwież salda</button>
        <button class="btn btn-sm" id="btnReloadFleet" title="Przeładuj flotę kont z dysku">🔄 Przeładuj flotę</button>
        <button class="btn btn-sm btn-bad" id="btnLogout" title="Wyloguj z panelu">🚪 Wyloguj</button>
      </div>
    </div>
    <div id="err"></div>
    <div id="problems"></div>
    <div id="note"></div>
    <div id="routesWrap" style="display:none">
      <h2>Routing</h2>
      <div class="card table-responsive" style="padding:4px 6px"><table id="routes"></table></div>
    </div>

    <div id="accounts" style="display:none"></div>
    <div class="dashboard-grid" id="accountsGrid">
      <!-- Sekcja nagłówka kont -->
      <div class="grid-head-accounts">
        <div class="sec-head" style="margin:0 0 4px; justify-content:flex-start; gap:12px;">
          <h2>Konta Claude & Codex</h2>
          <span style="font-size:11px; color:var(--dim);">💡 Przeciągnij kartę ⠿ w kolumnie, aby zmienić priorytet</span>
        </div>
      </div>

      <!-- Sekcja nagłówka kluczy klientów -->
      <div class="grid-head-clients">
        <div class="sec-head" style="margin:0 0 4px;">
          <h2>Stacje robocze & Klucze</h2>
        </div>
      </div>

      <!-- Column 1: Claude (Anthropic) -->
      <div class="account-col" id="colClaude">
        <div class="col-head">
          <div class="row" style="gap:6px; align-items:center;">
            <span class="col-title claude">🟣 Claude (Anthropic)</span>
            <span class="col-hint" id="countClaude">0 kont</span>
          </div>
          <button class="btn btn-sm btn-accent" id="btnAddClaudeCol" style="padding:2px 8px; font-size:11px;" title="Dodaj konto Claude (Anthropic)">➕ Dodaj konto</button>
        </div>
        <div class="account-list" id="listClaude" data-provider="anthropic"></div>
      </div>

      <!-- Column 2: OpenAI Codex -->
      <div class="account-col" id="colCodex">
        <div class="col-head">
          <div class="row" style="gap:6px; align-items:center;">
            <span class="col-title codex">🟢 OpenAI Codex</span>
            <span class="col-hint" id="countCodex">0 kont</span>
          </div>
          <button class="btn btn-sm btn-accent" id="btnAddCodexCol" style="padding:2px 8px; font-size:11px;" title="Dodaj konto OpenAI Codex">➕ Dodaj konto</button>
        </div>
        <div class="account-list" id="listCodex" data-provider="codex"></div>
      </div>

      <!-- Column 3: Klucze klientów & Narzędzia -->
      <div class="account-col dash-col-side" id="colClients">
        <div class="col-head">
          <div class="row" style="gap:6px; align-items:center;">
            <span class="col-title" style="color:#58a6ff;">🔑 Klucze klientów</span>
            <span class="col-hint" id="countClientKeys">0 kluczy</span>
          </div>
          <div class="row" style="gap:4px;">
            <button class="btn btn-sm" id="btnPullSetupRepo" style="padding:2px 7px; font-size:11px;" title="Pobierz najnowsze skrypty instalatora z GitHub (git pull)">🔄 Aktualizuj</button>
            <button class="btn btn-sm btn-accent" id="btnShowAddClientKey" style="padding:2px 7px; font-size:11px;" title="Utwórz nowy klucz klienta">➕ Nowy klucz</button>
          </div>
        </div>

        <div class="card" style="margin-bottom:8px; background:rgba(83,177,253,0.06); border-color:rgba(83,177,253,0.2); padding:8px 10px;">
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:5px;">
            <span style="font-weight:600; font-size:11.5px; color:#f0f6fc;">⚡ Szybkie podłączenie stacji:</span>
            <div style="display:flex; gap:3px;">
              <button class="btn btn-xs active" id="btnQuickTabBash" type="button" style="padding:1px 7px; font-size:10px;" title="Skrypt instalacyjny Linux, macOS, WSL (Bash)">Linux / macOS</button>
              <button class="btn btn-xs" id="btnQuickTabPS" type="button" style="padding:1px 7px; font-size:10px;" title="Skrypt instalacyjny Windows (PowerShell)">Windows</button>
            </div>
          </div>
          <div style="display:flex; align-items:center; gap:6px; background:rgba(13,17,23,0.85); border:1px solid var(--line); border-radius:4px; padding:4px 7px;">
            <code id="quickCmdText" class="mono" style="flex:1; font-size:10.5px; color:#58a6ff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:pointer;" title="Kliknij, aby skopiować pełną komendę"></code>
            <button class="btn btn-xs btn-accent" id="btnQuickCopyCmd" type="button" style="flex-shrink:0; padding:1px 7px;" title="Kopiuj polecenie do schowka">📋 Kopiuj</button>
          </div>
          <div style="display:flex; align-items:center; justify-content:space-between; margin-top:4px; font-size:10.5px; color:var(--dim);">
            <label style="display:inline-flex; align-items:center; gap:4px; cursor:pointer; user-select:none; color:var(--text);" title="Odznacz, jeśli chcesz uruchomić czystą komendę — instalator sam zapyta o wklejenie klucza">
              <input type="checkbox" id="chkIncludeKeyInCmd" checked style="margin:0; cursor:pointer;"> Dołącz klucz
            </label>
            <a href="https://github.com/tomaasz/agent-lb" target="_blank" rel="noopener" style="color:var(--accent); text-decoration:none; font-size:10.5px;">instrukcja GitHub ↗</a>
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
        <span style="font-size:12px; color:var(--dim);">Repozytorium: <a href="https://github.com/tomaasz/claude-lb" target="_blank" rel="noopener" style="color:var(--accent);">tomaasz/claude-lb ↗</a></span>
        <button class="btn" id="btnDoneKeyModal">Zamknij</button>
      </div>
    </div>
  </div>
</main>
<script>
(function () {
  'use strict';
  var KEY = 'teamclaude-dashboard-key';
  var POLL_MS = 5000;
  var timer = null;
  var lastStatus = null;
  var sessionFilters = { project: '', client: '' };
  var sortState = { sessions: { key: 'lastSeen', dir: 'desc' } };
  var UNAVAILABLE_TEXT = ${JSON.stringify(UNAVAILABLE_TEXT)};

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
      if (pb) pb.textContent = '#' + (idx + 1);
      var prioTag = c.querySelector('.card-prio-tag');
      if (prioTag) {
        var typeStr = c.dataset.accountType || '';
        prioTag.textContent = (typeStr ? typeStr + ' · ' : '') + 'prio ' + idx;
      }
      var prioBtn = c.querySelector('.btn-prio');
      if (prioBtn) prioBtn.textContent = 'prio ' + idx;
    });

    note('ok', 'Zapisywanie nowego priorytetu kont...');
    apiCall('/teamclaude/api/accounts/reorder', 'POST', { order: names })
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
    dragHandle.title = 'Przeciągnij myszką, aby zmienić priorytet w kolumnie';
    titleGroup.appendChild(dragHandle);

    // Rank badge (#1, #2...)
    if (rankIndex != null) {
      var prioBadge = el('span', 'prio-badge', '#' + (rankIndex + 1));
      prioBadge.title = 'Pozycja #' + (rankIndex + 1) + ' w kolejności (przeciągnij kartę lub kliknij, aby zmienić priorytet)';
      prioBadge.style.cursor = 'pointer';
      prioBadge.addEventListener('click', function (e) {
        e.stopPropagation();
        doSetPriority(a.name, a.priority || 0);
      });
      titleGroup.appendChild(prioBadge);
    }

    if (a.name) titleGroup.appendChild(el('span', 'name', a.name));

    // Subscription plan badge
    var planName = a.hasClaudeMax ? 'Claude Max' : (a.hasClaudePro || a.organizationType === 'claude_pro' ? 'Pro' : (a.planType ? (a.planType.toLowerCase() === 'plus' ? 'Plus' : a.planType.toUpperCase()) : (a.organizationType ? a.organizationType.replace(/_/g, ' ') : null)));
    if (planName) {
      titleGroup.appendChild(el('span', 'badge badge-plan', planName));
    }

    if (a.routingPolicy === 'burn-first') titleGroup.appendChild(el('span', 'badge badge-burn', '🔥 Burn'));
    if (a.name === current) titleGroup.appendChild(el('span', 'badge current', 'current'));
    if (a.disabled) titleGroup.appendChild(el('span', 'badge bad', 'disabled'));
    else if (a.status && a.status !== 'active' && a.status !== 'ready') {
      titleGroup.appendChild(el('span', 'badge ' + a.status, a.status));
    }

    if (a.unavailable) {
      var unavailText = a.unavailable === 'switch_threshold' ? 'Próg switcha' : (UNAVAILABLE_TEXT[a.unavailable] || a.unavailable);
      var unavailBadge = el('span', 'badge ' + (a.unavailable === 'error' || a.status === 'error' ? 'error' : 'throttled'), '⚠️ ' + unavailText);
      var isCritical = a.unavailable === 'error' || a.status === 'error' || a.unavailable === 'identity-verification';
      var unavailBadge = el('span', 'badge ' + (isCritical ? 'error' : 'throttled'), '⚠️ ' + unavailText);
      unavailBadge.title = 'Blokada konta: ' + (UNAVAILABLE_TEXT[a.unavailable] || a.unavailable);
      titleGroup.appendChild(unavailBadge);
    }

    head.appendChild(titleGroup);

    // Action buttons group (right aligned in header)
    var acts = el('div', 'card-actions');

    if (a.name !== current && !a.disabled) {
      var btnSwitch = el('button', 'btn btn-xs btn-accent', '⚡ Aktywuj');
      btnSwitch.title = 'Ustaw jako preferowane konto w rotacji';
      btnSwitch.addEventListener('click', function () { doSwitch(a.name, btnSwitch); });
      acts.appendChild(btnSwitch);
    }

    if (a.type === 'oauth') {
      var isErr = a.status === 'error' || a.unavailable === 'error';
      if (isErr) {
        var btnRelogin = el('button', 'btn btn-xs btn-accent', '🔐 Zaloguj');
        btnRelogin.title = 'Odnów sesję przez ' + (prov === 'codex' ? 'OpenAI Codex' : 'Claude') + ' OAuth';
        btnRelogin.addEventListener('click', function () { startReLogin(a.name, a.priority, a.provider); });
        acts.appendChild(btnRelogin);
      } else {
        var btnReloginIcon = el('button', 'btn-icon', '🔐');
        btnReloginIcon.title = 'Zaloguj ponownie konto przez OAuth';
        btnReloginIcon.addEventListener('click', function () { startReLogin(a.name, a.priority, a.provider); });
        acts.appendChild(btnReloginIcon);
      }
    }

    var btnProbe = el('button', 'btn-icon', '⟳');
    btnProbe.title = 'Odśwież salda i limity (Probe)';
    btnProbe.addEventListener('click', function () { doProbeSingle(a.name, btnProbe); });
    acts.appendChild(btnProbe);

    var isBurn = a.routingPolicy === 'burn-first';
    var btnPolicy = el('button', 'btn-icon' + (isBurn ? ' active' : ''), '🔥');
    btnPolicy.title = isBurn ? 'Polityka Burn-first: aktywna (kliknij, aby wyłączyć)' : 'Włącz politykę Burn-first (wyczerpuj to konto w pierwszej kolejności)';
    btnPolicy.addEventListener('click', function () { doSetPolicy(a.name, isBurn ? 'normal' : 'burn-first', btnPolicy); });
    acts.appendChild(btnPolicy);

    var btnToggle = el('button', 'btn-icon', a.disabled ? '▶️' : '⏸️');
    btnToggle.title = a.disabled ? 'Włącz konto do rotacji' : 'Wyłącz konto z rotacji';
    btnToggle.addEventListener('click', function () { doToggleDisabled(a.name, !!a.disabled, btnToggle); });
    acts.appendChild(btnToggle);

    var btnExport = el('button', 'btn-icon', '💾');
    btnExport.title = 'Eksportuj konfigurację i tokeny konta do pliku JSON';
    btnExport.addEventListener('click', function () { doExportAccount(a.name); });
    acts.appendChild(btnExport);

    var btnDel = el('button', 'btn-icon btn-icon-del', '🗑️');
    btnDel.title = 'Usuń konto z konfiguracji Agent LB';
    btnDel.addEventListener('click', function () { doRemoveAccount(a.name, btnDel); });
    acts.appendChild(btnDel);

    head.appendChild(acts);
    card.appendChild(head);
    attachCardDragListeners(card);

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

    if (a.identityVerificationUntil && parseTs(a.identityVerificationUntil) > Date.now()) {
      var idSec = (parseTs(a.identityVerificationUntil) - Date.now()) / 1000;
      meta.appendChild(el('span', 'card-meta-item bad', '⚠️ Weryfikacja: cooldown ' + fmtIn(idSec)));
    } else if (a.entitlementDeniedUntil && parseTs(a.entitlementDeniedUntil) > Date.now()) {
      var entSec = (parseTs(a.entitlementDeniedUntil) - Date.now()) / 1000;
      meta.appendChild(el('span', 'card-meta-item warn', '⏳ Entitlement: ' + fmtIn(entSec)));
    }

    if (a.sessions) {
      meta.appendChild(el('span', 'card-meta-item', '📡 ' + a.sessions + ' ses' + (a.sessions > 1 ? 'ji' : 'ja')));
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
      countClaude.textContent = claudeAccts.length + (claudeAccts.length === 1 ? ' konto' : ' kont');
    }
    var countCodex = document.getElementById('countCodex');
    if (countCodex) {
      countCodex.textContent = codexAccts.length + (codexAccts.length === 1 ? ' konto' : ' kont');
    }

    // Render Claude accounts
    if (claudeAccts.length === 0) {
      var emptyC = el('div', '', 'Brak kont Claude. Kliknij „➕ Dodaj konto” u góry.');
      emptyC.style.cssText = 'padding:16px; text-align:center; color:var(--dim); font-size:12px; border:1px dashed var(--line); border-radius:6px;';
      listClaude.appendChild(emptyC);
    } else {
      claudeAccts.forEach(function (a, idx) {
        listClaude.appendChild(renderAccount(a, s.currentAccount, idx));
      });
    }

    // Render Codex accounts
    if (codexAccts.length === 0) {
      var emptyX = el('div', '', 'Brak kont OpenAI Codex. Kliknij „➕ Dodaj konto” u góry.');
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
    sum.appendChild(el('span', '', 'active account '));
    sum.appendChild(el('b', '', s.currentAccount || 'none'));
    sum.appendChild(el('span', '', ' · ' + (sess.active || 0) + ' active / ' + (sess.known || 0) + ' known sessions' + (up ? ' · ' + up : '')));
    var acc = document.getElementById('accounts');
    if (acc) acc.textContent = '';

    renderAccountsGrid(s);
    renderProblems(s);
    renderRoutes(s);
    renderClientKeys(s.clientKeys, s.clients);
    renderClients(s.clients);
    renderDimensions(s.usageDimensions);
    renderSessions(s.sessions);
    document.getElementById('foot').textContent = 'refreshes every ' + (POLL_MS / 1000) + 's · ' + new Date().toLocaleTimeString();
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
    apiCall('/teamclaude/api/accounts/toggle', 'POST', { id: name, account: name, disabled: !currentDisabled })
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
    apiCall('/teamclaude/api/accounts/priority', 'POST', { id: name, account: name, priority: prio })
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

  function doRemoveAccount(name, btn) {
    if (!confirm('Czy na pewno chcesz usunąć konto "' + name + '" z konfiguracji Agent LB?')) return;
    if (btn) btn.disabled = true;
    apiCall('/teamclaude/api/accounts/remove', 'POST', { id: name, account: name })
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
    apiCall('/teamclaude/api/accounts/probe-single', 'POST', { account: name })
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

  function doSetPolicy(name, policy, btn) {
    if (btn) btn.disabled = true;
    apiCall('/teamclaude/api/accounts/policy', 'POST', { account: name, policy: policy })
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
    apiCall('/teamclaude/api/accounts/consume-reset-credit', 'POST', { account: name })
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
    var url = '/teamclaude/api/accounts/export?account=' + encodeURIComponent(name);
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

  function doReloadFleet(btn) {

    if (btn) btn.disabled = true;
    apiCall('/teamclaude/reload', 'POST')
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
    apiCall('/teamclaude/probe', 'POST')
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
    apiCall('/teamclaude/api/accounts/add', 'POST', {
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
    apiCall('/teamclaude/api/accounts/add', 'POST', {
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
    apiCall('/teamclaude/api/accounts/add', 'POST', {
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
    apiCall('/teamclaude/oauth/start?provider=' + encodeURIComponent(prov), 'GET')
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
    apiCall('/teamclaude/oauth/complete', 'POST', {
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

    var startUrl = '/teamclaude/oauth/start?provider=' + encodeURIComponent(currentReloginProvider || 'anthropic');
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
    apiCall('/teamclaude/oauth/complete', 'POST', {
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
    apiCall('/teamclaude/api/accounts/add', 'POST', {
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
    apiCall('/teamclaude/api/accounts/add', 'POST', {
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
    if (!name) {
      note('error', 'Nazwa klienta / urządzenia jest wymagana');
      return;
    }
    btn.disabled = true;
    apiCall('/teamclaude/api/keys/create', 'POST', { name: name, key: customKey })
      .then(function (res) {
        btn.disabled = false;
        if (!res) return;
        if (res.ok) {
          note('ok', 'Utworzono klucz klienta dla "' + res.name + '"');
          if (res.key) cachedClientKeys[res.name] = res.key;
          closeModal('modalAddClientKey');
          document.getElementById('inClientName').value = '';
          document.getElementById('inClientCustomKey').value = '';
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
    apiCall('/teamclaude/api/keys/delete', 'POST', { name: name })
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
      countEl.textContent = totalCount + (totalCount === 1 ? ' klucz' : ' kluczy');
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
      var pName = el('span', 'name', 'Główny klucz administratora (proxy.apiKey)');
      pName.style.fontWeight = '600';
      pNameWrap.appendChild(pName);
      var pBadge = el('span', 'badge', 'Admin & CLI');
      pBadge.style.cssText = 'font-size:10px; padding:1px 6px; background:rgba(59, 130, 246, 0.15); color:#60a5fa; border-radius:4px; border:1px solid rgba(59, 130, 246, 0.3);';
      pNameWrap.appendChild(pBadge);
      pTopRow.appendChild(pNameWrap);

      var pActs = el('div', 'card-actions');
      var btnPSetup = el('button', 'btn btn-xs btn-accent', '🚀 Podłącz');
      btnPSetup.title = 'Pokaż gotowe komendy instalatora (Linux, Windows, VS Code) dla tego klucza';
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
        var btnPToggle = el('button', 'btn btn-xs', isPRevealed ? 'Ukryj' : 'Pokaż');
        btnPToggle.addEventListener('click', function () {
          revealedKeys['__primary__'] = !revealedKeys['__primary__'];
          renderClientKeys(keys, clients);
        });
        pKeyWrap.appendChild(btnPToggle);
      }

      var btnPCopy = el('button', 'btn btn-xs', '📋 Kopiuj');
      btnPCopy.addEventListener('click', function () {
        copyToClipboard(primaryAdminKey, 'Główny klucz administratora');
      });
      pKeyWrap.appendChild(btnPCopy);
      pBottomRow.appendChild(pKeyWrap);

      var pDesc = el('span', 'client-key-stats', 'Logowanie do panelu + pełny dostęp CLI');
      pBottomRow.appendChild(pDesc);
      pCard.appendChild(pBottomRow);

      container.appendChild(pCard);
    }

    if (!list.length && !primaryAdminKey) {
      var empty = el('div', '', 'Brak zdefiniowanych kluczy. Kliknij „➕ Nowy klucz” powyżej.');
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
      topRow.appendChild(nameWrap);

      var acts = el('div', 'card-actions');

      var btnSetup = el('button', 'btn btn-xs btn-accent', '🚀 Podłącz');
      btnSetup.title = 'Pokaż gotowe komendy instalatora (Linux, Windows, VS Code) dla tego klienta';
      btnSetup.addEventListener('click', function () {
        currentQuickKey = raw;
        updateQuickCmd();
        showKeyModal(k.name, raw);
      });
      acts.appendChild(btnSetup);

      var btnDel = el('button', 'btn btn-xs btn-bad', 'Unieważnij');
      btnDel.title = 'Unieważnij i usuń ten klucz';
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
        var btnToggle = el('button', 'btn btn-xs', isRevealed ? 'Ukryj' : 'Pokaż');
        btnToggle.addEventListener('click', function () {
          revealedKeys[k.name] = !revealedKeys[k.name];
          renderClientKeys(keys, clients);
        });
        keyWrap.appendChild(btnToggle);
      }

      var btnCopy = el('button', 'btn btn-xs', '📋 Kopiuj');
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
      container.appendChild(card);
    });
  }

  function doPullSetup(btn) {
    if (btn) btn.disabled = true;
    note('ok', 'Pobieranie aktualizacji repozytorium claude-lb z GitHub...');
    apiCall('/teamclaude/api/setup/pull', 'POST')
      .then(function (res) {
        if (btn) btn.disabled = false;
        if (!res) return;
        if (res.ok) {
          note('ok', 'Zaktualizowano repozytorium claude-lb: ' + (res.output || 'Już aktualne.'));
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
    fetch('/teamclaude/status', { headers: headers })
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
        fetch('/teamclaude/api/keys', { headers: apiHeaders })
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
      fetch('/teamclaude/api/auth/verify')
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

    fetch('/teamclaude/api/auth/verify', {
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

    fetch('/teamclaude/api/auth/verify', {
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
      showKeybox(null, 'Zostałeś pomyślnie wylogowany.');
    });
  }

  ['fProject', 'fClient'].forEach(function (id) {
    document.getElementById(id).addEventListener('change', function () {
      sessionFilters[id === 'fProject' ? 'project' : 'client'] = this.value;
      if (lastStatus) render(lastStatus);
    });
  });

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
    }
  });

  ['modalAddAccount', 'modalAddClientKey', 'modalKeyCreated', 'modalRelogin'].forEach(function (id) {
    var m = document.getElementById(id);
    if (m) {
      m.addEventListener('click', function (e) {
        if (e.target === m) closeModal(id);
      });
    }
  });

  checkAuthAndStart();
})();
</script>
</body>
</html>
`;
