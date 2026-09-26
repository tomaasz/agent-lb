import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { renderDashboardHtml } from "../src/dashboard.js";
import { createProxyServer } from "../src/server.js";

// /jcode-setup.sh i /agent-prompt.md są serwowane bez logowania (jak pozostałe instalatory),
// z adresem serwera wstawionym w miejsce https://agentlb.gotova.pl.
describe("agent prompt + jcode setup", () => {
  let server;
  let base;
  before(async () => {
    const am = { accounts: [], getStatus: () => ({ accounts: [], sessions: {} }) };
    server = createProxyServer(am, { proxy: { apiKey: "admin-secret" } });
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  it("serves jcode-setup.sh as a shell script with the request origin baked in", async () => {
    const res = await fetch(`${base}/jcode-setup.sh`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/x-sh/);
    const body = await res.text();
    assert.ok(body.startsWith("#!/usr/bin/env bash"));
    assert.ok(body.includes(`URL="\${AGENT_LB_URL:-${base}}"`), "origin baked into default URL");
    assert.ok(!body.includes("agentlb.gotova.pl"), "no hard-coded public host left");
  });

  it("serves agent-prompt.md as markdown (also via /agentlb prefix and without extension)", async () => {
    for (const p of ["/agent-prompt.md", "/agent-prompt", "/agentlb/agent-prompt.md"]) {
      const res = await fetch(`${base}${p}`);
      assert.equal(res.status, 200, p);
      assert.match(res.headers.get("content-type"), /text\/markdown/, p);
      const body = await res.text();
      assert.ok(body.includes(`${base}/jcode-setup.sh`), `${p}: links local jcode-setup.sh`);
      assert.ok(body.includes("AGENT_LB_API_KEY"), p);
    }
  });

  it("has no Windows variant of jcode-setup and does not fall back to setup.sh", async () => {
    const res = await fetch(`${base}/jcode-setup.ps1`);
    assert.equal(res.status, 404);
    await res.text();
    const md = await fetch(`${base}/setup.md`);
    assert.equal(md.status, 404);
    await md.text();
  });

  it("jcode-setup.sh parses and contains no secrets or personal paths", () => {
    const r = spawnSync("bash", ["-n", "setup/jcode-setup.sh"]);
    assert.equal(r.status, 0, r.stderr?.toString());
    const src = spawnSync("cat", ["setup/jcode-setup.sh"]).stdout.toString();
    assert.ok(!/tc-[A-Za-z0-9_-]{20,}/.test(src), "no station key literal");
    assert.ok(!src.includes("/home/tomaasz"), "no personal home path");
  });

  it("dashboard setup modal offers the agent prompt and jcode command", () => {
    const html = renderDashboardHtml();
    for (const id of ["cmdAgentPrompt", "btnCopyAgentPrompt", "cmdJcodeSetupBash", "btnCopyJcodeSetupBash", "lnkAgentPrompt"]) {
      assert.ok(html.includes(`id="${id}"`), id);
    }
    assert.ok(html.includes("bindCopy('btnCopyAgentPrompt', 'cmdAgentPrompt'"));
  });
});
