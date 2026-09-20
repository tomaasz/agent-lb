import { randomBytes } from 'node:crypto';
import { atomicConfigUpdate } from './config.js';
import { maskSecret } from './access-control.js';
import { readControlBody } from './control-body.js';

// Caller must authorize administrator access before dispatching these handlers.
export async function handleClientKeys({ req, res, normApiPath, config, hooks, clientUsage }) {
  // Client Keys: List (GET /agentlb/api/keys & GET /agentlb/client-keys)
  if (req.method === 'GET' && (normApiPath === '/api/keys' || normApiPath === '/client-keys')) {
    const clientsStats = clientUsage?.export() || hooks.getStatusExtra?.()?.clients || {};
    const keys = (config.proxy?.clientKeys || []).map(k => {
      const raw = k.key || '';
      const masked = maskSecret(raw);
      const stat = clientsStats[k.name] || { requests: 0, connections: 0, inputTokens: 0, outputTokens: 0, dailyTokens: 0, monthlyTokens: 0, lastUsed: null };
      return {
        name: k.name,
        key: masked,
        maskedKey: masked,
        created: k.created || null,
        maxDailyTokens: k.maxDailyTokens != null ? Number(k.maxDailyTokens) : null,
        maxMonthlyTokens: k.maxMonthlyTokens != null ? Number(k.maxMonthlyTokens) : null,
        expiresAt: k.expiresAt || null,
        allowedModels: Array.isArray(k.allowedModels) ? k.allowedModels : null,
        allowedProviders: Array.isArray(k.allowedProviders) ? k.allowedProviders : null,
        dailyTokens: stat.dailyTokens || 0,
        monthlyTokens: stat.monthlyTokens || 0,
        stats: stat,
      };
    });
    const primaryRaw = config.proxy?.apiKey || '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      primaryKeyMasked: maskSecret(primaryRaw),
      keys,
      clientKeys: keys
    }));
    return true;
  }

  // Client Keys: Create / Add (POST /agentlb/api/keys/create & POST /agentlb/client-keys/add)
  if (req.method === 'POST' && (normApiPath === '/api/keys/create' || normApiPath === '/client-keys/add' || normApiPath === '/client-keys')) {
    let body;
    try {
      const raw = await readControlBody(req);
      body = JSON.parse(raw || '{}');
    } catch (err) {
      const tooLarge = err.message === 'body too large';
      res.writeHead(tooLarge ? 413 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: tooLarge ? 'request body too large' : 'invalid request body' }));
      return true;
    }

    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'missing "name"' }));
      return true;
    }

    const customKey = typeof body?.key === 'string' ? body.key.trim() : '';
    const key = customKey || ('tc-' + randomBytes(24).toString('base64url'));
    const nowIso = new Date().toISOString();

    const policy = {};
    for (const field of ['maxDailyTokens', 'maxMonthlyTokens']) {
      if (body[field] == null) continue;
      const value = Number(body[field]);
      if (!Number.isSafeInteger(value) || value <= 0) {
        res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'invalid token limit' }));
        return true;
      }
      policy[field] = value;
    }
    if (body.expiresAt != null) {
      if (typeof body.expiresAt !== 'string' || !Number.isFinite(Date.parse(body.expiresAt))) {
        res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'invalid expiry' }));
        return true;
      }
      policy.expiresAt = body.expiresAt;
    }
    for (const field of ['allowedModels', 'allowedProviders']) {
      if (body[field] == null) continue;
      if (!Array.isArray(body[field]) || body[field].some(v =>
        typeof v !== 'string' || !v.trim() ||
        (field === 'allowedProviders' && !['anthropic', 'codex'].includes(v)))) {
        res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'invalid access policy' }));
        return true;
      }
      policy[field] = body[field];
    }
    let duplicate = false;
    const updated = await atomicConfigUpdate(disk => {
      disk.proxy ||= {};
      disk.proxy.clientKeys ||= [];
      if (key === disk.proxy.apiKey || disk.proxy.clientKeys.some(k => k.name !== name && k.key === key)) {
        duplicate = true;
        return;
      }
      const existing = disk.proxy.clientKeys.find(k => k.name === name);
      disk.proxy.clientKeys = disk.proxy.clientKeys.filter(k => k.name !== name);
      disk.proxy.clientKeys.push({ name, key, created: existing?.created || nowIso, ...policy });
    });
    if (duplicate) {
      res.writeHead(409); res.end(JSON.stringify({ ok: false, error: 'key already in use' }));
      return true;
    }
    config.proxy ||= {};
    config.proxy.clientKeys = updated.proxy.clientKeys;

    if (hooks.reload) await hooks.reload();
    console.log('[AgentLB] Created/updated client access key (web control)');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name, key, client: { name, key } }));
    return true;
  }

  // Client Keys: Delete / Remove (POST /agentlb/api/keys/delete & POST /agentlb/client-keys/remove)
  if ((req.method === 'POST' && (normApiPath === '/api/keys/delete' || normApiPath === '/client-keys/remove')) ||
      (req.method === 'DELETE' && (normApiPath === '/client-keys' || normApiPath === '/api/keys'))) {
    let body;
    try {
      const raw = await readControlBody(req);
      body = JSON.parse(raw || '{}');
    } catch (err) {
      const tooLarge = err.message === 'body too large';
      res.writeHead(tooLarge ? 413 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: tooLarge ? 'request body too large' : 'invalid request body' }));
      return true;
    }

    const target = typeof body?.name === 'string' ? body.name.trim() : (typeof body?.key === 'string' ? body.key.trim() : '');
    if (!target) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'missing "name" or "key"' }));
      return true;
    }

    await atomicConfigUpdate(disk => {
      if (Array.isArray(disk.proxy?.clientKeys)) {
        disk.proxy.clientKeys = disk.proxy.clientKeys.filter(k => k.name !== target && k.key !== target);
      }
    });

    if (Array.isArray(config.proxy?.clientKeys)) {
      config.proxy.clientKeys = config.proxy.clientKeys.filter(k => k.name !== target && k.key !== target);
    }

    if (hooks.reload) await hooks.reload();
    console.log('[AgentLB] Removed client access key (web control)');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, removed: true }));
    return true;
  }

  // Client Keys: Rotate
  if (req.method === 'POST' && (normApiPath === '/client-keys/rotate' || normApiPath === '/api/keys/rotate')) {
    let body;
    try {
      const raw = await readControlBody(req);
      body = JSON.parse(raw || '{}');
    } catch (err) {
      const tooLarge = err.message === 'body too large';
      res.writeHead(tooLarge ? 413 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: tooLarge ? 'request body too large' : 'invalid request body' }));
      return true;
    }

    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'missing "name"' }));
      return true;
    }

    const newKey = 'tc-' + randomBytes(24).toString('base64url');

    await atomicConfigUpdate(disk => {
      if (!disk.proxy) disk.proxy = {};
      if (!Array.isArray(disk.proxy.clientKeys)) disk.proxy.clientKeys = [];
      const idx = disk.proxy.clientKeys.findIndex(k => k.name === name);
      if (idx >= 0) {
        for (const entry of disk.proxy.clientKeys) {
          if (entry.name === name) entry.key = newKey;
        }
      } else {
        disk.proxy.clientKeys.push({ name, key: newKey, created: new Date().toISOString() });
      }
    });

    if (!config.proxy) config.proxy = {};
    if (!Array.isArray(config.proxy.clientKeys)) config.proxy.clientKeys = [];
    const memIdx = config.proxy.clientKeys.findIndex(k => k.name === name);
    if (memIdx >= 0) {
      for (const entry of config.proxy.clientKeys) {
        if (entry.name === name) entry.key = newKey;
      }
    } else {
      config.proxy.clientKeys.push({ name, key: newKey, created: new Date().toISOString() });
    }

    if (hooks.reload) await hooks.reload();
    console.log('[AgentLB] Rotated client access key (web control)');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, client: { name, key: newKey } }));
    return true;
  }

  return false;
}
