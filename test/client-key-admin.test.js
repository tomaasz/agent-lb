import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "../src/server.js";
import { AccountManager } from "../src/account-manager.js";
import { resolveClientAuth } from "../src/access-control.js";

test("admin creates one restricted key, rejects invalid policies, rotates and deletes without leaking", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agentlb-admin-"));
  const prior = process.env.AGENT_LB_CONFIG;
  process.env.AGENT_LB_CONFIG = join(dir, "config.json");
  const config = {
    proxy: { apiKey: "fixture-master" },
    accounts: [],
    autoHealthCheck: { enabled: false },
  };
  await writeFile(process.env.AGENT_LB_CONFIG, JSON.stringify(config));
  const server = createProxyServer(new AccountManager([]), config);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (prior === undefined) delete process.env.AGENT_LB_CONFIG;
    else process.env.AGENT_LB_CONFIG = prior;
    await rm(dir, { recursive: true });
  });
  const base = "http://127.0.0.1:" + server.address().port;
  const call = (path, body) =>
    fetch(base + "/agent-lb/api/keys" + path, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: "Bearer fixture-master",
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const policy = {
    maxDailyTokens: 10,
    allowedModels: ["claude-allowed"],
    allowedProviders: ["anthropic"],
  };
  const created = await (
    await call("/create", { name: "station", ...policy })
  ).json();
  assert.equal(created.ok, true);
  assert.equal(config.proxy.clientKeys.length, 1);
  for (const [field, value] of Object.entries(policy)) {
    assert.deepEqual(config.proxy.clientKeys[0][field], value);
  }
  assert.equal(
    resolveClientAuth(config.proxy, created.key).entry.maxDailyTokens,
    10,
  );
  const denied = await fetch(base + "/v1/messages", {
    method: "POST",
    headers: {
      authorization: "Bearer " + created.key,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "claude-denied", messages: [] }),
  });
  assert.equal(denied.status, 403);
  await denied.text();
  assert.equal(
    (await (await call("")).json()).keys[0].allowedProviders[0],
    "anthropic",
  );
  for (const invalid of [
    { maxDailyTokens: "Infinity" },
    { allowedModels: [1] },
    { allowedProviders: ["unknown"] },
    { expiresAt: "invalid" },
  ]) {
    const response = await call("/create", { name: "invalid", ...invalid });
    assert.equal(response.status, 400);
    await response.text();
  }
  const collision = await call("/create", { name: "other", key: created.key });
  assert.equal(collision.status, 409);
  await collision.text();
  const updated = await (
    await call("/create", { name: "station", ...policy })
  ).json();
  assert.equal(config.proxy.clientKeys.length, 1);
  assert.equal(resolveClientAuth(config.proxy, created.key).ok, false);
  const rotated = await (await call("/rotate", { name: "station" })).json();
  assert.equal(resolveClientAuth(config.proxy, updated.key).ok, false);
  assert.equal(
    resolveClientAuth(config.proxy, rotated.client.key).entry.maxDailyTokens,
    10,
  );
  const revealedAll = await (await call("/reveal", { all: true })).json();
  assert.equal(revealedAll.ok, true);
  assert.equal(revealedAll.keys["station"], rotated.client.key);
  assert.equal(revealedAll.primaryKey, "fixture-master");
  const revealedOne = await (await call("/reveal", { name: "station" })).json();
  assert.equal(revealedOne.ok, true);
  assert.equal(revealedOne.key, rotated.client.key);
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  let result;
  try {
    result = await (await call("/delete", { key: rotated.client.key })).text();
  } finally {
    console.log = original;
  }
  assert.ok(!result.includes(rotated.client.key));
  assert.ok(!logs.join("\n").includes(rotated.client.key));
  assert.equal(config.proxy.clientKeys.length, 0);
  assert.equal(
    JSON.parse(await readFile(process.env.AGENT_LB_CONFIG, "utf8")).proxy
      .clientKeys.length,
    0,
  );
});
