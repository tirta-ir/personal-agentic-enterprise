import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";

export async function verifyWorkdirEnv({ page, request, call, state, until, finished, org, directory }) {
  assert(process.env.AE_TEST_ORG && path.resolve(org) !== path.resolve("../../org"), "Use an isolated organization");
  const workspace = path.join(org, "workdir");
  await mkdir(workspace, { recursive: true });
  const attached = (await call("/workspaces/probe", { path: workspace })).workspace;
  const original = (await state()).agents.find((a) => a.id === "ceo");
  const catalog = await call("/codex/settings", undefined, "GET");
  const agent = await call("/agents/ceo", { ...original, workdir: attached, model: catalog.models.find((m) => m.slug === "gpt-5.6-luna")?.slug ?? catalog.model, reasoning: "low", instructions: "Follow the requested verification exactly. Run the command using your shell tool and report its actual result. Never invent execution evidence.", permission: "read-only", timeout_seconds: 240 }, "PUT");
  const envPath = path.join(workspace, ".env");
  // This obsolete source must never be used, even when workdir .env is missing.
  await writeFile(path.join(org, "ceo/.env"), "AE_LEGACY_ENV=obsolete-value\n");
  const terminal = async (command) => {
    const started = await call("/agents/ceo/terminal", { id: crypto.randomUUID(), command });
    return until(async () => {
      const run = await call(`/agents/ceo/terminal/${started.id}`, undefined, "GET");
      return run.status !== "running" && run;
    }, 30000);
  };
  const empty = await terminal("if ($env:AE_LEGACY_ENV -or $env:AE_ENV_PROOF) { throw 'Unexpected variable' }; Write-Output 'MISSING_ENV_OK'");
  assert.equal(empty.status, "completed");
  assert(empty.output.includes("MISSING_ENV_OK"));
  const secret = `env-proof-${crypto.randomUUID()}`;
  const content = `\uFEFFAE_ENV_PROOF='${secret}'\r\nAE_QUOTED='literal-$HOME-"quoted"'\r\nAE_MULTILINE="first\nsecond"\r\n`;
  await writeFile(envPath, content);
  const check = "if (!$env:AE_ENV_PROOF -or $env:AE_LEGACY_ENV) { throw 'Environment mismatch' }; Write-Output $env:AE_ENV_PROOF; Write-Output 'WORKDIR_ENV_OK'";
  const loaded = await terminal(check);
  assert.equal(loaded.status, "completed", loaded.error);
  assert(loaded.output.includes("[REDACTED]"));
  assert(!loaded.output.includes(secret));
  const snapshot = await call("/agents/ceo/organization-context", undefined, "GET");
  assert.deepEqual(snapshot.members.find((a) => a.id === "ceo").environment_keys, ["AE_ENV_PROOF", "AE_MULTILINE", "AE_QUOTED"]);
  assert(!JSON.stringify(snapshot).includes(secret));
  for (const method of ["GET", "PUT", "DELETE"]) {
    assert.equal((await request.fetch("/api/agents/ceo/env?reveal=true", { method, ...(method === "PUT" ? { data: { values: { X: "value" } } } : {}) })).status(), 404);
  }
  assert.equal((await request.get("/api/agents/ceo/files?path=.env")).status(), 400);
  const anonymous = await page.context().browser().newContext();
  assert.equal((await anonymous.request.get(new URL("/api/agents/ceo/env", page.url()).href)).status(), 401);
  await anonymous.close();
  await page.goto("/organization/agents/ceo/workdir");
  await expect(page.getByRole("button", { name: "Environment", exact: true })).toHaveCount(0);
  await expect(page.getByText(/terminal commands automatically load/)).toBeVisible();
  await page.screenshot({ path: path.join(directory, "workdir-env.png"), animations: "disabled" });
  const send = async () => {
    const message = await call("/messages", { id: crypto.randomUUID(), group_id: "general", body: `Run this exact PowerShell command and report WORKDIR_ENV_OK only after it succeeds: ${check}`, recipients: [agent.id], reply_to: null, artifacts: [] });
    const run = await finished(message.id);
    assert.equal(run.status, "succeeded", run.error);
    const events = await call(`/runs/${run.id}/events`, undefined, "GET");
    const text = JSON.stringify(events);
    assert(text.includes("[REDACTED]"), "Actual native shell output must be redacted");
    assert(!text.includes(secret));
    assert(run.output.includes("WORKDIR_ENV_OK"));
    return run;
  };
  const first = await send();
  assert.equal(await readFile(envPath, "utf8"), content, "Platform must not rewrite dotenv");
  const updated = `changed-${crypto.randomUUID()}`;
  await writeFile(envPath, `AE_ENV_PROOF=${updated}\n`);
  const changed = await terminal(check);
  assert.equal(changed.status, "completed");
  assert(changed.output.includes("[REDACTED]"));
  assert(!changed.output.includes(updated));
  const second = await send();
  assert.equal(second.native_session_id, first.native_session_id, "Exercise real resume");
  assert(!JSON.stringify(await call(`/runs/${second.id}/events`, undefined, "GET")).includes(updated));
  // Separate workdir cannot inherit the CEO's values.
  const otherPath = path.join(org, "other-workdir");
  await mkdir(otherPath);
  const other = await call("/agents", { ...agent, id: "", name: "Other", workdir: (await call("/workspaces/probe", { path: otherPath })).workspace });
  const otherRun = await call(`/agents/${other.id}/terminal`, { id: crypto.randomUUID(), command: "if ($env:AE_ENV_PROOF -or $env:AE_LEGACY_ENV) { throw 'Leaked environment' }; Write-Output 'ISOLATED_OK'" });
  const isolated = await until(async () => { const r = await call(`/agents/${other.id}/terminal/${otherRun.id}`, undefined, "GET"); return r.status !== "running" && r; }, 30000);
  assert.equal(isolated.status, "completed");
  for (const bad of [`BROKEN="${secret}`, "CODEX_HOME=override"]) {
    await writeFile(envPath, bad);
    const rejected = await request.post("/api/agents/ceo/terminal", { data: { id: crypto.randomUUID(), command: "Write-Output 'must not start'" } });
    assert.equal(rejected.status(), 400);
    assert.match(await rejected.text(), /Invalid workdir \.env/);
    assert(!(await rejected.text()).includes(secret));
  }
  const message = await call("/messages", { id: crypto.randomUUID(), group_id: "general", body: "Reply only ENV_SHOULD_NOT_RUN", recipients: [agent.id], reply_to: null, artifacts: [] });
  const failed = await finished(message.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.pid, null);
  assert.match(failed.error, /workdir \.env/);
  await unlink(envPath);
  const removed = await terminal("if ($env:AE_ENV_PROOF -or $env:AE_LEGACY_ENV) { throw 'Stale environment' }; Write-Output 'REMOVED_ENV_OK'");
  assert.equal(removed.status, "completed");
  return { firstRun: first.id, resumedRun: second.id, failedBeforeSpawn: failed.id, terminalRuns: [empty.id, loaded.id, changed.id, isolated.id, removed.id], removedApi: 404, missingFile: "ok", fileEditsReloaded: true, legacyIgnored: true, normalizedValuesRedacted: true, mocks: "none" };
}
