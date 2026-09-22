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

import { createHash } from "node:crypto";
import { UNAVAILABLE_TEXT } from "./status-renderer.js";

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
  const script = html.slice(
    html.indexOf("<script>") + 8,
    html.indexOf("</script>"),
  );
  const hash = createHash("sha256").update(script, "utf8").digest("base64");
  return [
    "default-src 'none'",
    `script-src 'sha256-${hash}'`,
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
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
    rows.push({
      family: family,
      label: family.charAt(0).toUpperCase() + family.slice(1),
      utilization: b.utilization,
      resetAt: b.resetAt,
    });
  });
  [
    {
      family: "fable",
      label: "Fable",
      u: q.unified7dFable,
      r: q.unified7dFableReset,
    },
    {
      family: "sonnet",
      label: "Sonnet",
      u: q.unified7dSonnet,
      r: q.unified7dSonnetReset,
    },
  ].forEach(function (f) {
    if (Object.prototype.hasOwnProperty.call(scoped, f.family) || f.u == null)
      return;
    rows.push({
      family: f.family,
      label: f.label,
      utilization: f.u,
      resetAt: f.r,
    });
  });
  rows.sort(function (a, b) {
    return a.family < b.family ? -1 : a.family > b.family ? 1 : 0;
  });
  return rows;
}

// What an account has spent, cache included. `totalInputTokens` counts uncached
// input only, which on Claude Code traffic is ~0.05% of the input side — a
// total without the cache fields understates the account by orders of magnitude.
export function accountTokens(usage) {
  var u = usage || {};
  return (
    (u.totalInputTokens || 0) +
    (u.totalOutputTokens || 0) +
    (u.totalCacheReadTokens || 0) +
    (u.totalCacheCreationTokens || 0)
  );
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
      client: s.client || "",
      project: (s.dimensions || {}).project || "",
      active: !!s.active,
      requests: s.requests || 0,
      starved: s.starved || 0,
      cacheRead: 0,
      cacheCreation: 0,
      input: 0,
      output: 0,
      context: 0,
      accounts: Object.keys(s.pins || {})
        .map(function (b) {
          return s.pins[b];
        })
        .join(", "),
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
  var sign = dir === "asc" ? 1 : -1;
  return (rows || []).slice().sort(function (a, b) {
    var x = a[key],
      y = b[key];
    if (typeof x === "string" || typeof y === "string") {
      return (
        sign *
        String(x == null ? "" : x).localeCompare(String(y == null ? "" : y))
      );
    }
    return sign * ((x || 0) - (y || 0));
  });
}

export function uniqSorted(values) {
  var seen = Object.create(null);
  (values || []).forEach(function (v) {
    if (v) seen[v] = true;
  });
  return Object.keys(seen).sort();
}

// The request the switch button sends: POST /agent-lb/switch with the same
// key the status poll uses. Pure, so the test suite can send exactly this
// through a real proxy and prove the same-origin CSRF gate lets the page in.
export function switchRequest(name, key) {
  return {
    url: "/agent-lb/switch",
    init: {
      method: "POST",
      headers: { "x-api-key": key || "", "content-type": "application/json" },
      body: JSON.stringify({ account: name }),
    },
  };
}

// What to tell the operator afterwards. The endpoint answers `ok` for the choice
// being recorded and `eligible` for whether traffic will actually follow it —
// two different things, and a bare "done" would be a lie for a spent target.
export function switchOutcome(res) {
  if (!res || !res.ok)
    return {
      kind: "error",
      text: "switch failed" + (res && res.error ? ": " + res.error : ""),
    };
  if (res.eligible === false)
    return {
      kind: "warn",
      text:
        "switched to " +
        res.account +
        ", but rotation will not use it" +
        (res.reason ? ": " + res.reason : ""),
    };
  return { kind: "ok", text: "switched to " + res.account };
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
    var name = r.name || "";
    var match = r.match || [];
    var target = r.target || null;
    var pinned = r.pinned || null;
    return {
      kind: "route",
      name: name,
      label: name.charAt(0).toUpperCase() + name.slice(1),
      match: match.join(", "),
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
      blocked:
        match.length > 0 &&
        match.every(function (g) {
          return blockedModels.indexOf(g) !== -1;
        }),
      autocreated: !!r.autocreated,
      eligible: accounts
        .filter(function (a) {
          return a.eligible;
        })
        .map(function (a) {
          return a.name;
        }),
      ineligible: accounts
        .filter(function (a) {
          return !a.eligible;
        })
        .map(function (a) {
          return a.name;
        }),
    };
  });
  if (rows.length) {
    // The default row is the server's answer too (`defaultTarget`), not an
    // assumption that unrouted traffic lands on the current account: a
    // blocked or outranked current account is skipped by the next request.
    var current = s.currentAccount || null;
    var cur = (s.accounts || []).filter(function (a) {
      return a.name === current;
    })[0];
    rows.push({
      kind: "default",
      name: "",
      label: "Everything else",
      match: "",
      target: s.defaultTarget || current,
      current: current,
      currentUnavailable: (cur && cur.unavailable) || null,
      pinned: null,
      pinMismatch: false,
      blocked: false,
      autocreated: false,
      eligible: [],
      ineligible: [],
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
  var stalled = accounts.filter(function (a) {
    return a.unavailable === "quota" || a.unavailable === "throttled";
  });
  var reasons = {};
  stalled.forEach(function (a) {
    reasons[a.unavailable] = true;
  });
  var why =
    accounts.length && stalled.length === accounts.length
      ? " — every account is " +
        (reasons.quota && reasons.throttled
          ? "over its quota threshold or in a rate-limit hold"
          : reasons.quota
            ? "over its quota threshold"
            : "in a rate-limit hold") +
        "."
      : " — it is failing, not idle.";

  var sessions = s.sessions || {};
  var named = (sessions.items ? sessionRows(sessions) : [])
    .filter(function (r) {
      return r.active && r.starved >= STARVED_MIN;
    })
    .sort(function (a, b) {
      return b.starved - a.starved;
    });
  named.slice(0, STARVED_LIST_MAX).forEach(function (r) {
    out.push({
      severity: "bad",
      kind: "starved-session",
      text:
        (r.client ? r.client + "'s session " : "Session ") +
        String(r.id || "").slice(0, 8) +
        " has had " +
        r.starved +
        " requests in a row come back with nothing" +
        (r.project ? " (" + r.project + ")" : "") +
        why,
    });
  });
  if (named.length > STARVED_LIST_MAX) {
    out.push({
      severity: "bad",
      kind: "starved-more",
      text:
        "and " +
        (named.length - STARVED_LIST_MAX) +
        " more sessions are getting nothing back.",
    });
  }
  if (!named.length && (sessions.starvedMax || 0) >= STARVED_MIN) {
    out.push({
      severity: "bad",
      kind: "starved-session",
      text:
        "A session has had " +
        sessions.starvedMax +
        " requests in a row come back with nothing." +
        " Turn on proxy.sessionDetail to see which.",
    });
  }

  // Only the two states that do not clear themselves. `entitlement` is a
  // Only the states that do not clear themselves or require human attention.
  // `entitlement` is a short cooldown and `upstream-rejected` indicates a spent
  // shared bucket — both expire on their own. `identity-verification` requires
  // human action in the browser, and `error` needs re-login.
  var ATTENTION = {
    error: "needs a re-login",
    disabled: "is disabled",
    "identity-verification": "requires identity verification in browser",
  };
  (s.accounts || []).forEach(function (a) {
    var why = ATTENTION[a.unavailable];
    if (why)
      out.push({
        severity: "warn",
        kind: "account",
        text: "Account " + a.name + " " + why + ".",
        accountName: a.name,
        reason: a.unavailable,
        type: a.type,
        priority: a.priority || 0,
      });
  });

  // Deliberately no spend line. `usedMinor` is month-to-date overage, so on a
  // fleet that has overage switched on it is non-zero for most of the month —
  // an always-lit banner, which is the thing this is trying not to be. The
  // account card and `agentlb status` both carry it, with the amount.

  return out;
}

const SHARED_HELPERS = [
  scopedWeeklyRows,
  accountTokens,
  sessionRows,
  filterSessionRows,
  sortRows,
  uniqSorted,
  switchRequest,
  switchOutcome,
  routeRows,
  problems,
]
  .map((fn) => fn.toString())
  .join("\n\n");

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

  /* Main navigation tab bar */
  .main-nav-tabs {
    display: flex;
    align-items: center;
    gap: 8px;
    border-bottom: 1px solid var(--line);
    margin: 14px 0 16px;
    padding: 0 4px;
  }
  .main-nav-tab {
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--dim);
    font-size: 13.5px;
    font-weight: 600;
    padding: 8px 18px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    transition: all 0.15s ease;
    border-radius: 6px 6px 0 0;
    user-select: none;
  }
  .main-nav-tab:hover {
    color: var(--heading);
    background: rgba(255, 255, 255, 0.04);
  }
  .main-nav-tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
    background: rgba(88, 166, 255, 0.08);
  }
  .main-nav-badge {
    font-size: 11px;
    padding: 1px 7px;
    border-radius: 12px;
    background: var(--chip-bg);
    color: var(--text);
    font-weight: 500;
  }
  .main-nav-tab.active .main-nav-badge {
    background: rgba(88, 166, 255, 0.2);
    color: var(--accent);
  }
  .tab-pane {
    display: block;
  }

  /* 2-column master accounts grid: Col 1 Claude (1fr) | Col 2 Codex (1fr) */
  .dashboard-grid {
    display: grid;
    grid-template-columns: minmax(320px, 1fr) minmax(320px, 1fr);
    gap: 16px;
    align-items: start;
    margin-top: 6px;
  }
  .grid-head-accounts { grid-column: 1 / 3; min-width: 0; }
  #colClaude { grid-column: 1 / 2; min-width: 0; }
  #colCodex { grid-column: 2 / 3; min-width: 0; }
  @media (max-width: 860px) {
    .dashboard-grid { grid-template-columns: 1fr; }
    .grid-head-accounts, #colClaude, #colCodex { grid-column: 1 / 2; }
  }

  .agy-section { margin-top: 18px; }
  .col-title.agy { color: #4f9dff; }
  .agy-hint { font-size: 11px; color: var(--dim); margin: 2px 0 8px; }
  .agy-list { display: flex; flex-direction: column; gap: 6px; }
  .agy-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; background: var(--card, var(--bg)); border: 1px solid var(--line); border-radius: 6px; padding: 7px 10px; font-size: 12px; }
  .agy-row.off { opacity: 0.55; }
  .agy-row .agy-email { font-weight: 600; color: var(--heading); min-width: 180px; word-break: break-all; }
  .agy-row .agy-state { flex: 1; min-width: 160px; color: var(--dim); }
  .agy-row .agy-state.spent { color: var(--warn, #d29922); }
  .agy-row .agy-actions { display: flex; gap: 4px; flex-wrap: wrap; }
  .agy-steps { margin: 0 0 8px 18px; padding: 0; font-size: 13px; display: flex; flex-direction: column; gap: 10px; }
  .agy-countdown { font-size: 12px; color: var(--dim); }

  .workstations-pane {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 4px;
  }
  .account-col { background: var(--card-col-bg); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; min-width: 0; }
  .col-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid var(--line-subtle); }
  .col-title { font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; display: inline-flex; align-items: center; gap: 6px; }
  .col-title.claude { color: #d2a8ff; }
  .col-title.codex { color: #56d364; }
  .col-hint { font-size: 10.5px; color: var(--dim); font-weight: normal; }
  .account-list { display: flex; flex-direction: column; gap: 8px; }
  .client-keys-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(350px, 1fr)); gap: 12px; }
  @media (max-width: 600px) {
    .client-keys-list { grid-template-columns: 1fr; }
  }

  /* Master Key Banner */
  .master-key-banner {
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.09) 0%, rgba(37, 99, 235, 0.03) 100%);
    border: 1px solid rgba(59, 130, 246, 0.28);
    border-left: 3px solid #3b82f6;
    border-radius: 7px;
    padding: 9px 12px;
    margin-bottom: 8px;
    display: flex;
    flex-direction: column;
    gap: 5px;
    box-sizing: border-box;
  }
  .master-key-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .master-key-title { font-size: 12px; font-weight: 700; color: var(--heading); letter-spacing: -0.01em; }
  .master-key-sub { font-size: 10.5px; color: var(--dim); line-height: 1.35; }
  .master-key-bottom { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 2px; }
  .master-key-val { font-size: 11px; color: #93c5fd; font-weight: 500; }

  /* Workstation Card */
  .workstation-card {
    background: var(--card-bg);
    border: 1px solid var(--line);
    border-radius: 7px;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 7px;
    box-sizing: border-box;
    transition: border-color .15s ease, box-shadow .15s ease;
  }
  .workstation-card:hover { border-color: var(--card-hover-border); }
  .workstation-card.active-workstation { border-left: 3px solid #10b981; }
  .workstation-card.idle-workstation { border-left: 3px solid var(--line); }
  .workstation-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .workstation-identity { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; }
  .workstation-name { font-size: 13px; font-weight: 700; color: var(--heading); letter-spacing: -0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .workstation-badge-live { font-size: 10px; padding: 1px 6px; border-radius: 4px; background: rgba(16, 185, 129, 0.12); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.28); font-weight: 500; white-space: nowrap; }
  .workstation-badge-idle { font-size: 10px; padding: 1px 6px; border-radius: 4px; background: rgba(255, 255, 255, 0.05); color: var(--dim); border: 1px solid var(--line-subtle); font-weight: 400; white-space: nowrap; }
  .workstation-metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; background: rgba(255, 255, 255, 0.02); border: 1px solid var(--line-subtle); border-radius: 5px; padding: 6px 8px; }
  .ws-metric-item { display: flex; flex-direction: column; gap: 1px; }
  .ws-metric-label { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--dim); }
  .ws-metric-val { font-size: 12px; font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; }
  .workstation-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-top: 6px; border-top: 1px solid var(--line-subtle); font-size: 11px; }
  .workstation-key-box { display: flex; align-items: center; gap: 5px; }

  /* Back-compat client-key classes */
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
  .btn-rename, .btn-copy-name { background: transparent; border: none; padding: 2px 4px; font-size: 11px; cursor: pointer; opacity: 0.45; transition: opacity .15s ease, transform .15s ease; border-radius: 3px; line-height: 1; color: var(--dim); flex-shrink: 0; }
  .btn-rename:hover, .btn-copy-name:hover { opacity: 1; transform: scale(1.12); color: var(--accent); background: var(--line-subtle); }
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
      <p data-i18n="loginSubtitle">Wprowadź klucz administracyjny, aby zarządzać usługą.</p>
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
        <button class="btn btn-sm btn-outline" id="btnOpenFleetUsage" type="button" title="Podgląd kto i na co zużywa limity w całej flocie (zbiorczo)" data-i18n="btnFleetUsage" data-i18n-title="btnFleetUsageTitle" style="border-color:var(--accent); color:var(--accent);">📊 Kto i na co?</button>
        <button class="btn btn-sm btn-bad" id="btnRebootServer" title="Zrestartuj aplikację Agent-LB i wszystkie jej procesy (Reboot)" data-i18n="btnReboot" data-i18n-title="btnRebootTitle">⚡ Reboot</button>
        <button class="btn btn-sm" id="btnLogout" title="Wyloguj z panelu" data-i18n="btnLogout" data-i18n-title="btnLogoutTitle">🚪 Wyloguj</button>
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
    <!-- Main Navigation Tabs -->
    <nav class="main-nav-tabs" id="mainNavTabs">
      <button class="main-nav-tab active" id="tabBtnAccounts" data-tab="tabAccounts" type="button">
        <span class="main-nav-tab-icon">🤖</span>
        <span data-i18n="tabAccountsTitle">Konta & Flota</span>
        <span class="main-nav-badge" id="tabBadgeAccounts">0</span>
      </button>
      <button class="main-nav-tab" id="tabBtnWorkstations" data-tab="tabWorkstations" type="button">
        <span class="main-nav-tab-icon">💻</span>
        <span data-i18n="tabWorkstationsTitle">Stacje robocze & Narzędzia</span>
        <span class="main-nav-badge" id="tabBadgeWorkstations">0</span>
      </button>
    </nav>

    <!-- TAB 1: KONTA & FLOTA -->
    <div id="tabAccounts" class="tab-pane">
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
            <button id="btnSetDefaults" class="btn btn-sm" data-i18n="btnSetDefaults" data-i18n-title="btnSetDefaultsTitle" title="Przywróć optymalne ustawienia domyślne floty (Adaptive, Earliest-Reset, Fallback, Auto-Health)">✨ Ustaw domyślne</button>
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
      </div>

      <!-- AGY (Google Antigravity): accounts handed to agybridge on the stations -->
      <div class="agy-section" id="colAgy">
        <div class="col-head">
          <div class="row" style="gap:6px; align-items:center;">
            <span class="col-title agy" data-i18n="agyColTitle">🔷 AGY (Google Antigravity)</span>
            <span class="col-hint" id="countAgy">0</span>
          </div>
          <button class="btn btn-sm btn-accent" id="btnAgyLogin" style="padding:2px 8px; font-size:11px;" data-i18n="agyLoginBtn">🔑 Zaloguj konto Google</button>
        </div>
        <div class="agy-hint" data-i18n="agyHint">Stacje z agybridge używają konta z góry listy (albo przypiętego). Po wyczerpaniu limitu przechodzą automatycznie na następne.</div>
        <div id="listAgy" class="agy-list"></div>
      </div>
    </div>

    <!-- TAB 2: STACJE ROBOCZE & NARZĘDZIA -->
    <div id="tabWorkstations" class="tab-pane" style="display:none;">
      <div class="workstations-pane" id="colClients">
        <div class="sec-head" style="margin:0 0 8px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px;">
          <div class="row" style="gap:8px; align-items:center;">
            <h2 data-i18n="clientsHeading">Stacje robocze & Narzędzia</h2>
            <span class="col-hint" id="countClientKeys">0 stacji</span>
          </div>
          <div class="row" style="gap:6px;">
            <button class="btn btn-sm btn-accent" id="btnShowAddClientKey" style="padding:4px 10px; font-size:12px;" title="Podłącz nową stację roboczą lub agenta CLI" data-i18n="btnNewKey">➕ Podłącz stację</button>
            <button class="btn btn-sm" id="btnShowWorkstationGuide" style="padding:4px 9px; font-size:12px;" title="Przewodnik konfiguracji stacji (Linux, macOS, Windows)" data-i18n="btnWorkstationGuide">📖 Instrukcja</button>
            <button class="btn btn-sm" id="btnPullSetupRepo" style="padding:4px 8px; font-size:12px;" title="Pobierz najnowsze skrypty instalatora z GitHub (git pull)" data-i18n-title="btnUpdateTitle">🔄 Aktualizuj instalatory</button>
          </div>
        </div>

        <div class="card quick-station-box" style="margin-bottom:12px; background:rgba(83,177,253,0.05); border-color:rgba(83,177,253,0.22); padding:10px 14px; border-radius:8px;">
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; flex-wrap:wrap; gap:6px;">
            <div style="display:flex; align-items:center; gap:6px;">
              <span style="font-weight:600; font-size:12px; color:var(--heading);" data-i18n="quickConnectTitle">⚡ Szybkie podłączenie:</span>
              <select id="selQuickStation" style="font-size:11px; padding:2px 6px; background:var(--input-bg); border:1px solid var(--line); color:var(--heading); border-radius:4px; max-width:180px; cursor:pointer;" data-i18n-title="quickStationSelectTitle" title="Wybierz stację roboczą dla tego polecenia"></select>
            </div>
            <div style="display:flex; gap:4px;">
              <button class="btn btn-xs active" id="btnQuickTabBash" type="button" style="padding:2px 9px; font-size:11px;" data-i18n="quickTabBash" title="Skrypt instalacyjny Linux, macOS, WSL (Bash)">Linux / macOS / WSL</button>
              <button class="btn btn-xs" id="btnQuickTabPS" type="button" style="padding:2px 9px; font-size:11px;" data-i18n="quickTabPS" title="Skrypt instalacyjny Windows (PowerShell)">Windows</button>
            </div>
          </div>
          <div class="quick-cmd-wrap" style="display:flex; align-items:center; gap:8px; background:rgba(13,17,23,0.85); border:1px solid var(--line); border-radius:5px; padding:6px 10px;">
            <code id="quickCmdText" class="mono" style="flex:1; font-size:11.5px; color:#58a6ff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:pointer;" data-i18n-title="quickCmdClickCopy" title="Kliknij, aby skopiować pełną komendę"></code>
            <button class="btn btn-xs btn-accent" id="btnQuickCopyCmd" type="button" style="flex-shrink:0; padding:2px 10px; font-size:11px;" title="Kopiuj polecenie do schowka" data-i18n="copyCmd">📋 Kopiuj</button>
          </div>
          <div style="display:flex; align-items:center; justify-content:space-between; margin-top:6px; font-size:11px; color:var(--dim); flex-wrap:wrap; gap:6px;">
            <div style="display:flex; align-items:center; gap:12px;">
              <label style="display:inline-flex; align-items:center; gap:5px; cursor:pointer; user-select:none; color:var(--text);" title="Odznacz, jeśli chcesz uruchomić czystą komendę — instalator sam zapyta o wklejenie klucza">
                <input type="checkbox" id="chkIncludeKeyInCmd" checked style="margin:0; cursor:pointer;"> <span data-i18n="includeKey">Dołącz klucz stacji</span>
              </label>
              <span style="color:var(--dim); font-size:11px;">⚡ <b>All-in-One:</b> Claude Code + Codex + OpenCode / Hermes / Aider</span>
            </div>
            <a href="https://github.com/tomaasz/agent-lb" target="_blank" rel="noopener" style="color:var(--accent); text-decoration:none; font-size:11px;" data-i18n="githubGuide">instrukcja GitHub ↗</a>
          </div>
          <details style="margin-top:6px; font-size:11px; color:var(--dim);">
            <summary style="cursor:pointer; color:var(--dim); user-select:none;" data-i18n="quickToolOptional">Pojedyncze narzędzie lub eksport ENV (opcjonalnie)</summary>
            <div style="display:flex; align-items:center; gap:5px; margin-top:6px; flex-wrap:wrap;">
              <button class="btn btn-xs active" id="btnQuickToolAll" type="button" style="padding:2px 8px; font-size:11px;" data-i18n="quickToolAll" title="Wszystko naraz: Claude, Codex, OpenCode, Hermes (setup.sh / setup.ps1)">⚡ Wszystko (All-in-One)</button>
              <button class="btn btn-xs" id="btnQuickToolClaude" type="button" style="padding:2px 8px; font-size:11px;" title="Claude Code CLI & VS Code (claude-setup)">Claude</button>
              <button class="btn btn-xs" id="btnQuickToolCodex" type="button" style="padding:2px 8px; font-size:11px;" title="OpenAI Codex CLI & VS Code (codex-setup)">Codex</button>
              <button class="btn btn-xs" id="btnQuickToolHermes" type="button" style="padding:2px 8px; font-size:11px;" title="Hermes Agent">Hermes</button>
              <button class="btn btn-xs" id="btnQuickToolOpenCode" type="button" style="padding:2px 8px; font-size:11px;" title="OpenCode">OpenCode</button>
              <button class="btn btn-xs" id="btnQuickToolClaw" type="button" style="padding:2px 8px; font-size:11px;" title="Claw / OpenClaw">Claw</button>
              <button class="btn btn-xs" id="btnQuickToolOrca" type="button" style="padding:2px 8px; font-size:11px;" title="Orca ADE">Orca</button>
              <button class="btn btn-xs" id="btnQuickToolAgy" type="button" style="padding:2px 8px; font-size:11px;" title="AGY / Antigravity lokalnie przez agybridge (Hermes, OpenCode, OpenClaw, Claude MCP) — Linux / macOS / WSL">AGY</button>
              <button class="btn btn-xs" id="btnQuickToolAgent" type="button" style="padding:2px 8px; font-size:11px;" title="Zmienne środowiskowe OpenAI / Anthropic">ENV</button>
            </div>
          </details>
        </div>

        <div id="clientKeysTable" class="client-keys-list"></div>

        <div id="clientsWrap" style="display:none; margin-top:10px;">
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

  <!-- MODAL: ACCOUNT USAGE DETAILS (KTO I NA CO ZUŻYŁ LIMITY) -->
  <div id="modalAccountUsage" class="modal-backdrop" style="display:none;">
    <div class="modal-box" style="max-width:860px; width:95%; max-height:92vh; display:flex; flex-direction:column;">
      <div class="row" style="justify-content:space-between; align-items:center; margin-bottom:12px; padding-bottom:8px; border-bottom:1px solid var(--line);">
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="font-weight:700; font-size:16px;" data-i18n="modalAccountUsageTitle">📊 Szczegóły zużycia konta:</span>
          <span id="accountUsageNameBadge" class="badge mono" style="background:rgba(88,166,255,0.15); color:var(--accent); font-size:12px;"></span>
        </div>
        <button class="btn btn-sm" id="btnCloseAccountUsage" type="button" data-i18n="btnClose">✕ Zamknij</button>
      </div>

      <div id="accountUsageHeaderMeta" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(130px, 1fr)); gap:8px; margin-bottom:12px; background:var(--bg); padding:10px 12px; border-radius:6px; border:1px solid var(--line);">
        <div><div style="font-size:10.5px; color:var(--dim);" data-i18n="lblTotalTokens">Łącznie tokenów</div><div id="accountUsageTotalTok" style="font-size:14px; font-weight:700; color:var(--accent);">0</div></div>
        <div><div style="font-size:10.5px; color:var(--dim);" data-i18n="lblTotalReq">Liczba zapytań</div><div id="accountUsageTotalReq" style="font-size:14px; font-weight:700; color:var(--text);">0</div></div>
        <div><div style="font-size:10.5px; color:var(--dim);" data-i18n="lblSessionLimit">Limit Sesyjny</div><div id="accountUsageSessionPct" style="font-size:14px; font-weight:600;">—</div></div>
        <div><div style="font-size:10.5px; color:var(--dim);" data-i18n="lblWeeklyLimit">Limit Tygodniowy</div><div id="accountUsageWeeklyPct" style="font-size:14px; font-weight:600;">—</div></div>
        <div><div style="font-size:10.5px; color:var(--dim);" data-i18n="lblLastActivity">Ostatnia aktywność</div><div id="accountUsageLastUsed" style="font-size:12px; color:var(--dim);">—</div></div>
      </div>

      <div class="tabs-bar" style="margin-bottom:10px;">
        <button class="tab-btn active" type="button" id="tabBtnUsageClients" data-i18n="tabUsageClients">👤 Kto (Klienci / Stacje)</button>
        <button class="tab-btn" type="button" id="tabBtnUsageSessions" data-i18n="tabUsageSessions">🎯 Na co (Zadania / Sesje / Modele)</button>
        <button class="tab-btn" type="button" id="tabBtnUsageRecent" data-i18n="tabUsageRecent">📜 Ostatnie zapytania (Live feed)</button>
      </div>

      <div id="tabContentUsageClients" class="tab-content" style="flex:1; overflow-y:auto;">
        <div class="table-responsive" style="border:1px solid var(--line); border-radius:6px;">
          <table id="tblUsageClients" style="width:100%; border-collapse:collapse;"></table>
        </div>
      </div>

      <div id="tabContentUsageSessions" class="tab-content" style="flex:1; overflow-y:auto; display:none;">
        <div class="table-responsive" style="border:1px solid var(--line); border-radius:6px;">
          <table id="tblUsageSessions" style="width:100%; border-collapse:collapse;"></table>
        </div>
      </div>

      <div id="tabContentUsageRecent" class="tab-content" style="flex:1; overflow-y:auto; display:none;">
        <div class="table-responsive" style="border:1px solid var(--line); border-radius:6px;">
          <table id="tblUsageRecent" style="width:100%; border-collapse:collapse;"></table>
        </div>
      </div>

      <div style="display:flex; justify-content:space-between; align-items:center; margin-top:12px; padding-top:8px; border-top:1px solid var(--line);">
        <button class="btn btn-xs btn-bad" id="btnResetAccountUsage" type="button" data-i18n="btnResetAccountUsage" title="Zresetuj statystyki zużycia tego konta">🗑️ Zeruj liczniki tego konta</button>
        <span style="font-size:11px; color:var(--dim);" data-i18n="lblLiveDataAgentlb">Dane odświeżane na żywo z agentlb</span>
      </div>
    </div>
  </div>

  <!-- MODAL: FLEET USAGE OVERVIEW (ZBIORCZY PODGLĄD FLOTY) -->
  <div id="modalFleetUsage" class="modal-backdrop" style="display:none;">
    <div class="modal-box" style="max-width:920px; width:95%; max-height:92vh; display:flex; flex-direction:column;">
      <div class="row" style="justify-content:space-between; align-items:center; margin-bottom:12px; padding-bottom:8px; border-bottom:1px solid var(--line);">
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="font-weight:700; font-size:16px;" data-i18n="modalFleetUsageTitle">🌐 Zbiorczy raport zużycia floty: Kto i Na co</span>
          <span class="badge ok" style="font-size:11px;" data-i18n="badgeAllAccounts">Wszystkie konta</span>
        </div>
        <button class="btn btn-sm" id="btnCloseFleetUsage" type="button" data-i18n="btnClose">✕ Zamknij</button>
      </div>

      <div id="fleetUsageSummaryMeta" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(130px, 1fr)); gap:8px; margin-bottom:12px; background:var(--bg); padding:10px 12px; border-radius:6px; border:1px solid var(--line);">
        <div><div style="font-size:10.5px; color:var(--dim);" data-i18n="lblTotalFleetTokens">Łącznie tokenów floty</div><div id="fleetUsageTotalTok" style="font-size:14px; font-weight:700; color:var(--accent);">0</div></div>
        <div><div style="font-size:10.5px; color:var(--dim);" data-i18n="lblTotalFleetReq">Łącznie zapytań</div><div id="fleetUsageTotalReq" style="font-size:14px; font-weight:700; color:var(--text);">0</div></div>
        <div><div style="font-size:10.5px; color:var(--dim);" data-i18n="lblTotalFleetAccounts">Liczba kont</div><div id="fleetUsageTotalAccounts" style="font-size:14px; font-weight:600;">0</div></div>
        <div><div style="font-size:10.5px; color:var(--dim);" data-i18n="lblTotalFleetClients">Zidentyfikowani klienci</div><div id="fleetUsageTotalClients" style="font-size:14px; font-weight:600;">0</div></div>
      </div>

      <div class="tabs-bar" style="margin-bottom:10px;">
        <button class="tab-btn active" type="button" id="tabBtnFleetAccounts" data-i18n="tabFleetAccounts">🏦 Konta (Podział per konto)</button>
        <button class="tab-btn" type="button" id="tabBtnFleetClients" data-i18n="tabFleetClients">👤 Klienci (Kto ile zużył)</button>
        <button class="tab-btn" type="button" id="tabBtnFleetModels" data-i18n="tabFleetModels">🤖 Modele (Na jakie modele)</button>
      </div>

      <div id="tabContentFleetAccounts" class="tab-content" style="flex:1; overflow-y:auto;">
        <div class="table-responsive" style="border:1px solid var(--line); border-radius:6px;">
          <table id="tblFleetAccounts" style="width:100%; border-collapse:collapse;"></table>
        </div>
      </div>

      <div id="tabContentFleetClients" class="tab-content" style="flex:1; overflow-y:auto; display:none;">
        <div class="table-responsive" style="border:1px solid var(--line); border-radius:6px;">
          <table id="tblFleetClients" style="width:100%; border-collapse:collapse;"></table>
        </div>
      </div>

      <div id="tabContentFleetModels" class="tab-content" style="flex:1; overflow-y:auto; display:none;">
        <div class="table-responsive" style="border:1px solid var(--line); border-radius:6px;">
          <table id="tblFleetModels" style="width:100%; border-collapse:collapse;"></table>
        </div>
      </div>
    </div>
  </div>

  <!-- MODAL: TEST CHAT -->
  <div id="modalTestChat" class="modal-backdrop" style="display:none;">
    <div class="modal-box" style="max-width:700px; width:95%; display:flex; flex-direction:column; max-height:92vh;">
      <div class="row" style="justify-content:space-between; align-items:center; margin-bottom:12px; padding-bottom:8px; border-bottom:1px solid var(--line);">
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="font-weight:700; font-size:16px;" data-i18n="testChatTitle">💬 Test Chat — Claude & Codex Playground</span>
          <span class="badge" style="background:rgba(88,166,255,0.15); color:var(--accent); font-size:10.5px;" data-i18n="testChatBadge">Live Upstream Test</span>
        </div>
        <div style="display:flex; align-items:center; gap:6px;">
          <button class="btn btn-sm" id="btnTestChatHeaderCopy" data-i18n="btnTestChatHeaderCopy" data-i18n-title="btnTestChatHeaderCopyTitle" title="Skopiuj całą historię rozmowy do schowka">📋 Kopiuj czat</button>
          <button class="btn btn-sm" id="btnCloseTestChat" data-i18n="btnClose">✕ Zamknij</button>
        </div>
      </div>

      <!-- Controls row -->
      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:10px; margin-bottom:10px; background:rgba(13,17,23,0.6); padding:10px 12px; border:1px solid var(--line); border-radius:6px;">
        <div>
          <label for="selTestProvider" style="display:block; font-size:11px; font-weight:600; color:var(--dim); margin-bottom:4px;" data-i18n="lblTestProvider">Dostawca (Provider):</label>
          <select id="selTestProvider" class="btn btn-sm" style="width:100%; text-align:left; background:var(--bg); color:var(--text); border:1px solid var(--line); border-radius:4px; padding:4px 8px;">
            <option value="anthropic" data-i18n="provAnthropicOption">🟣 Claude (Anthropic)</option>
            <option value="codex" data-i18n="provCodexOption">🟢 Codex (ChatGPT / OpenAI)</option>
          </select>
        </div>
        <div>
          <label for="selTestModel" style="display:block; font-size:11px; font-weight:600; color:var(--dim); margin-bottom:4px;" data-i18n="lblTestModel">Model:</label>
          <select id="selTestModel" class="btn btn-sm" style="width:100%; text-align:left; background:var(--bg); color:var(--text); border:1px solid var(--line); border-radius:4px; padding:4px 8px;">
            <!-- populated dynamically according to provider -->
          </select>
        </div>
        <div id="colTestEffort" style="display:none;">
          <label for="selTestEffort" style="display:block; font-size:11px; font-weight:600; color:var(--dim); margin-bottom:4px;" data-i18n="lblTestEffort">Rozumowanie (Effort):</label>
          <select id="selTestEffort" class="btn btn-sm" style="width:100%; text-align:left; background:var(--bg); color:var(--text); border:1px solid var(--line); border-radius:4px; padding:4px 8px;">
            <option value="" data-i18n="optEffortDefault">⚡ Domyślne (Default)</option>
            <option value="minimal" data-i18n="optEffortMinimal">🟢 Minimalne (Minimal)</option>
            <option value="low" data-i18n="optEffortLow">🟢 Niskie (Low)</option>
            <option value="medium" selected data-i18n="optEffortMedium">🟡 Średnie (Medium)</option>
            <option value="high" data-i18n="optEffortHigh">🔴 Wysokie (High)</option>
            <option value="max" data-i18n="optEffortMax">🔥 Maksymalne (Max)</option>
          </select>
        </div>
        <div>
          <label for="selTestAccount" style="display:block; font-size:11px; font-weight:600; color:var(--dim); margin-bottom:4px;" data-i18n="lblTestAccount">Konto (Routing):</label>
          <select id="selTestAccount" class="btn btn-sm" style="width:100%; text-align:left; background:var(--bg); color:var(--text); border:1px solid var(--line); border-radius:4px; padding:4px 8px;">
            <option value="" data-i18n="optTestAccountAuto">⚡ Auto (Agent-LB Policy)</option>
            <!-- populated with account list -->
          </select>
        </div>
      </div>

      <!-- Quick prompts pills -->
      <div style="display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin-bottom:10px;">
        <span style="font-size:11px; color:var(--dim);" data-i18n="quickTestsLabel">Szybkie testy:</span>
        <button type="button" class="btn btn-xs quick-prompt-btn" data-prompt="Cześć! Przedstaw się w jednym zdaniu i potwierdź, że połączenie działa." style="border-radius:12px; font-size:10.5px; padding:2px 8px; background:rgba(88,166,255,0.1); border-color:rgba(88,166,255,0.3); color:#79c0ff;" data-i18n="quickPromptIntro">👋 Przedstaw się</button>
        <button type="button" class="btn btn-xs quick-prompt-btn" data-prompt="Odpowiedz jednym słowem: PONG" style="border-radius:12px; font-size:10.5px; padding:2px 8px; background:rgba(88,166,255,0.1); border-color:rgba(88,166,255,0.3); color:#79c0ff;" data-i18n="quickPromptPing">⚡ Ping</button>
        <button type="button" class="btn btn-xs quick-prompt-btn" data-prompt="Oblicz 256 * 64 i podaj sam wynik liczbowy." style="border-radius:12px; font-size:10.5px; padding:2px 8px; background:rgba(88,166,255,0.1); border-color:rgba(88,166,255,0.3); color:#79c0ff;">🧮 256 * 64</button>
        <button type="button" class="btn btn-xs quick-prompt-btn" data-prompt="Napisz zwięzłe dwuwersowe haiku o load balancerze Claude." style="border-radius:12px; font-size:10.5px; padding:2px 8px; background:rgba(88,166,255,0.1); border-color:rgba(88,166,255,0.3); color:#79c0ff;">📝 Haiku</button>
      </div>

      <!-- Chat History Box -->
      <div id="testChatHistory" style="flex:1; min-height:240px; max-height:380px; overflow-y:auto; background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:12px; margin-bottom:12px; display:flex; flex-direction:column; gap:12px;">
        <div id="testChatPlaceholder" style="margin:auto; text-align:center; color:var(--dim); font-size:12px;" data-i18n-html="testChatPlaceholder">
          <div style="font-size:26px; margin-bottom:6px;">💬</div>
          Wybierz dostawcę i model, a następnie wpisz wiadomość lub kliknij szybki test.<br>
          Żądanie zostanie wysłane przez silnik Agent-LB bezpośrednio do wybranego upstreamu.
        </div>
      </div>

      <!-- Chat Input and Actions -->
      <div style="display:flex; flex-direction:column; gap:8px;">
        <textarea id="testChatMessage" rows="2" placeholder="Wpisz treść wiadomości testowej (Enter wysyła, Shift+Enter nowa linia)..." data-i18n-placeholder="testChatMessagePlaceholder" style="width:100%; box-sizing:border-box; background:var(--bg); color:var(--text); border:1px solid var(--line); border-radius:6px; padding:8px 10px; font-family:inherit; font-size:12.5px; resize:vertical;"></textarea>
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
          <div style="display:flex; gap:6px; align-items:center;">
            <button class="btn btn-sm" id="btnTestChatCopy" type="button" style="font-size:11px; padding:4px 10px;" data-i18n="btnCopyChat" data-i18n-title="btnTestChatHeaderCopyTitle" title="Skopiuj całą historię rozmowy do schowka">📋 Kopiuj czat</button>
            <button class="btn btn-sm" id="btnTestChatClear" type="button" style="font-size:11px; padding:4px 10px;" data-i18n="btnTestChatClear" title="Wyczyść historię czatu">🗑️ Wyczyść historię</button>
          </div>
          <div style="display:flex; gap:8px; align-items:center;">
            <span id="testChatStatus" style="font-size:11.5px; color:var(--dim);"></span>
            <button class="btn btn-sm btn-accent" id="btnTestChatSend" type="button" style="font-weight:600; padding:5px 16px;" data-i18n="btnTestChatSend">Wyślij zapytanie 🚀</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- MODAL: ADD ACCOUNT -->
  <div id="modalAddAccount" class="modal-backdrop" style="display:none;">
    <div class="modal-box">
      <div class="row" style="justify-content:space-between; margin-bottom:12px;">
        <span id="modalAddAccountTitle" style="font-weight:600; font-size:15px;" data-i18n="modalAddAccountTitle">➕ Dodaj konto</span>
        <button class="btn btn-sm" id="btnCloseAddAccount" data-i18n="btnClose">✕ Zamknij</button>
      </div>
      <div style="margin-bottom:12px; display:flex; align-items:center; gap:14px; background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:8px 12px;">
        <span style="font-size:13px; color:var(--dim); font-weight:600;" data-i18n="lblProvider">Dostawca:</span>
        <label style="display:flex; align-items:center; gap:6px; cursor:pointer; font-size:13px;">
          <input type="radio" name="addAccountProvider" value="anthropic" checked id="radioProvAnthropic"> <span data-i18n="provAnthropicOption">🟣 Anthropic (Claude)</span>
        </label>
        <label style="display:flex; align-items:center; gap:6px; cursor:pointer; font-size:13px;">
          <input type="radio" name="addAccountProvider" value="codex" id="radioProvCodex"> <span data-i18n="provCodexOption">🟢 OpenAI (Codex / ChatGPT)</span>
        </label>
      </div>
      <div class="tabs-bar">
        <button class="tab-btn active" id="tabBtnApiKey" data-i18n="tabBtnApiKey">Klucz API Console</button>
        <button class="tab-btn" id="tabBtnOAuth" data-i18n="tabBtnOAuth">Wklej sesję OAuth</button>
        <button class="tab-btn" id="tabBtnImport" data-i18n="tabBtnImport">Import ze ścieżki</button>
        <button class="tab-btn" id="tabBtnBrowserOAuth" data-i18n="tabBtnBrowserOAuth">Logowanie w przeglądarce</button>
        <button class="tab-btn" id="tabBtnDeviceCode" style="display:none;" data-i18n="tabBtnDeviceCode">Kod urządzenia</button>
      </div>

      <!-- Tab 1: API Key -->
      <div id="tabContentApiKey" class="tab-content">
        <div class="form-grid">
          <div>
            <label id="lblApiKey" data-i18n="lblApiKeyAnthropic">Klucz API Anthropic Console (sk-ant-...) *</label>
            <input id="inApiKey" type="password" placeholder="sk-ant-api03-..." autocomplete="off">
          </div>
          <div class="form-row">
            <div style="flex:1;">
              <label data-i18n="lblAccountName">Nazwa konta (opcjonalnie)</label>
              <input id="inApiKeyName" type="text" placeholder="np. api-console-1">
            </div>
            <div style="width:110px;">
              <label data-i18n="lblPriority">Priorytet</label>
              <input id="inApiKeyPrio" type="number" value="0">
            </div>
          </div>
          <div style="margin-top:8px;">
            <button class="btn btn-accent" id="btnSubmitApiKey" data-i18n="btnSubmitApiKey">Dodaj konto API</button>
          </div>
        </div>
      </div>

      <!-- Tab 2: OAuth paste JSON/tokens -->
      <div id="tabContentOAuth" class="tab-content" style="display:none;">
        <div class="form-grid">
          <p id="pOAuthHelp" style="color:var(--dim); font-size:12px;" data-i18n-html="pOAuthHelp">
            Wklej zawartość pliku <code>~/.claude/.credentials.json</code> lub podaj tokeny z sesji OAuth:
          </p>
          <div>
            <label data-i18n="lblOAuthJson">Wklej cały JSON poświadczeń (.credentials.json)</label>
            <textarea id="inOAuthJson" rows="4" placeholder='{"claudeAiOauth":{"accessToken":"...","refreshToken":"...","expiresAt":...}}' class="mono"></textarea>
          </div>
          <div class="form-row">
            <div style="flex:1;">
              <label data-i18n="lblOAuthAccess">AccessToken (jeśli nie wklejasz JSON)</label>
              <input id="inOAuthAccess" type="password" placeholder="ey..." autocomplete="off">
            </div>
            <div style="flex:1;">
              <label data-i18n="lblOAuthRefresh">RefreshToken (opcjonalnie)</label>
              <input id="inOAuthRefresh" type="password" placeholder="ey..." autocomplete="off">
            </div>
          </div>
          <div class="form-row">
            <div style="flex:1;">
              <label data-i18n="lblAccountName">Nazwa konta (opcjonalnie)</label>
              <input id="inOAuthName" type="text" placeholder="np. dev@firma.pl">
            </div>
            <div style="width:110px;">
              <label data-i18n="lblPriority">Priorytet</label>
              <input id="inOAuthPrio" type="number" value="0">
            </div>
          </div>
          <div style="margin-top:8px;">
            <button class="btn btn-accent" id="btnSubmitOAuth" data-i18n="btnSubmitOAuth">Zapisz sesję OAuth</button>
          </div>
        </div>
      </div>

      <!-- Tab 3: Import from server file path -->
      <div id="tabContentImport" class="tab-content" style="display:none;">
        <div class="form-grid">
          <p style="color:var(--dim); font-size:12px;" data-i18n="pImportHelp">
            Wczytaj poświadczenia bezpośrednio z pliku na serwerze:
          </p>
          <div>
            <label data-i18n="lblImportPath">Ścieżka do pliku na serwerze *</label>
            <input id="inImportPath" type="text" value="~/.claude/.credentials.json" class="mono">
          </div>
          <div class="form-row">
            <div style="flex:1;">
              <label data-i18n="lblAccountName">Nazwa konta (opcjonalnie)</label>
              <input id="inImportPathName" type="text" placeholder="np. claude-local">
            </div>
            <div style="width:110px;">
              <label data-i18n="lblPriority">Priorytet</label>
              <input id="inImportPathPrio" type="number" value="0">
            </div>
          </div>
          <div style="margin-top:8px;">
            <button class="btn btn-accent" id="btnSubmitImportPath" data-i18n="btnSubmitImportPath">Importuj z pliku</button>
          </div>
        </div>
      </div>

      <!-- Tab 4: Browser OAuth -->
      <div id="tabContentBrowserOAuth" class="tab-content" style="display:none;">
        <div class="form-grid">
          <div id="oauthStep1">
            <p id="pBrowserOAuthHelp" style="color:var(--dim); font-size:12px; margin-bottom:10px;" data-i18n="pBrowserOAuthHelp">
              Zaloguj się na konto Claude w przeglądarce za pomocą bezpiecznego przepływu PKCE.
            </p>
            <button class="btn btn-accent" id="btnStartOAuth" data-i18n="btnStartOAuth">Rozpocznij logowanie Claude</button>
          </div>
          <div id="oauthStep2" style="display:none;">
            <p style="font-size:12px; margin-bottom:6px;" data-i18n-html="lblOAuthStep2Link">
              1. Jeśli okno logowania się nie otworzyło, <a id="oauthLink" href="#" target="_blank" style="color:var(--accent); text-decoration:underline;">kliknij tutaj ↗</a>.
            </p>
            <p id="pOAuthStep2Help" style="font-size:12px; color:var(--dim); margin-bottom:8px;" data-i18n="lblOAuthStep2Help">
              2. Zaloguj się w Claude.ai i skopiuj kod autoryzacyjny lub pełny adres URL:
            </p>
            <div>
              <label data-i18n="lblAuthCode">Kod autoryzacyjny lub callback URL *</label>
              <input id="inOAuthCode" type="text" placeholder="Wklej kod lub URL callback..." class="mono">
            </div>
            <div class="form-row" style="margin-top:8px;">
              <div style="flex:1;">
                <label data-i18n="lblAccountName">Nazwa konta (opcjonalnie)</label>
                <input id="inOAuthFlowName" type="text" placeholder="np. konto-osobiste">
              </div>
              <div style="width:110px;">
                <label data-i18n="lblPriority">Priorytet</label>
                <input id="inOAuthFlowPrio" type="number" value="0">
              </div>
            </div>
            <div class="row" style="gap:8px; margin-top:10px;">
              <button class="btn btn-accent" id="btnCompleteOAuth" data-i18n="btnCompleteOAuth">Dokończ autoryzację</button>
              <button class="btn" id="btnCancelOAuth" data-i18n="btnCancelOAuth">Wróć</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Tab 5: Device Code -->
      <div id="tabContentDeviceCode" class="tab-content" style="display:none;">
        <div class="form-grid">
          <div id="deviceCodeStep1">
            <p style="color:var(--dim); font-size:12px; margin-bottom:10px;" data-i18n="pDeviceCodeHelp">
              Zaloguj się na konto OpenAI Codex / ChatGPT za pomocą kodu urządzenia. Idealne dla serwerów i sesji SSH bez przeglądarki.
            </p>
            <button class="btn btn-accent" id="btnStartDeviceCode" data-i18n="btnStartDeviceCode">Rozpocznij logowanie kodem</button>
          </div>
          <div id="deviceCodeStep2" style="display:none;">
            <p style="font-size:13px; margin-bottom:8px;" data-i18n="lblDeviceCodeStep2Link">1. Otwórz ten link w przeglądarce na dowolnym urządzeniu:</p>
            <div style="background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:10px 14px; margin-bottom:12px;">
              <a id="deviceCodeUrl" href="#" target="_blank" style="color:var(--accent); text-decoration:underline; font-size:14px;"></a>
            </div>
            <p style="font-size:13px; margin-bottom:8px;" data-i18n="lblDeviceCodeStep2Code">2. Wpisz poniższy kod:</p>
            <div style="background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:14px 18px; margin-bottom:12px; text-align:center;">
              <span id="deviceCodeValue" style="font-family:var(--mono); font-size:28px; font-weight:700; letter-spacing:4px; color:var(--fg);"></span>
            </div>
            <div class="form-row" style="margin-top:8px;">
              <div style="flex:1;">
                <label data-i18n="lblAccountName">Nazwa konta (opcjonalnie)</label>
                <input id="inDeviceCodeName" type="text" placeholder="np. codex-server">
              </div>
              <div style="width:110px;">
                <label data-i18n="lblPriority">Priorytet</label>
                <input id="inDeviceCodePrio" type="number" value="0">
              </div>
            </div>
            <p id="deviceCodeStatus" style="font-size:12px; color:var(--dim); margin-top:10px;" data-i18n="pDeviceCodeStatus">⏳ Oczekiwanie na zatwierdzenie kodu...</p>
            <div class="row" style="gap:8px; margin-top:10px;">
              <button class="btn" id="btnCancelDeviceCode" data-i18n="btnCancelDeviceCode">Anuluj</button>
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
        <span style="font-weight:600; font-size:16px;"><span data-i18n="modalReloginTitle">🔐 Ponowne logowanie: </span><span id="reloginAccountTitle" class="mono" style="color:var(--accent);"></span></span>
        <button class="btn btn-sm" id="btnCloseReloginModal" data-i18n="btnClose">✕ Zamknij</button>
      </div>
      <p style="color:var(--dim); font-size:13px; margin-bottom:14px;" data-i18n="reloginDesc">
        Sesja tego konta wygasła lub token został odrzucony przez serwery Claude. Zaloguj się ponownie w Claude.ai, aby odnowić poświadczenia i natychmiast przywrócić konto do rotacji.
      </p>

      <div class="tabs-bar" style="margin-bottom:14px;">
        <button class="tab-btn active" id="tabBtnReloginBrowser" type="button" data-i18n="tabBtnReloginBrowser">🌐 Przeglądarka (OAuth)</button>
        <button class="tab-btn" id="tabBtnReloginJson" type="button" data-i18n="tabBtnReloginJson">📋 Wklej JSON / Token</button>
        <button class="tab-btn" id="tabBtnReloginImport" type="button" data-i18n="tabBtnReloginImport">📂 Plik na serwerze</button>
      </div>

      <!-- Tab 1: Browser OAuth -->
      <div id="tabContentReloginBrowser">
        <div id="reloginOAuthStep1">
          <div style="background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:12px 14px; margin-bottom:14px;">
            <div style="font-weight:600; font-size:13.5px; margin-bottom:4px;" data-i18n="reloginStep1Title">Krok 1: Otwórz stronę logowania Claude.ai</div>
            <div style="font-size:12.5px; color:var(--dim); line-height:1.4;" data-i18n="reloginStep1Desc">
              Kliknij poniższy przycisk. Otworzy się nowa karta z oficjalną stroną autoryzacji Claude.ai. Upewnij się, że logujesz się na właściwe konto (<b id="reloginStep1Email" style="color:var(--text);"></b>).
            </div>
          </div>
          <button class="btn btn-accent" id="btnStartReloginOAuth" style="width:100%; justify-content:center; padding:10px 14px; font-weight:600;" data-i18n="btnStartReloginOAuth">
            🌐 Otwórz logowanie Claude.ai w nowej karcie
          </button>
        </div>

        <div id="reloginOAuthStep2" style="display:none;">
          <div style="background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:12px 14px; margin-bottom:12px;">
            <div style="font-weight:600; font-size:13px; margin-bottom:4px;" data-i18n="reloginStep2Title">Krok 2: Skopiuj i wklej kod autoryzacyjny</div>
            <div style="font-size:12.5px; color:var(--dim); line-height:1.4;" data-i18n="reloginStep2Desc">
              Po zalogowaniu i zatwierdzeniu w Claude.ai, skopiuj wyświetlony kod autoryzacyjny (lub cały adres URL callback z paska adresu) i wklej poniżej:
            </div>
            <div style="font-size:12px; margin-top:6px;">
              <span style="color:var(--dim);">Okno logowania się nie otworzyło? </span>
              <a id="reloginOAuthLink" href="#" target="_blank" rel="noopener" style="color:var(--accent); text-decoration:underline;">Kliknij tutaj, aby otworzyć ↗</a>
            </div>
          </div>

          <div style="margin-bottom:12px;">
            <label style="font-size:12px; color:var(--dim); display:block; margin-bottom:4px;" data-i18n="lblAuthCode">Kod autoryzacyjny lub callback URL *</label>
            <input id="inReloginOAuthCode" type="text" placeholder="Wklej kod lub URL callback (https://claude.ai/oauth/callback?code=...)" class="mono" style="width:100%;">
          </div>

          <div class="row" style="gap:8px;">
            <button class="btn btn-accent" id="btnCompleteReloginOAuth" data-i18n="btnCompleteReloginOAuth">✅ Odnów sesję i zaloguj</button>
            <button class="btn" id="btnRestartReloginOAuth" data-i18n="btnRestartReloginOAuth">↺ Uruchom ponownie logowanie</button>
          </div>
        </div>
      </div>

      <!-- Tab 2: Paste JSON -->
      <div id="tabContentReloginJson" style="display:none;">
        <div style="font-size:12.5px; color:var(--dim); margin-bottom:8px;" data-i18n-html="reloginJsonHelp">
          Wklej zawartość pliku <code>~/.claude/.credentials.json</code> lub JSON z tokenami sesji OAuth:
        </div>
        <textarea id="inReloginJson" rows="4" placeholder='{"claudeAiOauth":{"accessToken":"...","refreshToken":"..."}}' class="mono" style="width:100%; margin-bottom:10px;"></textarea>
        <button class="btn btn-accent" id="btnSubmitReloginJson" data-i18n="btnSubmitReloginJson">Zapisz poświadczenia</button>
      </div>

      <!-- Tab 3: Import from file -->
      <div id="tabContentReloginImport" style="display:none;">
        <div style="font-size:12.5px; color:var(--dim); margin-bottom:8px;" data-i18n-html="reloginImportHelp">
          Wczytaj nowe poświadczenia z pliku zapisanego na serwerze (np. po <code>claude login</code> w konsoli):
        </div>
        <div style="margin-bottom:10px;">
          <label style="font-size:12px; color:var(--dim); display:block; margin-bottom:4px;" data-i18n="lblImportPath">Ścieżka do pliku *</label>
          <input id="inReloginImportPath" type="text" value="~/.claude/.credentials.json" class="mono" style="width:100%;">
        </div>
        <button class="btn btn-accent" id="btnSubmitReloginImport" data-i18n="btnSubmitReloginImport">Importuj z pliku</button>
      </div>
    </div>
  </div>

  <!-- MODAL: ADD CLIENT KEY -->
  <div id="modalAgyLogin" class="modal-backdrop" style="display:none;">
    <div class="modal-box" style="max-width:620px;">
      <div class="row" style="justify-content:space-between; margin-bottom:12px;">
        <span style="font-weight:600; font-size:15px;" data-i18n="agyModalTitle">🔑 Logowanie konta Google do AGY</span>
        <button class="btn btn-sm" id="btnCloseAgyLogin" data-i18n="btnClose">✕ Zamknij</button>
      </div>
      <div id="agyLoginWait" style="font-size:13px; color:var(--dim);" data-i18n="agyPreparing">Przygotowuję link logowania…</div>
      <div id="agyLoginStep" style="display:none;">
        <ol class="agy-steps">
          <li><span data-i18n="agyStep1">Otwórz link i wybierz konto Google:</span>
            <div style="margin-top:6px;"><a id="agyLoginLink" class="btn btn-sm btn-accent" href="#" target="_blank" rel="noopener noreferrer" data-i18n="agyOpenLink">↗ Otwórz logowanie Google</a></div></li>
          <li data-i18n="agyStep2">Po zgodzie strona antigravity.google pokaże kod — skopiuj go.</li>
          <li><span data-i18n="agyStep3">Wklej kod tutaj:</span>
            <div class="row" style="gap:6px; margin-top:6px;">
              <input id="agyLoginCode" type="text" autocomplete="off" spellcheck="false" style="flex:1;" placeholder="4/0A…">
              <button class="btn btn-accent" id="btnAgySubmitCode" data-i18n="agySubmit">Zaloguj</button>
            </div></li>
        </ol>
        <div class="agy-countdown"><span data-i18n="agyTimeLeft">Pozostało:</span> <b id="agyLoginCountdown">60</b> s</div>
      </div>
      <div id="agyLoginResult" style="display:none; margin-top:10px; font-size:13px;"></div>
      <div id="agyLoginRetry" style="display:none; margin-top:10px;">
        <button class="btn btn-sm" id="btnAgyNewLink" data-i18n="agyNewLink">🔄 Nowy link</button>
      </div>
    </div>
  </div>

  <div id="modalAddClientKey" class="modal-backdrop" style="display:none;">
    <div class="modal-box">
      <div class="row" style="justify-content:space-between; margin-bottom:12px;">
        <span style="font-weight:600; font-size:15px;" data-i18n="modalAddClientKeyTitle">➕ Podłącz nową stację roboczą</span>
        <button class="btn btn-sm" id="btnCloseAddClientKey" data-i18n="btnClose">✕ Zamknij</button>
      </div>
      <div class="form-grid">
        <p style="color:var(--dim); font-size:12px;" data-i18n="modalAddClientKeyDesc">
          Wygeneruj dedykowany klucz dostępu dla komputera, laptopa lub agenta CLI. Po utworzeniu od razu otrzymasz gotową komendę do wklejenia w terminalu.
        </p>
        <div>
          <label data-i18n="lblClientName">Nazwa stacji roboczej / urządzenia *</label>
          <input id="inClientName" type="text" placeholder="np. Laptop Tomek, PC Biuro, CI Worker" required>
        </div>
        <div>
          <label data-i18n="lblClientCustomKey">Własny klucz (opcjonalnie)</label>
          <input id="inClientCustomKey" type="text" placeholder="Pozostaw puste dla losowego tc-..." class="mono">
        </div>
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
          <div>
            <label data-i18n="lblClientDailyTokens">Dzienny limit tokenów (opcjonalnie)</label>
            <input id="inClientDailyTokens" type="number" min="1" placeholder="np. 500000 (puste = bez limitu)">
          </div>
          <div>
            <label data-i18n="lblClientMonthlyTokens">Miesięczny limit tokenów (opcjonalnie)</label>
            <input id="inClientMonthlyTokens" type="number" min="1" placeholder="np. 10000000 (puste = bez limitu)">
          </div>
        </div>
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
          <div>
            <label data-i18n="lblClientExpiresAt">Ważny do (data wygaśnięcia, opcjonalnie)</label>
            <input id="inClientExpiresAt" type="date">
          </div>
          <div>
            <label data-i18n="lblClientAllowedModels">Dozwolone modele (opcjonalnie)</label>
            <input id="inClientAllowedModels" type="text" placeholder="np. claude-*, gpt-4o">
          </div>
        </div>
        <div style="margin-top:8px;">
          <button class="btn btn-accent" id="btnSubmitClientKey" data-i18n="btnSubmitClientKey">Utwórz klucz</button>
        </div>
      </div>
    </div>
  </div>

  <!-- MODAL: CLIENT KEY SETUP & CONNECT -->
  <div id="modalKeyCreated" class="modal-backdrop" style="display:none;">
    <div class="modal-box" style="max-width:700px;">
      <div class="row" style="justify-content:space-between; margin-bottom:12px;">
        <span style="font-weight:600; color:var(--ok); font-size:16px;" data-i18n="modalKeyCreatedTitle">💻 Konfiguracja stacji roboczej</span>
        <button class="btn btn-sm" id="btnCloseKeyModal" data-i18n="btnClose">✕ Zamknij</button>
      </div>

      <div style="background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:12px 14px; margin-bottom:14px;">
        <div class="row" style="justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
          <div style="flex:1; min-width:260px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px; flex-wrap:wrap;">
              <span style="color:var(--dim); font-size:12px; font-weight:600;" data-i18n="lblStationWorkstation">Stacja robocza:</span>
              <select id="selModalStation" style="font-size:12.5px; font-weight:600; padding:3px 8px; background:var(--input-bg); border:1px solid var(--line); color:var(--heading); border-radius:5px; cursor:pointer;" title="Wybierz stację roboczą"></select>
              <b id="createdClientName" style="display:none;"></b>
            </div>
            <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
              <span style="color:var(--dim); font-size:11px;" data-i18n="lblStationKey">Klucz stacji:</span>
              <code class="mono" id="createdClientKey" style="font-size:12.5px; word-break:break-all; color:var(--accent); font-weight:600;"></code>
            </div>
          </div>
          <button class="btn btn-sm btn-accent" id="btnCopyCreatedKey" data-i18n="btnCopyCreatedKey">📋 Kopiuj klucz</button>
        </div>
      </div>

      <div style="margin-bottom:10px;">
        <div class="tabs-bar" style="margin-bottom:12px;">
          <button class="tab-btn active" id="tabSetupBash" type="button" data-i18n="tabSetupBash">🐧 Linux / macOS / WSL</button>
          <button class="tab-btn" id="tabSetupPowershell" type="button" data-i18n="tabSetupPowershell">🪟 Windows (PowerShell)</button>
        </div>

        <!-- TAB 1: LINUX / MACOS / WSL -->
        <div id="contentSetupBash">
          <div style="background:rgba(88,166,255,0.08); border:1px solid rgba(88,166,255,0.3); border-radius:8px; padding:12px 14px; margin-bottom:12px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; flex-wrap:wrap; gap:6px;">
              <span style="font-size:13px; font-weight:700; color:#58a6ff;" data-i18n="setupBashAllInOneTitle">🚀 Jedno polecenie konfiguruje całe środowisko (All-in-One):</span>
              <button class="btn btn-sm btn-accent" id="btnCopySetupBashMain" data-i18n="btnCopyCmd">📋 Kopiuj polecenie</button>
            </div>
            <div style="background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:10px 12px; margin-bottom:10px;">
              <code class="mono" id="cmdSetupBashMain" style="display:block; word-break:break-all; font-size:12.5px; color:#e6edf3; font-weight:600;"></code>
            </div>
            <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap:6px; font-size:11.5px; color:var(--dim);">
              <div><span style="color:var(--ok); font-weight:600;">✔ Claude Code</span> (CLI + VS Code + OAuth)</div>
              <div><span style="color:var(--ok); font-weight:600;">✔ OpenAI Codex</span> (CLI + config.toml + VS Code)</div>
              <div><span style="color:var(--ok); font-weight:600;">✔ OpenCode &amp; Hermes</span> (~/.config/agent-lb.env)</div>
              <div><span style="color:var(--ok); font-weight:600;">✔ Aider, Claw, Orca</span> (.bashrc / .zshrc)</div>
            </div>
          </div>

          <details style="border:1px solid var(--line); border-radius:6px; padding:8px 12px; background:rgba(255,255,255,0.01); margin-bottom:6px;">
            <summary style="cursor:pointer; font-size:12px; font-weight:600; color:var(--dim); user-select:none;" data-i18n="setupAdvancedSummary">
              ⚙️ Zaawansowane: rozdzielne polecenia, zmienne ENV oraz konfiguracja ręczna
            </summary>
            <div style="margin-top:10px; display:flex; flex-direction:column; gap:12px;">
              <div>
                <div style="font-size:12px; font-weight:600; color:var(--heading); margin-bottom:4px;" data-i18n="lblBashClaudeOnly">1. Tylko Claude Code CLI &amp; VS Code:</div>
                <div style="background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:8px 12px; margin-bottom:6px;">
                  <code class="mono" id="cmdSetupBash" style="display:block; word-break:break-all; font-size:12px; color:#e6edf3;"></code>
                </div>
                <button class="btn btn-xs btn-accent" id="btnCopySetupBash" data-i18n="btnCopySetupBash">📋 Kopiuj polecenie Claude</button>
              </div>

              <div>
                <div style="font-size:12px; font-weight:600; color:var(--heading); margin-bottom:4px;" data-i18n="lblBashCodexOnly">2. Tylko OpenAI Codex CLI &amp; VS Code:</div>
                <div style="background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:8px 12px; margin-bottom:6px;">
                  <code class="mono" id="cmdSetupCodexBash" style="display:block; word-break:break-all; font-size:12px; color:#e6edf3;"></code>
                </div>
                <button class="btn btn-xs btn-accent" id="btnCopySetupCodexBash" data-i18n="btnCopySetupCodexBash">📋 Kopiuj polecenie Codex</button>
              </div>

              <div>
                <div style="font-size:12px; font-weight:600; color:var(--heading); margin-bottom:4px;" data-i18n="lblBashAgentOnly">3. Zmienne powłoki (export ENV dla OpenCode / Hermes):</div>
                <div style="background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:8px 12px; margin-bottom:6px;">
                  <pre class="mono" id="cmdSetupAgentBash" style="margin:0; font-size:11.5px; color:#e6edf3; overflow-x:auto; white-space:pre-wrap;"></pre>
                </div>
                <button class="btn btn-xs btn-accent" id="btnCopySetupAgentBash" data-i18n="btnCopySetupAgentBash">📋 Kopiuj zmienne powłoki</button>
              </div>

              <div>
                <div style="font-size:12px; font-weight:600; color:var(--heading); margin-bottom:4px;" data-i18n="lblBashManualOnly">4. Ręczna konfiguracja JSON / env:</div>
                <div class="row" style="gap:8px; margin-bottom:6px;">
                  <button class="btn btn-xs" id="btnCopyShellEnv" data-i18n="btnCopyShellEnv">📋 Kopiuj export ENV</button>
                  <button class="btn btn-xs" id="btnCopyVSCode" data-i18n="btnCopyVSCode">📋 Kopiuj VS Code JSON</button>
                </div>
                <div style="background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:8px 12px;">
                  <pre class="mono" id="boxManualConfig" style="margin:0; font-size:11.5px; color:#e6edf3; overflow-x:auto;"></pre>
                </div>
              </div>
            </div>
          </details>
        </div>

        <!-- TAB 2: WINDOWS (POWERSHELL) -->
        <div id="contentSetupPowershell" style="display:none;">
          <div style="background:rgba(88,166,255,0.08); border:1px solid rgba(88,166,255,0.3); border-radius:8px; padding:12px 14px; margin-bottom:12px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; flex-wrap:wrap; gap:6px;">
              <span style="font-size:13px; font-weight:700; color:#58a6ff;" data-i18n="setupPowershellAllInOneTitle">🚀 Jedno polecenie konfiguruje całe środowisko Windows (All-in-One):</span>
              <button class="btn btn-sm btn-accent" id="btnCopySetupPowershellMain" data-i18n="btnCopyCmd">📋 Kopiuj polecenie</button>
            </div>
            <div style="background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:10px 12px; margin-bottom:10px;">
              <code class="mono" id="cmdSetupPowershellMain" style="display:block; word-break:break-all; font-size:12.5px; color:#e6edf3; font-weight:600;"></code>
            </div>
            <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap:6px; font-size:11.5px; color:var(--dim);">
              <div><span style="color:var(--ok); font-weight:600;">✔ Claude Code</span> (CLI + VS Code + OAuth)</div>
              <div><span style="color:var(--ok); font-weight:600;">✔ OpenAI Codex</span> (CLI + config.toml + VS Code)</div>
              <div><span style="color:var(--ok); font-weight:600;">✔ Zmienne Windows User</span> (OpenCode, Hermes, Aider)</div>
              <div><span style="color:var(--ok); font-weight:600;">✔ Trwałe w rejestrze</span> (nie znika po restarcie)</div>
            </div>
          </div>

          <details style="border:1px solid var(--line); border-radius:6px; padding:8px 12px; background:rgba(255,255,255,0.01); margin-bottom:6px;">
            <summary style="cursor:pointer; font-size:12px; font-weight:600; color:var(--dim); user-select:none;" data-i18n="setupAdvancedPSSummary">
              ⚙️ Zaawansowane: rozdzielne polecenia Windows i zmienne sesyjne
            </summary>
            <div style="margin-top:10px; display:flex; flex-direction:column; gap:12px;">
              <div>
                <div style="font-size:12px; font-weight:600; color:var(--heading); margin-bottom:4px;" data-i18n="lblPSClaudeOnly">1. Tylko Claude Code na Windows (PowerShell):</div>
                <div style="background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:8px 12px; margin-bottom:6px;">
                  <code class="mono" id="cmdSetupPowershell" style="display:block; word-break:break-all; font-size:12px; color:#e6edf3;"></code>
                </div>
                <button class="btn btn-xs btn-accent" id="btnCopySetupPowershell" data-i18n="btnCopySetupPowershell">📋 Kopiuj polecenie Claude (PS)</button>
              </div>

              <div>
                <div style="font-size:12px; font-weight:600; color:var(--heading); margin-bottom:4px;" data-i18n="lblPSCodexOnly">2. Tylko OpenAI Codex na Windows (PowerShell):</div>
                <div style="background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:8px 12px; margin-bottom:6px;">
                  <code class="mono" id="cmdSetupCodexPowershell" style="display:block; word-break:break-all; font-size:12px; color:#e6edf3;"></code>
                </div>
                <button class="btn btn-xs btn-accent" id="btnCopySetupCodexPowershell" data-i18n="btnCopySetupCodexPowershell">📋 Kopiuj polecenie Codex (PS)</button>
              </div>

              <div>
                <div style="font-size:12px; font-weight:600; color:var(--heading); margin-bottom:4px;" data-i18n="lblPSAgentOnly">3. Zmienne sesyjne PowerShell:</div>
                <div style="background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:8px 12px; margin-bottom:6px;">
                  <pre class="mono" id="cmdSetupAgentPowershell" style="margin:0; font-size:11.5px; color:#e6edf3; overflow-x:auto; white-space:pre-wrap;"></pre>
                </div>
                <button class="btn btn-xs btn-accent" id="btnCopySetupAgentPowershell" data-i18n="btnCopySetupAgentPowershell">📋 Kopiuj polecenie PowerShell</button>
              </div>
            </div>
          </details>
        </div>
      </div>

      <div class="row" style="justify-content:space-between; align-items:center; margin-top:16px; border-top:1px solid var(--line); padding-top:12px;">
        <span style="font-size:12px; color:var(--dim);"><span data-i18n="lblRepoLink">Repozytorium:</span> <a href="https://github.com/tomaasz/agent-lb" target="_blank" rel="noopener" style="color:var(--accent);">tomaasz/agent-lb ↗</a></span>
        <button class="btn" id="btnDoneKeyModal" data-i18n="btnDoneKeyModal">Zamknij</button>
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
      loginSubtitle: 'Wprowadź klucz administracyjny, aby zarządzać usługą.',
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
      btnReboot: '⚡ Reboot',
      btnRebootTitle: 'Zrestartuj aplikację Agent-LB i wszystkie procesy proxy',
      rebootConfirm: 'Czy na pewno chcesz zrestartować aplikację Agent-LB i wszystkie jej procesy?',
      rebootInitiated: 'Inicjalizacja restartu... Ponowne łączenie z serwerem...',
      rebootSuccess: 'Serwer Agent-LB został pomyślnie zrestartowany.',
      btnLogout: '🚪 Wyloguj',
      btnLogoutTitle: 'Wyloguj z panelu',
      routesHeading: 'Routing',
      policyTitle: 'Polityka routingu i działania floty',
      policySubtitle: 'Inteligentny podział obciążenia, pamięć podręczna promptów i odporność na limity API.',
      btnPolicyHelp: 'ℹ️ Wyjaśnienia',
      btnPolicyHelpCompact: '⚡ Zwiń opisy',
      btnSetDefaults: '✨ Ustaw domyślne',
      btnSetDefaultsTitle: 'Przywróć optymalne ustawienia domyślne floty (Adaptive, Earliest-Reset, Fallback, Auto-Health)',
      msgFleetDefaultsRestored: 'Przywrócono optymalne ustawienia domyślne floty',
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
      tabAccountsTitle: 'Konta & Flota',
      tabWorkstationsTitle: 'Stacje robocze & Narzędzia',
      accountsHeading: 'Konta Claude & Codex',
      accountsHint: '💡 Przeciągnij kartę ⠿ w kolumnie, aby zmienić priorytet',
      clientsHeading: 'Stacje robocze & Narzędzia',
      colClaudeTitle: '🟣 Claude (Anthropic)',
      colCodexTitle: '🟢 OpenAI Codex',
      colClientsTitle: '💻 Stacje robocze',
      agyColTitle: '🔷 AGY (Google Antigravity)',
      agyLoginBtn: '🔑 Zaloguj konto Google',
      agyHint: 'Stacje z agybridge używają konta z góry listy (albo przypiętego). Po wyczerpaniu limitu przechodzą automatycznie na następne.',
      agyModalTitle: '🔑 Logowanie konta Google do AGY',
      agyPreparing: 'Przygotowuję link logowania…',
      agyStep1: 'Otwórz link i wybierz konto Google:',
      agyOpenLink: '↗ Otwórz logowanie Google',
      agyStep2: 'Po zgodzie strona antigravity.google pokaże kod — skopiuj go.',
      agyStep3: 'Wklej kod tutaj:',
      agySubmit: 'Zaloguj',
      agyTimeLeft: 'Pozostało:',
      agyNewLink: '🔄 Nowy link',
      btnAddAccount: '➕ Dodaj konto',
      btnNewKey: '➕ Podłącz stację',
      btnNewKeyTitle: 'Podłącz nową stację roboczą lub agenta CLI',
      btnWorkstationGuide: '📖 Instrukcja',
      btnWorkstationGuideTitle: 'Przewodnik konfiguracji terminala (Linux, macOS, Windows)',
      btnUpdate: '🔄 Aktualizuj skrypty',
      btnUpdateTitle: 'Pobierz najnowsze skrypty instalatora z GitHub (git pull)',
      quickConnectTitle: '⚡ Szybkie podłączenie:',
      copyCmd: '📋 Kopiuj',
      includeKey: 'Dołącz klucz stacji',
      githubGuide: 'instrukcja GitHub ↗',
      countAccounts: '{n} kont',
      countAccountsSingle: '1 konto',
      countKeys: '{n} stacji',
      countKeysSingle: '1 stacja',
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
      btnCopyName: 'Kopiuj pełną nazwę konta do schowka',
      prioBadgeTopTitle: 'Pozycja #1 — główne konto obsługujące zapytania w pierwszej kolejności',
      prioBadgeOtherTitle: 'Pozycja #{rank} — konto zapasowe w kolejce (kliknij „▲ Na górę” lub przeciągnij ⠿, aby zmienić)',
      dragHandleTitle: 'Przeciągnij myszką, aby zmienić priorytet w kolumnie',
      summaryActiveAccount: 'aktywne konto ',
      summaryNone: 'brak',
      summarySessions: ' · {active} aktywnych / {known} znanych sesji',
      summaryRefreshes: 'odświeżanie co {sec}s · {time}',
      emptyNoAccountsClaude: 'Brak kont Claude. Kliknij „➕ Dodaj konto” u góry.',
      emptyNoAccountsCodex: 'Brak kont OpenAI Codex. Kliknij „➕ Dodaj konto” u góry.',
      emptyNoKeys: 'Brak skonfigurowanych stacji roboczych. Kliknij „➕ Podłącz stację”, aby dodać swój komputer.',
      primaryAdminKeyName: 'Klucz Master Administratora',
      btnKeyConnect: '💻 Setup',
      keyShow: 'Pokaż',
      keyHide: 'Ukryj',
      btnFleetUsage: '📊 Kto i na co?',
      btnFleetUsageTitle: 'Podgląd kto i na co zużywa limity w całej flocie (zbiorczo)',
      quickStationSelectTitle: 'Wybierz stację roboczą dla tego polecenia',
      quickCmdClickCopy: 'Kliknij, aby skopiować pełną komendę',
      quickToolOptional: 'Pojedyncze narzędzie lub eksport ENV (opcjonalnie)',
      quickToolAll: '⚡ Wszystko (All-in-One)',
      quickTabBash: 'Linux / macOS / WSL',
      quickTabPS: 'Windows',
      modalAddAccountTitle: '➕ Dodaj konto',
      btnClose: '✕ Zamknij',
      lblProvider: 'Dostawca:',
      provAnthropicOption: '🟣 Anthropic (Claude)',
      provCodexOption: '🟢 OpenAI (Codex / ChatGPT)',
      tabBtnApiKey: 'Klucz API Console',
      tabBtnOAuth: 'Wklej sesję OAuth',
      tabBtnImport: 'Import ze ścieżki',
      tabBtnBrowserOAuth: 'Logowanie w przeglądarce',
      tabBtnDeviceCode: 'Kod urządzenia',
      lblApiKeyAnthropic: 'Klucz API Anthropic Console (sk-ant-...) *',
      lblApiKeyCodex: 'Klucz API OpenAI Platform (sk-proj-...) *',
      lblAccountName: 'Nazwa konta (opcjonalnie)',
      lblPriority: 'Priorytet',
      btnSubmitApiKey: 'Dodaj konto API',
      pOAuthHelp: 'Wklej zawartość pliku <code>~/.claude/.credentials.json</code> lub podaj tokeny z sesji OAuth:',
      lblOAuthJson: 'Wklej cały JSON poświadczeń (.credentials.json)',
      lblOAuthAccess: 'AccessToken (jeśli nie wklejasz JSON)',
      lblOAuthRefresh: 'RefreshToken (opcjonalnie)',
      btnSubmitOAuth: 'Zapisz sesję OAuth',
      pImportHelp: 'Wczytaj poświadczenia bezpośrednio z pliku na serwerze:',
      lblImportPath: 'Ścieżka do pliku na serwerze *',
      btnSubmitImportPath: 'Importuj z pliku',
      pBrowserOAuthHelp: 'Zaloguj się na konto Claude w przeglądarce za pomocą bezpiecznego przepływu PKCE.',
      btnStartOAuth: 'Rozpocznij logowanie Claude',
      lblOAuthStep2Link: '1. Jeśli okno logowania się nie otworzyło, <a id="oauthLink" href="#" target="_blank" style="color:var(--accent); text-decoration:underline;">kliknij tutaj ↗</a>.',
      lblOAuthStep2Help: '2. Zaloguj się w Claude.ai i skopiuj kod autoryzacyjny lub pełny adres URL:',
      lblAuthCode: 'Kod autoryzacyjny lub callback URL *',
      btnCompleteOAuth: 'Dokończ autoryzację',
      btnCancelOAuth: 'Wróć',
      pDeviceCodeHelp: 'Zaloguj się na konto OpenAI Codex / ChatGPT za pomocą kodu urządzenia. Idealne dla serwerów i sesji SSH bez przeglądarki.',
      btnStartDeviceCode: 'Rozpocznij logowanie kodem',
      lblDeviceCodeStep2Link: '1. Otwórz ten link w przeglądarce na dowolnym urządzeniu:',
      lblDeviceCodeStep2Code: '2. Wpisz poniższy kod:',
      pDeviceCodeStatus: '⏳ Oczekiwanie na zatwierdzenie kodu...',
      btnCancelDeviceCode: 'Anuluj',
      modalReloginTitle: '🔐 Ponowne logowanie: ',
      reloginDesc: 'Sesja tego konta wygasła lub token został odrzucony przez serwery Claude. Zaloguj się ponownie w Claude.ai, aby odnowić poświadczenia i natychmiast przywrócić konto do rotacji.',
      tabBtnReloginBrowser: '🌐 Przeglądarka (OAuth)',
      tabBtnReloginJson: '📋 Wklej JSON / Token',
      tabBtnReloginImport: '📂 Plik na serwerze',
      reloginStep1Title: 'Krok 1: Otwórz stronę logowania Claude.ai',
      reloginStep1Desc: 'Kliknij poniższy przycisk. Otworzy się nowa karta z oficjalną stroną autoryzacji Claude.ai. Upewnij się, że logujesz się na właściwe konto.',
      btnStartReloginOAuth: '🌐 Otwórz logowanie Claude.ai w nowej karcie',
      reloginStep2Title: 'Krok 2: Skopiuj i wklej kod autoryzacyjny',
      reloginStep2Desc: 'Po zalogowaniu i zatwierdzeniu w Claude.ai, skopiuj wyświetlony kod autoryzacyjny (lub cały adres URL callback z paska adresu) i wklej poniżej:',
      btnCompleteReloginOAuth: '✅ Odnów sesję i zaloguj',
      btnRestartReloginOAuth: '↺ Uruchom ponownie logowanie',
      reloginJsonHelp: 'Wklej zawartość pliku <code>~/.claude/.credentials.json</code> lub JSON z tokenami sesji OAuth:',
      btnSubmitReloginJson: 'Zapisz poświadczenia',
      reloginImportHelp: 'Wczytaj nowe poświadczenia z pliku zapisanego na serwerze (np. po <code>claude login</code> w konsoli):',
      btnSubmitReloginImport: 'Importuj z pliku',
      modalAddClientKeyTitle: '➕ Podłącz nową stację roboczą',
      modalAddClientKeyDesc: 'Wygeneruj dedykowany klucz dostępu dla komputera, laptopa lub agenta CLI. Po utworzeniu od razu otrzymasz gotową komendę do wklejenia w terminalu.',
      lblClientName: 'Nazwa stacji roboczej / urządzenia *',
      lblClientCustomKey: 'Własny klucz (opcjonalnie)',
      lblClientDailyTokens: 'Dzienny limit tokenów (opcjonalnie)',
      lblClientMonthlyTokens: 'Miesięczny limit tokenów (opcjonalnie)',
      lblClientExpiresAt: 'Ważny do (data wygaśnięcia, opcjonalnie)',
      lblClientAllowedModels: 'Dozwolone modele (opcjonalnie)',
      btnSubmitClientKey: 'Utwórz klucz',
      modalKeyCreatedTitle: '💻 Konfiguracja stacji roboczej',
      lblStationWorkstation: 'Stacja robocza:',
      lblStationKey: 'Klucz stacji:',
      btnCopyCreatedKey: '📋 Kopiuj klucz',
      tabSetupBash: '🐧 Linux / macOS / WSL',
      tabSetupPowershell: '🪟 Windows (PowerShell)',
      setupBashAllInOneTitle: '🚀 Jedno polecenie konfiguruje całe środowisko (All-in-One):',
      setupPowershellAllInOneTitle: '🚀 Jedno polecenie konfiguruje całe środowisko Windows (All-in-One):',
      btnCopyCmd: '📋 Kopiuj polecenie',
      setupAdvancedSummary: '⚙️ Zaawansowane: rozdzielne polecenia, zmienne ENV oraz konfiguracja ręczna',
      setupAdvancedPSSummary: '⚙️ Zaawansowane: rozdzielne polecenia Windows i zmienne sesyjne',
      lblBashClaudeOnly: '1. Tylko Claude Code CLI & VS Code:',
      lblBashCodexOnly: '2. Tylko OpenAI Codex CLI & VS Code:',
      lblBashAgentOnly: '3. Zmienne powłoki (export ENV dla OpenCode / Hermes):',
      lblBashManualOnly: '4. Ręczna konfiguracja JSON / env:',
      lblPSClaudeOnly: '1. Tylko Claude Code na Windows (PowerShell):',
      lblPSCodexOnly: '2. Tylko OpenAI Codex na Windows (PowerShell):',
      lblPSAgentOnly: '3. Zmienne sesyjne PowerShell:',
      btnCopySetupBash: '📋 Kopiuj polecenie Claude',
      btnCopySetupCodexBash: '📋 Kopiuj polecenie Codex',
      btnCopySetupAgentBash: '📋 Kopiuj zmienne powłoki',
      btnCopyShellEnv: '📋 Kopiuj export ENV',
      btnCopyVSCode: '📋 Kopiuj VS Code JSON',
      btnCopySetupPowershell: '📋 Kopiuj polecenie Claude (PS)',
      btnCopySetupCodexPowershell: '📋 Kopiuj polecenie Codex (PS)',
      btnCopySetupAgentPowershell: '📋 Kopiuj polecenie PowerShell',
      btnDoneKeyModal: 'Zamknij',
      lblRepoLink: 'Repozytorium:',
      modalAccountUsageTitle: '📊 Szczegóły zużycia konta:',
      lblTotalTokens: 'Łącznie tokenów',
      lblTotalReq: 'Liczba zapytań',
      lblSessionLimit: 'Limit Sesyjny',
      lblWeeklyLimit: 'Limit Tygodniowy',
      lblLastActivity: 'Ostatnia aktywność',
      tabUsageClients: '👤 Kto (Klienci / Stacje)',
      tabUsageSessions: '🎯 Na co (Zadania / Sesje / Modele)',
      tabUsageRecent: '📜 Ostatnie zapytania (Live feed)',
      btnResetAccountUsage: '🗑️ Zeruj liczniki tego konta',
      lblLiveDataAgentlb: 'Dane odświeżane na żywo z agentlb',
      modalFleetUsageTitle: '🌐 Zbiorczy raport zużycia floty: Kto i Na co',
      badgeAllAccounts: 'Wszystkie konta',
      lblTotalFleetTokens: 'Łącznie tokenów floty',
      lblTotalFleetReq: 'Łącznie zapytań',
      lblTotalFleetAccounts: 'Liczba kont',
      lblTotalFleetClients: 'Zidentyfikowani klienci',
      tabFleetAccounts: '🏦 Konta (Podział per konto)',
      tabFleetClients: '👤 Klienci (Kto ile zużył)',
      tabFleetModels: '🤖 Modele (Na jakie modele)',
      testChatTitle: '💬 Test Chat — Claude & Codex Playground',
      testChatBadge: 'Live Upstream Test',
      btnTestChatHeaderCopy: '📋 Kopiuj czat',
      btnTestChatHeaderCopyTitle: 'Skopiuj całą historię rozmowy do schowka',
      lblTestProvider: 'Dostawca (Provider):',
      lblTestModel: 'Model:',
      lblTestEffort: 'Rozumowanie (Effort):',
      optEffortDefault: '⚡ Domyślne (Default)',
      optEffortMinimal: '🟢 Minimalne (Minimal)',
      optEffortLow: '🟢 Niskie (Low)',
      optEffortMedium: '🟡 Średnie (Medium)',
      optEffortHigh: '🔴 Wysokie (High)',
      optEffortMax: '🔥 Maksymalne (Max)',
      lblTestAccount: 'Konto (Routing):',
      optTestAccountAuto: '⚡ Auto (Agent-LB Policy)',
      quickTestsLabel: 'Szybkie testy:',
      quickPromptIntro: '👋 Przedstaw się',
      quickPromptPing: '⚡ Ping',
      testChatPlaceholder: 'Wybierz dostawcę i model, a następnie wpisz wiadomość lub kliknij szybki test.<br>Żądanie zostanie wysłane przez silnik Agent-LB bezpośrednio do wybranego upstreamu.',
      testChatMessagePlaceholder: 'Wpisz treść wiadomości testowej (Enter wysyła, Shift+Enter nowa linia)...',
      btnTestChatClear: '🗑️ Wyczyść historię',
      btnTestChatSend: 'Wyślij zapytanie 🚀',
      thAccount: 'Konto',
      thProvider: 'Dostawca',
      thRequests: 'Żądania',
      thTokens: 'Tokeny',
      thShare: 'Udział %',
      thClient: 'Klient / Stacja',
      thProject: 'Projekt',
      thSession: 'Sesja',
      thModel: 'Model',
      thTime: 'Czas',
      thStatus: 'Status',
      thActions: 'Akcje'
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
      btnReboot: '⚡ Reboot',
      btnRebootTitle: 'Restart Agent-LB service and all proxy processes',
      rebootConfirm: 'Are you sure you want to reboot Agent-LB application and all its processes?',
      rebootInitiated: 'Reboot initiated... Reconnecting to server...',
      rebootSuccess: 'Agent-LB server restarted successfully.',
      btnLogout: '🚪 Logout',
      btnLogoutTitle: 'Sign out from dashboard',
      routesHeading: 'Routing',
      policyTitle: 'Fleet Routing & Operations Policy',
      policySubtitle: 'Smart load balancing, prompt cache reuse, and upstream quota resilience.',
      btnPolicyHelp: 'ℹ️ Explanations',
      btnPolicyHelpCompact: '⚡ Collapse descriptions',
      btnSetDefaults: '✨ Set Defaults',
      btnSetDefaultsTitle: 'Restore optimal fleet routing defaults (Adaptive, Earliest-Reset, Fallback, Auto-Health)',
      msgFleetDefaultsRestored: 'Restored optimal fleet routing defaults',
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
      tabAccountsTitle: 'Accounts & Fleet',
      tabWorkstationsTitle: 'Workstations & Tools',
      accountsHeading: 'Claude & Codex Accounts',
      accountsHint: '💡 Drag card ⠿ in column to adjust queue priority',
      clientsHeading: 'Workstations & Tools',
      colClaudeTitle: '🟣 Claude (Anthropic)',
      colCodexTitle: '🟢 OpenAI Codex',
      colClientsTitle: '💻 Workstations',
      agyColTitle: '🔷 AGY (Google Antigravity)',
      agyLoginBtn: '🔑 Log in a Google account',
      agyHint: 'Stations running agybridge use the top account (or the pinned one). When its quota runs out they move to the next one automatically.',
      agyModalTitle: '🔑 Log a Google account in to AGY',
      agyPreparing: 'Preparing the login link…',
      agyStep1: 'Open the link and choose a Google account:',
      agyOpenLink: '↗ Open Google login',
      agyStep2: 'After consenting, antigravity.google shows a code — copy it.',
      agyStep3: 'Paste the code here:',
      agySubmit: 'Log in',
      agyTimeLeft: 'Time left:',
      agyNewLink: '🔄 New link',
      btnAddAccount: '➕ Add Account',
      btnNewKey: '➕ Connect Workstation',
      btnNewKeyTitle: 'Connect a new workstation or CLI agent',
      btnWorkstationGuide: '📖 Guide',
      btnWorkstationGuideTitle: 'Workstation configuration guide (Linux, macOS, Windows)',
      btnUpdate: '🔄 Update Scripts',
      btnUpdateTitle: 'Pull latest installer scripts from GitHub (git pull)',
      quickConnectTitle: '⚡ Quick Connect:',
      copyCmd: '📋 Copy',
      includeKey: 'Include workstation key',
      githubGuide: 'GitHub guide ↗',
      countAccounts: '{n} accounts',
      countAccountsSingle: '1 account',
      countKeys: '{n} workstations',
      countKeysSingle: '1 workstation',
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
      btnCopyName: 'Copy full account name to clipboard',
      prioBadgeTopTitle: 'Rank #1 — primary account handling requests first',
      prioBadgeOtherTitle: 'Rank #{rank} — fallback account in queue (click "▲ Move to Top" or drag ⠿ to reorder)',
      dragHandleTitle: 'Drag with mouse to reorder queue priority in column',
      summaryActiveAccount: 'active account ',
      summaryNone: 'none',
      summarySessions: ' · {active} active / {known} known sessions',
      summaryRefreshes: 'refreshes every {sec}s · {time}',
      emptyNoAccountsClaude: 'No Claude accounts. Click “➕ Add Account” above.',
      emptyNoAccountsCodex: 'No OpenAI Codex accounts. Click “➕ Add Account” above.',
      emptyNoKeys: 'No workstations configured. Click “➕ Connect Workstation” to add your computer.',
      primaryAdminKeyName: 'Master Administrator Key',
      btnKeyConnect: '💻 Setup',
      keyShow: 'Show',
      keyHide: 'Hide',
      btnFleetUsage: '📊 Who & What?',
      btnFleetUsageTitle: 'View who and what consumes limits across the whole fleet (aggregate)',
      quickStationSelectTitle: 'Select workstation for this command',
      quickCmdClickCopy: 'Click to copy full command',
      quickToolOptional: 'Single tool or ENV export (optional)',
      quickToolAll: '⚡ Everything (All-in-One)',
      quickTabBash: 'Linux / macOS / WSL',
      quickTabPS: 'Windows',
      modalAddAccountTitle: '➕ Add New Account',
      btnClose: '✕ Close',
      lblProvider: 'Provider:',
      provAnthropicOption: '🟣 Anthropic (Claude)',
      provCodexOption: '🟢 OpenAI (Codex / ChatGPT)',
      tabBtnApiKey: 'Console API Key',
      tabBtnOAuth: 'Paste OAuth Session',
      tabBtnImport: 'Import from Path',
      tabBtnBrowserOAuth: 'Browser Login',
      tabBtnDeviceCode: 'Device Code',
      lblApiKeyAnthropic: 'Anthropic Console API Key (sk-ant-...) *',
      lblApiKeyCodex: 'OpenAI Platform API Key (sk-proj-...) *',
      lblAccountName: 'Account Name (optional)',
      lblPriority: 'Priority',
      btnSubmitApiKey: 'Add API Account',
      pOAuthHelp: 'Paste content of <code>~/.claude/.credentials.json</code> or OAuth session tokens:',
      lblOAuthJson: 'Paste entire credentials JSON (.credentials.json)',
      lblOAuthAccess: 'AccessToken (if not pasting JSON)',
      lblOAuthRefresh: 'RefreshToken (optional)',
      btnSubmitOAuth: 'Save OAuth Session',
      pImportHelp: 'Load credentials directly from file on the server:',
      lblImportPath: 'File path on server *',
      btnSubmitImportPath: 'Import from File',
      pBrowserOAuthHelp: 'Sign in to Claude account in browser using secure PKCE flow.',
      btnStartOAuth: 'Start Claude Login',
      lblOAuthStep2Link: '1. If login window did not open, <a id="oauthLink" href="#" target="_blank" style="color:var(--accent); text-decoration:underline;">click here ↗</a>.',
      lblOAuthStep2Help: '2. Sign in to Claude.ai and copy authorization code or callback URL:',
      lblAuthCode: 'Authorization code or callback URL *',
      btnCompleteOAuth: 'Complete Authorization',
      btnCancelOAuth: 'Back',
      pDeviceCodeHelp: 'Log in to OpenAI Codex / ChatGPT using a device code. Ideal for headless servers and SSH sessions.',
      btnStartDeviceCode: 'Start Device Code Login',
      lblDeviceCodeStep2Link: '1. Open this link in a browser on any device:',
      lblDeviceCodeStep2Code: '2. Enter the code below:',
      pDeviceCodeStatus: '⏳ Waiting for code approval...',
      btnCancelDeviceCode: 'Cancel',
      modalReloginTitle: '🔐 Re-login Account: ',
      reloginDesc: 'Session has expired or upstream rejected tokens. Sign in to Claude.ai again to renew credentials and immediately restore account to rotation.',
      tabBtnReloginBrowser: '🌐 Browser (OAuth)',
      tabBtnReloginJson: '📋 Paste JSON / Token',
      tabBtnReloginImport: '📂 Server File',
      reloginStep1Title: 'Step 1: Open Claude.ai Login Page',
      reloginStep1Desc: 'Click the button below to open official Claude.ai authorization page in a new tab. Make sure you log into the correct account.',
      btnStartReloginOAuth: '🌐 Open Claude.ai login in new tab',
      reloginStep2Title: 'Step 2: Copy and paste authorization code',
      reloginStep2Desc: 'After logging in and approving in Claude.ai, copy the authorization code (or the full callback URL) and paste below:',
      btnCompleteReloginOAuth: '✅ Renew Session & Log In',
      btnRestartReloginOAuth: '↺ Restart Login Flow',
      reloginJsonHelp: 'Paste content of <code>~/.claude/.credentials.json</code> or OAuth session tokens JSON:',
      btnSubmitReloginJson: 'Save Credentials',
      reloginImportHelp: 'Load new credentials from a file saved on server (e.g. after <code>claude login</code> in console):',
      btnSubmitReloginImport: 'Import from File',
      modalAddClientKeyTitle: '➕ Connect New Workstation',
      modalAddClientKeyDesc: 'Generate a dedicated access key for a developer machine or CLI agent. You will get ready-to-run terminal commands immediately.',
      lblClientName: 'Workstation / device name *',
      lblClientCustomKey: 'Custom key (optional)',
      lblClientDailyTokens: 'Daily token limit (optional)',
      lblClientMonthlyTokens: 'Monthly token limit (optional)',
      lblClientExpiresAt: 'Expires at (date, optional)',
      lblClientAllowedModels: 'Allowed models (optional)',
      btnSubmitClientKey: 'Create Key',
      modalKeyCreatedTitle: '💻 Workstation Setup & Connect',
      lblStationWorkstation: 'Workstation:',
      lblStationKey: 'Workstation key:',
      btnCopyCreatedKey: '📋 Copy key',
      tabSetupBash: '🐧 Linux / macOS / WSL',
      tabSetupPowershell: '🪟 Windows (PowerShell)',
      setupBashAllInOneTitle: '🚀 One command configures entire environment (All-in-One):',
      setupPowershellAllInOneTitle: '🚀 One command configures entire Windows environment (All-in-One):',
      btnCopyCmd: '📋 Copy command',
      setupAdvancedSummary: '⚙️ Advanced: separate commands, ENV variables & manual setup',
      setupAdvancedPSSummary: '⚙️ Advanced: separate Windows commands & session variables',
      lblBashClaudeOnly: '1. Claude Code CLI & VS Code only:',
      lblBashCodexOnly: '2. OpenAI Codex CLI & VS Code only:',
      lblBashAgentOnly: '3. Shell environment variables (export ENV for OpenCode / Hermes):',
      lblBashManualOnly: '4. Manual JSON / env configuration:',
      lblPSClaudeOnly: '1. Claude Code on Windows (PowerShell) only:',
      lblPSCodexOnly: '2. OpenAI Codex on Windows (PowerShell) only:',
      lblPSAgentOnly: '3. PowerShell session variables:',
      btnCopySetupBash: '📋 Copy Claude command',
      btnCopySetupCodexBash: '📋 Copy Codex command',
      btnCopySetupAgentBash: '📋 Copy shell variables',
      btnCopyShellEnv: '📋 Copy export ENV',
      btnCopyVSCode: '📋 Copy VS Code JSON',
      btnCopySetupPowershell: '📋 Copy Claude command (PS)',
      btnCopySetupCodexPowershell: '📋 Copy Codex command (PS)',
      btnCopySetupAgentPowershell: '📋 Copy PowerShell command',
      btnDoneKeyModal: 'Close',
      lblRepoLink: 'Repository:',
      modalAccountUsageTitle: '📊 Account Usage Details:',
      lblTotalTokens: 'Total Tokens',
      lblTotalReq: 'Total Requests',
      lblSessionLimit: 'Session Limit',
      lblWeeklyLimit: 'Weekly Limit',
      lblLastActivity: 'Last Activity',
      tabUsageClients: '👤 Who (Clients / Workstations)',
      tabUsageSessions: '🎯 What (Tasks / Sessions / Models)',
      tabUsageRecent: '📜 Recent requests (Live feed)',
      btnResetAccountUsage: '🗑️ Reset account counters',
      lblLiveDataAgentlb: 'Live data from agentlb',
      modalFleetUsageTitle: '🌐 Fleet Usage Overview: Who & What',
      badgeAllAccounts: 'All accounts',
      lblTotalFleetTokens: 'Total fleet tokens',
      lblTotalFleetReq: 'Total requests',
      lblTotalFleetAccounts: 'Total accounts',
      lblTotalFleetClients: 'Identified clients',
      tabFleetAccounts: '🏦 Accounts (Per-account breakdown)',
      tabFleetClients: '👤 Clients (Usage by client)',
      tabFleetModels: '🤖 Models (By model)',
      testChatTitle: '💬 Test Chat — Claude & Codex Playground',
      testChatBadge: 'Live Upstream Test',
      btnTestChatHeaderCopy: '📋 Copy chat',
      btnTestChatHeaderCopyTitle: 'Copy entire chat history to clipboard',
      lblTestProvider: 'Provider:',
      lblTestModel: 'Model:',
      lblTestEffort: 'Reasoning Effort:',
      optEffortDefault: '⚡ Default',
      optEffortMinimal: '🟢 Minimal',
      optEffortLow: '🟢 Low',
      optEffortMedium: '🟡 Medium',
      optEffortHigh: '🔴 High',
      optEffortMax: '🔥 Max',
      lblTestAccount: 'Account (Routing):',
      optTestAccountAuto: '⚡ Auto (Agent-LB Policy)',
      quickTestsLabel: 'Quick tests:',
      quickPromptIntro: '👋 Introduce yourself',
      quickPromptPing: '⚡ Ping',
      testChatPlaceholder: 'Select a provider and model, then type a message or click a quick prompt.<br>Request will be sent through Agent-LB directly to the chosen upstream.',
      testChatMessagePlaceholder: 'Type a test message (Enter to send, Shift+Enter for new line)...',
      btnTestChatClear: '🗑️ Clear history',
      btnTestChatSend: 'Send Request 🚀',
      thAccount: 'Account',
      thProvider: 'Provider',
      thRequests: 'Requests',
      thTokens: 'Tokens',
      thShare: 'Share %',
      thClient: 'Client / Workstation',
      thProject: 'Project',
      thSession: 'Session',
      thModel: 'Model',
      thTime: 'Time',
      thStatus: 'Status',
      thActions: 'Actions'
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
    var htmlNodes = document.querySelectorAll('[data-i18n-html]');
    for (var h = 0; h < htmlNodes.length; h++) {
      var hn = htmlNodes[h];
      var hk = hn.getAttribute('data-i18n-html');
      if (hk) hn.innerHTML = t(hk);
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
  var activeRenameAccount = null;

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
    activeRenameAccount = currentName;
    nameRow.innerHTML = '';
    var form = el('form', 'card-rename-form');
    var input = el('input', 'card-rename-input');
    input.type = 'text';
    input.value = currentName;
    input.placeholder = currentLang === 'pl' ? 'Wpisz nową nazwę konta...' : 'Enter new account name...';
    input.required = true;

    var btnCopyInput = el('button', 'btn btn-xs btn-outline', '📋');
    btnCopyInput.type = 'button';
    btnCopyInput.title = t('btnCopyName');
    btnCopyInput.addEventListener('click', function (e) {
      e.stopPropagation();
      copyToClipboard(input.value || currentName, currentLang === 'pl' ? 'nazwa konta' : 'Account name');
      btnCopyInput.textContent = '✅';
      setTimeout(function () { btnCopyInput.textContent = '📋'; }, 1500);
    });

    var btnSave = el('button', 'btn btn-xs btn-accent', '✓ ' + (currentLang === 'pl' ? 'Zapisz' : 'Save'));
    btnSave.type = 'submit';
    btnSave.title = currentLang === 'pl' ? 'Zapisz nową nazwę konta' : 'Save new account name';

    var btnCancel = el('button', 'btn btn-xs btn-outline', '✕');
    btnCancel.type = 'button';
    btnCancel.title = currentLang === 'pl' ? 'Anuluj' : 'Cancel';

    form.appendChild(input);
    form.appendChild(btnCopyInput);
    form.appendChild(btnSave);
    form.appendChild(btnCancel);
    nameRow.appendChild(form);

    input.focus();
    input.select();

    function cancel() {
      activeRenameAccount = null;
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
        note('warn', currentLang === 'pl' ? 'Nazwa konta nie może być pusta' : 'Account name cannot be empty');
        input.focus();
        return;
      }
      if (val === currentName) {
        cancel();
        return;
      }
      btnSave.disabled = true;
      btnCancel.disabled = true;
      btnCopyInput.disabled = true;
      input.disabled = true;

      apiCall('/agent-lb/api/accounts/rename', 'POST', { oldName: currentName, newName: val })
        .then(function (res) {
          if (!res) {
            cancel();
            return;
          }
          if (res.ok) {
            activeRenameAccount = null;
            note('ok', (currentLang === 'pl' ? 'Zmieniono nazwę konta z "' : 'Renamed account from "') + currentName + (currentLang === 'pl' ? '" na "' : '" to "') + res.newName + '"');
            if (card) {
              card.dataset.accountName = res.newName;
            }
            nameRow.innerHTML = '';
            poll();
          } else {
            note('error', (currentLang === 'pl' ? 'Błąd zmiany nazwy: ' : 'Rename error: ') + (res.error || (currentLang === 'pl' ? 'nieznany błąd' : 'unknown error')));
            btnSave.disabled = false;
            btnCancel.disabled = false;
            btnCopyInput.disabled = false;
            input.disabled = false;
            input.focus();
          }
        })
        .catch(function (err) {
          note('error', (currentLang === 'pl' ? 'Błąd: ' : 'Error: ') + err.message);
          btnSave.disabled = false;
          btnCancel.disabled = false;
          btnCopyInput.disabled = false;
          input.disabled = false;
          input.focus();
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
    btnDel.addEventListener('click', function () { doRemoveAccount(a.id || a.name, a.name, btnDel); });
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

    if (a.name) {
      var btnCopy = el('button', 'btn-rename btn-copy-name', '📋');
      btnCopy.title = t('btnCopyName');
      btnCopy.setAttribute('aria-label', t('btnCopyName') + ' ' + a.name);
      btnCopy.addEventListener('click', function (e) {
        e.stopPropagation();
        copyToClipboard(a.name, currentLang === 'pl' ? 'nazwa konta' : 'Account name');
        btnCopy.textContent = '✅';
        setTimeout(function () { btnCopy.textContent = '📋'; }, 1500);
      });
      nameDisplay.appendChild(btnCopy);

      var btnRename = el('button', 'btn-rename', '✏️');
      btnRename.title = t('renameAccount');
      btnRename.setAttribute('aria-label', t('renameAccount') + ' ' + a.name);
      btnRename.addEventListener('click', function (e) {
        e.stopPropagation();
        startInlineRename(a.name, nameRow, nameDisplay, card);
      });
      nameDisplay.appendChild(btnRename);

      nameText.addEventListener('dblclick', function (e) {
        e.stopPropagation();
        startInlineRename(a.name, nameRow, nameDisplay, card);
      });
    }
    nameRow.appendChild(nameDisplay);
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
        meta.appendChild(el('span', 'card-meta-item bad', currentLang === 'pl' ? '⚠️ Brak środków' : '⚠️ Out of credits'));
      } else if (sp2.disabledReason) {
        meta.appendChild(el('span', 'card-meta-item warn', '⚠️ ' + sp2.disabledReason));
      } else if (sp2.enabled) {
        meta.appendChild(el('span', 'card-meta-item ok', '💳 Extra: ok' + (usedVal ? ' · ' + usedVal : '')));
      } else if (planName) {
        meta.appendChild(el('span', 'card-meta-item', '💳 ' + planName + (usedVal ? ' · ' + usedVal : '')));
      } else {
        meta.appendChild(el('span', 'card-meta-item', (currentLang === 'pl' ? '💳 Nielimitowany' : '💳 Unlimited') + (usedVal ? ' · ' + usedVal : '')));
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
        btnReset.title = currentLang === 'pl' ? 'Zużyj kredyt resetu OpenAI i natychmiast wyzeruj limit 5h' : 'Consume OpenAI reset credit and immediately clear 5h limit';
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
        else tokenParts.push(currentLang === 'pl' ? 'Wygasł' : 'Expired');
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

    // Usage & request counts (pushed to right, interactive inspect modal)
    var u = a.usage || {};
    var last = u.lastUsed ? ' · ' + fmtAgo(u.lastUsed) : '';
    var usageBtn = el('button', 'btn btn-xs card-meta-item', '📊 ' + (u.totalRequests || 0) + ' req · ' + fmtNum(accountTokens(u)) + ' tok' + last);
    usageBtn.type = 'button';
    usageBtn.style.marginLeft = 'auto';
    usageBtn.style.cursor = 'pointer';
    usageBtn.style.background = 'rgba(88,166,255,0.08)';
    usageBtn.style.border = '1px solid rgba(88,166,255,0.3)';
    usageBtn.style.borderRadius = '4px';
    usageBtn.style.padding = '2px 8px';
    usageBtn.style.fontSize = '11px';
    usageBtn.style.color = 'var(--text)';
    usageBtn.title = currentLang === 'pl'
      ? 'Kliknij, aby sprawdzić KTO i NA CO zużył limity tego konta'
      : 'Click to inspect WHO and WHAT spent limits on this account';
    usageBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      openAccountUsageModal(a);
    });
    meta.appendChild(usageBtn);

    card.appendChild(meta);
    return card;
  }

  function renderClients(clients) {
    var wrap = document.getElementById('clientsWrap');
    if (!wrap) return;
    var names = Object.keys(clients || {});
    if (!names.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    names.sort(function (a, b) {
      var ca = clients[a], cb = clients[b];
      return ((cb.inputTokens || 0) + (cb.outputTokens || 0)) - ((ca.inputTokens || 0) + (ca.outputTokens || 0));
    });
    var table = document.getElementById('clients');
    if (!table) return;
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
        var btn = el('button', 'btn btn-sm btn-ok', currentLang === 'pl' ? '▶️ Włącz konto' : '▶️ Enable account');
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

    if (activeRenameAccount || document.querySelector('.card-rename-input')) {
      return; // Do not replace account cards while inline renaming is active
    }

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
    var bAcc = document.getElementById('tabBadgeAccounts');
    if (bAcc) {
      bAcc.textContent = accts.length;
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
    if (typeof routeRetryPending === 'function') routeRetryPending();
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
      sel.value = (s.sessions && (s.sessions.mode || (s.sessions.distribute ? 'even' : 'off'))) || 'adaptive';
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
          note('ok', currentLang === 'pl' ? 'Zaktualizowano politykę floty (Routing / Cache)' : 'Updated fleet policy (Routing / Cache)');
          poll();
        } else {
          note('error', (currentLang === 'pl' ? 'Błąd zapisu polityki: ' : 'Error saving policy: ') + (res && res.error ? res.error : (currentLang === 'pl' ? 'nieznany' : 'unknown')));
        }
      })
      .catch(function (e) {
        note('error', (currentLang === 'pl' ? 'Błąd zapisu polityki: ' : 'Error saving policy: ') + e.message);
      });
  }

  function resetFleetRoutingDefaults() {
    apiCall('/agent-lb/api/routing', 'POST', { resetDefaults: true })
      .then(function (res) {
        if (res && res.ok) {
          var sel = document.getElementById('selDistributeSessions');
          var chkExp = document.getElementById('chkExpiryRouting');
          var chkFb = document.getElementById('chkCrossProviderFallback');
          var chkHealth = document.getElementById('chkAutoHealthCheck');
          if (sel) sel.value = 'adaptive';
          if (chkExp) chkExp.checked = true;
          if (chkFb) chkFb.checked = true;
          if (chkHealth) chkHealth.checked = true;
          note('ok', t('msgFleetDefaultsRestored'));
          poll();
        } else {
          note('error', (currentLang === 'pl' ? 'Błąd przywracania ustawień domyślnych: ' : 'Error restoring defaults: ') + ((res && res.error) || (currentLang === 'pl' ? 'Nieznany błąd' : 'Unknown error')));
        }
      })
      .catch(function (e) {
        note('error', (currentLang === 'pl' ? 'Błąd komunikacji z serwerem: ' : 'Server communication error: ') + e.message);
      });
  }

  function toggleDrain() {
    var isDraining = lastStatus && lastStatus.draining;
    var endpoint = isDraining ? '/agent-lb/api/drain/cancel' : '/agent-lb/api/drain';
    apiCall(endpoint, 'POST')
      .then(function (res) {
        if (res && res.ok) {
          note('ok', isDraining ? (currentLang === 'pl' ? 'Wznowiono normalną pracę floty (anulowano drain)' : 'Resumed normal fleet operation (drain canceled)') : (currentLang === 'pl' ? 'Włączono tryb Drain (dokańczanie aktywnych zapytań)' : 'Drain mode enabled (finishing active requests)'));
          poll();
        } else {
          note('error', (currentLang === 'pl' ? 'Błąd przełączania drain: ' : 'Error toggling drain: ') + (res && res.error ? res.error : (currentLang === 'pl' ? 'nieznany' : 'unknown')));
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
  try {
    var storedKeys = JSON.parse(localStorage.getItem('agentlb_cached_keys') || '{}');
    if (storedKeys && typeof storedKeys === 'object') {
      for (var sk in storedKeys) {
        if (typeof storedKeys[sk] === 'string' && !storedKeys[sk].includes('...')) {
          cachedClientKeys[sk] = storedKeys[sk];
        }
      }
    }
  } catch (e) {}

  function saveCachedKeys() {
    try {
      localStorage.setItem('agentlb_cached_keys', JSON.stringify(cachedClientKeys));
    } catch (e) {}
  }
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
        showKeybox(currentLang === 'pl' ? 'Wymagana autoryzacja administracyjna. Wprowadź klucz proxy (proxy.apiKey).' : 'Administrative authorization required. Enter proxy key (proxy.apiKey).');
        return null;
      }
      return res.json().catch(function () {
        return { ok: false, error: 'status ' + res.status };
      });
    });
  }

  function copyToClipboard(text, label) {
    function notifySuccess() {
      var msg = currentLang === 'pl'
        ? ('Skopiowano do schowka: ' + (label || 'tekst'))
        : ((label || 'Text') + ' copied to clipboard');
      note('ok', msg);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        notifySuccess();
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
      var msg = currentLang === 'pl'
        ? ('Skopiowano do schowka: ' + (label || 'tekst'))
        : ((label || 'Text') + ' copied to clipboard');
      note('ok', msg);
    } catch (e) {
      note('error', (currentLang === 'pl' ? 'Nie udało się skopiować: ' : 'Could not copy to clipboard: ') + e.message);
    }
    document.body.removeChild(ta);
  }

  function openModal(id) {
    var m = document.getElementById(id);
    if (m) m.style.display = 'flex';
    if (typeof routeModalOpened === 'function') routeModalOpened(id);
  }

  function closeModal(id) {
    var m = document.getElementById(id);
    if (m) m.style.display = 'none';
    if (typeof routeModalClosed === 'function') routeModalClosed(id);
  }

  function doToggleDisabled(name, currentDisabled, btn) {
    btn.disabled = true;
    apiCall('/agent-lb/api/accounts/toggle', 'POST', { id: name, account: name, disabled: !currentDisabled })
      .then(function (res) {
        if (!res) return;
        if (res.ok) {
          note('ok', currentLang === 'pl' ? ('Konto "' + name + '" ' + (res.disabled ? 'wyłączone' : 'włączone')) : ('Account "' + name + '" ' + (res.disabled ? 'disabled' : 'enabled')));
          poll();
        } else {
          note('error', (currentLang === 'pl' ? 'Błąd przełączania: ' : 'Toggle error: ') + (res.error || (currentLang === 'pl' ? 'nieznany błąd' : 'unknown error')));
          btn.disabled = false;
        }
      })
      .catch(function (e) {
        note('error', 'Błąd: ' + e.message);
        btn.disabled = false;
      });
  }

  function doSetPriority(name, currentPrio) {
    var input = prompt(currentLang === 'pl' ? ('Podaj nowy priorytet dla konta "' + name + '" (liczba całkowita, niższa wartość = wyższy priorytet):') : ('Enter new priority for account "' + name + '" (integer, lower value = higher priority):'), currentPrio || 0);
    if (input == null) return;
    var prio = parseInt(input.trim(), 10);
    if (isNaN(prio)) {
      note('error', currentLang === 'pl' ? 'Priorytet musi być liczbą całkowitą' : 'Priority must be an integer');
      return;
    }
    apiCall('/agent-lb/api/accounts/priority', 'POST', { id: name, account: name, priority: prio })
      .then(function (res) {
        if (!res) return;
        if (res.ok) {
          note('ok', currentLang === 'pl' ? ('Zmieniono priorytet konta "' + name + '" na ' + res.priority) : ('Changed priority of account "' + name + '" to ' + res.priority));
          poll();
        } else {
          note('error', (currentLang === 'pl' ? 'Błąd zmiany priorytetu: ' : 'Error changing priority: ') + (res.error || (currentLang === 'pl' ? 'nieznany błąd' : 'unknown error')));
        }
      })
      .catch(function (e) {
        note('error', 'Błąd: ' + e.message);
      });
  }

  function doRenameAccount(oldName) {
    var input = prompt(currentLang === 'pl' ? ('Podaj nową nazwę dla konta "' + oldName + '":') : ('Enter new name for account "' + oldName + '":'), oldName);
    if (input == null) return;
    var newName = input.trim();
    if (!newName || newName === oldName) return;
    apiCall('/agent-lb/api/accounts/rename', 'POST', { oldName: oldName, newName: newName })
      .then(function (res) {
        if (!res) return;
        if (res.ok) {
          note('ok', currentLang === 'pl' ? ('Zmieniono nazwę konta z "' + oldName + '" na "' + res.newName + '"') : ('Renamed account from "' + oldName + '" to "' + res.newName + '"'));
          poll();
        } else {
          note('error', (currentLang === 'pl' ? 'Błąd zmiany nazwy: ' : 'Error renaming account: ') + (res.error || (currentLang === 'pl' ? 'nieznany błąd' : 'unknown error')));
        }
      })
      .catch(function (e) {
        note('error', 'Błąd: ' + e.message);
      });
  }

  function doRemoveAccount(targetId, displayName, btn) {
    var nameToAsk = displayName || targetId;
    if (!confirm(currentLang === 'pl' ? ('Czy na pewno chcesz usunąć konto "' + nameToAsk + '" z konfiguracji Agent LB?') : ('Are you sure you want to remove account "' + nameToAsk + '" from Agent LB config?'))) return;
    if (btn) btn.disabled = true;
    apiCall('/agent-lb/api/accounts/remove', 'POST', { id: targetId, name: nameToAsk, account: nameToAsk })
      .then(function (res) {
        if (!res) return;
        if (res.ok) {
          note('ok', currentLang === 'pl' ? ('Usunięto konto "' + nameToAsk + '"') : ('Removed account "' + nameToAsk + '"'));
          poll();
        } else {
          note('error', (currentLang === 'pl' ? 'Błąd usuwania konta: ' : 'Error removing account: ') + (res.error || (currentLang === 'pl' ? 'nieznany błąd' : 'unknown error')));
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
    note('ok', currentLang === 'pl' ? ('Odpytywanie limitów konta "' + name + '"...') : ('Probing limits for account "' + name + '"...'));
    apiCall('/agent-lb/api/accounts/probe-single', 'POST', { account: name })
      .then(function (res) {
        if (!res) return;
        if (res.ok) {
          note('ok', currentLang === 'pl' ? ('Zaktualizowano limity konta "' + name + '"') : ('Updated limits for account "' + name + '"'));
          poll();
        } else {
          note('error', (currentLang === 'pl' ? 'Błąd odświeżania: ' : 'Error refreshing: ') + (res.error || (currentLang === 'pl' ? 'nieznany błąd' : 'unknown error')));
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
    note('ok', currentLang === 'pl' ? ('Wysyłanie zapytania testowego do konta "' + name + '"...') : ('Sending test request to account "' + name + '"...'));
    apiCall('/api/test/chat', 'POST', {
      provider: provider,
      account: name,
      model: model,
      message: currentLang === 'pl' ? 'Ping test konta. Odpowiedz jednym słowem "OK".' : 'Ping test for account. Reply with single word "OK".'
    })
      .then(function (res) {
        if (!res) return;
        if (res.ok) {
          if (btn) {
            btn.textContent = '🟢 OK (' + (res.durationMs || 0) + 'ms)';
            btn.className = 'btn btn-xs btn-success';
          }
          note('ok', currentLang === 'pl' ? ('Konto "' + name + '" działa poprawnie! Czas odpowiedzi: ' + (res.durationMs || 0) + 'ms. Model: ' + (res.model || model)) : ('Account "' + name + '" is healthy! Response time: ' + (res.durationMs || 0) + 'ms. Model: ' + (res.model || model)));
          poll();
        } else {
          if (btn) {
            btn.textContent = '🔴 ' + (currentLang === 'pl' ? 'Błąd' : 'Error');
            btn.className = 'btn btn-xs btn-error';
          }
          note('error', (currentLang === 'pl' ? ('Konto "' + name + '" zwróciło błąd: ') : ('Account "' + name + '" returned error: ')) + (res.error || (currentLang === 'pl' ? 'nieznany błąd' : 'unknown error')));
          poll();
        }
      })
      .catch(function (e) {
        if (btn) {
          btn.textContent = '🔴 Błąd';
          btn.className = 'btn btn-xs btn-error';
        }
        note('error', (currentLang === 'pl' ? 'Błąd sieci podczas testowania konta: ' : 'Network error testing account: ') + e.message);
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
          note('ok', currentLang === 'pl' ? ('Ustawiono politykę konta "' + name + '" na: ' + (policy === 'burn-first' ? 'Burn first' : 'Normal')) : ('Set policy of account "' + name + '" to: ' + (policy === 'burn-first' ? 'Burn first' : 'Normal')));
          poll();
        } else {
          note('error', (currentLang === 'pl' ? 'Błąd zmiany polityki: ' : 'Error changing policy: ') + (res.error || (currentLang === 'pl' ? 'nieznany błąd' : 'unknown error')));
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
    if (!confirm(currentLang === 'pl' ? ('UWAGA: Czy na pewno chcesz zużyć 1 kredyt resetu OpenAI dla konta "' + name + '"?\\n\\nSpowoduje to natychmiastowe wyzerowanie okna 5h (blokady limitu) w ChatGPT. Ta operacja jest nieodwracalna.') : ('WARNING: Are you sure you want to consume 1 OpenAI reset credit for account "' + name + '"?\\n\\nThis will immediately clear the 5h limit window in ChatGPT. This action is irreversible.'))) return;
    if (btn) btn.disabled = true;

    note('ok', currentLang === 'pl' ? 'Wysyłanie żądania resetu limitu do OpenAI...' : 'Sending reset request to OpenAI...');
    apiCall('/agent-lb/api/accounts/consume-reset-credit', 'POST', { account: name })
      .then(function (res) {
        if (!res) return;
        if (res.ok) {
          note('ok', currentLang === 'pl' ? ('Pomyślnie zresetowano limit 5h dla konta "' + name + '"!') : ('Successfully reset 5h limit for account "' + name + '"!'));
          poll();
        } else {
          note('error', (currentLang === 'pl' ? 'Błąd resetowania: ' : 'Reset error: ') + (res.error || (currentLang === 'pl' ? 'nieznany błąd' : 'unknown error')));
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
        note('ok', currentLang === 'pl' ? ('Wyeksportowano konto "' + name + '"') : ('Exported account "' + name + '"'));
      })
      .catch(function (e) {
        note('error', (currentLang === 'pl' ? 'Błąd eksportu: ' : 'Export error: ') + e.message);
      });
  }

  function doTestFleet(btn) {
    if (btn) {
      btn.disabled = true;
      btn.textContent = currentLang === 'pl' ? '⏳ Diagnozowanie...' : '⏳ Diagnosing...';
    }
    note('ok', currentLang === 'pl' ? 'Rozpoczęto diagnostykę floty (weryfikacja aktywnych kont)...' : 'Started fleet diagnostics (checking active accounts)...');
    apiCall('/agent-lb/api/health-check/run', 'POST', { force: true })
      .then(function (res) {
        if (!res) return;
        var sum = res.summary || {};
        var msg = currentLang === 'pl' ? ('Zakończono diagnostykę: ' + (sum.ok || 0) + ' sprawnych, ' + (sum.errors || 0) + ' z błędami, ' + (sum.skipped || 0) + ' pominiętych, zużyto łącznie ' + (sum.tokensUsed || 0) + ' tokenów.') : ('Diagnostics finished: ' + (sum.ok || 0) + ' healthy, ' + (sum.errors || 0) + ' errors, ' + (sum.skipped || 0) + ' skipped, ' + (sum.tokensUsed || 0) + ' tokens used.');
        note(sum.errors > 0 ? 'warn' : 'ok', msg);
        poll();
      })
      .catch(function (e) {
        note('error', (currentLang === 'pl' ? 'Błąd podczas diagnostyki floty: ' : 'Error during fleet diagnostics: ') + e.message);
      })
      .finally(function () {
        if (btn) {
          btn.disabled = false;
          btn.textContent = t('btnFleetDiagnostics') || (currentLang === 'pl' ? '🩺 Testuj flotę' : '🩺 Test Fleet');
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
          note('ok', currentLang === 'pl' ? ('Przeładowano flotę kont z dysku (' + (res.added || 0) + ' nowych kont)') : ('Reloaded account fleet from disk (' + (res.added || 0) + ' new accounts)'));
          poll();
        } else {
          note('error', (currentLang === 'pl' ? 'Błąd przeładowania: ' : 'Reload error: ') + (res.error || (currentLang === 'pl' ? 'nieznany błąd' : 'unknown error')));
        }
      })
      .catch(function (e) {
        if (btn) btn.disabled = false;
        note('error', 'Błąd przeładowania: ' + e.message);
      });
  }

  function doRebootServer(btn) {
    var confirmMsg = (I18N[currentLang] && I18N[currentLang].rebootConfirm) || 'Czy na pewno chcesz zrestartować aplikację Agent-LB i wszystkie jej procesy?';
    if (!confirm(confirmMsg)) return;

    if (btn) btn.disabled = true;
    note('ok', (I18N[currentLang] && I18N[currentLang].rebootInitiated) || 'Inicjalizacja restartu... Ponowne łączenie...');

    apiCall('/agent-lb/api/system/reboot', 'POST', {})
      .then(function () {
        waitForServerReboot();
      })
      .catch(function () {
        waitForServerReboot();
      });
  }

  function waitForServerReboot() {
    var attempts = 0;
    var maxAttempts = 35;
    var overlay = document.createElement('div');
    overlay.id = 'rebootOverlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(13,17,23,0.85);z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;backdrop-filter:blur(4px);';
    overlay.innerHTML = '<div style="background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px 32px;text-align:center;box-shadow:0 12px 32px rgba(0,0,0,0.5);max-width:380px;">' +
      '<div style="font-size:32px;margin-bottom:12px;">⚡</div>' +
      '<div style="font-weight:600;font-size:16px;color:var(--heading);margin-bottom:6px;">Restartowanie Agent-LB...</div>' +
      '<div style="font-size:13px;color:var(--dim);margin-bottom:14px;" id="rebootCountdown">Zatrzymywanie i ponowne uruchamianie procesów...</div>' +
      '<div class="mono" style="font-size:11px;color:var(--accent);">status: oczekiwanie na serwer...</div>' +
      '</div>';
    document.body.appendChild(overlay);

    setTimeout(function () {
      var checkTimer = setInterval(function () {
        attempts++;
        var elCd = document.getElementById('rebootCountdown');
        if (elCd) elCd.textContent = 'Próba ponownego połączenia (' + attempts + '/' + maxAttempts + ')...';

        fetch('/ready?t=' + Date.now(), { method: 'GET', cache: 'no-cache' })
          .then(function (r) {
            if (r.ok || r.status === 200 || r.status === 401 || r.status === 403) {
              clearInterval(checkTimer);
              if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
              note('ok', (I18N[currentLang] && I18N[currentLang].rebootSuccess) || 'Serwer Agent-LB został pomyślnie zrestartowany.');
              var btn = document.getElementById('btnRebootServer');
              if (btn) btn.disabled = false;
              poll();
            }
          })
          .catch(function () {
            if (attempts >= maxAttempts) {
              clearInterval(checkTimer);
              if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
              note('warn', 'Restart trwa dłużej niż zwykle. Odśwież stronę, aby sprawdzić stan.');
              var btn = document.getElementById('btnRebootServer');
              if (btn) btn.disabled = false;
            }
          });
      }, 1000);
    }, 1500);
  }

  function doProbeQuota(btn) {
    if (btn) btn.disabled = true;
    note('ok', currentLang === 'pl' ? 'Sprawdzanie sald i limitów kont w Anthropic...' : 'Checking quotas and balances in Anthropic...');
    apiCall('/agent-lb/probe', 'POST')
      .then(function (res) {
        if (btn) btn.disabled = false;
        if (!res) return;
        if (res.ok) {
          note('ok', currentLang === 'pl' ? 'Pomyślnie zaktualizowano salda i limity floty kont' : 'Successfully updated fleet quotas and balances');
          poll();
        } else {
          note('error', (currentLang === 'pl' ? 'Błąd sprawdzania sald: ' : 'Error checking quotas: ') + (res.error || (currentLang === 'pl' ? 'nieznany błąd' : 'unknown error')));
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
      note('error', currentLang === 'pl' ? 'Klucz API jest wymagany' : 'API key is required');
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
          note('ok', currentLang === 'pl' ? ('Dodano konto API "' + res.account + '"') : ('Added API account "' + res.account + '"'));
          document.getElementById('inApiKey').value = '';
          document.getElementById('inApiKeyName').value = '';
          closeModal('modalAddAccount');
          poll();
        } else {
          note('error', (currentLang === 'pl' ? 'Błąd dodawania konta: ' : 'Error adding account: ') + (res.error || (currentLang === 'pl' ? 'nieznany błąd' : 'unknown error')));
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
      note('error', currentLang === 'pl' ? 'Podaj token AccessToken lub wklej JSON poświadczeń' : 'Provide AccessToken or paste credentials JSON');
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
          note('ok', currentLang === 'pl' ? ('Dodano konto OAuth "' + res.account + '"') : ('Added OAuth account "' + res.account + '"'));
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
      note('error', currentLang === 'pl' ? 'Ścieżka do pliku poświadczeń jest wymagana' : 'Credentials file path is required');
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
          note('ok', currentLang === 'pl' ? ('Zaimportowano konto "' + res.account + '" z pliku ' + path) : ('Imported account "' + res.account + '" from file ' + path));
          document.getElementById('inImportPathName').value = '';
          closeModal('modalAddAccount');
          poll();
        } else {
          note('error', (currentLang === 'pl' ? 'Błąd importu: ' : 'Import error: ') + (res.error || (currentLang === 'pl' ? 'nieznany błąd' : 'unknown error')));
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
      titleEl.textContent = isCodex ? (currentLang === 'pl' ? '➕ Dodaj konto OpenAI Codex' : '➕ Add OpenAI Codex Account') : (currentLang === 'pl' ? '➕ Dodaj konto Claude (Anthropic)' : '➕ Add Claude (Anthropic) Account');
    }

    var lblApiKey = document.getElementById('lblApiKey');
    if (lblApiKey) lblApiKey.textContent = isCodex ? (currentLang === 'pl' ? 'Klucz API OpenAI (sk-...) *' : 'OpenAI Platform API Key (sk-...) *') : (currentLang === 'pl' ? 'Klucz API Anthropic Console (sk-ant-...) *' : 'Anthropic Console API Key (sk-ant-...) *');
    var inApiKey = document.getElementById('inApiKey');
    if (inApiKey) inApiKey.placeholder = isCodex ? 'sk-proj-...' : 'sk-ant-api03-...';

    var pOAuth = document.getElementById('pOAuthHelp');
    if (pOAuth) {
      pOAuth.innerHTML = isCodex
        ? (currentLang === 'pl' ? 'Wklej zawartość pliku <code>~/.codex/auth.json</code> lub podaj tokeny z sesji OAuth:' : 'Paste content of <code>~/.codex/auth.json</code> or OAuth session tokens:')
        : (currentLang === 'pl' ? 'Wklej zawartość pliku <code>~/.claude/.credentials.json</code> lub podaj tokeny z sesji OAuth:' : 'Paste content of <code>~/.claude/.credentials.json</code> or OAuth session tokens:');
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
        ? (currentLang === 'pl' ? 'Zaloguj się na konto OpenAI Codex / ChatGPT w przeglądarce za pomocą bezpiecznego przepływu PKCE.' : 'Sign in to OpenAI Codex / ChatGPT account in browser using PKCE flow.')
        : (currentLang === 'pl' ? 'Zaloguj się na konto Claude w przeglądarce za pomocą bezpiecznego przepływu PKCE.' : 'Sign in to Claude account in browser using secure PKCE flow.');
    }
    var btnStart = document.getElementById('btnStartOAuth');
    if (btnStart) {
      btnStart.textContent = isCodex ? (currentLang === 'pl' ? 'Rozpocznij logowanie OpenAI Codex' : 'Start OpenAI Codex Login') : (currentLang === 'pl' ? 'Rozpocznij logowanie Claude' : 'Start Claude Login');
    }
    var pStep2 = document.getElementById('pOAuthStep2Help');
    if (pStep2) {
      pStep2.textContent = isCodex
        ? (currentLang === 'pl' ? '2. Zaloguj się w OpenAI / ChatGPT i skopiuj kod autoryzacyjny lub adres URL (http://localhost:1455/auth/callback?code=...):' : '2. Sign in to OpenAI / ChatGPT and copy authorization code or callback URL:')
        : (currentLang === 'pl' ? '2. Zaloguj się w Claude.ai i skopiuj kod autoryzacyjny lub pełny adres URL:' : '2. Sign in to Claude.ai and copy authorization code or callback URL:');
    }

    var dcBtn = document.getElementById('tabBtnDeviceCode');
    if (dcBtn) dcBtn.style.display = isCodex ? '' : 'none';
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
    note('ok', (currentLang === 'pl' ? 'Inicjowanie logowania w przeglądarce (' : 'Starting browser login (') + (prov === 'codex' ? 'OpenAI Codex' : 'Claude') + ')...');
    apiCall('/agent-lb/oauth/start?provider=' + encodeURIComponent(prov), 'GET')
      .then(function (res) {
        if (btn) btn.disabled = false;
        if (!res || !res.ok) {
          if (authWindow) authWindow.close();
          note('error', (currentLang === 'pl' ? 'Nie można zainicjować logowania: ' : 'Cannot initiate login: ') + (res ? res.error : (currentLang === 'pl' ? 'nieznany błąd' : 'unknown error')));
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
        note('ok', (currentLang === 'pl' ? ('Otwarto stronę logowania ' + (prov === 'codex' ? 'OpenAI' : 'Claude') + '. Po zatwierdzeniu wklej kod poniżej.') : ('Opened ' + (prov === 'codex' ? 'OpenAI' : 'Claude') + ' login page. After approving, paste code below.')));
      })
      .catch(function (e) {
        if (btn) btn.disabled = false;
        if (authWindow) authWindow.close();
        note('error', (currentLang === 'pl' ? 'Błąd logowania OAuth: ' : 'OAuth login error: ') + e.message);
      });
  }
  var doStartBrowserOAuth = doStartOAuth;

  var deviceCodePollTimer = null;
  var pendingDeviceAuthId = null;

  function doStartDeviceCode(btn) {
    if (btn) btn.disabled = true;
    note('ok', currentLang === 'pl' ? 'Inicjowanie logowania kodem urządzenia (Codex)...' : 'Starting device code login (Codex)...');
    apiCall('/agent-lb/oauth/device-start', 'POST', { provider: 'codex' })
      .then(function (res) {
        if (btn) btn.disabled = false;
        if (!res || !res.ok) {
          note('error', 'Nie można zainicjować logowania: ' + (res ? res.error : 'nieznany błąd'));
          return;
        }
        pendingDeviceAuthId = res.deviceAuthId;
        var urlEl = document.getElementById('deviceCodeUrl');
        urlEl.href = res.verificationUrl;
        urlEl.textContent = res.verificationUrl;
        document.getElementById('deviceCodeValue').textContent = res.userCode;
        document.getElementById('deviceCodeStep1').style.display = 'none';
        document.getElementById('deviceCodeStep2').style.display = 'block';
        document.getElementById('deviceCodeStatus').textContent = currentLang === 'pl' ? '⏳ Oczekiwanie na zatwierdzenie kodu...' : '⏳ Waiting for code approval...';
        note('ok', currentLang === 'pl' ? ('Kod urządzenia: ' + res.userCode + '. Otwórz link i wpisz kod.') : ('Device code: ' + res.userCode + '. Open link and enter the code.'));

        var interval = (res.interval || 5) * 1000;
        deviceCodePollTimer = setInterval(function () {
          var name = document.getElementById('inDeviceCodeName').value.trim();
          var prio = parseInt(document.getElementById('inDeviceCodePrio').value.trim(), 10) || 0;
          apiCall('/agent-lb/oauth/device-poll', 'POST', {
            deviceAuthId: pendingDeviceAuthId,
            userCode: res.userCode,
            name: name,
            priority: prio,
          })
            .then(function (pollRes) {
              if (!pollRes) return;
              if (pollRes.ok && pollRes.status === 'complete') {
                clearInterval(deviceCodePollTimer);
                deviceCodePollTimer = null;
                note('ok', (currentLang === 'pl' ? 'Zautoryzowano konto "' : 'Authorized account "') + pollRes.account + '"' + (pollRes.email ? ' (' + pollRes.email + ')' : ''));
                document.getElementById('deviceCodeStep1').style.display = 'block';
                document.getElementById('deviceCodeStep2').style.display = 'none';
                document.getElementById('inDeviceCodeName').value = '';
                closeModal('modalAddAccount');
                pendingDeviceAuthId = null;
                poll();
              } else if (!pollRes.ok) {
                clearInterval(deviceCodePollTimer);
                deviceCodePollTimer = null;
                document.getElementById('deviceCodeStatus').textContent = '❌ ' + (pollRes.error || (currentLang === 'pl' ? 'Błąd autoryzacji' : 'Authorization error'));
                note('error', pollRes.error || (currentLang === 'pl' ? 'Błąd autoryzacji kodem urządzenia' : 'Device code authorization error'));
              }
              // else status === 'pending' — keep polling
            })
            .catch(function () {
              // transient error, keep polling
            });
        }, interval);
      })
      .catch(function (e) {
        if (btn) btn.disabled = false;
        note('error', (currentLang === 'pl' ? 'Błąd logowania kodem urządzenia: ' : 'Device code login error: ') + e.message);
      });
  }


  function doCompleteOAuth(btn) {
    var code = document.getElementById('inOAuthCode').value.trim();
    var name = document.getElementById('inOAuthFlowName').value.trim();
    var prio = parseInt(document.getElementById('inOAuthFlowPrio').value.trim(), 10) || 0;
    if (!code) {
      note('error', currentLang === 'pl' ? 'Wklej kod autoryzacyjny lub pełny adres URL' : 'Paste authorization code or full callback URL');
      return;
    }
    if (!pendingOAuthState) {
      note('error', currentLang === 'pl' ? 'Brak aktywnej sesji logowania. Rozpocznij logowanie ponownie.' : 'No active login session. Start login again.');
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
          note('error', (currentLang === 'pl' ? 'Błąd autoryzacji: ' : 'Authorization error: ') + (res.error || (currentLang === 'pl' ? 'nieznany błąd' : 'unknown error')));
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
    if (s1Btn) s1Btn.textContent = isCodex ? (currentLang === 'pl' ? '🌐 Otwórz logowanie OpenAI Codex w nowej karcie' : '🌐 Open OpenAI Codex login in new tab') : (currentLang === 'pl' ? '🌐 Otwórz logowanie Claude.ai w nowej karcie' : '🌐 Open Claude.ai login in new tab');

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
      inCode.placeholder = isCodex ? (currentLang === 'pl' ? 'Wklej kod lub URL callback (http://localhost:1455/auth/callback?code=...)' : 'Paste code or callback URL (http://localhost:1455/auth/callback?code=...)') : (currentLang === 'pl' ? 'Wklej kod lub URL callback (https://claude.ai/oauth/callback?code=...)' : 'Paste code or callback URL (https://claude.ai/oauth/callback?code=...)');
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
          note('ok', currentLang === 'pl' ? ('Zalogowano pomyślnie! Sesja konta "' + res.account + '" została odnowiona.') : ('Logged in successfully! Session for account "' + res.account + '" has been renewed.'));
          closeModal('modalRelogin');
          pendingOAuthState = null;
          poll();
        } else {
          note('error', (currentLang === 'pl' ? 'Błąd logowania: ' : 'Login error: ') + (res.error || (currentLang === 'pl' ? 'nieznany błąd' : 'unknown error')));
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
      note('error', currentLang === 'pl' ? 'Wklej treść JSON poświadczeń' : 'Paste credentials JSON content');
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
          note('ok', currentLang === 'pl' ? ('Zaktualizowano poświadczenia dla konta "' + res.account + '"') : ('Updated credentials for account "' + res.account + '"'));
          closeModal('modalRelogin');
          poll();
        } else {
          note('error', (currentLang === 'pl' ? 'Błąd aktualizacji konta: ' : 'Error updating account: ') + (res.error || (currentLang === 'pl' ? 'nieznany błąd' : 'unknown error')));
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
      note('error', currentLang === 'pl' ? 'Podaj ścieżkę do pliku na serwerze' : 'Provide file path on server');
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
          note('ok', currentLang === 'pl' ? ('Zaimportowano nowe poświadczenia dla konta "' + res.account + '"') : ('Imported new credentials for account "' + res.account + '"'));
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

  function updateModalCommands(name, key) {
    var realKey = (key && !key.includes('...')) ? key : (cachedClientKeys[name] || key || '');
    if (name === '__primary__' && primaryAdminKey) realKey = primaryAdminKey;
    var hostUrl = window.location.origin;
    var cmdKey = realKey || '<KLUCZ_STACJI>';

    var elName = document.getElementById('createdClientName');
    if (elName) elName.textContent = name || 'stacja';
    var elKey = document.getElementById('createdClientKey');
    if (elKey) elKey.textContent = realKey || (name ? 'Wczytywanie klucza...' : '<KLUCZ_STACJI>');

    var cmdBashMain = 'curl -fsSL ' + hostUrl + '/setup.sh | bash -s -- --key ' + cmdKey;
    var cmdPsMain = '& ([scriptblock]::Create((irm ' + hostUrl + '/setup.ps1))) -Key "' + cmdKey + '"';

    var elBashMain = document.getElementById('cmdSetupBashMain');
    if (elBashMain) elBashMain.textContent = cmdBashMain;
    var elPsMain = document.getElementById('cmdSetupPowershellMain');
    if (elPsMain) elPsMain.textContent = cmdPsMain;

    var cmdBash = 'curl -fsSL ' + hostUrl + '/claude-setup.sh | bash -s -- --key ' + cmdKey;
    var cmdCodexBash = 'curl -fsSL ' + hostUrl + '/codex-setup.sh | bash -s -- --key ' + cmdKey;
    var cmdAgentBash = [
      '# OpenCode, Hermes Agent, Aider (zmienne OpenAI / Anthropic):',
      'export OPENAI_BASE_URL="' + hostUrl + '/v1"',
      'export OPENAI_API_KEY="' + cmdKey + '"',
      'export ANTHROPIC_BASE_URL="' + hostUrl + '"',
      'export ANTHROPIC_API_KEY="' + cmdKey + '"',
      'export AGENT_LB_API_KEY="' + cmdKey + '"'
    ].join('\\n');

    var cmdPs = '& ([scriptblock]::Create((irm ' + hostUrl + '/claude-setup.ps1))) -Key "' + cmdKey + '"';
    var cmdCodexPs = '& ([scriptblock]::Create((irm ' + hostUrl + '/codex-setup.ps1))) -Key "' + cmdKey + '"';
    var cmdAgentPs = [
      '[Environment]::SetEnvironmentVariable("OPENAI_BASE_URL", "' + hostUrl + '/v1", "User")',
      '[Environment]::SetEnvironmentVariable("OPENAI_API_KEY", "' + cmdKey + '" , "User")',
      '[Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL", "' + hostUrl + '", "User")',
      '[Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", "' + cmdKey + '", "User")',
      '$env:OPENAI_BASE_URL = "' + hostUrl + '/v1"',
      '$env:OPENAI_API_KEY = "' + cmdKey + '"'
    ].join('\\n');

    var cmdNode = 'curl -fsSL ' + hostUrl + '/claude-setup.js | node - --key ' + cmdKey;
    var cmdCodexNode = 'curl -fsSL ' + hostUrl + '/codex-setup.js | node - --key ' + cmdKey;
    var cmdGit = 'git clone https://github.com/tomaasz/agent-lb.git && cd agent-lb && ./setup/claude-setup.sh --key ' + cmdKey;
    var cmdCodexGit = 'git clone https://github.com/tomaasz/agent-lb.git && cd agent-lb && ./setup/codex-setup.sh --key ' + cmdKey;
    var manualText = [
      '# --- 1. Claude Code CLI (OAuth / subscription — zalecane) ---',
      'export ANTHROPIC_BASE_URL="' + hostUrl + '"',
      'unset ANTHROPIC_API_KEY  # zachowaj sesję OAuth Claude Code',
      'export ANTHROPIC_CUSTOM_HEADERS="x-api-key: ' + cmdKey + '"',
      '',
      '# --- 1b. Claude Code CLI (tryb direct API Key) ---',
      'export ANTHROPIC_BASE_URL="' + hostUrl + '"',
      'export ANTHROPIC_API_KEY="' + cmdKey + '"',
      'unset ANTHROPIC_CUSTOM_HEADERS',
      '',
      '# --- 2. OpenAI Codex CLI ---',
      'export CODEX_BASE_URL="' + hostUrl + '/backend-api/codex"',
      'export CODEX_LB_API_KEY="' + cmdKey + '"',
      '',
      '# --- 3. OpenCode, Hermes Agent, Aider & OpenAI Compatible ---',
      'export OPENAI_BASE_URL="' + hostUrl + '/v1"',
      'export OPENAI_API_KEY="' + cmdKey + '"',
      'export AGENT_LB_API_KEY="' + cmdKey + '"',
      '',
      '# Przykłady uruchomienia narzędzi:',
      '# opencode                        -> OpenCode CLI (model z proxy)',
      '# aider --model openai/gpt-5.6-sol -> Aider CLI z routingiem agent-lb',
      '# hermes                          -> Hermes Agent z modelem na proxy'
    ].join('\\n');

    var elBash = document.getElementById('cmdSetupBash');
    if (elBash) elBash.textContent = cmdBash;
    var elCodexBash = document.getElementById('cmdSetupCodexBash');
    if (elCodexBash) elCodexBash.textContent = cmdCodexBash;
    var elAgentBash = document.getElementById('cmdSetupAgentBash');
    if (elAgentBash) elAgentBash.textContent = cmdAgentBash;

    var elPs = document.getElementById('cmdSetupPowershell');
    if (elPs) elPs.textContent = cmdPs;
    var elCodexPs = document.getElementById('cmdSetupCodexPowershell');
    if (elCodexPs) elCodexPs.textContent = cmdCodexPs;
    var elAgentPs = document.getElementById('cmdSetupAgentPowershell');
    if (elAgentPs) elAgentPs.textContent = cmdAgentPs;

    var elNode = document.getElementById('cmdSetupNode');
    if (elNode) elNode.textContent = cmdNode;
    var elCodexNode = document.getElementById('cmdSetupCodexNode');
    if (elCodexNode) elCodexNode.textContent = cmdCodexNode;

    var elGit = document.getElementById('cmdSetupGit');
    if (elGit) elGit.textContent = cmdGit;
    var elCodexGit = document.getElementById('cmdSetupCodexGit');
    if (elCodexGit) elCodexGit.textContent = cmdCodexGit;

    var elManual = document.getElementById('boxManualConfig');
    if (elManual) elManual.textContent = manualText;

    var cmdHermes = 'curl -fsSL ' + hostUrl + '/hermes-setup.sh | bash -s -- --key ' + cmdKey;
    var cmdOpenCode = 'curl -fsSL ' + hostUrl + '/opencode-setup.sh | bash -s -- --key ' + cmdKey;
    var cmdClaw = 'curl -fsSL ' + hostUrl + '/claw-setup.sh | bash -s -- --key ' + cmdKey;
    var cmdOrca = 'curl -fsSL ' + hostUrl + '/orca-setup.sh | bash -s -- --key ' + cmdKey;
    var cmdAider = 'mkdir -p ~/.aider && printf "openai-api-base: ' + hostUrl + '/v1\\nopenai-api-key: ' + cmdKey + '\\nmodel: openai/gpt-5.6-sol\\n" > ~/.aider.conf.yml';

    var elHermes = document.getElementById('cmdSetupHermes');
    if (elHermes) elHermes.textContent = cmdHermes;
    var elOpenCode = document.getElementById('cmdSetupOpenCode');
    if (elOpenCode) elOpenCode.textContent = cmdOpenCode;
    var elClaw = document.getElementById('cmdSetupClaw');
    if (elClaw) elClaw.textContent = cmdClaw;
    var elOrca = document.getElementById('cmdSetupOrca');
    if (elOrca) elOrca.textContent = cmdOrca;
    var elAider = document.getElementById('cmdSetupAider');
    if (elAider) elAider.textContent = cmdAider;
  }

  function showKeyModal(name, key) {
    var list = (lastStatus && lastStatus.clientKeys) || [];
    var selModal = document.getElementById('selModalStation');
    if (selModal) {
      selModal.textContent = '';
      if (list.length) {
        list.forEach(function (k) {
          var opt = el('option', '', k.name);
          opt.value = k.name;
          selModal.appendChild(opt);
        });
      }
      if (primaryAdminKey) {
        var optAdmin = el('option', '', '👑 Admin (Master)');
        optAdmin.value = '__primary__';
        selModal.appendChild(optAdmin);
      }
      if (!list.length && !primaryAdminKey) {
        var optNone = el('option', '', 'Stacja');
        optNone.value = '';
        selModal.appendChild(optNone);
      }
    }

    var chosenName = name || (selModal ? selModal.value : '');
    if (!chosenName && selModal && selModal.options.length) {
      chosenName = selModal.options[0].value;
    }
    if (selModal && chosenName) {
      selModal.value = chosenName;
    }

    var realKey = (key && !key.includes('...')) ? key : (cachedClientKeys[chosenName] || '');
    if (chosenName === '__primary__' && primaryAdminKey) {
      realKey = primaryAdminKey;
    }

    if (realKey && !realKey.includes('...') && chosenName !== '__primary__') {
      cachedClientKeys[chosenName] = realKey;
      saveCachedKeys();
    }

    updateModalCommands(chosenName, realKey);

    // Asynchronously fetch key if missing
    if (!realKey && chosenName) {
      apiCall('/agent-lb/api/keys/reveal', 'POST', { name: chosenName })
        .then(function (rev) {
          if (rev && rev.ok && rev.key) {
            if (chosenName === '__primary__') {
              primaryAdminKey = rev.key;
            } else {
              cachedClientKeys[chosenName] = rev.key;
              saveCachedKeys();
            }
            if (selModal && selModal.value === chosenName) {
              updateModalCommands(chosenName, rev.key);
            }
            updateQuickCmd();
          }
        })
        .catch(function () {});
    }

    // Attach change listener to selModalStation
    if (selModal && !selModal._bound) {
      selModal._bound = true;
      selModal.addEventListener('change', function () {
        var st = this.value;
        var k = (st === '__primary__') ? primaryAdminKey : (cachedClientKeys[st] || '');
        showKeyModal(st, k);
        var selQuick = document.getElementById('selQuickStation');
        if (selQuick && Array.from(selQuick.options).some(function (o) { return o.value === st; })) {
          selQuick.value = st;
          updateQuickCmd();
        }
      });
    }

    selectSetupTab('Bash');
    openModal('modalKeyCreated');
  }

  function selectSetupTab(tab) {
    var tabs = ['Bash', 'Powershell'];
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
      note('error', currentLang === 'pl' ? 'Nazwa klienta / urządzenia jest wymagana' : 'Workstation / device name is required');
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
    apiCall('/agent-lb/api/keys/create', 'POST', payload)
      .then(function (res) {
        btn.disabled = false;
        if (!res) return;
        if (res.ok) {
          note('ok', currentLang === 'pl' ? ('Utworzono klucz klienta dla "' + res.name + '"') : ('Created workstation key for "' + res.name + '"'));
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
          note('error', (currentLang === 'pl' ? 'Błąd tworzenia klucza: ' : 'Error creating key: ') + (res.error || (currentLang === 'pl' ? 'nieznany błąd' : 'unknown error')));
        }
      })
      .catch(function (e) {
        btn.disabled = false;
        note('error', 'Błąd tworzenia klucza: ' + e.message);
      });
  }

  function doRemoveClientKey(name, btn) {
    if (!confirm(currentLang === 'pl' ? ('Czy na pewno chcesz unieważnić klucz klienta dla "' + name + '"? Ruch z tego urządzenia zostanie natychmiast odrzucony.') : ('Are you sure you want to revoke workstation key for "' + name + '"? Traffic from this device will be immediately rejected.'))) return;
    if (btn) btn.disabled = true;
    apiCall('/agent-lb/api/keys/delete', 'POST', { name: name })
      .then(function (res) {
        if (btn) btn.disabled = false;
        if (!res) return;
        if (res.ok) {
          note('ok', currentLang === 'pl' ? ('Unieważniono klucz klienta "' + name + '"') : ('Revoked workstation key "' + name + '"'));
          delete cachedClientKeys[name];
          poll();
        } else {
          note('error', (currentLang === 'pl' ? 'Błąd unieważniania klucza: ' : 'Error revoking key: ') + (res.error || (currentLang === 'pl' ? 'nieznany błąd' : 'unknown error')));
        }
      })
      .catch(function (e) {
        if (btn) btn.disabled = false;
        note('error', 'Błąd unieważniania klucza: ' + e.message);
      });
  }

  var currentQuickTab = 'bash';
  var currentQuickTool = 'all';
  var currentQuickKey = '';

  function updateQuickCmd(keys) {
    var hostUrl = window.location.origin;
    var list = keys || (lastStatus && lastStatus.clientKeys) || [];

    // Populate selQuickStation dropdown if available
    var sel = document.getElementById('selQuickStation');
    if (sel) {
      var prevVal = sel.value;
      sel.textContent = '';
      if (list.length) {
        list.forEach(function (k) {
          var opt = el('option', '', k.name);
          opt.value = k.name;
          sel.appendChild(opt);
        });
        if (primaryAdminKey) {
          var optAdmin = el('option', '', '👑 Admin (Master)');
          optAdmin.value = '__primary__';
          sel.appendChild(optAdmin);
        }
        if (prevVal && Array.from(sel.options).some(function (o) { return o.value === prevVal; })) {
          sel.value = prevVal;
        }
      } else if (primaryAdminKey) {
        var optAdminOnly = el('option', '', '👑 Admin (Master)');
        optAdminOnly.value = '__primary__';
        sel.appendChild(optAdminOnly);
      } else {
        var optNone = el('option', '', currentLang === 'pl' ? '(brak stacji)' : '(no stations)');
        optNone.value = '';
        sel.appendChild(optNone);
      }
    }

    var selectedStationName = sel ? sel.value : '';
    var key = '';

    if (selectedStationName === '__primary__' || (sel && sel.value === '__primary__')) {
      key = primaryAdminKey;
    } else if (selectedStationName && cachedClientKeys[selectedStationName]) {
      key = cachedClientKeys[selectedStationName];
    } else if (currentQuickKey && !currentQuickKey.includes('...')) {
      key = currentQuickKey;
    } else if (list.length) {
      for (var i = 0; i < list.length; i++) {
        var cand = cachedClientKeys[list[i].name] || ((list[i].rawKey && !list[i].rawKey.includes('...')) ? list[i].rawKey : '');
        if (cand) {
          key = cand;
          if (sel && !selectedStationName) sel.value = list[i].name;
          break;
        }
      }
    }

    if (!key && primaryAdminKey && !primaryAdminKey.includes('...')) {
      key = primaryAdminKey;
    }
    if (!key) key = '<KLUCZ_STACJI>';

    var chk = document.getElementById('chkIncludeKeyInCmd');
    var withKey = chk ? chk.checked : true;

    var cmd = '';
    if (currentQuickTool === 'all' || !currentQuickTool) {
      if (currentQuickTab === 'ps') {
        cmd = withKey
          ? '& ([scriptblock]::Create((irm ' + hostUrl + '/setup.ps1))) -Key "' + key + '"'
          : 'irm ' + hostUrl + '/setup.ps1 | iex';
      } else {
        cmd = withKey
          ? 'curl -fsSL ' + hostUrl + '/setup.sh | bash -s -- --key ' + key
          : 'curl -fsSL ' + hostUrl + '/setup.sh | bash';
      }
    } else if (currentQuickTool === 'hermes') {
      cmd = withKey
        ? 'curl -fsSL ' + hostUrl + '/hermes-setup.sh | bash -s -- --key ' + key
        : 'curl -fsSL ' + hostUrl + '/hermes-setup.sh | bash';
    } else if (currentQuickTool === 'opencode') {
      cmd = withKey
        ? 'curl -fsSL ' + hostUrl + '/opencode-setup.sh | bash -s -- --key ' + key
        : 'curl -fsSL ' + hostUrl + '/opencode-setup.sh | bash';
    } else if (currentQuickTool === 'claw') {
      cmd = withKey
        ? 'curl -fsSL ' + hostUrl + '/claw-setup.sh | bash -s -- --key ' + key
        : 'curl -fsSL ' + hostUrl + '/claw-setup.sh | bash';
    } else if (currentQuickTool === 'orca') {
      cmd = withKey
        ? 'curl -fsSL ' + hostUrl + '/orca-setup.sh | bash -s -- --key ' + key
        : 'curl -fsSL ' + hostUrl + '/orca-setup.sh | bash';
    } else if (currentQuickTool === 'agy') {
      // The station key lets agybridge take its Google account from the AGY
      // pool in this dashboard. On Windows it runs inside WSL (Linux/macOS only).
      var agyArgs = withKey ? ' -s -- --key ' + key : '';
      cmd = currentQuickTab === 'ps'
        ? 'wsl bash -lc "curl -fsSL ' + hostUrl + '/agy-setup.sh | bash' + agyArgs + '"'
        : 'curl -fsSL ' + hostUrl + '/agy-setup.sh | bash' + agyArgs;
    } else if (currentQuickTool === 'agent') {
      if (currentQuickTab === 'ps') {
        cmd = '$env:OPENAI_BASE_URL="' + hostUrl + '/v1"; $env:OPENAI_API_KEY="' + (withKey ? key : '<KLUCZ>') + '"; $env:ANTHROPIC_BASE_URL="' + hostUrl + '"; $env:ANTHROPIC_API_KEY="' + (withKey ? key : '<KLUCZ>') + '"';
      } else {
        cmd = 'export OPENAI_BASE_URL="' + hostUrl + '/v1" OPENAI_API_KEY="' + (withKey ? key : '<KLUCZ>') + '" ANTHROPIC_BASE_URL="' + hostUrl + '" ANTHROPIC_API_KEY="' + (withKey ? key : '<KLUCZ>') + '"';
      }
    } else if (currentQuickTool === 'codex') {
      if (currentQuickTab === 'ps') {
        cmd = withKey
          ? '& ([scriptblock]::Create((irm ' + hostUrl + '/codex-setup.ps1))) -Key "' + key + '"'
          : 'irm ' + hostUrl + '/codex-setup.ps1 | iex';
      } else {
        cmd = withKey
          ? 'curl -fsSL ' + hostUrl + '/codex-setup.sh | bash -s -- --key ' + key
          : 'curl -fsSL ' + hostUrl + '/codex-setup.sh | bash';
      }
    } else {
      if (currentQuickTab === 'ps') {
        cmd = withKey
          ? '& ([scriptblock]::Create((irm ' + hostUrl + '/claude-setup.ps1))) -Key "' + key + '"'
          : 'irm ' + hostUrl + '/claude-setup.ps1 | iex';
      } else {
        cmd = withKey
          ? 'curl -fsSL ' + hostUrl + '/claude-setup.sh | bash -s -- --key ' + key
          : 'curl -fsSL ' + hostUrl + '/claude-setup.sh | bash';
      }
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

  function setQuickTool(tool) {
    currentQuickTool = tool;
    var tools = [
      { id: 'btnQuickToolAll', name: 'all' },
      { id: 'btnQuickToolClaude', name: 'claude' },
      { id: 'btnQuickToolCodex', name: 'codex' },
      { id: 'btnQuickToolHermes', name: 'hermes' },
      { id: 'btnQuickToolOpenCode', name: 'opencode' },
      { id: 'btnQuickToolClaw', name: 'claw' },
      { id: 'btnQuickToolOrca', name: 'orca' },
      { id: 'btnQuickToolAgy', name: 'agy' },
      { id: 'btnQuickToolAgent', name: 'agent' }
    ];
    tools.forEach(function (t) {
      var btn = document.getElementById(t.id);
      if (btn) {
        if (t.name === tool) btn.classList.add('active');
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
      var unmasked = cachedClientKeys[k.name] || '';
      if (unmasked) {
        cachedClientKeys[k.name] = unmasked;
      }
    });

    var container = document.getElementById('clientKeysTable');
    if (!container) return;
    container.textContent = '';

    // Update workstation counter
    var countEl = document.getElementById('countClientKeys');
    if (countEl) {
      var wsCount = list.length;
      countEl.textContent = wsCount === 1
        ? (currentLang === 'pl' ? '1 stacja' : '1 workstation')
        : (wsCount + (currentLang === 'pl' ? ' stacji' : ' workstations'));
    }
    var bWork = document.getElementById('tabBadgeWorkstations');
    if (bWork) {
      bWork.textContent = list.length;
    }

    // 1. Dedicated Master Admin Key banner at top
    if (primaryAdminKey) {
      var pBanner = el('div', 'master-key-banner');
      var isPRevealed = !!revealedKeys['__primary__'];

      var pTop = el('div', 'master-key-top');
      var pTitleWrap = el('div', 'row');
      pTitleWrap.style.gap = '6px';
      pTitleWrap.style.alignItems = 'center';
      pTitleWrap.appendChild(el('span', '', '👑'));
      var pTitle = el('span', 'master-key-title', t('primaryAdminKeyName'));
      pTitleWrap.appendChild(pTitle);
      var pBadge = el('span', 'badge', 'Master / proxy.apiKey');
      pBadge.style.cssText = 'font-size:10px; padding:1px 6px; background:rgba(59, 130, 246, 0.18); color:#60a5fa; border-radius:4px; border:1px solid rgba(59, 130, 246, 0.35); font-weight:600;';
      pTitleWrap.appendChild(pBadge);
      pTop.appendChild(pTitleWrap);

      var pTopActs = el('div', 'card-actions');
      var btnPSetup = el('button', 'btn btn-xs', currentLang === 'pl' ? 'Terminal CLI ↗' : 'CLI Setup ↗');
      btnPSetup.title = currentLang === 'pl' ? 'Pokaż komendy instalatora z kluczem administratora' : 'Show installer commands with administrator key';
      btnPSetup.addEventListener('click', function () {
        currentQuickKey = primaryAdminKey;
        updateQuickCmd();
        showKeyModal(currentLang === 'pl' ? 'Główny klucz (proxy.apiKey)' : 'Master key (proxy.apiKey)', primaryAdminKey);
      });
      pTopActs.appendChild(btnPSetup);
      pTop.appendChild(pTopActs);
      pBanner.appendChild(pTop);

      var pSub = el('div', 'master-key-sub', currentLang === 'pl' ? 'Dostęp administracyjny do panelu zarządzania i konfiguracji serwera' : 'Full administrative access to the dashboard and proxy server');
      pBanner.appendChild(pSub);

      var pBottom = el('div', 'master-key-bottom');
      var pKeyWrap = el('div', 'row');
      pKeyWrap.style.gap = '5px';
      pKeyWrap.style.alignItems = 'center';
      var pMasked = isPRevealed ? primaryAdminKey : (primaryAdminKey.length > 8 ? primaryAdminKey.slice(0, 5) + '••••••••' + primaryAdminKey.slice(-4) : '••••••••');
      var pKeySpan = el('span', 'mono master-key-val', pMasked);
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
        copyToClipboard(primaryAdminKey, currentLang === 'pl' ? 'Główny klucz administratora' : 'Master administrator key');
      });
      pKeyWrap.appendChild(btnPCopy);
      pBottom.appendChild(pKeyWrap);
      pBanner.appendChild(pBottom);

      container.appendChild(pBanner);
    }

    // Update Quick Command box and selector
    updateQuickCmd(keys);

    // Empty state if no workstations configured
    if (!list.length) {
      var empty = el('div', '', t('emptyNoKeys'));
      empty.style.cssText = 'padding:16px; text-align:center; color:var(--dim); font-size:12px; border:1px dashed var(--line); border-radius:7px; margin-top:4px;';
      container.appendChild(empty);
      return;
    }

    // 2. Render each workstation card
    list.forEach(function (k) {
      var card = el('div', 'workstation-card client-key-card');
      var raw = cachedClientKeys[k.name] || '';
      if (raw && !raw.includes('...')) {
        cachedClientKeys[k.name] = raw;
      }
      var isRevealed = !!revealedKeys[k.name];
      var stat = (k.stats) || (clients && clients[k.name]) || {};
      var inT = stat.inputTokens || 0;
      var outT = stat.outputTokens || 0;
      var reqCount = stat.requests || 0;
      var lastUsedTs = stat.lastUsed ? parseTs(stat.lastUsed) : 0;
      var isRecentlyActive = lastUsedTs > 0 && (Date.now() - lastUsedTs < 24 * 3600 * 1000);

      if (isRecentlyActive) {
        card.classList.add('active-workstation');
      } else {
        card.classList.add('idle-workstation');
      }

      // Workstation Header
      var topRow = el('div', 'workstation-header');

      var nameWrap = el('div', 'workstation-identity');
      nameWrap.appendChild(el('span', '', '💻'));
      var nameEl = el('span', 'workstation-name', k.name);
      nameWrap.appendChild(nameEl);

      // Activity badge
      if (stat.lastUsed) {
        var actBadge = el('span', 'workstation-badge-live', '🟢 ' + fmtAgo(stat.lastUsed));
        actBadge.title = (currentLang === 'pl' ? 'Ostatnia aktywność: ' : 'Last activity: ') + new Date(stat.lastUsed).toLocaleString();
        nameWrap.appendChild(actBadge);
      } else if (reqCount > 0) {
        var actBadgeOld = el('span', 'workstation-badge-live', currentLang === 'pl' ? '● Aktywna' : '● Active');
        nameWrap.appendChild(actBadgeOld);
      } else {
        var idleBadge = el('span', 'workstation-badge-idle', currentLang === 'pl' ? '⚪ Oczekuje na ruch' : '⚪ Idle (no requests)');
        nameWrap.appendChild(idleBadge);
      }

      if (k.expiresAt) {
        var expMs = parseTs(k.expiresAt);
        var isExp = expMs < Date.now();
        var expBadge = el('span', 'badge ' + (isExp ? 'bad' : 'ok'), isExp ? (currentLang === 'pl' ? '⚠️ Wygasł' : '⚠️ Expired') : '📅 ' + (typeof k.expiresAt === 'string' ? k.expiresAt.split('T')[0] : new Date(k.expiresAt).toLocaleDateString()));
        expBadge.style.fontSize = '9.5px';
        nameWrap.appendChild(expBadge);
      }

      if (Array.isArray(k.allowedModels) && k.allowedModels.length) {
        var mBadge = el('span', 'badge', '🎯 ' + k.allowedModels.join(', '));
        mBadge.style.cssText = 'font-size:9.5px; padding:1px 5px; background:rgba(255,255,255,0.06); border-radius:3px;';
        nameWrap.appendChild(mBadge);
      }

      topRow.appendChild(nameWrap);

      // Actions: Setup and Revoke
      var acts = el('div', 'card-actions');

      var btnSetup = el('button', 'btn btn-xs btn-accent', t('btnKeyConnect'));
      btnSetup.title = currentLang === 'pl' ? 'Pokaż gotowe komendy instalatora (Linux, Windows, VS Code) dla tej stacji' : 'Show installer commands (Linux, Windows, VS Code) for this workstation';
      btnSetup.addEventListener('click', function () {
        var kVal = cachedClientKeys[k.name] || raw || '';
        showKeyModal(k.name, kVal);
      });
      acts.appendChild(btnSetup);

      var btnDel = el('button', 'btn btn-xs btn-bad', currentLang === 'pl' ? 'Unieważnij' : 'Revoke');
      btnDel.title = currentLang === 'pl' ? 'Unieważnij i usuń tę stację' : 'Revoke and delete this workstation key';
      btnDel.addEventListener('click', function () {
        doRemoveClientKey(k.name, btnDel);
      });
      acts.appendChild(btnDel);

      topRow.appendChild(acts);
      card.appendChild(topRow);

      // Workstation Metrics Box (integrated stats)
      var metricsBox = el('div', 'workstation-metrics');

      var mReq = el('div', 'ws-metric-item');
      mReq.appendChild(el('span', 'ws-metric-label', currentLang === 'pl' ? 'Zapytania' : 'Requests'));
      mReq.appendChild(el('span', 'ws-metric-val', fmtNum(reqCount)));
      metricsBox.appendChild(mReq);

      var mIn = el('div', 'ws-metric-item');
      mIn.appendChild(el('span', 'ws-metric-label', currentLang === 'pl' ? 'Wejście (in)' : 'Input tok'));
      mIn.appendChild(el('span', 'ws-metric-val', inT ? fmtNum(inT) : '0'));
      metricsBox.appendChild(mIn);

      var mOut = el('div', 'ws-metric-item');
      mOut.appendChild(el('span', 'ws-metric-label', currentLang === 'pl' ? 'Wyjście (out)' : 'Output tok'));
      mOut.appendChild(el('span', 'ws-metric-val', outT ? fmtNum(outT) : '0'));
      metricsBox.appendChild(mOut);

      card.appendChild(metricsBox);

      // Optional Daily / Monthly token limit progress bars
      if (k.maxDailyTokens || k.maxMonthlyTokens) {
        var limitWrap = el('div', 'workstation-limits');
        limitWrap.style.cssText = 'font-size:10.5px; color:var(--dim); margin-top:2px; display:flex; gap:12px; flex-wrap:wrap;';
        if (k.maxDailyTokens) {
          var dUsed = k.dailyTokens || 0;
          var dPct = Math.min(100, Math.round((dUsed / k.maxDailyTokens) * 100));
          var dColor = dPct >= 90 ? '#f85149' : (dPct >= 70 ? '#d29922' : 'var(--text)');
          var dEl = el('span', '', (currentLang === 'pl' ? 'Dziś: ' : 'Today: '));
          var dVal = el('b', '', fmtNum(dUsed) + ' / ' + fmtNum(k.maxDailyTokens) + ' (' + dPct + '%)');
          dVal.style.color = dColor;
          dEl.appendChild(dVal);
          limitWrap.appendChild(dEl);
        }
        if (k.maxMonthlyTokens) {
          var mUsed = k.monthlyTokens || 0;
          var mPct = Math.min(100, Math.round((mUsed / k.maxMonthlyTokens) * 100));
          var mColor = mPct >= 90 ? '#f85149' : (mPct >= 70 ? '#d29922' : 'var(--text)');
          var mEl = el('span', '', (currentLang === 'pl' ? 'Miesiąc: ' : 'Month: '));
          var mVal = el('b', '', fmtNum(mUsed) + ' / ' + fmtNum(k.maxMonthlyTokens) + ' (' + mPct + '%)');
          mVal.style.color = mColor;
          mEl.appendChild(mVal);
          limitWrap.appendChild(mEl);
        }
        card.appendChild(limitWrap);
      }

      // Workstation Footer (Key + Show + Copy)
      var bottomRow = el('div', 'workstation-footer');
      var keyWrap = el('div', 'workstation-key-box');
      keyWrap.appendChild(el('span', '', '🔑'));
      var masked = !raw ? (k.maskedKey || k.key || '***') : isRevealed ? raw : (raw.length > 8 ? raw.slice(0, 5) + '••••••••' + raw.slice(-4) : '••••••••');
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
        var toCopy = cachedClientKeys[k.name] || raw;
        if (toCopy) {
          copyToClipboard(toCopy, (currentLang === 'pl' ? 'Klucz stacji ' : 'Station key ') + k.name);
        } else {
          apiCall('/agent-lb/api/keys/reveal', 'POST', { name: k.name })
            .then(function (rev) {
              if (rev && rev.ok && rev.key) {
                cachedClientKeys[k.name] = rev.key;
                saveCachedKeys();
                copyToClipboard(rev.key, (currentLang === 'pl' ? 'Klucz stacji ' : 'Station key ') + k.name);
                renderClientKeys(keys, clients);
              }
            });
        }
      });
      keyWrap.appendChild(btnCopy);
      bottomRow.appendChild(keyWrap);

      // Active websocket badge if any
      if (stat.connections > 0) {
        var wsBadge = el('span', 'badge', '🔌 ' + stat.connections + ' WS');
        wsBadge.style.cssText = 'font-size:9.5px; padding:1px 5px; color:#58a6ff;';
        bottomRow.appendChild(wsBadge);
      }

      card.appendChild(bottomRow);
      container.appendChild(card);
    });

    // Also render any unmapped active clients (direct traffic)
    var knownNames = {};
    list.forEach(function (k) { knownNames[k.name] = true; });
    Object.keys(clients || {}).forEach(function (clientName) {
      if (knownNames[clientName]) return;
      var stat = clients[clientName] || {};
      var card = el('div', 'workstation-card idle-workstation');
      var topRow = el('div', 'workstation-header');
      var nameWrap = el('div', 'workstation-identity');
      nameWrap.appendChild(el('span', '', '💻'));
      nameWrap.appendChild(el('span', 'workstation-name', clientName));
      if (stat.lastUsed) {
        var b = el('span', 'workstation-badge-live', '🟢 ' + fmtAgo(stat.lastUsed));
        nameWrap.appendChild(b);
      }
      var unmappedBadge = el('span', 'badge', currentLang === 'pl' ? 'Ruch bezpośredni' : 'Direct traffic');
      unmappedBadge.style.cssText = 'font-size:9.5px; padding:1px 5px; background:rgba(255,255,255,0.06); border-radius:3px;';
      nameWrap.appendChild(unmappedBadge);
      topRow.appendChild(nameWrap);
      card.appendChild(topRow);

      var metricsBox = el('div', 'workstation-metrics');
      var mReq = el('div', 'ws-metric-item');
      mReq.appendChild(el('span', 'ws-metric-label', currentLang === 'pl' ? 'Zapytania' : 'Requests'));
      mReq.appendChild(el('span', 'ws-metric-val', fmtNum(stat.requests || 0)));
      metricsBox.appendChild(mReq);

      var mIn = el('div', 'ws-metric-item');
      mIn.appendChild(el('span', 'ws-metric-label', currentLang === 'pl' ? 'Wejście (in)' : 'Input tok'));
      mIn.appendChild(el('span', 'ws-metric-val', stat.inputTokens ? fmtNum(stat.inputTokens) : '0'));
      metricsBox.appendChild(mIn);

      var mOut = el('div', 'ws-metric-item');
      mOut.appendChild(el('span', 'ws-metric-label', currentLang === 'pl' ? 'Wyjście (out)' : 'Output tok'));
      mOut.appendChild(el('span', 'ws-metric-val', stat.outputTokens ? fmtNum(stat.outputTokens) : '0'));
      metricsBox.appendChild(mOut);
      card.appendChild(metricsBox);

      container.appendChild(card);
    });
  }

  function doPullSetup(btn) {
    if (btn) btn.disabled = true;
    note('ok', currentLang === 'pl' ? 'Pobieranie aktualizacji repozytorium agent-lb z GitHub...' : 'Pulling agent-lb repository updates from GitHub...');
    apiCall('/agent-lb/api/setup/pull', 'POST')
      .then(function (res) {
        if (btn) btn.disabled = false;
        if (!res) return;
        if (res.ok) {
          note('ok', (currentLang === 'pl' ? 'Zaktualizowano repozytorium agent-lb: ' : 'Updated agent-lb repository: ') + (res.output || (currentLang === 'pl' ? 'Już aktualne.' : 'Already up to date.')));
        } else {
          note('error', (currentLang === 'pl' ? 'Błąd git pull: ' : 'git pull error: ') + (res.error || (currentLang === 'pl' ? 'nieznany błąd' : 'unknown error')));
        }
      })
      .catch(function (e) {
        if (btn) btn.disabled = false;
        note('error', (currentLang === 'pl' ? 'Błąd aktualizacji repozytorium: ' : 'Repository update error: ') + e.message);
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

  // A login/verify refusal can be the proxy's own key gate, which answers in
  // the API error shape { error: { type, message } } rather than the auth
  // endpoints' { error: "text" }. Rendering that object verbatim showed
  // "[object Object]" — typically right after a key rotation, when the browser
  // still held the old key.
  function keyboxErrorText(err, lang) {
    if (err == null || err === '') return '';
    var text = typeof err === 'string' ? err : (err && typeof err.message === 'string' ? err.message : '');
    if (!text || text === 'Invalid proxy API key') {
      return lang === 'pl'
        ? 'Nieprawidłowy klucz. Jeśli klucz był niedawno zmieniany, wpisz nowy.'
        : 'Invalid key. If the key was changed recently, enter the new one.';
    }
    return text;
  }

  function showKeybox(errMsg, infoMsg) {
    errMsg = keyboxErrorText(errMsg, currentLang);
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
            showKeybox(currentLang === 'pl' ? 'Nieprawidłowy klucz proxy API. Upewnij się, że podajesz klucz administracyjny (proxy.apiKey).' : 'Invalid proxy API key. Make sure you provide the master administrative key (proxy.apiKey).');
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
              if (kd.primaryKey) primaryAdminKey = kd.primaryKey;
              else if (apiKey) primaryAdminKey = apiKey;
              if (Array.isArray(kd.keys)) {
                renderClientKeys(kd.keys, s.clients);
              }
              apiCall('/agent-lb/api/keys/reveal', 'POST', { all: true })
                .then(function (rev) {
                  if (rev && rev.ok && rev.keys) {
                    Object.assign(cachedClientKeys, rev.keys);
                    if (rev.primaryKey) primaryAdminKey = rev.primaryKey;
                    saveCachedKeys();
                    if (Array.isArray(kd.keys)) renderClientKeys(kd.keys, s.clients);
                    updateQuickCmd();
                  }
                })
                .catch(function () {});
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
            showKeybox(errData && errData.error ? errData.error : (currentLang === 'pl' ? 'Sesja wygasła lub klucz API jest nieprawidłowy.' : 'Session expired or API key is invalid.'));
          }).catch(function () {
            showKeybox(currentLang === 'pl' ? 'Sesja wygasła lub klucz API jest nieprawidłowy.' : 'Session expired or API key is invalid.');
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
    v = v.replace(/^export\\s+ANTHROPIC_API_KEY\\s*=\\s*/i, '')
         .replace(/^ANTHROPIC_API_KEY\\s*=\\s*/i, '')
         .replace(/^["']|["']$/g, '')
         .trim();
    if (!v) {
      showKeybox(currentLang === 'pl' ? 'Wprowadź hasło lub klucz API przed połączeniem.' : 'Enter password or API key before connecting.');
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
            showKeybox(errData && errData.error ? errData.error : (currentLang === 'pl' ? 'Nieprawidłowe hasło lub klucz administracyjny.' : 'Invalid password or administrative key.'));
          }).catch(function () {
            showKeybox(currentLang === 'pl' ? 'Nieprawidłowe hasło lub klucz administracyjny.' : 'Invalid password or administrative key.');
          });
        }
      })
      .catch(function (e) {
        showKeybox((currentLang === 'pl' ? 'Błąd połączenia: ' : 'Connection error: ') + e.message);
      })
      .finally(function () {
        btn.disabled = false;
        btn.textContent = currentLang === 'pl' ? 'Zaloguj się' : 'Log In';
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

  // Header button: Reboot server
  var btnReboot = document.getElementById('btnRebootServer');
  if (btnReboot) {
    btnReboot.addEventListener('click', function () { doRebootServer(this); });
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

  // --- AGY (Google Antigravity) accounts ------------------------------------
  // Tokens never reach the page: the list carries e-mails and quota state only.
  var agyLogin = null;
  function agyT(pl, en) { return currentLang === 'pl' ? pl : en; }
  function agyLeft(ms) {
    var m = Math.max(1, Math.round(ms / 60000));
    var h = Math.floor(m / 60);
    return h ? (h + 'h ' + (m % 60) + 'm') : (m + 'm');
  }
  function loadAgyAccounts() {
    var key = localStorage.getItem(KEY) || '';
    var headers = {};
    if (key) headers['x-api-key'] = key;
    return fetch('/agent-lb/api/agy/accounts', { headers: headers })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.ok) renderAgyAccounts(d.accounts || []); })
      .catch(function () {});
  }
  function agyAction(path, body, okMsg) {
    return apiCall('/agent-lb/api/agy/' + path, 'POST', body).then(function (d) {
      if (d && d.ok) { if (okMsg) note('ok', okMsg); }
      else if (d) note('error', d.error || 'error');
      return loadAgyAccounts();
    });
  }
  function agyButton(label, title, onClick) {
    var b = document.createElement('button');
    b.className = 'btn btn-xs';
    b.type = 'button';
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }
  function renderAgyAccounts(list) {
    var box = document.getElementById('listAgy');
    if (!box) return;
    var count = document.getElementById('countAgy');
    if (count) count.textContent = list.length + ' ' + agyT('kont', 'accounts');
    box.textContent = '';
    if (!list.length) {
      var empty = document.createElement('div');
      empty.className = 'agy-hint';
      empty.textContent = agyT('Brak kont. Zaloguj pierwsze konto Google przyciskiem powyżej.', 'No accounts yet. Log in the first Google account with the button above.');
      box.appendChild(empty);
      return;
    }
    var ids = list.map(function (a) { return a.id; });
    list.forEach(function (a, i) {
      var row = document.createElement('div');
      row.className = 'agy-row' + (a.enabled ? '' : ' off');
      var email = document.createElement('span');
      email.className = 'agy-email';
      email.textContent = (i + 1) + '. ' + a.email;
      row.appendChild(email);
      var state = document.createElement('span');
      var parts = [];
      if (!a.enabled) parts.push(agyT('⏸ wyłączone', '⏸ disabled'));
      else if (a.quotaUntil) parts.push(agyT('⏳ limit wyczerpany, odnowienie za ', '⏳ quota spent, resets in ') + agyLeft(a.quotaUntil - Date.now()));
      else parts.push(agyT('✅ dostępne', '✅ available'));
      if (a.pinned) parts.push(agyT('📌 przypięte', '📌 pinned'));
      if (a.usedBy && a.usedBy.length) parts.push(agyT('używa: ', 'used by: ') + a.usedBy.join(', '));
      state.className = 'agy-state' + (a.quotaUntil ? ' spent' : '');
      state.textContent = parts.join(' · ');
      if (a.quotaMessage) state.title = a.quotaMessage;
      row.appendChild(state);
      var actions = document.createElement('span');
      actions.className = 'agy-actions';
      if (i > 0) actions.appendChild(agyButton('↑', agyT('Wyżej na liście', 'Move up'), function () {
        var next = ids.slice(); next.splice(i - 1, 0, next.splice(i, 1)[0]);
        agyAction('accounts/reorder', { ids: next });
      }));
      if (i < list.length - 1) actions.appendChild(agyButton('↓', agyT('Niżej na liście', 'Move down'), function () {
        var next = ids.slice(); next.splice(i + 1, 0, next.splice(i, 1)[0]);
        agyAction('accounts/reorder', { ids: next });
      }));
      actions.appendChild(a.pinned
        ? agyButton(agyT('Odepnij', 'Unpin'), agyT('Wróć do automatycznego wyboru', 'Back to automatic choice'), function () { agyAction('accounts/pin', { id: null }); })
        : agyButton(agyT('📌 Użyj', '📌 Use'), agyT('Wszystkie stacje używają tego konta, dopóki ma limit', 'All stations use this account while it has quota'), function () { agyAction('accounts/pin', { id: a.id }, agyT('Przypięto ', 'Pinned ') + a.email); }));
      actions.appendChild(agyButton(a.enabled ? agyT('Wyłącz', 'Disable') : agyT('Włącz', 'Enable'), '', function () {
        agyAction('accounts/enable', { id: a.id, enabled: !a.enabled });
      }));
      if (a.quotaUntil) actions.appendChild(agyButton(agyT('Wyczyść limit', 'Clear quota'), agyT('Uznaj, że limit wrócił (np. po zmianie planu)', 'Treat the quota as back (e.g. after a plan change)'), function () {
        agyAction('accounts/clear-quota', { id: a.id });
      }));
      actions.appendChild(agyButton('🗑', agyT('Usuń konto', 'Remove account'), function () {
        if (confirm(agyT('Usunąć konto ', 'Remove account ') + a.email + '?')) agyAction('accounts/remove', { id: a.id }, agyT('Usunięto ', 'Removed ') + a.email);
      }));
      row.appendChild(actions);
      box.appendChild(row);
    });
  }
  function agyEl(id) { return document.getElementById(id); }
  function agyStopTimer() {
    if (agyLogin && agyLogin.timer) clearInterval(agyLogin.timer);
  }
  function agyShowResult(ok, text) {
    var r = agyEl('agyLoginResult');
    r.style.display = 'block';
    r.style.color = ok ? 'var(--ok)' : 'var(--err, #f85149)';
    r.textContent = text;
  }
  function agyExpired(text) {
    agyStopTimer();
    agyEl('agyLoginStep').style.display = 'none';
    agyShowResult(false, text);
    agyEl('agyLoginRetry').style.display = 'block';
  }
  function agyStartLogin() {
    agyStopTimer();
    agyLogin = null;
    agyEl('agyLoginWait').style.display = 'block';
    agyEl('agyLoginStep').style.display = 'none';
    agyEl('agyLoginResult').style.display = 'none';
    agyEl('agyLoginRetry').style.display = 'none';
    agyEl('agyLoginCode').value = '';
    agyEl('btnAgySubmitCode').disabled = false;
    openModal('modalAgyLogin');
    apiCall('/agent-lb/api/agy/login/start', 'POST', {}).then(function (d) {
      if (!d) return;
      agyEl('agyLoginWait').style.display = 'none';
      if (!d.ok) { agyExpired(d.error || 'error'); return; }
      // The server's clock may differ from the browser's; count the window locally.
      var deadline = Date.now() + (d.expiresInMs || 58000);
      agyLogin = { loginId: d.loginId };
      agyEl('agyLoginLink').href = d.url;
      agyEl('agyLoginStep').style.display = 'block';
      agyEl('agyLoginCountdown').textContent = Math.round((deadline - Date.now()) / 1000);
      agyLogin.timer = setInterval(function () {
        var left = Math.round((deadline - Date.now()) / 1000);
        agyEl('agyLoginCountdown').textContent = Math.max(0, left);
        if (left <= 0) agyExpired(agyT('Link wygasł — AGY czeka na kod tylko 60 s. Kliknij „Nowy link”.', 'The link expired — AGY waits for the code only 60 s. Click “New link”.'));
      }, 1000);
    });
  }
  function agySubmitCode() {
    // Enter and the button can both fire; one code per login.
    if (!agyLogin || agyEl('btnAgySubmitCode').disabled) return;
    var code = agyEl('agyLoginCode').value.trim();
    if (!code) return;
    agyEl('btnAgySubmitCode').disabled = true;
    apiCall('/agent-lb/api/agy/login/submit', 'POST', { loginId: agyLogin.loginId, code: code }).then(function (d) {
      agyEl('btnAgySubmitCode').disabled = false;
      if (!d) return;
      agyStopTimer();
      agyLogin = null;
      agyEl('agyLoginStep').style.display = 'none';
      if (d.ok) {
        agyShowResult(true, agyT('✅ Zalogowano: ', '✅ Logged in: ') + d.account.email);
        agyEl('agyLoginRetry').style.display = 'block';
        loadAgyAccounts();
      } else {
        agyExpired((d.error || 'error') + agyT(' — kliknij „Nowy link”, aby spróbować ponownie.', ' — click “New link” to try again.'));
      }
    });
  }
  function agyCloseLogin() {
    if (agyLogin) apiCall('/agent-lb/api/agy/login/cancel', 'POST', { loginId: agyLogin.loginId });
    agyStopTimer();
    agyLogin = null;
    closeModal('modalAgyLogin');
  }
  var bAgyLogin = document.getElementById('btnAgyLogin');
  if (bAgyLogin) bAgyLogin.addEventListener('click', agyStartLogin);
  var bAgyNew = document.getElementById('btnAgyNewLink');
  if (bAgyNew) bAgyNew.addEventListener('click', agyStartLogin);
  var bAgySubmit = document.getElementById('btnAgySubmitCode');
  if (bAgySubmit) bAgySubmit.addEventListener('click', agySubmitCode);
  var inAgyCode = document.getElementById('agyLoginCode');
  if (inAgyCode) inAgyCode.addEventListener('keydown', function (e) { if (e.key === 'Enter') agySubmitCode(); });
  var bAgyClose = document.getElementById('btnCloseAgyLogin');
  if (bAgyClose) bAgyClose.addEventListener('click', agyCloseLogin);
  loadAgyAccounts();
  setInterval(loadAgyAccounts, 15000);

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

  // Account & Fleet Usage Modals (Kto i na co zużył limity)
  var currentUsageAccount = null;

  function switchUsageTab(activeBtnId, activeContentId, allBtnIds, allContentIds) {
    allBtnIds.forEach(function (id) {
      var b = document.getElementById(id);
      if (b) {
        if (id === activeBtnId) b.classList.add('active');
        else b.classList.remove('active');
      }
    });
    allContentIds.forEach(function (id) {
      var c = document.getElementById(id);
      if (c) c.style.display = id === activeContentId ? 'block' : 'none';
    });
  }

  function renderUsageClientsTable(table, byClient, totalTok) {
    if (!table) return;
    table.textContent = '';
    var thead = el('tr');
    thead.style.background = 'rgba(255,255,255,0.03)';
    (currentLang === 'pl' ? ['Klient / Stacja', 'Żądania', 'Input tok', 'Output tok', 'Cache tok', 'Razem tok', 'Udział w koncie', 'Ostatnio aktywny'] : ['Client / Station', 'Requests', 'Input tok', 'Output tok', 'Cache tok', 'Total tok', 'Account share', 'Last active']).forEach(function (h, i) {
      thead.appendChild(el('th', i >= 1 && i <= 5 ? 'num' : '', h));
    });
    table.appendChild(thead);

    var entries = Object.entries(byClient || {});
    if (!entries.length) {
      var trEmpty = el('tr');
      var tdEmpty = el('td', '', currentLang === 'pl' ? 'Brak zarejestrowanego zużycia przez klientów na tym koncie.' : 'No recorded client usage for this account.');
      tdEmpty.colSpan = 8;
      tdEmpty.style.textAlign = 'center';
      tdEmpty.style.color = 'var(--dim)';
      tdEmpty.style.padding = '18px';
      trEmpty.appendChild(tdEmpty);
      table.appendChild(trEmpty);
      return;
    }

    entries.sort(function (a, b) {
      return (b[1].totalTokens || 0) - (a[1].totalTokens || 0);
    });

    entries.forEach(function (entry) {
      var name = entry[0];
      var c = entry[1] || {};
      var tr = el('tr');
      var tdName = el('td', 'mono', name);
      tdName.style.fontWeight = '600';
      tr.appendChild(tdName);
      tr.appendChild(el('td', 'num', fmtNum(c.requests || 0)));
      tr.appendChild(el('td', 'num', fmtNum(c.inputTokens || 0)));
      tr.appendChild(el('td', 'num', fmtNum(c.outputTokens || 0)));
      tr.appendChild(el('td', 'num', fmtNum((c.cacheReadTokens || 0) + (c.cacheCreationTokens || 0))));
      var tdTotal = el('td', 'num', fmtNum(c.totalTokens || 0));
      tdTotal.style.fontWeight = '600';
      tdTotal.style.color = 'var(--accent)';
      tr.appendChild(tdTotal);

      var tdShare = el('td');
      var pct = totalTok > 0 ? Math.min(100, Math.round(((c.totalTokens || 0) / totalTok) * 100)) : 0;
      var barWrap = el('div');
      barWrap.style.display = 'flex';
      barWrap.style.alignItems = 'center';
      barWrap.style.gap = '6px';
      var barBg = el('div');
      barBg.style.flex = '1';
      barBg.style.height = '6px';
      barBg.style.background = 'var(--line)';
      barBg.style.borderRadius = '3px';
      barBg.style.overflow = 'hidden';
      var barFill = el('div');
      barFill.style.width = pct + '%';
      barFill.style.height = '100%';
      barFill.style.background = 'var(--accent)';
      barBg.appendChild(barFill);
      barWrap.appendChild(barBg);
      barWrap.appendChild(el('span', 'mono', pct + '%'));
      tdShare.appendChild(barWrap);
      tr.appendChild(tdShare);

      tr.appendChild(el('td', '', c.lastUsed ? fmtAgo(c.lastUsed) : '—'));
      table.appendChild(tr);
    });
  }

  function renderUsageSessionsTable(table, bySession) {
    if (!table) return;
    table.textContent = '';
    var thead = el('tr');
    thead.style.background = 'rgba(255,255,255,0.03)';
    (currentLang === 'pl' ? ['Zadanie / Cel / Sesja', 'Projekt', 'Model', 'Klient', 'Żądania', 'Razem tok', 'Ostatnio'] : ['Task / Goal / Session', 'Project', 'Model', 'Client', 'Requests', 'Total tok', 'Last active']).forEach(function (h, i) {
      thead.appendChild(el('th', i === 4 || i === 5 ? 'num' : '', h));
    });
    table.appendChild(thead);

    var entries = Object.entries(bySession || {});
    if (!entries.length) {
      var trEmpty = el('tr');
      var tdEmpty = el('td', '', currentLang === 'pl' ? 'Brak zarejestrowanych sesji dla tego konta.' : 'No recorded sessions for this account.');
      tdEmpty.colSpan = 7;
      tdEmpty.style.textAlign = 'center';
      tdEmpty.style.color = 'var(--dim)';
      tdEmpty.style.padding = '18px';
      trEmpty.appendChild(tdEmpty);
      table.appendChild(trEmpty);
      return;
    }

    entries.sort(function (a, b) {
      return (b[1].lastUsed || '').localeCompare(a[1].lastUsed || '');
    });

    entries.forEach(function (entry) {
      var id = entry[0];
      var s = entry[1] || {};
      var tr = el('tr');

      var tdTitle = el('td');
      var label = s.title || (id ? id.slice(0, 8) + '...' : 'Sesja');
      var sp = el('span', '', label);
      sp.title = 'Sesja: ' + id + (s.title ? '\\nTytuł: ' + s.title : '');
      tdTitle.appendChild(sp);
      tr.appendChild(tdTitle);

      tr.appendChild(el('td', '', s.project || '—'));
      var tdModel = el('td', 'mono', s.model || '—');
      tdModel.style.fontSize = '11px';
      tr.appendChild(tdModel);

      var tdClient = el('td', 'mono', s.client || '—');
      tdClient.style.fontSize = '11px';
      tr.appendChild(tdClient);

      tr.appendChild(el('td', 'num', fmtNum(s.requests || 0)));
      var tdTok = el('td', 'num', fmtNum(s.totalTokens || 0));
      tdTok.style.fontWeight = '600';
      tdTok.style.color = 'var(--accent)';
      tr.appendChild(tdTok);

      tr.appendChild(el('td', '', s.lastUsed ? fmtAgo(s.lastUsed) : '—'));
      table.appendChild(tr);
    });
  }

  function renderUsageRecentTable(table, recent) {
    if (!table) return;
    table.textContent = '';
    var thead = el('tr');
    thead.style.background = 'rgba(255,255,255,0.03)';
    (currentLang === 'pl' ? ['Czas', 'Klient', 'Zadanie / Cel', 'Model', 'Tokeny (In / Out / Cache / Suma)'] : ['Time', 'Client', 'Task / Goal', 'Model', 'Tokens (In / Out / Cache / Total)']).forEach(function (h, i) {
      thead.appendChild(el('th', i === 4 ? 'num' : '', h));
    });
    table.appendChild(thead);

    var items = Array.isArray(recent) ? recent : [];
    if (!items.length) {
      var trEmpty = el('tr');
      var tdEmpty = el('td', '', currentLang === 'pl' ? 'Brak historii ostatnich zapytań dla tego konta.' : 'No recent request history for this account.');
      tdEmpty.colSpan = 5;
      tdEmpty.style.textAlign = 'center';
      tdEmpty.style.color = 'var(--dim)';
      tdEmpty.style.padding = '18px';
      trEmpty.appendChild(tdEmpty);
      table.appendChild(trEmpty);
      return;
    }

    items.forEach(function (r) {
      var tr = el('tr');
      var tStr = r.timestamp ? (new Date(r.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' (' + fmtAgo(r.timestamp) + ')') : '—';
      tr.appendChild(el('td', '', tStr));

      var tdClient = el('td', 'mono', r.client || '—');
      tdClient.style.fontWeight = '600';
      tr.appendChild(tdClient);

      var tdTask = el('td');
      var taskDesc = r.sessionTitle || (r.sessionId ? r.sessionId.slice(0, 8) + '...' : 'Zapytanie API');
      var spanTask = el('span', '', taskDesc);
      if (r.sessionId) spanTask.title = 'Sesja ID: ' + r.sessionId + (r.sessionTitle ? '\\n' + r.sessionTitle : '');
      tdTask.appendChild(spanTask);
      tr.appendChild(tdTask);

      var tdModel = el('td', 'mono', r.model || '—');
      tdModel.style.fontSize = '11px';
      tr.appendChild(tdModel);

      var tdTok = el('td', 'num mono', fmtNum(r.inputTokens || 0) + ' / ' + fmtNum(r.outputTokens || 0) + ' / ' + fmtNum(r.cacheTokens || 0) + ' → ' + fmtNum(r.totalTokens || 0));
      tdTok.style.fontWeight = '600';
      tdTok.style.color = 'var(--accent)';
      tr.appendChild(tdTok);

      table.appendChild(tr);
    });
  }

  function openAccountUsageModal(account) {
    if (!account) return;
    currentUsageAccount = account;
    var nameBadge = document.getElementById('accountUsageNameBadge');
    if (nameBadge) nameBadge.textContent = account.name;

    var u = account.usage || {};
    var totTok = accountTokens(u);
    var totReq = u.totalRequests || 0;

    var elTok = document.getElementById('accountUsageTotalTok');
    if (elTok) elTok.textContent = fmtNum(totTok);
    var elReq = document.getElementById('accountUsageTotalReq');
    if (elReq) elReq.textContent = fmtNum(totReq);

    var q = account.quota || {};
    var elSess = document.getElementById('accountUsageSessionPct');
    if (elSess) elSess.textContent = q.unified5h != null ? Math.round(q.unified5h * 100) + '%' : (q.requestsRemaining != null ? q.requestsRemaining + ' req' : '—');
    var elWk = document.getElementById('accountUsageWeeklyPct');
    if (elWk) elWk.textContent = q.unified7d != null ? Math.round(q.unified7d * 100) + '%' : (q.tokensRemaining != null ? fmtNum(q.tokensRemaining) + ' tok' : '—');
    var elLast = document.getElementById('accountUsageLastUsed');
    if (elLast) elLast.textContent = u.lastUsed ? fmtAgo(u.lastUsed) : '—';

    renderUsageClientsTable(document.getElementById('tblUsageClients'), u.byClient, totTok);
    renderUsageSessionsTable(document.getElementById('tblUsageSessions'), u.bySession);
    renderUsageRecentTable(document.getElementById('tblUsageRecent'), u.recent);

    switchUsageTab(
      'tabBtnUsageClients',
      'tabContentUsageClients',
      ['tabBtnUsageClients', 'tabBtnUsageSessions', 'tabBtnUsageRecent'],
      ['tabContentUsageClients', 'tabContentUsageSessions', 'tabContentUsageRecent']
    );

    openModal('modalAccountUsage');
  }

  function openFleetUsageModal() {
    if (!lastStatus || !Array.isArray(lastStatus.accounts)) return;
    var accounts = lastStatus.accounts;
    var totalTok = 0;
    var totalReq = 0;
    var clientMap = {};
    var modelMap = {};

    accounts.forEach(function (a) {
      var u = a.usage || {};
      totalTok += accountTokens(u);
      totalReq += u.totalRequests || 0;

      if (u.byClient) {
        Object.entries(u.byClient).forEach(function (e) {
          var cName = e[0];
          var st = e[1] || {};
          if (!clientMap[cName]) clientMap[cName] = { requests: 0, totalTokens: 0, accounts: {} };
          clientMap[cName].requests += st.requests || 0;
          clientMap[cName].totalTokens += st.totalTokens || 0;
          clientMap[cName].accounts[a.name] = (clientMap[cName].accounts[a.name] || 0) + (st.totalTokens || 0);
        });
      }

      if (u.byModel) {
        Object.entries(u.byModel).forEach(function (e) {
          var mName = e[0];
          var st = e[1] || {};
          if (!modelMap[mName]) modelMap[mName] = { requests: 0, totalTokens: 0 };
          modelMap[mName].requests += st.requests || 0;
          modelMap[mName].totalTokens += st.totalTokens || 0;
        });
      }
    });

    var elTok = document.getElementById('fleetUsageTotalTok');
    if (elTok) elTok.textContent = fmtNum(totalTok);
    var elReq = document.getElementById('fleetUsageTotalReq');
    if (elReq) elReq.textContent = fmtNum(totalReq);
    var elAcc = document.getElementById('fleetUsageTotalAccounts');
    if (elAcc) elAcc.textContent = accounts.length;
    var elCli = document.getElementById('fleetUsageTotalClients');
    if (elCli) elCli.textContent = Object.keys(clientMap).length;

    // Render Fleet Accounts Table
    var tblAcc = document.getElementById('tblFleetAccounts');
    if (tblAcc) {
      tblAcc.textContent = '';
      var thead = el('tr');
      thead.style.background = 'rgba(255,255,255,0.03)';
      (currentLang === 'pl' ? ['Konto', 'Dostawca', 'Stan limitu', 'Żądania', 'Tokeny razem', 'Główni klienci', 'Akcja'] : ['Account', 'Provider', 'Quota Status', 'Requests', 'Total Tokens', 'Top Clients', 'Action']).forEach(function (h, i) {
        thead.appendChild(el('th', i === 3 || i === 4 ? 'num' : '', h));
      });
      tblAcc.appendChild(thead);

      accounts.forEach(function (a) {
        var tr = el('tr');
        var tdName = el('td', 'mono', a.name);
        tdName.style.fontWeight = '600';
        tr.appendChild(tdName);

        var tdProv = el('td', '', (a.provider === 'codex' ? '🟢 OpenAI' : '🟣 Claude'));
        tr.appendChild(tdProv);

        var q = a.quota || {};
        var qStr = (q.unified5h != null ? 'Ses: ' + Math.round(q.unified5h * 100) + '%' : '') +
          (q.unified7d != null ? ' | Tyg: ' + Math.round(q.unified7d * 100) + '%' : '');
        tr.appendChild(el('td', '', qStr || '—'));

        var u = a.usage || {};
        tr.appendChild(el('td', 'num', fmtNum(u.totalRequests || 0)));
        var tdTok = el('td', 'num', fmtNum(accountTokens(u)));
        tdTok.style.fontWeight = '600';
        tdTok.style.color = 'var(--accent)';
        tr.appendChild(tdTok);

        var clientsList = Object.keys(u.byClient || {}).join(', ') || '—';
        var tdCli = el('td', '', clientsList);
        tdCli.style.fontSize = '11px';
        tr.appendChild(tdCli);

        var tdAct = el('td');
        var btnInspect = el('button', 'btn btn-xs btn-outline', currentLang === 'pl' ? '🔍 Podgląd' : '🔍 Inspect');
        btnInspect.type = 'button';
        btnInspect.addEventListener('click', function () {
          closeModal('modalFleetUsage');
          openAccountUsageModal(a);
        });
        tdAct.appendChild(btnInspect);
        tr.appendChild(tdAct);

        tblAcc.appendChild(tr);
      });
    }

    // Render Fleet Clients Table
    var tblCli = document.getElementById('tblFleetClients');
    if (tblCli) {
      tblCli.textContent = '';
      var theadC = el('tr');
      theadC.style.background = 'rgba(255,255,255,0.03)';
      (currentLang === 'pl' ? ['Klient (Stacja)', 'Żądania', 'Łącznie tokenów', 'Udział we flocie', 'Używane konta'] : ['Client (Station)', 'Requests', 'Total Tokens', 'Fleet Share', 'Used Accounts']).forEach(function (h, i) {
        theadC.appendChild(el('th', i === 1 || i === 2 ? 'num' : '', h));
      });
      tblCli.appendChild(theadC);

      var clientEntries = Object.entries(clientMap);
      if (!clientEntries.length) {
        var trE = el('tr');
        var tdE = el('td', '', currentLang === 'pl' ? 'Brak aktywności klientów.' : 'No client activity recorded.');
        tdE.colSpan = 5;
        tdE.style.textAlign = 'center';
        trE.appendChild(tdE);
        tblCli.appendChild(trE);
      } else {
        clientEntries.sort(function (a, b) { return b[1].totalTokens - a[1].totalTokens; });
        clientEntries.forEach(function (entry) {
          var cName = entry[0];
          var data = entry[1];
          var tr = el('tr');
          var tdName = el('td', 'mono', cName);
          tdName.style.fontWeight = '600';
          tr.appendChild(tdName);

          tr.appendChild(el('td', 'num', fmtNum(data.requests)));
          var tdTok = el('td', 'num', fmtNum(data.totalTokens));
          tdTok.style.fontWeight = '600';
          tdTok.style.color = 'var(--accent)';
          tr.appendChild(tdTok);

          var pct = totalTok > 0 ? Math.min(100, Math.round((data.totalTokens / totalTok) * 100)) : 0;
          tr.appendChild(el('td', 'mono', pct + '%'));

          var accUsageDetails = Object.entries(data.accounts).map(function (acc) {
            return acc[0] + ' (' + fmtNum(acc[1]) + ')';
          }).join(', ');
          var tdAccs = el('td', 'mono', accUsageDetails || '—');
          tdAccs.style.fontSize = '11px';
          tr.appendChild(tdAccs);

          tblCli.appendChild(tr);
        });
      }
    }

    // Render Fleet Models Table
    var tblMod = document.getElementById('tblFleetModels');
    if (tblMod) {
      tblMod.textContent = '';
      var theadM = el('tr');
      theadM.style.background = 'rgba(255,255,255,0.03)';
      (currentLang === 'pl' ? ['Model', 'Żądania', 'Łącznie tokenów', 'Udział %'] : ['Model', 'Requests', 'Total Tokens', 'Share %']).forEach(function (h, i) {
        theadM.appendChild(el('th', i === 1 || i === 2 ? 'num' : '', h));
      });
      tblMod.appendChild(theadM);

      var modelEntries = Object.entries(modelMap);
      if (!modelEntries.length) {
        var trM = el('tr');
        var tdM = el('td', '', currentLang === 'pl' ? 'Brak zarejestrowanych modeli.' : 'No recorded models.');
        tdM.colSpan = 4;
        tdM.style.textAlign = 'center';
        trM.appendChild(tdM);
        tblMod.appendChild(trM);
      } else {
        modelEntries.sort(function (a, b) { return b[1].totalTokens - a[1].totalTokens; });
        modelEntries.forEach(function (entry) {
          var mName = entry[0];
          var data = entry[1];
          var tr = el('tr');
          var tdName = el('td', 'mono', mName);
          tdName.style.fontWeight = '600';
          tr.appendChild(tdName);

          tr.appendChild(el('td', 'num', fmtNum(data.requests)));
          var tdTok = el('td', 'num', fmtNum(data.totalTokens));
          tdTok.style.fontWeight = '600';
          tdTok.style.color = 'var(--accent)';
          tr.appendChild(tdTok);

          var pct = totalTok > 0 ? Math.min(100, Math.round((data.totalTokens / totalTok) * 100)) : 0;
          tr.appendChild(el('td', 'mono', pct + '%'));

          tblMod.appendChild(tr);
        });
      }
    }

    switchUsageTab(
      'tabBtnFleetAccounts',
      'tabContentFleetAccounts',
      ['tabBtnFleetAccounts', 'tabBtnFleetClients', 'tabBtnFleetModels'],
      ['tabContentFleetAccounts', 'tabContentFleetClients', 'tabContentFleetModels']
    );

    openModal('modalFleetUsage');
  }

  // Hook up Account Usage modal buttons
  var btnCloseAccountUsage = document.getElementById('btnCloseAccountUsage');
  if (btnCloseAccountUsage) {
    btnCloseAccountUsage.addEventListener('click', function () {
      closeModal('modalAccountUsage');
    });
  }

  var btnCloseFleetUsage = document.getElementById('btnCloseFleetUsage');
  if (btnCloseFleetUsage) {
    btnCloseFleetUsage.addEventListener('click', function () {
      closeModal('modalFleetUsage');
    });
  }

  var btnOpenFleetUsage = document.getElementById('btnOpenFleetUsage');
  if (btnOpenFleetUsage) {
    btnOpenFleetUsage.addEventListener('click', function () {
      openFleetUsageModal();
    });
  }

  // Tab switching inside modalAccountUsage
  ['tabBtnUsageClients', 'tabBtnUsageSessions', 'tabBtnUsageRecent'].forEach(function (bId) {
    var b = document.getElementById(bId);
    if (b) {
      b.addEventListener('click', function () {
        var contentMap = {
          tabBtnUsageClients: 'tabContentUsageClients',
          tabBtnUsageSessions: 'tabContentUsageSessions',
          tabBtnUsageRecent: 'tabContentUsageRecent'
        };
        switchUsageTab(
          bId,
          contentMap[bId],
          ['tabBtnUsageClients', 'tabBtnUsageSessions', 'tabBtnUsageRecent'],
          ['tabContentUsageClients', 'tabContentUsageSessions', 'tabContentUsageRecent']
        );
      });
    }
  });

  // Tab switching inside modalFleetUsage
  ['tabBtnFleetAccounts', 'tabBtnFleetClients', 'tabBtnFleetModels'].forEach(function (bId) {
    var b = document.getElementById(bId);
    if (b) {
      b.addEventListener('click', function () {
        var contentMap = {
          tabBtnFleetAccounts: 'tabContentFleetAccounts',
          tabBtnFleetClients: 'tabContentFleetClients',
          tabBtnFleetModels: 'tabContentFleetModels'
        };
        switchUsageTab(
          bId,
          contentMap[bId],
          ['tabBtnFleetAccounts', 'tabBtnFleetClients', 'tabBtnFleetModels'],
          ['tabContentFleetAccounts', 'tabContentFleetClients', 'tabContentFleetModels']
        );
      });
    }
  });

  // Reset usage button
  var btnResetAccUsage = document.getElementById('btnResetAccountUsage');
  if (btnResetAccUsage) {
    btnResetAccUsage.addEventListener('click', function () {
      if (!currentUsageAccount) return;
      if (!confirm(currentLang === 'pl' ? ('Czy na pewno chcesz zresetować statystyki zużycia dla konta "' + currentUsageAccount.name + '"?') : ('Are you sure you want to reset usage statistics for account "' + currentUsageAccount.name + '"?'))) return;
      apiCall('/api/accounts/usage/reset', 'POST', { account: currentUsageAccount.name })
        .then(function (res) {
          if (res && res.ok) {
            note('ok', currentLang === 'pl' ? ('Zresetowano liczniki zużycia dla konta ' + currentUsageAccount.name) : ('Reset usage counters for account ' + currentUsageAccount.name));
            closeModal('modalAccountUsage');
            poll();
          } else {
            note('bad', (currentLang === 'pl' ? 'Błąd resetowania liczników: ' : 'Error resetting counters: ') + (res && res.error ? res.error : (currentLang === 'pl' ? 'błąd serwera' : 'server error')));
          }
        })
        .catch(function (err) {
          note('bad', (currentLang === 'pl' ? 'Błąd połączenia: ' : 'Connection error: ') + err.message);
        });
    });
  }

  var btnWorkstationGuide = document.getElementById('btnShowWorkstationGuide');
  if (btnWorkstationGuide) {
    btnWorkstationGuide.addEventListener('click', function () {
      var sel = document.getElementById('selQuickStation');
      var list = (lastStatus && lastStatus.clientKeys) || [];
      var chosen = (sel && sel.value) ? sel.value : (list.length ? list[0].name : (primaryAdminKey ? '__primary__' : ''));
      var chosenKey = (chosen === '__primary__') ? primaryAdminKey : (cachedClientKeys[chosen] || '');
      showKeyModal(chosen, chosenKey);
    });
  }

  var selQuick = document.getElementById('selQuickStation');
  if (selQuick) {
    selQuick.addEventListener('change', function () {
      var val = this.value;
      if (val === '__primary__') {
        currentQuickKey = primaryAdminKey;
        updateQuickCmd();
      } else if (cachedClientKeys[val]) {
        currentQuickKey = cachedClientKeys[val];
        updateQuickCmd();
      } else {
        apiCall('/agent-lb/api/keys/reveal', 'POST', { name: val })
          .then(function (rev) {
            if (rev && rev.ok && rev.key) {
              cachedClientKeys[val] = rev.key;
              saveCachedKeys();
              currentQuickKey = rev.key;
              updateQuickCmd();
            }
          })
          .catch(function () {});
      }
      var selModal = document.getElementById('selModalStation');
      if (selModal && Array.from(selModal.options).some(function (o) { return o.value === val; })) {
        selModal.value = val;
      }
    });
  }

  // Tab switching in modalAddAccount
  function selectTab(tab) {
    var tabs = ['ApiKey', 'OAuth', 'Import', 'BrowserOAuth', 'DeviceCode'];
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
  document.getElementById('tabBtnDeviceCode').addEventListener('click', function () { selectTab('DeviceCode'); });

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
  document.getElementById('btnStartDeviceCode').addEventListener('click', function () { doStartDeviceCode(this); });
  document.getElementById('btnCancelDeviceCode').addEventListener('click', function () {
    if (deviceCodePollTimer) { clearInterval(deviceCodePollTimer); deviceCodePollTimer = null; }
    document.getElementById('deviceCodeStep1').style.display = 'block';
    document.getElementById('deviceCodeStep2').style.display = 'none';
  });

  // Create Client Key submission
  document.getElementById('btnSubmitClientKey').addEventListener('click', function () { doAddClientKey(this); });

  // Setup tabs switching
  ['Bash', 'Powershell'].forEach(function (t) {
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
  bindCopy('btnCopySetupBashMain', 'cmdSetupBashMain', 'Polecenie instalatora (Linux)');
  bindCopy('btnCopySetupPowershellMain', 'cmdSetupPowershellMain', 'Polecenie instalatora (Windows)');
  bindCopy('btnCopySetupBash', 'cmdSetupBash', 'Polecenie Claude (Bash)');
  bindCopy('btnCopySetupCodexBash', 'cmdSetupCodexBash', 'Polecenie Codex (Bash)');
  bindCopy('btnCopySetupAgentBash', 'cmdSetupAgentBash', 'Zmienne OpenCode / Hermes (Bash)');
  bindCopy('btnCopySetupPowershell', 'cmdSetupPowershell', 'Polecenie Claude (PowerShell)');
  bindCopy('btnCopySetupCodexPowershell', 'cmdSetupCodexPowershell', 'Polecenie Codex (PowerShell)');
  bindCopy('btnCopySetupAgentPowershell', 'cmdSetupAgentPowershell', 'Zmienne OpenCode / Hermes (PowerShell)');
  bindCopy('btnCopySetupHermesCmd', 'cmdSetupHermes', 'Polecenie Hermes Agent');
  bindCopy('btnCopySetupOpenCodeCmd', 'cmdSetupOpenCode', 'Polecenie OpenCode');
  bindCopy('btnCopySetupClawCmd', 'cmdSetupClaw', 'Polecenie Claw / OpenClaw');
  bindCopy('btnCopySetupOrcaCmd', 'cmdSetupOrca', 'Polecenie Orca');
  bindCopy('btnCopySetupAiderCmd', 'cmdSetupAider', 'Konfiguracja Aider');
  bindCopy('btnCopySetupNode', 'cmdSetupNode', 'Polecenie Claude (Node.js)');
  bindCopy('btnCopySetupCodexNode', 'cmdSetupCodexNode', 'Polecenie Codex (Node.js)');
  bindCopy('btnCopySetupGit', 'cmdSetupGit', 'Polecenie Git (Claude)');
  bindCopy('btnCopySetupCodexGit', 'cmdSetupCodexGit', 'Polecenie Git (Codex)');

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
        '',
        '# OpenAI Compatible (OpenCode, Hermes Agent, Aider):',
        'export OPENAI_BASE_URL="' + hostUrl + '/v1"',
        'export OPENAI_API_KEY="' + k + '"',
        'export AGENT_LB_API_KEY="' + k + '"'
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
  ['All', 'Claude', 'Codex', 'Hermes', 'OpenCode', 'Claw', 'Orca', 'Agy', 'Agent'].forEach(function (tool) {
    var b = document.getElementById('btnQuickTool' + tool);
    if (b) {
      b.addEventListener('click', function () { setQuickTool(tool.toLowerCase()); });
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
          note('error', (currentLang === 'pl' ? 'Błąd konfiguracji auto-diagnostyki: ' : 'Auto-diagnostics config error: ') + e.message);
        });
    });
  }
  var btnDrain = document.getElementById('btnDrainToggle');
  if (btnDrain) btnDrain.addEventListener('click', toggleDrain);
  var btnSetDefaults = document.getElementById('btnSetDefaults');
  if (btnSetDefaults) btnSetDefaults.addEventListener('click', resetFleetRoutingDefaults);

  // --- Test Chat (Playground) ---
  function getClaudeModels() {
    var isEn = currentLang === 'en';
    return [
      { id: 'claude-fable-5-1', name: isEn ? 'Claude Fable 5.1 (Advanced Reasoning & Agents)' : 'Claude Fable 5.1 (Najbardziej zaawansowany / Agenty)' },
      { id: 'claude-fable-5', name: isEn ? 'Claude Fable 5 (Complex Reasoning)' : 'Claude Fable 5 (Złożone rozumowanie)' },
      { id: 'claude-opus-5', name: isEn ? 'Claude Opus 5 (Flagship / Agentic Coding)' : 'Claude Opus 5 (Flagowy / Kodowanie agentowe)' },
      { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
      { id: 'claude-opus-4-7', name: 'Claude Opus 4.7' },
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
      { id: 'claude-sonnet-5', name: isEn ? 'Claude Sonnet 5 (Default Claude Code)' : 'Claude Sonnet 5 (Domyślny Claude Code)' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
      { id: 'claude-mythos-5-1', name: isEn ? 'Claude Mythos 5.1 (Specialized / Research)' : 'Claude Mythos 5.1 (Specjalistyczny / Eksperymentalny)' },
      { id: 'claude-haiku-4-5-20251001', name: isEn ? 'Claude Haiku 4.5 (Fast / Light tasks)' : 'Claude Haiku 4.5 (Szybki / Lekkie zadania)' },
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
        statusEl.textContent = currentLang === 'pl' ? 'Brak wiadomości do skopiowania.' : 'No messages to copy.';
        setTimeout(function () { statusEl.textContent = ''; }, 2000);
      }
      return;
    }

    var lines = [];
    testChatLog.forEach(function (m) {
      var timeStr = m.time ? ('[' + m.time.toLocaleTimeString() + '] ') : '';
      if (m.role === 'user') {
        lines.push(timeStr + (currentLang === 'pl' ? 'Użytkownik:\\n' : 'User:\\n') + m.text);
      } else {
        var details = [];
        if (m.meta) {
          if (m.meta.account) details.push('Konto: ' + m.meta.account);
          if (m.meta.model) details.push('Model: ' + m.meta.model);
          if (m.meta.durationMs != null) details.push('Czas: ' + m.meta.durationMs + ' ms');
          if (m.meta.error) details.push(currentLang === 'pl' ? 'Status: Błąd upstreamu' : 'Status: Upstream error');
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
        btn.textContent = ok ? (currentLang === 'pl' ? '✓ Skopiowano!' : '✓ Copied!') : (currentLang === 'pl' ? '⚠️ Błąd' : '⚠️ Error');
        setTimeout(function () { btn.textContent = orig; }, 2000);
      }
      var statusEl = document.getElementById('testChatStatus');
      if (statusEl) {
        statusEl.textContent = ok ? (currentLang === 'pl' ? '✓ Skopiowano historię do schowka' : '✓ Copied history to clipboard') : (currentLang === 'pl' ? 'Błąd dostępu do schowka' : 'Clipboard access error');
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
      copySingleBtn.textContent = currentLang === 'pl' ? '📋 Kopiuj' : '📋 Copy';
      copySingleBtn.title = currentLang === 'pl' ? 'Skopiuj tę odpowiedź do schowka' : 'Copy this response to clipboard';
      copySingleBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        copyTextToClipboard(text, function (ok) {
          copySingleBtn.textContent = ok ? (currentLang === 'pl' ? '✓ Skopiowano' : '✓ Copied') : (currentLang === 'pl' ? 'Błąd' : 'Error');
          setTimeout(function () { copySingleBtn.textContent = currentLang === 'pl' ? '📋 Kopiuj' : '📋 Copy'; }, 1500);
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
      copyUserBtn.textContent = currentLang === 'pl' ? '📋 Kopiuj' : '📋 Copy';
      copyUserBtn.title = currentLang === 'pl' ? 'Skopiuj treść zapytania' : 'Copy query text';
      copyUserBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        copyTextToClipboard(text, function (ok) {
          copyUserBtn.textContent = ok ? (currentLang === 'pl' ? '✓ Skopiowano' : '✓ Copied') : (currentLang === 'pl' ? 'Błąd' : 'Error');
          setTimeout(function () { copyUserBtn.textContent = currentLang === 'pl' ? '📋 Kopiuj' : '📋 Copy'; }, 1500);
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
    statusEl.textContent = (currentLang === 'pl' ? '⏳ Łączenie z upstreamem (' : '⏳ Connecting to upstream (') + (prov === 'codex' ? 'Codex' : 'Claude') + ')...';

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
        addTestChatBubble('assistant', currentLang === 'pl' ? 'Brak odpowiedzi z serwera lub błąd autoryzacji.' : 'No response from server or authorization error.', { error: true });
        return;
      }

      if (res.ok) {
        addTestChatBubble('assistant', res.reply || (currentLang === 'pl' ? '(Pusta odpowiedź)' : '(Empty response)'), {
          account: res.account,
          model: res.model,
          effort: res.effort || effort,
          isFallback: res.isFallback,
          durationMs: res.durationMs,
          usage: res.usage,
        });
      } else {
        var errText = res.error || ((currentLang === 'pl' ? 'Błąd HTTP ' : 'HTTP Error ') + (res.status || '500'));
        addTestChatBubble('assistant', (currentLang === 'pl' ? '⚠️ Błąd upstreamu: ' : '⚠️ Upstream error: ') + errText, {
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
      addTestChatBubble('assistant', (currentLang === 'pl' ? 'Błąd sieciowy klienta: ' : 'Client network error: ') + err.message, { error: true });
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
        history.innerHTML = '<div id="testChatPlaceholder" style="margin:auto; text-align:center; color:var(--dim); font-size:12px;"><div style="font-size:26px; margin-bottom:6px;">💬</div>' + t('testChatPlaceholder') + '</div>';
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

  // Main navigation tabs (Konta & Flota vs Stacje robocze & Narzędzia)
  function switchMainTab(tabId) {
    var tabAccounts = document.getElementById('tabAccounts');
    var tabWorkstations = document.getElementById('tabWorkstations');
    var btnAccounts = document.getElementById('tabBtnAccounts');
    var btnWorkstations = document.getElementById('tabBtnWorkstations');

    if (tabId === 'tabWorkstations') {
      if (tabAccounts) tabAccounts.style.display = 'none';
      if (tabWorkstations) tabWorkstations.style.display = 'block';
      if (btnAccounts) btnAccounts.classList.remove('active');
      if (btnWorkstations) btnWorkstations.classList.add('active');
    } else {
      if (tabAccounts) tabAccounts.style.display = 'block';
      if (tabWorkstations) tabWorkstations.style.display = 'none';
      if (btnAccounts) btnAccounts.classList.add('active');
      if (btnWorkstations) btnWorkstations.classList.remove('active');
    }
    try { localStorage.setItem('agentlb-active-tab', tabId); } catch (e) {}
    routeTo(tabId === 'tabWorkstations' ? 'workstations' : 'accounts');
  }

  var btnTabAccounts = document.getElementById('tabBtnAccounts');
  if (btnTabAccounts) {
    btnTabAccounts.addEventListener('click', function () {
      switchMainTab('tabAccounts');
    });
  }
  var btnTabWorkstations = document.getElementById('tabBtnWorkstations');
  if (btnTabWorkstations) {
    btnTabWorkstations.addEventListener('click', function () {
      switchMainTab('tabWorkstations');
    });
  }

  // --- Addresses for every view ----------------------------------------------
  // /dashboard/<view> opens that view directly; the address follows the tab or
  // dialog on screen, so a view can be bookmarked, shared and reached with
  // Back/Forward. The server answers every /dashboard/... path with this page.
  var ROUTES = {
    'accounts': { tab: 'tabAccounts', title: ['Konta & Flota', 'Accounts & Fleet'] },
    'accounts/agy': { tab: 'tabAccounts', scroll: 'colAgy', title: ['Konta AGY', 'AGY accounts'] },
    'accounts/add': { tab: 'tabAccounts', modal: 'modalAddAccount', open: 'btnAddClaudeCol', title: ['Dodaj konto', 'Add account'] },
    'workstations': { tab: 'tabWorkstations', title: ['Stacje robocze', 'Workstations'] },
    'workstations/new': { tab: 'tabWorkstations', modal: 'modalAddClientKey', open: 'btnShowAddClientKey', title: ['Podłącz stację', 'Connect workstation'] },
    'usage': { tab: 'tabAccounts', modal: 'modalFleetUsage', open: 'btnOpenFleetUsage', title: ['Kto i na co?', 'Fleet usage'] },
    'chat': { tab: 'tabAccounts', modal: 'modalTestChat', open: 'btnOpenTestChat', title: ['Test Chat', 'Test Chat'] }
  };
  var routeBase = (function () {
    var m = /^(.*\\/dashboard)(?:\\/|$)/.exec(location.pathname);
    return m ? m[1] : '/dashboard';
  })();
  var routeApplying = false;
  var currentRoute = null;
  var routePendingModal = null; // a view whose dialog needs the first status
  var routeModalPushed = false; // the open dialog added its own history entry

  function routeFromPath() {
    var rest = location.pathname.slice(routeBase.length).replace(/^\\/+|\\/+$/g, '');
    return ROUTES[rest] ? rest : null;
  }
  function routeTitle(name) {
    var r = ROUTES[name];
    document.title = r ? ('Agent LB · ' + r.title[currentLang === 'pl' ? 0 : 1]) : 'Agent LB';
  }
  function routeTo(name, replace) {
    if (routeApplying || !ROUTES[name]) return;
    currentRoute = name;
    routeTitle(name);
    var url = routeBase + '/' + name + location.search;
    if (location.pathname + location.search === url) return;
    try {
      if (replace) history.replaceState({ route: name }, '', url);
      else history.pushState({ route: name }, '', url);
    } catch (e) {}
  }
  function tabRouteName() {
    var ws = document.getElementById('tabWorkstations');
    return ws && ws.style.display === 'block' ? 'workstations' : 'accounts';
  }
  function routeModalOpened(id) {
    for (var name in ROUTES) {
      if (ROUTES[name].modal === id) {
        if (!routeApplying && currentRoute !== name) routeModalPushed = true;
        routeTo(name);
        return;
      }
    }
  }
  function routeModalClosed(id) {
    if (routeApplying || !currentRoute || ROUTES[currentRoute].modal !== id) return;
    if (routeModalPushed) {
      // The dialog pushed its address: step back to the view underneath.
      routeModalPushed = false;
      history.back();
    } else {
      routeTo(tabRouteName(), true);
    }
  }
  function routeRetryPending() {
    var name = routePendingModal;
    if (!name || currentRoute !== name) { routePendingModal = null; return; }
    routePendingModal = null;
    var r = ROUTES[name];
    var btn = r.open && document.getElementById(r.open);
    routeApplying = true;
    try { if (btn) btn.click(); } finally { routeApplying = false; }
  }
  function applyRoute(name) {
    var r = ROUTES[name];
    if (!r) return;
    routeApplying = true;
    try {
      // Dialogs of other views are closed so the screen matches the address.
      for (var other in ROUTES) {
        var mid = ROUTES[other].modal;
        if (mid && mid !== r.modal) {
          var el = document.getElementById(mid);
          if (el) el.style.display = 'none';
        }
      }
      switchMainTab(r.tab);
      routeModalPushed = false;
      if (r.modal) {
        var dlg = document.getElementById(r.modal);
        var btn = r.open && document.getElementById(r.open);
        if (btn && (!dlg || dlg.style.display !== 'flex')) btn.click();
        // Some dialogs (fleet usage) need data that the first poll brings.
        if (dlg && dlg.style.display !== 'flex') routePendingModal = name;
      }
      if (r.scroll) {
        var target = document.getElementById(r.scroll);
        if (target && target.scrollIntoView) setTimeout(function () { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 150);
      }
    } finally {
      routeApplying = false;
    }
    currentRoute = name;
    routeTitle(name);
  }
  window.addEventListener('popstate', function () {
    applyRoute(routeFromPath() || tabRouteName());
  });

  (function startRouter() {
    var initial = routeFromPath();
    if (!initial) {
      // Bare /dashboard (or an unknown view): the last tab, then its address.
      var saved = null;
      try { saved = localStorage.getItem('agentlb-active-tab'); } catch (e) {}
      initial = saved === 'tabWorkstations' ? 'workstations' : 'accounts';
    }
    applyRoute(initial);
    routeTo(initial, true);
  })();

  checkAuthAndStart();
})();
</script>
</body>
</html>
`;
