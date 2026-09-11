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
  body { background: var(--bg); color: var(--text); font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; padding: 24px; }
  main { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 18px; margin-bottom: 4px; }
  h2 { font-size: 13px; color: var(--dim); text-transform: uppercase; letter-spacing: .06em; margin: 24px 0 8px; }
  .sub { color: var(--dim); margin-bottom: 16px; }
  .sub b { color: var(--text); font-weight: 600; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; margin-bottom: 10px; }
  .row { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .name { font-weight: 600; }
  .tag { font-size: 12px; color: var(--dim); }
  .badge { font-size: 12px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); }
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
  th, td { text-align: left; padding: 6px 10px; font-variant-numeric: tabular-nums; }
  th { color: var(--dim); font-size: 12px; font-weight: 500; border-bottom: 1px solid var(--line); }
  td { border-bottom: 1px solid var(--line); }
  tr:last-child td { border-bottom: none; }
  td.num, th.num { text-align: right; }
  .usage { color: var(--dim); font-size: 12px; margin-top: 6px; }
  .blocked { color: var(--warn); font-size: 12px; margin-top: 6px; }
  .act { font: inherit; font-size: 12px; padding: 1px 10px; border-radius: 999px; border: 1px solid var(--accent); background: transparent; color: var(--accent); cursor: pointer; margin-left: auto; }
  .act:hover { background: var(--accent); color: var(--bg); }
  .act:disabled { opacity: .5; cursor: default; }
  #note { font-size: 12px; margin: 8px 0; display: none; }
  #note.ok { color: var(--ok); } #note.warn { color: var(--warn); } #note.error { color: var(--bad); }
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
  .sec-head { display: flex; align-items: center; justify-content: space-between; margin: 24px 0 8px; }
  .sec-head h2 { margin: 0; }
  .btn { font: inherit; font-size: 12px; padding: 3px 12px; border-radius: 6px; cursor: pointer; border: 1px solid var(--line); background: var(--panel); color: var(--text); }
  .btn:hover { background: var(--line); }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn-accent { background: var(--accent); color: #06121f; border-color: var(--accent); font-weight: 600; }
  .btn-accent:hover { filter: brightness(1.1); }
  .btn-sm { padding: 2px 8px; font-size: 11px; border-radius: 4px; }
  .btn-warn { border-color: var(--warn); color: var(--warn); background: transparent; }
  .btn-warn:hover { background: var(--warn); color: var(--bg); }
  .btn-bad { border-color: var(--bad); color: var(--bad); background: transparent; }
  .btn-bad:hover { background: var(--bad); color: var(--bg); }
  .btn-ok { border-color: var(--ok); color: var(--ok); background: transparent; }
  .btn-ok:hover { background: var(--ok); color: var(--bg); }
  .panel-form { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; margin-bottom: 12px; }
  .form-grid { display: grid; gap: 10px; grid-template-columns: 1fr; }
  .form-grid input, .form-grid textarea, .form-grid select { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; color: var(--text); font: inherit; font-size: 12px; padding: 6px 10px; }
  .form-grid input:focus, .form-grid textarea:focus, .form-grid select:focus { border-color: var(--accent); outline: none; }
  .actions-group { display: flex; gap: 6px; align-items: center; margin-left: auto; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; }
  #keybox { display: none; margin: 40px auto; max-width: 420px; text-align: center; }
  #keybox input { width: 100%; padding: 10px 12px; margin: 12px 0; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; color: var(--text); font: inherit; }
  #keybox button { padding: 8px 20px; background: var(--accent); border: 0; border-radius: 6px; color: #06121f; font: inherit; font-weight: 600; cursor: pointer; }
  footer { color: var(--dim); font-size: 12px; margin-top: 24px; }
</style>
</head>
<body>
<main>
  <div id="keybox">
    <h1>TeamClaude</h1>
    <p class="sub">Enter your proxy key to view status.</p>
    <input id="key" type="password" placeholder="tc-..." autocomplete="off">
    <br><button id="go">Connect</button>
  </div>
  <div id="app" style="display:none">
    <h1>TeamClaude</h1>
    <p class="sub" id="summary"></p>
    <div id="err"></div>
    <div id="problems"></div>
    <div id="note"></div>
    <div id="routesWrap" style="display:none">
      <h2>Routing</h2>
      <div class="card" style="padding:4px 6px"><table id="routes"></table></div>
    </div>
    <div class="sec-head">
      <h2>Accounts</h2>
      <div class="row" style="gap:8px;">
        <button class="btn btn-sm" id="btnReloadDisk">↻ Reload</button>
        <button class="btn btn-sm btn-accent" id="btnShowAddAccount">+ Add Account</button>
      </div>
    </div>
    <div id="addAccountPanel" class="panel-form" style="display:none;">
      <div class="row" style="justify-content:space-between; margin-bottom:12px;">
        <span style="font-weight:600;">Add Claude Account</span>
        <button class="btn btn-sm" id="btnCloseAddAccount">✕ Close</button>
      </div>
      <div class="row" style="gap:8px; margin-bottom:12px;">
        <button class="btn btn-sm btn-accent" id="tabBtnApiKey">Anthropic API Key</button>
        <button class="btn btn-sm" id="tabBtnOAuth">Browser OAuth</button>
        <button class="btn btn-sm" id="tabBtnImport">Import JSON / Tokens</button>
      </div>

      <div id="tabContentApiKey">
        <div class="form-grid">
          <div>
            <label style="display:block; font-size:12px; color:var(--dim); margin-bottom:4px;">Anthropic API Key *</label>
            <input id="inApiKey" type="password" placeholder="sk-ant-api03-..." style="width:100%;">
          </div>
          <div class="row" style="gap:10px;">
            <div style="flex:1;">
              <label style="display:block; font-size:12px; color:var(--dim); margin-bottom:4px;">Account Name (optional)</label>
              <input id="inApiKeyName" type="text" placeholder="e.g. api-main" style="width:100%;">
            </div>
            <div style="width:110px;">
              <label style="display:block; font-size:12px; color:var(--dim); margin-bottom:4px;">Priority</label>
              <input id="inApiKeyPrio" type="number" value="0" style="width:100%;">
            </div>
          </div>
          <div style="margin-top:6px;">
            <button class="btn btn-accent" id="btnSubmitApiKey">Add API Key Account</button>
          </div>
        </div>
      </div>

      <div id="tabContentOAuth" style="display:none;">
        <div class="form-grid">
          <p style="color:var(--dim); font-size:12px;">
            Authenticate directly with your Anthropic Claude subscription (Pro, Max, Team, Enterprise).
          </p>
          <div id="oauthStep1">
            <button class="btn btn-accent" id="btnStartOAuth">Start Claude Login Flow</button>
          </div>
          <div id="oauthStep2" style="display:none;">
            <p style="font-size:12px; margin-bottom:6px;">
              1. <a id="oauthLink" href="#" target="_blank" style="color:var(--accent); text-decoration:underline;">Click here to open Claude.ai login page in a new tab ↗</a>
            </p>
            <p style="font-size:12px; color:var(--dim); margin-bottom:8px;">
              2. Log in and authorize. You will see a success screen or redirect URL. Copy the authorization code or full URL and paste it below:
            </p>
            <div>
              <label style="display:block; font-size:12px; color:var(--dim); margin-bottom:4px;">Authorization Code or Callback URL *</label>
              <input id="inOAuthCode" type="text" placeholder="Paste code or URL here..." style="width:100%;">
            </div>
            <div class="row" style="gap:10px; margin-top:8px;">
              <div style="flex:1;">
                <label style="display:block; font-size:12px; color:var(--dim); margin-bottom:4px;">Account Name (optional)</label>
                <input id="inOAuthName" type="text" placeholder="Auto-detected from profile if blank" style="width:100%;">
              </div>
              <div style="width:110px;">
                <label style="display:block; font-size:12px; color:var(--dim); margin-bottom:4px;">Priority</label>
                <input id="inOAuthPrio" type="number" value="0" style="width:100%;">
              </div>
            </div>
            <div style="margin-top:8px;">
              <button class="btn btn-accent" id="btnCompleteOAuth">Complete Login & Add Account</button>
            </div>
          </div>
        </div>
      </div>

      <div id="tabContentImport" style="display:none;">
        <div class="form-grid">
          <p style="color:var(--dim); font-size:12px;">
            Paste credentials from <code>~/.claude/.credentials.json</code> or OAuth token JSON.
          </p>
          <div>
            <label style="display:block; font-size:12px; color:var(--dim); margin-bottom:4px;">Credentials JSON *</label>
            <textarea id="inImportJson" rows="4" placeholder='{"claudeAiOauth":{"accessToken":"...","refreshToken":"...","expiresAt":...}}' style="width:100%; font-family:monospace;"></textarea>
          </div>
          <div class="row" style="gap:10px;">
            <div style="flex:1;">
              <label style="display:block; font-size:12px; color:var(--dim); margin-bottom:4px;">Account Name (optional)</label>
              <input id="inImportName" type="text" placeholder="Auto-detected from profile if blank" style="width:100%;">
            </div>
            <div style="width:110px;">
              <label style="display:block; font-size:12px; color:var(--dim); margin-bottom:4px;">Priority</label>
              <input id="inImportPrio" type="number" value="0" style="width:100%;">
            </div>
          </div>
          <div style="margin-top:6px;">
            <button class="btn btn-accent" id="btnSubmitImport">Import Credentials</button>
          </div>
        </div>
      </div>
    </div>
    <div id="accounts"></div>

    <div class="sec-head">
      <h2>Client Access Keys (proxy.clientKeys)</h2>
      <button class="btn btn-sm btn-accent" id="btnShowAddClientKey">+ Add Client Key</button>
    </div>
    <div id="keyNoticeBox" class="card" style="display:none; border-color:var(--ok); background:rgba(63,185,80,.08); margin-bottom:12px;">
      <div class="row" style="justify-content:space-between; margin-bottom:6px;">
        <span style="color:var(--ok); font-weight:600;">Access Key Ready for Client: <b id="keyNoticeName"></b></span>
        <button class="btn btn-sm" id="btnCloseKeyNotice">✕ Dismiss</button>
      </div>
      <div style="margin:8px 0;">
        <span class="mono" id="keyNoticeVal" style="font-weight:600; font-size:13px; color:var(--text); word-break:break-all;"></span>
      </div>
      <div class="row" style="gap:8px;">
        <button class="btn btn-sm btn-accent" id="btnCopyNoticeKey">Copy Key</button>
        <button class="btn btn-sm" id="btnCopyNoticeEnv">Copy Shell Env</button>
        <button class="btn btn-sm" id="btnCopyNoticeVSCode">Copy VS Code JSON</button>
      </div>
    </div>
    <div id="addClientKeyPanel" class="panel-form" style="display:none;">
      <div class="row" style="justify-content:space-between; margin-bottom:10px;">
        <span style="font-weight:600;">Create Client Access Key</span>
        <button class="btn btn-sm" id="btnCloseAddClientKey">✕ Close</button>
      </div>
      <div class="form-grid">
        <p style="color:var(--dim); font-size:12px;">
          Generate a dedicated access key for a machine, developer, or CI runner. Request metrics and token usage are tracked per client name.
        </p>
        <div class="row" style="gap:10px;">
          <div style="flex:1;">
            <label style="display:block; font-size:12px; color:var(--dim); margin-bottom:4px;">Client Name *</label>
            <input id="inClientName" type="text" placeholder="e.g. laptop-macbook, dev-worker" style="width:100%;">
          </div>
          <div style="flex:1;">
            <label style="display:block; font-size:12px; color:var(--dim); margin-bottom:4px;">Custom Key (optional)</label>
            <input id="inClientCustomKey" type="text" placeholder="Leave empty for auto-generated tc-..." style="width:100%; font-family:monospace;">
          </div>
        </div>
        <div style="margin-top:6px;">
          <button class="btn btn-accent" id="btnSubmitClientKey">Create Client Key</button>
        </div>
      </div>
    </div>
    <div class="card" style="padding:4px 6px; margin-bottom:14px;">
      <table id="clientKeysTable"></table>
    </div>
    <div id="clientsWrap" style="display:none">
      <h2>Clients</h2>
      <div class="card" style="padding:4px 6px"><table id="clients"></table></div>
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
        <div style="padding:4px 6px"><table id="sessions"></table></div>
      </div>
    </div>
    <footer id="foot"></footer>
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
      var btnSwitch = el('button', 'btn btn-sm', 'switch');
      btnSwitch.title = 'Make preferred account';
      btnSwitch.addEventListener('click', function () { doSwitch(a.name, btnSwitch); });
      acts.appendChild(btnSwitch);
    }
    var btnToggle = el('button', 'btn btn-sm ' + (a.disabled ? 'btn-ok' : 'btn-warn'), a.disabled ? 'enable' : 'disable');
    btnToggle.title = a.disabled ? 'Re-enable account for rotation' : 'Disable account (skip in rotation)';
    btnToggle.addEventListener('click', function () { doToggleDisabled(a.name, !!a.disabled, btnToggle); });
    acts.appendChild(btnToggle);

    var btnPrio = el('button', 'btn btn-sm', 'prio: ' + (a.priority || 0));
    btnPrio.title = 'Click to change priority';
    btnPrio.addEventListener('click', function () { doSetPriority(a.name, a.priority || 0); });
    acts.appendChild(btnPrio);

    var btnDel = el('button', 'btn btn-sm btn-bad', '✕');
    btnDel.title = 'Remove account from TeamClaude';
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

  function doToggleDisabled(name, currentDisabled, btn) {
    btn.disabled = true;
    apiCall('/teamclaude/accounts/toggle', 'POST', { account: name, disabled: !currentDisabled })
      .then(function (res) {
        if (!res) return;
        if (res.ok) {
          note('ok', 'Account "' + name + '" ' + (res.disabled ? 'disabled' : 're-enabled'));
          poll();
        } else {
          note('error', 'Toggle failed: ' + (res.error || 'unknown error'));
          btn.disabled = false;
        }
      })
      .catch(function (e) {
        note('error', 'Toggle failed: ' + e.message);
        btn.disabled = false;
      });
  }

  function doSetPriority(name, currentPrio) {
    var input = prompt('Enter new priority for "' + name + '" (integer, lower value = higher priority):', currentPrio || 0);
    if (input == null) return;
    var prio = parseInt(input.trim(), 10);
    if (isNaN(prio)) {
      note('error', 'Priority must be an integer');
      return;
    }
    apiCall('/teamclaude/accounts/priority', 'POST', { account: name, priority: prio })
      .then(function (res) {
        if (!res) return;
        if (res.ok) {
          note('ok', 'Updated priority of "' + name + '" to ' + res.priority);
          poll();
        } else {
          note('error', 'Set priority failed: ' + (res.error || 'unknown error'));
        }
      })
      .catch(function (e) {
        note('error', 'Set priority failed: ' + e.message);
      });
  }

  function doRemoveAccount(name, btn) {
    if (!confirm('Are you sure you want to remove account "' + name + '" from TeamClaude?')) return;
    if (btn) btn.disabled = true;
    apiCall('/teamclaude/accounts/remove', 'POST', { account: name })
      .then(function (res) {
        if (!res) return;
        if (res.ok) {
          note('ok', 'Removed account "' + name + '"');
          poll();
        } else {
          note('error', 'Remove failed: ' + (res.error || 'unknown error'));
          if (btn) btn.disabled = false;
        }
      })
      .catch(function (e) {
        note('error', 'Remove failed: ' + e.message);
        if (btn) btn.disabled = false;
      });
  }

  function doReloadFromDisk(btn) {
    if (btn) btn.disabled = true;
    apiCall('/teamclaude/reload', 'POST')
      .then(function (res) {
        if (btn) btn.disabled = false;
        if (!res) return;
        if (res.ok) {
          note('ok', 'Reloaded config from disk (' + (res.added || 0) + ' new account' + (res.added === 1 ? '' : 's') + ')');
          poll();
        } else {
          note('error', 'Reload failed: ' + (res.error || 'unknown error'));
        }
      })
      .catch(function (e) {
        if (btn) btn.disabled = false;
        note('error', 'Reload failed: ' + e.message);
      });
  }

  function doAddApiKey(btn) {
    var key = document.getElementById('inApiKey').value.trim();
    var name = document.getElementById('inApiKeyName').value.trim();
    var prio = parseInt(document.getElementById('inApiKeyPrio').value.trim(), 10) || 0;
    if (!key) {
      note('error', 'Anthropic API key is required');
      return;
    }
    btn.disabled = true;
    apiCall('/teamclaude/accounts/add', 'POST', { type: 'apikey', apiKey: key, name: name, priority: prio })
      .then(function (res) {
        btn.disabled = false;
        if (!res) return;
        if (res.ok) {
          note('ok', 'Added API key account "' + res.account + '"');
          document.getElementById('inApiKey').value = '';
          document.getElementById('inApiKeyName').value = '';
          document.getElementById('addAccountPanel').style.display = 'none';
          poll();
        } else {
          note('error', 'Add account failed: ' + (res.error || 'unknown error'));
        }
      })
      .catch(function (e) {
        btn.disabled = false;
        note('error', 'Add account failed: ' + e.message);
      });
  }

  function doStartOAuth(btn) {
    btn.disabled = true;
    apiCall('/teamclaude/oauth/start', 'GET')
      .then(function (res) {
        btn.disabled = false;
        if (!res || !res.ok) {
          note('error', 'Could not initiate OAuth: ' + (res ? res.error : 'unknown error'));
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
        note('error', 'OAuth start failed: ' + e.message);
      });
  }

  function doCompleteOAuth(btn) {
    var code = document.getElementById('inOAuthCode').value.trim();
    var name = document.getElementById('inOAuthName').value.trim();
    var prio = parseInt(document.getElementById('inOAuthPrio').value.trim(), 10) || 0;
    if (!code) {
      note('error', 'Please paste the authorization code or callback URL');
      return;
    }
    if (!pendingOAuthState) {
      note('error', 'No active OAuth session. Click "Start Claude Login Flow" again.');
      return;
    }
    btn.disabled = true;
    apiCall('/teamclaude/oauth/complete', 'POST', { code: code, state: pendingOAuthState, name: name, priority: prio })
      .then(function (res) {
        btn.disabled = false;
        if (!res) return;
        if (res.ok) {
          note('ok', 'Authenticated Claude account "' + res.account + '"' + (res.email ? ' (' + res.email + ')' : ''));
          document.getElementById('inOAuthCode').value = '';
          document.getElementById('inOAuthName').value = '';
          document.getElementById('oauthStep1').style.display = 'block';
          document.getElementById('oauthStep2').style.display = 'none';
          document.getElementById('addAccountPanel').style.display = 'none';
          pendingOAuthState = null;
          poll();
        } else {
          note('error', 'OAuth completion failed: ' + (res.error || 'unknown error'));
        }
      })
      .catch(function (e) {
        btn.disabled = false;
        note('error', 'OAuth completion failed: ' + e.message);
      });
  }

  function doImportJson(btn) {
    var jsonStr = document.getElementById('inImportJson').value.trim();
    var name = document.getElementById('inImportName').value.trim();
    var prio = parseInt(document.getElementById('inImportPrio').value.trim(), 10) || 0;
    if (!jsonStr) {
      note('error', 'Please paste credentials JSON');
      return;
    }
    btn.disabled = true;
    apiCall('/teamclaude/accounts/add', 'POST', { type: 'oauth', credentialsJson: jsonStr, name: name, priority: prio })
      .then(function (res) {
        btn.disabled = false;
        if (!res) return;
        if (res.ok) {
          note('ok', 'Imported credentials for "' + res.account + '"');
          document.getElementById('inImportJson').value = '';
          document.getElementById('inImportName').value = '';
          document.getElementById('addAccountPanel').style.display = 'none';
          poll();
        } else {
          note('error', 'Import failed: ' + (res.error || 'unknown error'));
        }
      })
      .catch(function (e) {
        btn.disabled = false;
        note('error', 'Import failed: ' + e.message);
      });
  }

  function showKeyNotice(name, key) {
    var box = document.getElementById('keyNoticeBox');
    if (!box) return;
    box.style.display = 'block';
    document.getElementById('keyNoticeName').textContent = name;
    document.getElementById('keyNoticeVal').textContent = key;
  }

  function doAddClientKey(btn) {
    var name = document.getElementById('inClientName').value.trim();
    var customKey = document.getElementById('inClientCustomKey').value.trim();
    if (!name) {
      note('error', 'Client name is required');
      return;
    }
    btn.disabled = true;
    apiCall('/teamclaude/client-keys/add', 'POST', { name: name, key: customKey })
      .then(function (res) {
        btn.disabled = false;
        if (!res) return;
        if (res.ok) {
          note('ok', 'Created client access key for "' + res.client.name + '"');
          showKeyNotice(res.client.name, res.client.key);
          document.getElementById('inClientName').value = '';
          document.getElementById('inClientCustomKey').value = '';
          document.getElementById('addClientKeyPanel').style.display = 'none';
          poll();
        } else {
          note('error', 'Create client key failed: ' + (res.error || 'unknown error'));
        }
      })
      .catch(function (e) {
        btn.disabled = false;
        note('error', 'Create client key failed: ' + e.message);
      });
  }

  function doRotateClientKey(name, btn) {
    if (!confirm('Rotate access key for client "' + name + '"? The old key will immediately stop working.')) return;
    if (btn) btn.disabled = true;
    apiCall('/teamclaude/client-keys/rotate', 'POST', { name: name })
      .then(function (res) {
        if (btn) btn.disabled = false;
        if (!res) return;
        if (res.ok) {
          note('ok', 'Rotated key for client "' + res.client.name + '"');
          showKeyNotice(res.client.name, res.client.key);
          poll();
        } else {
          note('error', 'Rotate key failed: ' + (res.error || 'unknown error'));
        }
      })
      .catch(function (e) {
        if (btn) btn.disabled = false;
        note('error', 'Rotate key failed: ' + e.message);
      });
  }

  function doRemoveClientKey(name, btn) {
    if (!confirm('Are you sure you want to remove client access key for "' + name + '"?')) return;
    if (btn) btn.disabled = true;
    apiCall('/teamclaude/client-keys/remove', 'POST', { name: name })
      .then(function (res) {
        if (btn) btn.disabled = false;
        if (!res) return;
        if (res.ok) {
          note('ok', 'Removed client access key for "' + name + '"');
          poll();
        } else {
          note('error', 'Remove client key failed: ' + (res.error || 'unknown error'));
        }
      })
      .catch(function (e) {
        if (btn) btn.disabled = false;
        note('error', 'Remove client key failed: ' + e.message);
      });
  }

  function renderClientKeys(keys, clients) {
    var table = document.getElementById('clientKeysTable');
    if (!table) return;
    table.textContent = '';
    var list = keys || [];

    if (!list.length) {
      var emptyTr = el('tr');
      var td = el('td', 'dim', 'No client keys configured yet. Click "+ Add Client Key" above to generate one.');
      td.colSpan = 5;
      td.style.padding = '12px 10px';
      emptyTr.appendChild(td);
      table.appendChild(emptyTr);
      return;
    }

    var hr = el('tr');
    ['Client Name', 'API Key (ANTHROPIC_API_KEY)', 'Requests', 'Tokens', 'Actions'].forEach(function (h, i) {
      hr.appendChild(el('th', (i === 2 || i === 3) ? 'num' : (i === 4 ? 'num' : ''), h));
    });
    table.appendChild(hr);

    list.forEach(function (k) {
      var tr = el('tr');
      tr.appendChild(el('td', '', k.name));

      var keyTd = el('td');
      var row = el('div', 'row');
      row.style.gap = '6px';
      var isRevealed = !!revealedKeys[k.name];
      var masked = isRevealed ? k.key : (k.key && k.key.length > 8 ? k.key.slice(0, 6) + '••••••••' + k.key.slice(-4) : '••••••••');
      row.appendChild(el('span', 'mono', masked));

      var btnToggle = el('button', 'btn btn-sm', isRevealed ? 'Hide' : 'Show');
      btnToggle.addEventListener('click', function () {
        revealedKeys[k.name] = !revealedKeys[k.name];
        renderClientKeys(keys, clients);
      });
      row.appendChild(btnToggle);

      var btnCopy = el('button', 'btn btn-sm', 'Copy');
      btnCopy.addEventListener('click', function () {
        copyToClipboard(k.key, 'Client key for ' + k.name);
      });
      row.appendChild(btnCopy);
      keyTd.appendChild(row);
      tr.appendChild(keyTd);

      var c = (clients && clients[k.name]) || {};
      tr.appendChild(el('td', 'num', fmtNum(c.requests || 0)));

      var toks = (c.inputTokens || 0) + (c.outputTokens || 0);
      tr.appendChild(el('td', 'num', toks ? fmtNum(toks) : '—'));

      var actTd = el('td', 'num');
      var acts = el('div', 'actions-group');
      acts.style.justifyContent = 'flex-end';

      var btnEnv = el('button', 'btn btn-sm', 'Env');
      btnEnv.title = 'Copy shell export commands';
      btnEnv.addEventListener('click', function () {
        var hostUrl = window.location.origin;
        var envText = 'export ANTHROPIC_BASE_URL="' + hostUrl + '"\nexport ANTHROPIC_API_KEY="' + k.key + '"';
        copyToClipboard(envText, 'Shell env for ' + k.name);
      });
      acts.appendChild(btnEnv);

      var btnRot = el('button', 'btn btn-sm btn-warn', 'Rotate');
      btnRot.title = 'Generate a new key for this client';
      btnRot.addEventListener('click', function () {
        doRotateClientKey(k.name, btnRot);
      });
      acts.appendChild(btnRot);

      var btnDel = el('button', 'btn btn-sm btn-bad', '✕');
      btnDel.title = 'Remove client key';
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
        // Re-enabled on any non-success, whether the server refused or the
        // fetch threw, so the two failure paths leave the button in one state.
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
    fetch('/teamclaude/status', { headers: { 'x-api-key': localStorage.getItem(KEY) || '' } })
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

  document.getElementById('btnReloadDisk').addEventListener('click', function () {
    doReloadFromDisk(this);
  });

  document.getElementById('btnShowAddAccount').addEventListener('click', function () {
    var p = document.getElementById('addAccountPanel');
    p.style.display = p.style.display === 'none' ? 'block' : 'none';
  });
  document.getElementById('btnCloseAddAccount').addEventListener('click', function () {
    document.getElementById('addAccountPanel').style.display = 'none';
  });

  function selectTab(tab) {
    var tabs = ['ApiKey', 'OAuth', 'Import'];
    tabs.forEach(function (t) {
      var btn = document.getElementById('tabBtn' + t);
      var content = document.getElementById('tabContent' + t);
      if (t === tab) {
        btn.className = 'btn btn-sm btn-accent';
        content.style.display = 'block';
      } else {
        btn.className = 'btn btn-sm';
        content.style.display = 'none';
      }
    });
  }

  document.getElementById('tabBtnApiKey').addEventListener('click', function () { selectTab('ApiKey'); });
  document.getElementById('tabBtnOAuth').addEventListener('click', function () { selectTab('OAuth'); });
  document.getElementById('tabBtnImport').addEventListener('click', function () { selectTab('Import'); });

  document.getElementById('btnSubmitApiKey').addEventListener('click', function () { doAddApiKey(this); });
  document.getElementById('btnStartOAuth').addEventListener('click', function () { doStartOAuth(this); });
  document.getElementById('btnCompleteOAuth').addEventListener('click', function () { doCompleteOAuth(this); });
  document.getElementById('btnSubmitImport').addEventListener('click', function () { doImportJson(this); });

  document.getElementById('btnShowAddClientKey').addEventListener('click', function () {
    var p = document.getElementById('addClientKeyPanel');
    p.style.display = p.style.display === 'none' ? 'block' : 'none';
  });
  document.getElementById('btnCloseAddClientKey').addEventListener('click', function () {
    document.getElementById('addClientKeyPanel').style.display = 'none';
  });
  document.getElementById('btnSubmitClientKey').addEventListener('click', function () { doAddClientKey(this); });

  document.getElementById('btnCloseKeyNotice').addEventListener('click', function () {
    document.getElementById('keyNoticeBox').style.display = 'none';
  });
  document.getElementById('btnCopyNoticeKey').addEventListener('click', function () {
    var k = document.getElementById('keyNoticeVal').textContent;
    copyToClipboard(k, 'Client key');
  });
  document.getElementById('btnCopyNoticeEnv').addEventListener('click', function () {
    var k = document.getElementById('keyNoticeVal').textContent;
    var hostUrl = window.location.origin;
    copyToClipboard('export ANTHROPIC_BASE_URL="' + hostUrl + '"\nexport ANTHROPIC_API_KEY="' + k + '"', 'Shell env');
  });
  document.getElementById('btnCopyNoticeVSCode').addEventListener('click', function () {
    var k = document.getElementById('keyNoticeVal').textContent;
    var hostUrl = window.location.origin;
    var snippet = JSON.stringify([
      { name: 'ANTHROPIC_BASE_URL', value: hostUrl },
      { name: 'ANTHROPIC_API_KEY', value: k },
    ], null, 2);
    copyToClipboard(snippet, 'VS Code settings');
  });

  if (localStorage.getItem(KEY)) start(); else showKeybox();
})();
</script>
</body>
</html>
`;
