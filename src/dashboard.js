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
  (s.accounts || []).forEach(function (a) {
    var why = ATTENTION[a.unavailable];
    if (why) out.push({ severity: 'warn', kind: 'account', text: 'Account ' + a.name + ' ' + why + '.' });
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
<title>TeamClaude</title>
<style>
  :root {
    --bg: #101418; --panel: #171d24; --line: #242c36;
    --text: #d7dde4; --dim: #8a949f; --accent: #53b1fd;
    --ok: #3fb950; --warn: #d29922; --bad: #f85149;
  }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--bg); color: var(--text); font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; padding: 24px 16px; }
  main { max-width: 860px; margin: 0 auto; width: 100%; }
  h1 { font-size: 20px; font-weight: 700; margin-bottom: 2px; }
  h2 { font-size: 13px; color: var(--dim); text-transform: uppercase; letter-spacing: .06em; margin: 24px 0 8px; }
  .sub { color: var(--dim); margin-bottom: 12px; font-size: 13px; }
  .sub b { color: var(--text); font-weight: 600; }
  .header-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
  .header-actions { display: flex; gap: 8px; align-items: center; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; margin-bottom: 10px; }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .name { font-weight: 600; }
  .tag { font-size: 12px; color: var(--dim); }
  .badge { font-size: 12px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); white-space: nowrap; }
  .badge.active { color: var(--ok); border-color: var(--ok); }
  .badge.throttled { color: var(--warn); border-color: var(--warn); }
  .badge.error, .badge.exhausted { color: var(--bad); border-color: var(--bad); }
  .badge.current { color: var(--accent); border-color: var(--accent); }
  .quota { display: grid; grid-template-columns: 64px 1fr 170px; gap: 8px; align-items: center; margin-top: 6px; }
  .quota .lbl { color: var(--dim); font-size: 12px; }
  .quota .val { color: var(--dim); font-size: 12px; text-align: right; font-variant-numeric: tabular-nums; }
  .bar { height: 8px; background: var(--line); border-radius: 4px; overflow: hidden; }
  .bar i { display: block; height: 100%; border-radius: 4px; background: var(--ok); }
  .bar i.warn { background: var(--warn); }
  .bar i.bad { background: var(--bad); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 10px; font-variant-numeric: tabular-nums; }
  th { color: var(--dim); font-size: 12px; font-weight: 500; border-bottom: 1px solid var(--line); }
  td { border-bottom: 1px solid var(--line); }
  tr:last-child td { border-bottom: none; }
  td.num, th.num { text-align: right; }
  .table-responsive { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .usage { color: var(--dim); font-size: 12px; margin-top: 6px; }
  .blocked { color: var(--warn); font-size: 12px; margin-top: 6px; }
  .act { font: inherit; font-size: 12px; padding: 2px 10px; border-radius: 999px; border: 1px solid var(--accent); background: transparent; color: var(--accent); cursor: pointer; margin-left: auto; }
  .act:hover { background: var(--accent); color: var(--bg); }
  .act:disabled { opacity: .5; cursor: default; }
  #note { font-size: 13px; margin: 10px 0; padding: 8px 12px; border-radius: 6px; display: none; }
  #note.ok { background: rgba(63,185,80,.15); color: var(--ok); border: 1px solid var(--ok); }
  #note.warn { background: rgba(210,153,34,.15); color: var(--warn); border: 1px solid var(--warn); }
  #note.error { background: rgba(248,81,73,.15); color: var(--bad); border: 1px solid var(--bad); }
  .filters { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; padding: 8px 10px; border-bottom: 1px solid var(--line); }
  .filters label { color: var(--dim); font-size: 12px; display: flex; align-items: center; gap: 6px; }
  .filters select { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; color: var(--text); font: inherit; font-size: 12px; padding: 4px 8px; }
  .hint { color: var(--dim); font-size: 12px; margin-left: auto; }
  th.sortable { cursor: pointer; user-select: none; }
  th.sortable:hover { color: var(--text); }
  td.dim { color: var(--dim); }
  .ok { color: var(--ok); }
  .no { color: var(--dim); text-decoration: line-through; }
  .pin { color: var(--accent); font-size: 12px; }
  .warnt { color: var(--warn); font-size: 12px; }
  .badt { color: var(--bad); }
  #err { color: var(--bad); margin: 12px 0; display: none; }
  #problems { display: none; margin: 0 0 16px; }
  #problems div { border-radius: 8px; padding: 8px 12px; margin-bottom: 6px; font-size: 13px; }
  #problems .bad { background: rgba(248,81,73,.12); border: 1px solid var(--bad); color: var(--bad); }
  #problems .warn { background: rgba(210,153,34,.12); border: 1px solid var(--warn); color: var(--warn); }
  .sec-head { display: flex; align-items: center; justify-content: space-between; margin: 24px 0 8px; flex-wrap: wrap; gap: 8px; }
  .sec-head h2 { margin: 0; }
  .btn { font: inherit; font-size: 12px; padding: 5px 12px; border-radius: 6px; cursor: pointer; border: 1px solid var(--line); background: var(--panel); color: var(--text); display: inline-flex; align-items: center; justify-content: center; gap: 4px; }
  .btn:hover { background: var(--line); }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn-accent { background: var(--accent); color: #06121f; border-color: var(--accent); font-weight: 600; }
  .btn-accent:hover { filter: brightness(1.1); }
  .btn-sm { padding: 4px 8px; font-size: 11px; border-radius: 4px; }
  .btn-warn { border-color: var(--warn); color: var(--warn); background: transparent; }
  .btn-warn:hover { background: var(--warn); color: var(--bg); }
  .btn-bad { border-color: var(--bad); color: var(--bad); background: transparent; }
  .btn-bad:hover { background: var(--bad); color: var(--bg); }
  .btn-ok { border-color: var(--ok); color: var(--ok); background: transparent; }
  .btn-ok:hover { background: var(--ok); color: var(--bg); }
  .actions-group { display: flex; gap: 6px; align-items: center; margin-left: auto; flex-wrap: wrap; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; }
  #keybox { display: none; margin: 40px auto; max-width: 420px; text-align: center; }
  #keybox input { width: 100%; padding: 10px 12px; margin: 12px 0; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; color: var(--text); font: inherit; }
  #keybox button { padding: 8px 20px; background: var(--accent); border: 0; border-radius: 6px; color: #06121f; font: inherit; font-weight: 600; cursor: pointer; }

  /* Modal Overlay & Tabs Styles */
  .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.78); backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; z-index: 9999; padding: 16px; }
  .modal-box { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; width: 100%; max-width: 540px; max-height: 90vh; overflow-y: auto; padding: 18px 20px; box-shadow: 0 16px 40px rgba(0,0,0,0.6); }
  .tabs-bar { display: flex; gap: 6px; border-bottom: 1px solid var(--line); padding-bottom: 8px; margin-bottom: 14px; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .tab-btn { font: inherit; font-size: 12px; padding: 5px 12px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: var(--dim); cursor: pointer; white-space: nowrap; }
  .tab-btn.active { background: var(--accent); color: #06121f; border-color: var(--accent); font-weight: 600; }
  .form-grid { display: grid; gap: 10px; grid-template-columns: 1fr; }
  .form-row { display: flex; gap: 10px; align-items: flex-end; }
  .form-grid label { display: block; font-size: 12px; color: var(--dim); margin-bottom: 4px; }
  .form-grid input, .form-grid textarea, .form-grid select { width: 100%; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; color: var(--text); font: inherit; font-size: 13px; padding: 8px 10px; box-sizing: border-box; }
  .form-grid input:focus, .form-grid textarea:focus, .form-grid select:focus { border-color: var(--accent); outline: none; }
  footer { color: var(--dim); font-size: 12px; margin-top: 24px; }

  /* Mobile-first / Responsive media queries */
  @media (max-width: 768px) {
    body { padding: 12px 8px; font-size: 13px; }
    main { max-width: 100%; }
    .header-row { flex-direction: column; align-items: flex-start; gap: 8px; }
    .header-actions { width: 100%; }
    .header-actions .btn { width: 100%; min-height: 38px; }
    .sec-head { flex-direction: column; align-items: flex-start; gap: 8px; }
    .sec-head .row { width: 100%; }
    .card { padding: 10px 12px; }
    .quota { grid-template-columns: 50px 1fr 90px; gap: 6px; font-size: 11px; }
    .quota .lbl, .quota .val { font-size: 11px; }
    .actions-group { width: 100%; justify-content: flex-start; flex-wrap: wrap; margin-top: 8px; margin-left: 0; }
    .actions-group .btn { flex: 1 1 auto; text-align: center; }
    .btn { min-height: 38px; padding: 6px 12px; font-size: 12px; }
    .btn-sm { min-height: 34px; padding: 5px 10px; font-size: 12px; }
    .form-row { flex-direction: column; gap: 8px; }
    .form-row > div { width: 100% !important; }
    .modal-box { padding: 14px 12px; width: 100%; max-height: 94vh; }
    .tabs-bar { padding-bottom: 6px; }
    .tab-btn { padding: 6px 10px; font-size: 11px; }
    #keybox { width: 100%; max-width: 100%; padding: 0 8px; margin: 20px auto; }
    #keybox input { min-height: 44px; font-size: 16px; }
    #keybox button { width: 100%; min-height: 44px; }
    table { font-size: 12px; }
    th, td { padding: 8px 6px; }
  }
</style>
</head>
<body>
<main>
  <div id="keybox">
    <h1>TeamClaude</h1>
    <p class="sub">Wprowadź swój klucz proxy (proxy.apiKey), aby uzyskać dostęp do panelu.</p>
    <input id="key" type="password" placeholder="tc-..." autocomplete="off">
    <br><button id="go">Połącz</button>
  </div>
  <div id="app" style="display:none">
    <div class="header-row">
      <div>
        <h1>TeamClaude</h1>
        <p class="sub" id="summary"></p>
      </div>
      <div class="header-actions">
        <button class="btn btn-sm" id="btnReloadFleet" title="Przeładuj flotę kont z dysku">🔄 Przeładuj flotę</button>
      </div>
    </div>
    <div id="err"></div>
    <div id="problems"></div>
    <div id="note"></div>
    <div id="routesWrap" style="display:none">
      <h2>Routing</h2>
      <div class="card table-responsive" style="padding:4px 6px"><table id="routes"></table></div>
    </div>

    <!-- ACCOUNTS SECTION -->
    <div class="sec-head">
      <h2>Accounts (Konta Claude)</h2>
      <div class="row" style="gap:8px;">
        <button class="btn btn-sm btn-accent" id="btnShowAddAccount">➕ Dodaj konto</button>
      </div>
    </div>
    <div id="accounts"></div>

    <!-- CLIENT API KEYS SECTION -->
    <div class="sec-head">
      <h2>CLIENT API KEYS</h2>
      <button class="btn btn-sm btn-accent" id="btnShowAddClientKey">➕ Utwórz klucz klienta</button>
    </div>
    <div class="card table-responsive" style="padding:4px 6px; margin-bottom:14px;">
      <table id="clientKeysTable"></table>
    </div>

    <div id="clientsWrap" style="display:none">
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
    <footer id="foot"></footer>
  </div>

  <!-- MODAL: ADD ACCOUNT -->
  <div id="modalAddAccount" class="modal-backdrop" style="display:none;">
    <div class="modal-box">
      <div class="row" style="justify-content:space-between; margin-bottom:12px;">
        <span style="font-weight:600; font-size:15px;">➕ Dodaj konto Claude</span>
        <button class="btn btn-sm" id="btnCloseAddAccount">✕ Zamknij</button>
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
            <label>Klucz API Anthropic Console (sk-ant-...) *</label>
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
          <p style="color:var(--dim); font-size:12px;">
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
            <p style="color:var(--dim); font-size:12px; margin-bottom:10px;">
              Zaloguj się na konto Claude w przeglądarce za pomocą bezpiecznego przepływu PKCE.
            </p>
            <button class="btn btn-accent" id="btnStartOAuth">Rozpocznij logowanie Claude</button>
          </div>
          <div id="oauthStep2" style="display:none;">
            <p style="font-size:12px; margin-bottom:6px;">
              1. Jeśli okno logowania się nie otworzyło, <a id="oauthLink" href="#" target="_blank" style="color:var(--accent); text-decoration:underline;">kliknij tutaj ↗</a>.
            </p>
            <p style="font-size:12px; color:var(--dim); margin-bottom:8px;">
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

  <!-- MODAL: CLIENT KEY CREATED -->
  <div id="modalKeyCreated" class="modal-backdrop" style="display:none;">
    <div class="modal-box">
      <div class="row" style="justify-content:space-between; margin-bottom:12px;">
        <span style="font-weight:600; color:var(--ok); font-size:15px;">🔑 Klucz klienta został utworzony</span>
        <button class="btn btn-sm" id="btnCloseKeyModal">✕ Zamknij</button>
      </div>
      <p style="color:var(--dim); font-size:12px; margin-bottom:8px;">
        Klucz dla klienta: <b id="createdClientName" style="color:var(--text)"></b>. Skopiuj go teraz — pełna wartość nie zostanie powtórnie wyświetlona:
      </p>
      <div style="background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:10px; margin-bottom:10px;">
        <div class="mono" id="createdClientKey" style="font-size:13px; word-break:break-all; color:var(--accent);"></div>
      </div>
      <div class="row" style="gap:8px; margin-bottom:14px;">
        <button class="btn btn-sm btn-accent" id="btnCopyCreatedKey">📋 Kopiuj klucz</button>
      </div>

      <div style="margin-bottom:6px; font-size:12px; color:var(--dim); font-weight:600;">Gotowa komenda konfiguracji klienta:</div>
      <div style="background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:10px; margin-bottom:10px;">
        <code class="mono" id="createdClientSetupCmd" style="display:block; font-size:12px; word-break:break-all;"></code>
      </div>
      <div class="row" style="gap:8px; margin-bottom:14px; flex-wrap:wrap;">
        <button class="btn btn-sm" id="btnCopySetupCmd">📋 Kopiuj komendę setup</button>
        <button class="btn btn-sm" id="btnCopyShellEnv">📋 Kopiuj export ENV</button>
        <button class="btn btn-sm" id="btnCopyVSCode">📋 Kopiuj VS Code JSON</button>
      </div>
      <div style="text-align:right;">
        <button class="btn" id="btnDoneKeyModal">Gotowe</button>
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

  function renderAccount(a, current) {
    var card = el('div', 'card');
    var head = el('div', 'row');
    head.appendChild(el('span', 'name', a.name));
    head.appendChild(el('span', 'tag', a.type + ' · prio ' + (a.priority || 0)));
    if (a.name === current) head.appendChild(el('span', 'badge current', 'current'));
    head.appendChild(el('span', 'badge ' + (a.status || ''), a.disabled ? 'disabled' : (a.status || 'unknown')));
    if (a.sessions) head.appendChild(el('span', 'tag', a.sessions + ' active session' + (a.sessions > 1 ? 's' : '')));
    // Action buttons group
    var acts = el('div', 'actions-group');
    if (a.name !== current) {
      var btnSwitch = el('button', 'btn btn-sm btn-accent', '⚡ Aktywuj');
      btnSwitch.title = 'Ustaw jako preferowane konto w rotacji';
      btnSwitch.addEventListener('click', function () { doSwitch(a.name, btnSwitch); });
      acts.appendChild(btnSwitch);
    }
    var btnToggle = el('button', 'btn btn-sm ' + (a.disabled ? 'btn-ok' : 'btn-warn'), a.disabled ? '▶️ Włącz' : '⏸️ Wyłącz');
    btnToggle.title = a.disabled ? 'Włącz konto do rotacji' : 'Wyłącz konto z rotacji';
    btnToggle.addEventListener('click', function () { doToggleDisabled(a.name, !!a.disabled, btnToggle); });
    acts.appendChild(btnToggle);

    var btnPrio = el('button', 'btn btn-sm', 'prio: ' + (a.priority || 0));
    btnPrio.title = 'Zmień priorytet konta';
    btnPrio.addEventListener('click', function () { doSetPriority(a.name, a.priority || 0); });
    acts.appendChild(btnPrio);

    var btnDel = el('button', 'btn btn-sm btn-bad', '🗑️ Usuń');
    btnDel.title = 'Usuń konto z konfiguracji TeamClaude';
    btnDel.addEventListener('click', function () { doRemoveAccount(a.name, btnDel); });
    acts.appendChild(btnDel);

    head.appendChild(acts);
    card.appendChild(head);
    if (a.unavailable) card.appendChild(el('div', 'blocked', 'blocked: ' + (UNAVAILABLE_TEXT[a.unavailable] || a.unavailable)));
    var q = a.quota || {};
    if (q.unified5h != null || q.unified7d != null) {
      card.appendChild(quotaRow('Session', q.unified5h, q.unified5hReset));
      card.appendChild(quotaRow('Weekly', q.unified7d, q.unified7dReset));
      // Model-scoped weekly buckets are learned from the usage endpoint rather
      // than declared, so hard-coding the two families that have dedicated
      // fields drew an incomplete picture the moment upstream metered a third.
      scopedWeeklyRows(q).forEach(function (r) { card.appendChild(quotaRow(r.label, r.utilization, r.resetAt)); });
    } else if (q.tokensLimit != null && q.tokensRemaining != null) {
      card.appendChild(quotaRow('Tokens', 1 - q.tokensRemaining / q.tokensLimit, q.resetsAt));
    } else {
      card.appendChild(el('div', 'usage', 'quota unknown (no traffic observed yet)'));
    }
    var u = a.usage || {};
    var last = u.lastUsed ? ' · last ' + fmtAgo(u.lastUsed) : '';
    card.appendChild(el('div', 'usage', (u.totalRequests || 0) + ' req · ' + fmtNum(accountTokens(u)) + ' tok' + last));
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
    list.forEach(function (p) { wrap.appendChild(el('div', p.severity, p.text)); });
  }

  function render(s) {
    lastStatus = s;
    var sess = s.sessions || {};
    var up = s.server && s.server.uptimeSeconds != null ? 'up ' + fmtIn(s.server.uptimeSeconds) : '';
    var sum = document.getElementById('summary');
    sum.textContent = '';
    sum.appendChild(el('span', '', 'active account '));
    sum.appendChild(el('b', '', s.currentAccount || 'none'));
    sum.appendChild(el('span', '', ' · ' + (sess.active || 0) + ' active / ' + (sess.known || 0) + ' known sessions' + (up ? ' · ' + up : '')));
    var acc = document.getElementById('accounts');
    acc.textContent = '';
    (s.accounts || []).forEach(function (a) { acc.appendChild(renderAccount(a, s.currentAccount)); });
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
  var pendingOAuthState = null;

  function apiCall(url, method, body) {
    var key = localStorage.getItem(KEY) || '';
    var init = {
      method: method || 'GET',
      headers: {
        'x-api-key': key,
        'content-type': 'application/json',
      },
    };
    if (body != null) init.body = JSON.stringify(body);
    return fetch(url, init).then(function (res) {
      if (res.status === 401) {
        localStorage.removeItem(KEY);
        showKeybox();
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
    if (!confirm('Czy na pewno chcesz usunąć konto "' + name + '" z konfiguracji TeamClaude?')) return;
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

  function doAddApiKey(btn) {
    var key = document.getElementById('inApiKey').value.trim();
    var name = document.getElementById('inApiKeyName').value.trim();
    var prio = parseInt(document.getElementById('inApiKeyPrio').value.trim(), 10) || 0;
    if (!key) {
      note('error', 'Klucz API Anthropic jest wymagany');
      return;
    }
    btn.disabled = true;
    apiCall('/teamclaude/api/accounts/add', 'POST', { type: 'api', apiKey: key, name: name, priority: prio })
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
      priority: prio
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
    apiCall('/teamclaude/api/accounts/add', 'POST', { type: 'import', importFrom: path, name: name, priority: prio })
      .then(function (res) {
        btn.disabled = false;
        if (!res) return;
        if (res.ok) {
          note('ok', 'Zaimportowano konto "' + res.account + '" z pliku ' + path);
          document.getElementById('inImportPathName').value = '';
          closeModal('modalAddAccount');
          poll();
        } else {
          note('error', 'Błąd importu konta: ' + (res.error || 'nieznany błąd'));
        }
      })
      .catch(function (e) {
        btn.disabled = false;
        note('error', 'Błąd importu konta: ' + e.message);
      });
  }

  function doStartOAuth(btn) {
    btn.disabled = true;
    apiCall('/teamclaude/oauth/start', 'GET')
      .then(function (res) {
        btn.disabled = false;
        if (!res || !res.ok) {
          note('error', 'Nie można zainicjować logowania: ' + (res ? res.error : 'nieznany błąd'));
          return;
        }
        pendingOAuthState = res.state;
        var link = document.getElementById('oauthLink');
        link.href = res.authUrl;
        document.getElementById('oauthStep1').style.display = 'none';
        document.getElementById('oauthStep2').style.display = 'block';
        window.open(res.authUrl, '_blank');
      })
      .catch(function (e) {
        btn.disabled = false;
        note('error', 'Błąd logowania OAuth: ' + e.message);
      });
  }

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
    apiCall('/teamclaude/oauth/complete', 'POST', { code: code, state: pendingOAuthState, name: name, priority: prio })
      .then(function (res) {
        btn.disabled = false;
        if (!res) return;
        if (res.ok) {
          note('ok', 'Zautoryzowano konto Claude "' + res.account + '"' + (res.email ? ' (' + res.email + ')' : ''));
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

  function showKeyModal(name, key) {
    document.getElementById('createdClientName').textContent = name;
    document.getElementById('createdClientKey').textContent = key;
    var setupCmd = './teamclaude-setup.sh --key ' + key;
    document.getElementById('createdClientSetupCmd').textContent = setupCmd;
    openModal('modalKeyCreated');
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

  function renderClientKeys(keys, clients) {
    var table = document.getElementById('clientKeysTable');
    if (!table) return;
    table.textContent = '';
    var list = keys || [];

    if (!list.length) {
      var emptyTr = el('tr');
      var td = el('td', 'dim', 'Brak zdefiniowanych kluczy klientów. Kliknij „➕ Utwórz klucz klienta” powyżej.');
      td.colSpan = 5;
      td.style.padding = '14px 10px';
      emptyTr.appendChild(td);
      table.appendChild(emptyTr);
      return;
    }

    var hr = el('tr');
    ['Klient', 'Klucz API', 'Zapytania', 'Tokeny (In / Out)', 'Akcje'].forEach(function (h, i) {
      hr.appendChild(el('th', (i === 2 || i === 3 || i === 4) ? 'num' : '', h));
    });
    table.appendChild(hr);

    list.forEach(function (k) {
      var tr = el('tr');
      tr.appendChild(el('td', '', k.name));

      var keyTd = el('td');
      var row = el('div', 'row');
      row.style.gap = '6px';
      var isRevealed = !!revealedKeys[k.name];
      var raw = k.rawKey || k.key || '';
      var masked = isRevealed ? raw : (raw.length > 8 ? raw.slice(0, 5) + '••••••••' + raw.slice(-4) : '••••••••');
      row.appendChild(el('span', 'mono', masked));

      if (raw && raw !== masked) {
        var btnToggle = el('button', 'btn btn-sm', isRevealed ? 'Ukryj' : 'Pokaż');
        btnToggle.addEventListener('click', function () {
          revealedKeys[k.name] = !revealedKeys[k.name];
          renderClientKeys(keys, clients);
        });
        row.appendChild(btnToggle);
      }

      var btnCopy = el('button', 'btn btn-sm', '📋 Kopiuj');
      btnCopy.addEventListener('click', function () {
        copyToClipboard(raw, 'Klucz klienta ' + k.name);
      });
      row.appendChild(btnCopy);
      keyTd.appendChild(row);
      tr.appendChild(keyTd);

      var stat = (k.stats) || (clients && clients[k.name]) || {};
      tr.appendChild(el('td', 'num', fmtNum(stat.requests || 0)));

      var inT = stat.inputTokens || 0;
      var outT = stat.outputTokens || 0;
      var tokText = (inT || outT) ? (fmtNum(inT) + ' / ' + fmtNum(outT)) : '—';
      tr.appendChild(el('td', 'num', tokText));

      var actTd = el('td', 'num');
      var acts = el('div', 'actions-group');
      acts.style.justifyContent = 'flex-end';

      var btnSetup = el('button', 'btn btn-sm', '⚙️ Setup');
      btnSetup.title = 'Pokaż polecenie setup klienta';
      btnSetup.addEventListener('click', function () {
        showKeyModal(k.name, raw);
      });
      acts.appendChild(btnSetup);

      var btnDel = el('button', 'btn btn-sm btn-bad', '🗑️ Unieważnij');
      btnDel.title = 'Unieważnij i usuń ten klucz';
      btnDel.addEventListener('click', function () {
        doRemoveClientKey(k.name, btnDel);
      });
      acts.appendChild(btnDel);

      actTd.appendChild(acts);
      tr.appendChild(actTd);
      table.appendChild(tr);
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
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
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

  function showKeybox() {
    if (timer) { clearInterval(timer); timer = null; }
    document.getElementById('app').style.display = 'none';
    document.getElementById('keybox').style.display = 'block';
    document.getElementById('key').focus();
  }

  function poll() {
    var apiKey = localStorage.getItem(KEY) || '';
    fetch('/teamclaude/status', { headers: { 'x-api-key': apiKey } })
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
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
        fetch('/teamclaude/api/keys', { headers: { 'x-api-key': apiKey } })
          .then(function (kr) { return kr.ok ? kr.json() : null; })
          .then(function (kd) {
            if (kd && Array.isArray(kd.keys)) {
              renderClientKeys(kd.keys, s.clients);
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

  document.getElementById('go').addEventListener('click', function () {
    var v = document.getElementById('key').value.trim();
    if (!v) return;
    localStorage.setItem(KEY, v);
    start();
  });
  document.getElementById('key').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') document.getElementById('go').click();
  });

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

  // Modals opening/closing
  document.getElementById('btnShowAddAccount').addEventListener('click', function () {
    openModal('modalAddAccount');
  });
  document.getElementById('btnCloseAddAccount').addEventListener('click', function () {
    closeModal('modalAddAccount');
  });

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

  // Key Created Modal copy actions
  document.getElementById('btnCopyCreatedKey').addEventListener('click', function () {
    var k = document.getElementById('createdClientKey').textContent;
    copyToClipboard(k, 'Klucz klienta');
  });
  document.getElementById('btnCopySetupCmd').addEventListener('click', function () {
    var cmd = document.getElementById('createdClientSetupCmd').textContent;
    copyToClipboard(cmd, 'Polecenie setup klienta');
  });
  document.getElementById('btnCopyShellEnv').addEventListener('click', function () {
    var k = document.getElementById('createdClientKey').textContent;
    var hostUrl = window.location.origin;
    copyToClipboard('export ANTHROPIC_BASE_URL="' + hostUrl + '"\nexport ANTHROPIC_API_KEY="' + k + '"', 'Shell env');
  });
  document.getElementById('btnCopyVSCode').addEventListener('click', function () {
    var k = document.getElementById('createdClientKey').textContent;
    var hostUrl = window.location.origin;
    var snippet = JSON.stringify([
      { name: 'ANTHROPIC_BASE_URL', value: hostUrl },
      { name: 'ANTHROPIC_API_KEY', value: k },
    ], null, 2);
    copyToClipboard(snippet, 'VS Code JSON');
  });

  // Close modals on Escape key or clicking backdrop
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      closeModal('modalAddAccount');
      closeModal('modalAddClientKey');
      closeModal('modalKeyCreated');
    }
  });

  ['modalAddAccount', 'modalAddClientKey', 'modalKeyCreated'].forEach(function (id) {
    var m = document.getElementById(id);
    if (m) {
      m.addEventListener('click', function (e) {
        if (e.target === m) closeModal(id);
      });
    }
  });

  if (localStorage.getItem(KEY)) start(); else showKeybox();
})();
</script>
</body>
</html>
`;
