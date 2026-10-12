// The band decision, as a pure function of a snapshot. `decideBand` reads no
// clock, no account object and no configuration. `now` arrives in the snapshot,
// so the same snapshot always yields the same decision and the decision can be
// driven with inputs a live fleet cannot easily be put into. An account whose
// window is unreported is its own variant rather than a coerced `null`, so
// nothing downstream has to remember whether that null meant zero pressure,
// infinite pressure or nothing known.

// The longest a weekly window can be. Scoring an account with no clock as
// though its window were the furthest it could be gives a LOWER BOUND on its
// true pressure: it can only turn out to be worth more, never less, so it can
// never be preferred over a measured account on a number nobody reported. Not a
// tuning constant, but the definition of the window.
const WEEKLY_WINDOW_SECONDS = 7 * 24 * 3600;

/**
 * Why an account has no comparable pressure. Each names an upstream state
 * rather than a failure, so a caller branches on a value rather than a message.
 *
 * @typedef {'no-utilization' | 'no-reset' | 'utilization-not-finite'
 *         | 'expiry-routing-off'} AbsentReason
 */

/**
 * `lowerBound` is carried by `no-reset` alone: the least this account's pressure
 * can turn out to be once its window is reported. The other reasons have no
 * utilization to bound anything with.
 *
 * @typedef {{ kind: 'known', value: number }
 *         | { kind: 'absent', reason: AbsentReason, lowerBound?: number }} Pressure
 */

/**
 * One account as the decision sees it, deliberately not an account object: the
 * decision layer cannot reach anything it was not handed.
 *
 * @typedef {{ index: number, priority: number, utilization: number | null,
 *             resetAt: number | null }} BandAccount
 */

/**
 * @typedef {{ now: number, enabled: boolean, tolerance: number,
 *             accounts: BandAccount[] }} BandSnapshot
 */

/**
 * Why the band kept everything it was given. `no-known-pressure` is the cold
 * start: the mechanism stays inert until a signal exists rather than guessing
 * from a default.
 *
 * @typedef {'disabled' | 'single-candidate' | 'no-known-pressure'} PassthroughReason
 */

/**
 * @typedef {{ kind: 'passthrough', reason: PassthroughReason }
 *         | { kind: 'banded', keep: number[], floor: number }} BandDecision
 */

/**
 * Exhaustiveness enforced at runtime: on plain JS a variant nothing here
 * handles has no other check.
 */
export function assertNever(value, context) {
  throw new Error(`${context}: unhandled variant ${JSON.stringify(value)}`);
}

/**
 * The expiring-quota pressure of one account: headroom per second remaining in
 * its governing window, so higher means more quota closer to expiring.
 *
 * @param {BandAccount} account
 * @param {number} now
 * @returns {Pressure}
 */
export function pressureOf(account, now) {
  if (account.utilization == null) return { kind: 'absent', reason: 'no-utilization' };
  // Ahead of the reset check, so that `no-reset` means the utilization is known
  // and only the clock is missing: the whole basis on which it is rankable.
  // Clamping a non-finite utilization would read as 0, a completely unspent
  // window, which is the strongest score there is out of a malformed value.
  if (!Number.isFinite(account.utilization)) {
    return { kind: 'absent', reason: 'utilization-not-finite' };
  }
  const spendable = spendableFraction(account.utilization);
  if (!account.resetAt) {
    return { kind: 'absent', reason: 'no-reset', lowerBound: spendable / WEEKLY_WINDOW_SECONDS };
  }
  const seconds = (account.resetAt - now) / 1000;
  // A passed reset is a KNOWN pressure of zero, not an absence: worth nothing to
  // spend for expiry reasons is a different claim from nothing being known.
  if (seconds <= 0) return { kind: 'known', value: 0 };
  const value = spendable / seconds;
  return Number.isFinite(value)
    ? { kind: 'known', value }
    : { kind: 'absent', reason: 'utilization-not-finite' };
}

/** How much of a window is left to spend. Clamped at both ends: above 1 is real
 * overage and leaves nothing, below 0 would read as MORE headroom than the
 * window has. Shared by the measured pressure and the unknown-reset bound so the
 * two cannot disagree about what an account is holding. */
function spendableFraction(utilization) {
  return 1 - Math.min(1, Math.max(0, utilization));
}

/**
 * A pressure as an ascending sort key, so it reads like priority and reset in
 * the caller's chain. Discovery sorts first, at the `-Infinity` an unknown reset
 * sorts at in `_pickBestAvailable`: using an account is how its quota becomes
 * known. `expiry-routing-off` sorts there too and must be constant across the
 * fleet, or the off switch stops being one. A bounded absence sorts by its
 * bound, since `no-reset` knows the utilization and lacks only the clock.
 */
export function pressureRank(pressure) {
  switch (pressure.kind) {
    case 'known': return -pressure.value;
    case 'absent': return pressure.lowerBound == null ? -Infinity : -pressure.lowerBound;
    default: return assertNever(pressure, 'pressureRank');
  }
}

/**
 * The accounts worth spending, as a decision. Only the best priority tier is
 * banded: priority is the operator's explicit order and has to keep winning, so
 * a high-pressure low-priority fallback must not band out the tier the operator
 * preferred. Lower tiers pass through unfiltered, since they are reached only
 * when the top tier is empty, which banding cannot cause because the maximum
 * always qualifies.
 */
export function decideBand(snapshot) {
  const { accounts, now, tolerance, enabled } = snapshot;
  if (!enabled) return { kind: 'passthrough', reason: 'disabled' };
  if (accounts.length <= 1) return { kind: 'passthrough', reason: 'single-candidate' };

  const top = Math.min(...accounts.map(a => a.priority));
  const tier = accounts.filter(a => a.priority === top);
  const pressures = tier.map(a => pressureOf(a, now));
  const known = pressures.filter(p => p.kind === 'known').map(p => p.value);
  if (!known.length) return { kind: 'passthrough', reason: 'no-known-pressure' };

  const maxKnown = Math.max(...known);
  // A tolerance below 1 asks for accounts strictly better than the best there
  // is, and a non-finite one defines no floor at all; both empty the tier and
  // break "the maximum always qualifies". Clamping makes that true by
  // construction. `setExpiryRouting` clamps the config, but this function is
  // exported and takes a plain number, so the precondition holds here as well.
  const ratio = Number.isFinite(tolerance) && tolerance > 0 ? tolerance : 1;
  const floor = Math.min(maxKnown, maxKnown / ratio);

  const keep = [];
  tier.forEach((account, i) => {
    const pressure = pressures[i];
    switch (pressure.kind) {
      // An unknown account stays in, bounded or not: using it is how its quota
      // is discovered, and its window is exactly what using it reports. An
      // account its bound disqualifies is held off by the RANKING, in
      // `_belowBandFloor`.
      case 'absent': keep.push(account.index); break;
      case 'known': if (pressure.value >= floor) keep.push(account.index); break;
      default: assertNever(pressure, 'decideBand');
    }
  });
  // Top tier first, then every lower tier untouched. The order is part of the
  // contract: callers break ties by taking the first acceptable candidate, so
  // emitting in the snapshot's order would silently re-rank a mixed-priority
  // fleet.
  for (const account of accounts) {
    if (account.priority !== top) keep.push(account.index);
  }
  return { kind: 'banded', keep, floor };
}

/** Defaults for the session-burn rule, see `decideSessionBurn`. */
export const SESSION_BURN_DEFAULTS = Object.freeze({
  enabled: true,
  withinMin: 90,
  minSpendable: 0.25,
  minWeeklySpendable: 0.10,
});

/**
 * The account whose 5-hour window is about to reset with quota still unspent,
 * as a decision: that quota is lost at the reset, so spending it is free as
 * long as the week can pay for it (every token also meters into the weekly
 * window). Pure, like `decideBand`: `now` arrives in the snapshot.
 *
 * An account qualifies when its session resets within `withinMin`, at least
 * `minSpendable` of the session is unspent, and at least `minWeeklySpendable`
 * of its governing weekly window is. Unknown session or weekly readings never
 * qualify: the rule acts only on what was reported. Of the qualifiers the
 * highest session-pressure (unspent fraction per second to reset) wins, so the
 * result is one account and deterministic.
 *
 * @typedef {{ index: number, priority: number, sessionUtilization: number | null,
 *             sessionResetAt: number | null, weeklyUtilization: number | null }} BurnAccount
 * @param {{ now: number, config: typeof SESSION_BURN_DEFAULTS, accounts: BurnAccount[] }} snapshot
 * @returns {{ kind: 'none', reason: 'disabled' | 'no-qualifier' }
 *         | { kind: 'burn', index: number, pressure: number }}
 */
export function decideSessionBurn(snapshot) {
  const { accounts, now, config } = snapshot;
  if (!config || !config.enabled) return { kind: 'none', reason: 'disabled' };
  const horizonMs = config.withinMin * 60_000;
  let best = null;
  for (const a of accounts) {
    if (a.sessionUtilization == null || !Number.isFinite(a.sessionUtilization)) continue;
    if (a.weeklyUtilization == null || !Number.isFinite(a.weeklyUtilization)) continue;
    if (!a.sessionResetAt) continue;
    const msLeft = a.sessionResetAt - now;
    if (msLeft <= 0 || msLeft > horizonMs) continue;
    const sessionSpendable = spendableFraction(a.sessionUtilization);
    if (sessionSpendable < config.minSpendable) continue;
    if (spendableFraction(a.weeklyUtilization) < config.minWeeklySpendable) continue;
    const pressure = sessionSpendable / (msLeft / 1000);
    if (!best || pressure > best.pressure) best = { index: a.index, pressure };
  }
  return best ? { kind: 'burn', ...best } : { kind: 'none', reason: 'no-qualifier' };
}

/** A hand-edited config into a usable session-burn config: only a literal
 * `false` for `enabled` turns it off, and each number must be finite and in
 * range or it falls back to the default. */
export function normalizeSessionBurn(raw) {
  const d = SESSION_BURN_DEFAULTS;
  const c = raw && typeof raw === 'object' ? raw : {};
  const num = (v, lo, hi, dflt) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : dflt);
  return {
    enabled: c.enabled !== false,
    withinMin: num(c.withinMin, 1, 300, d.withinMin),
    minSpendable: num(c.minSpendable, 0, 1, d.minSpendable),
    minWeeklySpendable: num(c.minWeeklySpendable, 0, 1, d.minWeeklySpendable),
  };
}

/** Defaults for the weekly-burn rule, see `decideWeeklyBurn`. `preemptPinned`
 * lets the rule move sessions already pinned elsewhere, at the cost of their
 * prompt cache. `crossPriority` lets it pick an account from a lower priority
 * tier: a fallback account's expiring week is lost like any other. */
export const WEEKLY_BURN_DEFAULTS = Object.freeze({
  enabled: true,
  withinHours: 72,
  minSpendable: 0.15,
  preemptPinned: true,
  crossPriority: true,
});

/**
 * The account whose weekly window resets within `withinHours` with at least
 * `minSpendable` of it unspent: that quota is lost at the reset, and a week is
 * far larger than a 5-hour session, so this outranks `decideSessionBurn`. Same
 * contract as it: pure, unknown readings never qualify, the highest
 * unspent-per-second wins.
 *
 * @param {{ now: number, config: typeof WEEKLY_BURN_DEFAULTS,
 *           accounts: { index: number, weeklyUtilization: number | null, weeklyResetAt: number | null }[] }} snapshot
 * @returns {{ kind: 'none', reason: 'disabled' | 'no-qualifier' }
 *         | { kind: 'burn', index: number, pressure: number }}
 */
export function decideWeeklyBurn(snapshot) {
  const { accounts, now, config } = snapshot;
  if (!config || !config.enabled) return { kind: 'none', reason: 'disabled' };
  const horizonMs = config.withinHours * 3600_000;
  let best = null;
  for (const a of accounts) {
    if (a.weeklyUtilization == null || !Number.isFinite(a.weeklyUtilization)) continue;
    if (!a.weeklyResetAt) continue;
    const msLeft = a.weeklyResetAt - now;
    if (msLeft <= 0 || msLeft > horizonMs) continue;
    const spendable = spendableFraction(a.weeklyUtilization);
    if (spendable < config.minSpendable) continue;
    const pressure = spendable / (msLeft / 1000);
    if (!best || pressure > best.pressure) best = { index: a.index, pressure };
  }
  return best ? { kind: 'burn', ...best } : { kind: 'none', reason: 'no-qualifier' };
}

/** A hand-edited config into a usable weekly-burn config; see `normalizeSessionBurn`. */
export function normalizeWeeklyBurn(raw) {
  const d = WEEKLY_BURN_DEFAULTS;
  const c = raw && typeof raw === 'object' ? raw : {};
  const num = (v, lo, hi, dflt) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : dflt);
  return {
    enabled: c.enabled !== false,
    withinHours: num(c.withinHours, 1, 168, d.withinHours),
    minSpendable: num(c.minSpendable, 0, 1, d.minSpendable),
    preemptPinned: c.preemptPinned !== false,
    crossPriority: c.crossPriority !== false,
  };
}
