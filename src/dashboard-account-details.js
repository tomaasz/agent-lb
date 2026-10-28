// Embedded in the existing dashboard and CSP hash; no external assets or requests.
export const ACCOUNT_DETAILS_CSS = `
.account-details-trigger { appearance:none; border:0; background:none; padding:0; text-align:left; font:inherit; }
.card .account-details-trigger { cursor:pointer; color:var(--heading); }
.card .account-details-trigger:hover { color:var(--accent); }
.account-details-trigger:focus-visible, .account-details-dialog button:focus-visible { outline:2px solid var(--accent); outline-offset:4px; }
.account-details-backdrop { position:fixed; inset:0; z-index:10010; background:rgba(0,0,0,.66); backdrop-filter:blur(8px); display:flex; justify-content:flex-end; }
.account-details-backdrop[hidden] { display:none; }
.account-details-dialog [hidden] { display:none !important; }
.account-details-dialog { width:min(980px,100%); height:100%; background:var(--bg); color:var(--text); box-shadow:-24px 0 80px #0005; display:flex; flex-direction:column; border-left:1px solid var(--line); }
.account-details-topbar { display:flex; justify-content:space-between; gap:16px; align-items:center; padding:20px 28px; border-bottom:1px solid var(--line); }
.account-details-eyebrow { text-transform:uppercase; letter-spacing:.14em; font-size:10px; color:var(--dim); font-weight:700; }
.account-details-topbar h2 { margin:5px 0 0; font-size:18px; letter-spacing:-.025em; }
.account-details-close { border:1px solid var(--line); border-radius:10px; background:var(--card,var(--bg)); color:var(--text); width:36px; height:36px; cursor:pointer; font-size:18px; flex-shrink:0; }
.account-details-body { overflow:auto; overscroll-behavior:contain; flex:1; padding:28px; }
.account-details-hero { border:1px solid var(--line); border-radius:18px; padding:24px; background:linear-gradient(120deg,rgba(88,166,255,.12),transparent 75%); margin-bottom:20px; }
.account-details-hero h3 { margin:12px 0 6px; font-size:clamp(19px,3vw,28px); letter-spacing:-.04em; overflow-wrap:anywhere; line-height:1.3; }
.account-details-subtitle { color:var(--dim); font-size:12px; overflow-wrap:anywhere; }
.account-details-status { display:inline-flex; align-items:center; gap:7px; border:1px solid var(--line); padding:5px 9px; border-radius:20px; font-size:11px; margin-right:8px; }
.account-details-status::before { content:''; width:6px; height:6px; border-radius:50%; background:var(--dim); }
.account-details-status.good::before { background:#3fb950; box-shadow:0 0 10px #3fb95055; }
.account-details-status.warn::before { background:#d29922; }
.account-details-status.bad::before { background:#f85149; }
.account-details-stats { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; margin:20px 0; }
.account-details-stat, .account-details-section { border:1px solid var(--line); background:var(--card,var(--bg)); border-radius:14px; padding:18px; min-width:0; }
.account-details-stat strong { display:block; margin:8px 0 4px; font-size:24px; letter-spacing:-.04em; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
.account-details-stat small, .account-details-note { color:var(--dim); font-size:11px; line-height:1.6; }
.account-details-grid { display:grid; grid-template-columns:minmax(0,1.4fr) minmax(0,1fr); gap:16px; align-items:start; }
.account-details-section { margin-bottom:16px; }
.account-details-section h4 { margin:0 0 18px; font-size:13px; display:flex; align-items:center; justify-content:space-between; }
.account-details-meter { margin:0 0 20px; }
.account-details-meter:last-child { margin-bottom:0; }
.account-details-meter-title { display:flex; justify-content:space-between; gap:12px; font-size:12px; margin-bottom:9px; }
.account-details-track { height:7px; border-radius:10px; background:var(--line); overflow:hidden; }
.account-details-track i { display:block; height:100%; border-radius:10px; background:var(--accent); }
.account-details-track i.warn { background:#d29922; }
.account-details-track i.bad { background:#f85149; }
.account-details-meter small { display:block; margin-top:7px; color:var(--dim); font-size:10px; }
.account-details-info { display:grid; grid-template-columns:minmax(90px,1fr) minmax(0,1.6fr); gap:12px; font-size:12px; margin:0; }
.account-details-info dt { color:var(--dim); }
.account-details-info dd { margin:0; overflow-wrap:anywhere; text-align:right; }
.account-details-chips { display:flex; flex-wrap:wrap; gap:7px; }
.account-details-chip { font-size:10px; padding:6px 9px; border:1px solid var(--line); border-radius:7px; background:var(--bg); overflow-wrap:anywhere; max-width:100%; }
.account-details-alert { border-left:3px solid #d29922; padding:12px 14px; border-radius:6px; background:rgba(210,153,34,.08); font-size:12px; line-height:1.6; margin:16px 0; overflow-wrap:anywhere; }
.account-details-event { padding:11px 0; border-bottom:1px solid var(--line); font-size:12px; overflow-wrap:anywhere; }
.account-details-event:last-child { border-bottom:0; padding-bottom:0; }
.account-details-event small { display:block; color:var(--dim); margin-top:4px; font-size:10px; }
.account-details-footer { border-top:1px solid var(--line); padding:14px 28px; display:flex; gap:12px; justify-content:space-between; align-items:center; font-size:11px; color:var(--dim); }
.account-details-footer button { white-space:normal; }
@media(max-width:680px) { .account-details-body { padding:16px; } .account-details-topbar { padding:16px; } .account-details-stats { grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; } .account-details-grid { grid-template-columns:1fr; } .account-details-hero { padding:18px; } .account-details-footer { padding:12px 16px; } }
@media(prefers-reduced-motion:no-preference) { .account-details-dialog { animation:account-details-enter .18s ease-out; } @keyframes account-details-enter { from { transform:translateX(24px); opacity:.5; } to { transform:translateX(0); opacity:1; } } }
`;

export const ACCOUNT_DETAILS_HTML = `
<div id="accountDetailsBackdrop" class="account-details-backdrop" hidden>
  <section id="accountDetailsDialog" class="account-details-dialog" role="dialog" aria-modal="true" aria-labelledby="accountDetailsTitle" tabindex="-1">
    <header class="account-details-topbar">
      <div><div class="account-details-eyebrow">AGENT LB / ACCOUNT</div><h2 id="accountDetailsTitle"></h2></div>
      <button id="accountDetailsClose" type="button" class="account-details-close">×</button>
    </header>
    <div id="accountDetailsBody" class="account-details-body"></div>
    <footer class="account-details-footer"><span id="accountDetailsUpdated"></span><button id="accountDetailsHistory" type="button" class="btn btn-sm"></button></footer>
  </section>
</div>`;

// Stringified into the dashboard so it shares its existing polling and locale.
export function installAccountDetails({ document, getAccounts, getLanguage, getAgyEvents,
  formatNumber, formatAgo, accountTokens, scopedWeeklyRows, accountError, openHistory, now = Date.now }) {
  const backdrop = document.getElementById('accountDetailsBackdrop');
  const dialog = document.getElementById('accountDetailsDialog');
  const body = document.getElementById('accountDetailsBody');
  const closeButton = document.getElementById('accountDetailsClose');
  const historyButton = document.getElementById('accountDetailsHistory');
  let selection = null;
  let opener = null;
  let overflow = '';
  const tr = (pl, en) => getLanguage() === 'pl' ? pl : en;
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }
  function stamp(value) {
    if (value == null || value === '') return null;
    const t = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  function date(value) {
    const t = stamp(value);
    return t === null ? '—' : new Date(t).toLocaleString(getLanguage() === 'pl' ? 'pl-PL' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  }
  function section(parent, title) {
    const node = el('section', 'account-details-section');
    node.appendChild(el('h4', '', title));
    parent.appendChild(node);
    return node;
  }
  function note(parent, text) { parent.appendChild(el('div', 'account-details-note', text)); }
  function info(parent, rows) {
    const list = el('dl', 'account-details-info');
    for (const [label, value] of rows) {
      list.appendChild(el('dt', '', label)); list.appendChild(el('dd', '', value == null || value === '' ? '—' : value));
    }
    parent.appendChild(list);
  }
  function meter(parent, label, fraction, reset, detail, observed) {
    const node = el('div', 'account-details-meter');
    const ratio = typeof fraction === 'number' && Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : null;
    const expired = stamp(reset) !== null && stamp(reset) <= now();
    const title = el('div', 'account-details-meter-title');
    title.appendChild(el('span', '', label));
    title.appendChild(el('strong', '', ratio === null ? tr('Brak pomiaru', 'No measurement') : Math.round(ratio * 100) + '% ' + tr('zużyte', 'used')));
    node.appendChild(title);
    const track = el('div', 'account-details-track');
    const fill = el('i', ratio >= .9 ? 'bad' : ratio >= .7 ? 'warn' : '');
    fill.style.width = (ratio === null ? 0 : ratio * 100) + '%';
    track.appendChild(fill); node.appendChild(track);
    if (ratio !== null) node.appendChild(el('small', '', Math.round((1 - ratio) * 100) + '% ' + tr('pozostało według pomiaru', 'remaining at measurement')));
    if (reset != null) node.appendChild(el('small', '', expired
      ? tr('Termin resetu minął — oczekuje na nowy pomiar', 'Reset time passed — awaiting a new measurement')
      : tr('Reset: ', 'Resets: ') + date(reset)));
    if (detail) node.appendChild(el('small', '', detail));
    if (observed) node.appendChild(el('small', '', tr('Pomiar: ', 'Observed: ') + date(observed)));
    parent.appendChild(node);
  }
  function find() {
    if (!selection) return null;
    return getAccounts(selection.provider).find(a => (a.id || a.name) === selection.key) || null;
  }
  function state(a, agy) {
    if (agy ? a.enabled === false : a.disabled) return { label: tr('Wyłączone', 'Disabled'), tone: 'warn' };
    const reason = agy ? (a.diagnostics?.routingStatus || a.diagnostics?.status) : a.unavailable;
    if (['auth_invalid', 'forbidden', 'validation_required', 'subscription_required', 'tos_violation', 'error', 'identity-verification', 'entitlement', 'circuit-breaker'].includes(reason) ||
      (agy && (a.health?.requiresReview || a.health?.until > now()))) return { label: tr('Wymaga uwagi', 'Needs attention'), tone: 'bad' };
    if (a.quotaUntil > now() || ['quota', 'throttled', 'upstream-rejected', 'paused'].includes(reason)) return { label: tr('Czasowo niedostępne', 'Temporarily unavailable'), tone: 'warn' };
    if ((!agy && a.status === 'error') || (agy && a.diagnostics?.status === 'error')) return { label: tr('Wymaga uwagi', 'Needs attention'), tone: 'bad' };
    if (reason && reason !== 'available') return { label: tr('Dostępność niepotwierdzona', 'Availability unconfirmed'), tone: 'warn' };
    return { label: tr('Włączone do obsługi', 'Enabled for routing'), tone: 'good' };
  }
  function refresh() {
    if (!selection || backdrop.hidden) return;
    const a = find();
    body.textContent = '';
    document.getElementById('accountDetailsTitle').textContent = tr('Szczegóły konta', 'Account details');
    closeButton.setAttribute('aria-label', tr('Zamknij szczegóły konta', 'Close account details'));
    historyButton.textContent = tr('Pełna historia użycia ↗', 'Full usage history ↗');
    document.getElementById('accountDetailsUpdated').textContent = tr('Aktualizacja widoku: ', 'View updated: ') + new Date(now()).toLocaleTimeString();
    if (!a) {
      note(body, tr('To konto zostało usunięte lub nie jest już dostępne.', 'This account was removed or is no longer available.'));
      historyButton.hidden = true;
      return;
    }
    const agy = selection.provider === 'agy';
    const provider = agy ? 'Google Gemini' : selection.provider === 'codex' ? 'OpenAI Codex' : 'Anthropic Claude';
    const plan = agy ? a.subscription?.name : a.hasClaudeMax ? 'Claude Max' : a.hasClaudePro ? 'Claude Pro' : a.planType || a.organizationType;
    const status = state(a, agy);
    const hero = el('section', 'account-details-hero');
    hero.appendChild(el('div', 'account-details-eyebrow', provider));
    hero.appendChild(el('h3', '', a.name || a.email || tr('Konto bez nazwy', 'Unnamed account')));
    hero.appendChild(el('div', 'account-details-subtitle', a.email && a.email !== a.name ? a.email : provider));
    const badges = el('div'); badges.style.marginTop = '16px';
    badges.appendChild(el('span', 'account-details-status ' + status.tone, status.label));
    badges.appendChild(el('span', 'account-details-status', plan || tr('Plan nieznany', 'Unknown plan')));
    hero.appendChild(badges); body.appendChild(hero);
    const error = agy ? (a.health?.reason || (a.quotaUntil > now() ? a.quotaMessage : null)) : accountError(a)?.error;
    if (error) body.appendChild(el('div', 'account-details-alert', error));
    const u = a.usage || {};
    const stats = a.stats || {};
    const input = agy ? stats.inputTokens : u.totalInputTokens;
    const output = agy ? stats.outputTokens : u.totalOutputTokens;
    const total = agy ? (Number(input) || 0) + (Number(output) || 0) : accountTokens(u);
    const requests = agy ? stats.requests : u.totalRequests;
    const activity = agy ? stats.lastAt : u.lastUsed;
    const metrics = el('div', 'account-details-stats');
    for (const [label, value, caption] of [
      [tr('ZAPYTANIA', 'REQUESTS'), formatNumber(requests || 0), tr('Zarejestrowane przez AgentLB', 'Recorded by AgentLB')],
      [tr('TOKENY ŁĄCZNIE', 'TOTAL TOKENS'), formatNumber(total), agy ? tr('Wejście + wyjście', 'Input + output') : tr('Z uwzględnieniem cache', 'Including cache')],
      [agy ? tr('W TOKU', 'IN PROGRESS') : tr('SESJE', 'SESSIONS'), String((agy ? a.busy : a.sessions) || 0), tr('Bieżący stan konta', 'Current account state')],
      [tr('OSTATNIA AKTYWNOŚĆ', 'LAST ACTIVITY'), activity ? formatAgo(activity) : '—', activity ? date(activity) : tr('Nie zarejestrowano jeszcze', 'Not recorded yet')],
    ]) {
      const stat = el('div', 'account-details-stat'); stat.appendChild(el('div', 'account-details-eyebrow', label));
      stat.appendChild(el('strong', '', value)); stat.appendChild(el('small', '', caption)); metrics.appendChild(stat);
    }
    body.appendChild(metrics);
    const grid = el('div', 'account-details-grid'); const left = el('div'); const right = el('div');
    grid.appendChild(left); grid.appendChild(right); body.appendChild(grid);
    const limits = section(left, tr('Limity i dostępna pula', 'Limits and remaining allowance'));
    if (agy) {
      const telemetry = a.diagnostics?.telemetry?.models;
      const measurement = telemetry?.data?.length && (!u.models?.length || (stamp(telemetry.observedAt) || 0) >= (stamp(u.updatedAt) || 0)) ? telemetry : null;
      const models = measurement ? measurement.data : (u.models || []);
      const observedAt = measurement ? measurement.observedAt : u.updatedAt;
      if (!models.length) note(limits, tr('Brak pomiaru limitów. Dostęp do modelu nie oznacza znanego stanu jego limitu.', 'No quota measurement. Model access does not imply a known remaining allowance.'));
      if (measurement?.stale || !stamp(observedAt) || now() - stamp(observedAt) > 900000) note(limits, tr('Ostatnie znane pomiary — dane mogą być nieaktualne.', 'Last known measurements — data may be stale.'));
      for (const m of models) {
        const remaining = m.remainingFraction ?? m.remaining;
        meter(limits, m.displayName || m.label || m.id || tr('Model', 'Model'), typeof remaining === 'number' ? 1 - remaining : null,
          m.resetAt, null, observedAt);
      }
      for (const [model, until] of Object.entries(a.modelQuotas || {})) if (until > now()) note(limits, model + ' · ' + tr('Blokada do: ', 'Unavailable until: ') + date(until));
      if (a.quotaUntil > now()) note(limits, tr('Limit konta wyczerpany do: ', 'Account quota exhausted until: ') + date(a.quotaUntil));
    } else {
      const q = a.quota || {};
      note(limits, tr('Ostatnie pomiary dostawcy; widok nie wykonuje dodatkowych zapytań do jego API.', 'Last provider measurements; opening this view does not query the provider.'));
      if (q.unifiedStatusSeenAt) note(limits, tr('Ostatnie potwierdzenie stanu: ', 'Last status confirmation: ') + date(q.unifiedStatusSeenAt));
      let rows = 0;
      for (const [label, ratio, reset] of [
        [tr('Okno 5 godzin', '5-hour window'), q.unified5h, q.unified5hReset],
        [tr('Okno tygodniowe', 'Weekly window'), q.unified7d, q.unified7dReset],
        ...scopedWeeklyRows(q).map(r => [r.label, r.utilization, r.resetAt]),
        [tr('Tokeny API', 'API tokens'), q.tokensLimit > 0 && q.tokensRemaining != null ? 1 - q.tokensRemaining / q.tokensLimit : null, q.resetsAt],
        [tr('Zapytania API', 'API requests'), q.requestsLimit > 0 && q.requestsRemaining != null ? 1 - q.requestsRemaining / q.requestsLimit : null, q.resetsAt],
      ]) if (ratio != null) { meter(limits, label, ratio, reset); rows++; }
      if (!rows) note(limits, tr('Brak pomiaru limitów od dostawcy. Dane pojawią się po ich odczytaniu lub zaobserwowaniu ruchu.', 'No provider quota measurement. Data appears after a successful quota reading or observed traffic.'));
      if (q.spend?.limitMinor > 0) meter(limits, tr('Budżet dodatkowego użycia', 'Additional usage budget'), (q.spend.usedMinor || 0) / q.spend.limitMinor, null);
      if (q.backend?.text) note(limits, (q.backend.label || tr('Saldo', 'Balance')) + ': ' + q.backend.text);
    }
    const tokens = section(left, tr('Struktura zużycia tokenów', 'Token usage breakdown'));
    const tokenRows = [[tr('Wejście', 'Input'), input], [tr('Wyjście', 'Output'), output]];
    if (!agy) tokenRows.push([tr('Odczyt cache', 'Cache reads'), u.totalCacheReadTokens], [tr('Zapis cache', 'Cache writes'), u.totalCacheCreationTokens]);
    info(tokens, tokenRows.map(([label, value]) => [label, formatNumber(value || 0)]));
    note(tokens, tr('Liczniki dotyczą ruchu przez AgentLB, nie całego użycia u dostawcy.', 'Counters cover traffic through AgentLB, not all usage at the provider.'));
    const details = section(right, tr('Informacje o koncie', 'Account information'));
    info(details, [
      [tr('Dostawca', 'Provider'), provider], [tr('Subskrypcja', 'Subscription'), plan || tr('Nieznana', 'Unknown')],
      [tr('Priorytet', 'Priority'), agy ? '#' + ((a.order || 0) + 1) : a.priority ?? 0],
      [tr('Przypięte', 'Pinned'), agy ? (a.pinned ? tr('Tak', 'Yes') : tr('Nie', 'No')) : null],
      [tr('Ostatnia aktywność', 'Last activity'), date(activity)],
      [tr('Ważność logowania', 'Login validity'), agy ? tr('Zarządzana przez Google', 'Managed by Google') : date(a.expiresAt)],
      [tr('Dodano', 'Added'), date(a.addedAt)],
    ]);
    if (!agy && a.rateLimitedUntil) note(details, tr('Ograniczenie tempa do: ', 'Rate limited until: ') + date(a.rateLimitedUntil));
    if (agy && a.diagnostics) note(details, tr('Diagnostyka: ', 'Diagnostics: ') + a.diagnostics.status + ' · ' + date(a.diagnostics.checkedAt));
    if (agy) {
      const models = section(right, tr('Modele dostępne temu kontu', 'Models available to this account'));
      const catalog = a.modelCatalog;
      if (catalog?.models?.length) {
        const chips = el('div', 'account-details-chips');
        for (const id of catalog.models) chips.appendChild(el('span', 'account-details-chip', id));
        models.appendChild(chips);
      } else note(models, tr('Katalog jeszcze niedostępny.', 'Catalog not available yet.'));
      if (catalog?.updatedAt != null) note(models, tr('Katalog odczytano: ', 'Catalog fetched: ') + date(catalog.updatedAt));
      if (catalog?.stale) note(models, tr('Ostatnia znana lista — trwa ponawianie odczytu.', 'Last known list — discovery will retry.'));
    }
    const events = section(left, tr('Ostatnia aktywność', 'Recent activity'));
    const recent = agy ? getAgyEvents().filter(e => e.accountId === a.id).slice(-8).reverse() : (u.recent || []).slice(0, 8);
    if (!recent.length) note(events, tr('Brak zarejestrowanej historii dla tego konta.', 'No recorded history for this account.'));
    for (const e of recent) {
      const item = el('div', 'account-details-event', e.model || tr('Zapytanie API', 'API request'));
      item.appendChild(el('small', '', [date(e.at || e.timestamp), e.client || '—', agy ? e.outcome : formatNumber(e.totalTokens || 0) + ' tok'].join(' · ')));
      events.appendChild(item);
    }
    if (!agy && Object.keys(u.byModel || {}).length) {
      const models = section(right, tr('Modele używane przez to konto', 'Models used by this account'));
      info(models, Object.entries(u.byModel).slice(0, 12).map(([id, usage]) => [id, formatNumber(usage.totalTokens || 0) + ' tok']));
      note(models, tr('Historia ruchu, nie katalog dostępnych modeli.', 'Traffic history, not an available model catalog.'));
    }
    historyButton.hidden = agy;
  }
  function close() {
    if (backdrop.hidden) return;
    backdrop.hidden = true;
    document.body.style.overflow = overflow;
    const target = opener?.isConnected ? opener : [...document.querySelectorAll('[data-details-key]')].find(node =>
      node.dataset.detailsProvider === selection?.provider && node.dataset.detailsKey === String(selection?.key));
    selection = null;
    target?.focus();
  }
  function open(provider, key, trigger) {
    if (backdrop.hidden) { overflow = document.body.style.overflow; opener = trigger || document.activeElement; }
    selection = { provider, key };
    backdrop.hidden = false;
    document.body.style.overflow = 'hidden';
    refresh();
    closeButton.focus();
  }
  closeButton.addEventListener('click', close);
  backdrop.addEventListener('click', event => { if (event.target === backdrop) close(); });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key !== 'Tab') return;
    const nodes = [...dialog.querySelectorAll('button:not([hidden]):not([disabled]), [href], [tabindex="0"]')];
    const first = nodes[0]; const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  historyButton.addEventListener('click', () => { const a = find(); close(); if (a) openHistory(a); });
  return { open, close, refresh };
}
