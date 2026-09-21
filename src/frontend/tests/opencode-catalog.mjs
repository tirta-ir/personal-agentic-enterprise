// Real native catalogs, Rust API and browser; no provider calls in catalog checks.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";

const live = process.argv.includes("--live");
const org = path.resolve(live ? "../../org" : "../../org/verification-opencode-20260920");
const baseURL = `http://10.69.0.102:${live ? 8765 : 8766}`;
const proofDir = path.resolve("../../org/.state/verification/opencode-catalog-20260920");
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
async function api(route, data, method = data === undefined ? "GET" : "POST") {
  const response = await context.request.fetch(`/api${route}`, { method, ...(data === undefined ? {} : { data }), timeout: 90000 });
  assert(response.ok(), `${route}: ${response.status()} ${await response.text()}`);
  return response.json();
}
const proof = [];
try {
  await api("/login", { token: (await fs.readFile(path.join(org, ".state/owner.key"), "utf8")).trim() });
  const state = await api("/state");
  for (const remote of [false, true]) {
    const agent = state.agents.find(a => remote ? a.workdir?.ssh_host === "mac-personal" : a.workdir && !a.workdir.ssh_host && (live || a.name === "OpenCode Pilot"));
    assert(agent);
    const route = `/harness/settings?harness=opencode&agent_id=${agent.id}`;
    const catalog = await api(route);
    const providers = [...new Set(catalog.models.map(m => m.slug.split("/")[0]))];
    assert(providers.includes("tokenrouter"));
    assert(catalog.models.some(m => !m.slug.endsWith("-free")));
    assert(catalog.models.some(m => m.slug === catalog.model));
    await page.goto(`/organization/agents/${agent.id}/profile`);
    await page.getByLabel("Harness", { exact: true }).selectOption("opencode");
    await expect(page.locator('#profile-harness option[value="opencode"]')).toHaveText("OpenCode");
    const model = page.getByLabel("Model", { exact: true });
    await expect(model.locator("option")).toHaveCount(catalog.models.length + 1, { timeout: 30000 });
    for (const entry of catalog.models) {
      await expect(model.locator(`option[value="${entry.slug}"]`)).toHaveText(`${entry.display_name} · ${entry.slug.split("/")[0]}`);
    }
    await expect(model.locator('option[value=""]')).toHaveText(`Use OpenCode setting (${catalog.model})`);
    if (!live && !remote) {
      const file = path.join(agent.workdir.path, "opencode.json");
      // A temporary native provider definition tests discovery only; no model call
      // or fake HTTP service is made against its unconnected local endpoint.
      await fs.writeFile(file, JSON.stringify({ provider: { "catalog-smoke": { npm: "@ai-sdk/openai-compatible", name: "Catalog smoke", options: { baseURL: "http://127.0.0.1:11434/v1" }, models: { "new-model": { name: "New CLI model" } } } } }), { flag: "wx" });
      try {
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect(model.locator('option[value="catalog-smoke/new-model"]')).toHaveText("New CLI model · catalog-smoke", { timeout: 30000 });
      } finally { await fs.unlink(file); }
      await page.getByRole("button", { name: "Refresh models" }).click();
      await expect(model.locator('option[value="catalog-smoke/new-model"]')).toHaveCount(0, { timeout: 30000 });
    }
    await page.screenshot({ path: path.join(proofDir, `${live ? "live" : "pilot"}-${remote ? "mac" : "local"}-catalog.png`) });
    proof.push({ host: remote ? "mac-personal" : "local", modelCount: catalog.models.length, providers, default: catalog.model });
  }
  const after = await api("/state");
  assert.deepEqual(after.agents, state.agents);
  assert.deepEqual(after.groups, state.groups);
  assert.deepEqual(errors, []);
  assert.equal((await context.request.get("/api/harness/settings?harness=opencode", { headers: { cookie: "" } })).status(), 401);
  await fs.writeFile(path.join(proofDir, live ? "live-proof.json" : "pilot-proof.json"), JSON.stringify({ catalogs: proof, profilesPreserved: true, browserErrors: errors }, null, 2));
  console.log(JSON.stringify(proof));
} finally { await browser.close(); }
