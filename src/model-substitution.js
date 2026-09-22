import { resolveTargetModel } from './provider-translator.js';

// Exact model names, deliberately no wildcard fallback to an unrelated model.
// Legacy preserves existing installations. Explicit denies every unlisted change.
export function validateSubstitutionPolicy(policy) {
  if (policy == null) return;
  if (!policy || !['legacy', 'explicit'].includes(policy.mode)) throw new Error('fallbackPolicy.mode must be legacy or explicit');
  if (policy.rules != null && !Array.isArray(policy.rules)) throw new Error('fallbackPolicy.rules must be an array');
  const seen = new Set();
  for (const rule of policy.rules || []) {
    if (!rule || typeof rule.fromModel !== 'string' || !rule.fromModel.trim() ||
        typeof rule.toModel !== 'string' || !rule.toModel.trim() ||
        !['anthropic', 'codex'].includes(rule.toProvider)) throw new Error('invalid fallbackPolicy rule');
    const key = JSON.stringify([rule.fromModel, rule.toProvider]);
    if (seen.has(key)) throw new Error('duplicate fallbackPolicy source/provider rule');
    seen.add(key);
  }
}
export function substitutedModel(policy, sourceModel, targetProvider) {
  const rule = policy?.rules?.find(r => r.fromModel === sourceModel && r.toProvider === targetProvider);
  if (rule) return rule.toModel;
  return resolveTargetModel(sourceModel, targetProvider);
}
export function substitutionAllowed(policy, sourceModel, targetProvider, finalModel) {
  if (!policy || policy.mode === 'legacy') return true;
  if (sourceModel === finalModel) return true;
  if ((sourceModel === 'agy' || sourceModel === 'agy-fast') && (finalModel === 'claude-sonnet-5' || finalModel === 'claude-haiku-4-5-20251001' || finalModel === 'gpt-5.6-sol' || finalModel === 'gpt-5.6-terra')) return true;
  return !!policy.rules?.some(r => r.fromModel === sourceModel && r.toProvider === targetProvider && r.toModel === finalModel);
}
