import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect } from "@playwright/test";

export async function verifyAgentTools({
  page,
  request,
  call,
  state,
  until,
  org,
  base,
  directory,
}) {
  assert(
    process.env.AE_TEST_ORG && base !== "http://127.0.0.1:8765",
    "Use an isolated organization",
  );
  page.setDefaultTimeout(20000);
  const root = "/agents/ceo/terminal";
  const history = () => call(root, undefined, "GET");
  const get = (id) => call(`${root}/${id}`, undefined, "GET");
  const finished = (id, timeout = 90000) =>
    until(async () => {
      const r = await get(id);
      return r.status !== "running" && r;
    }, timeout);
  const run = (command) => call(root, { id: crypto.randomUUID(), command });
  const ps = (value) => `'${value.replaceAll("'", "''")}'`;
  const workspace = path.join(org, "CLI workdir");
  await mkdir(workspace, { recursive: true });
  execFileSync("git", ["init", workspace], { stdio: "ignore" });
  await writeFile(
    path.join(workspace, "sentinel.txt"),
    "Existing user content\n",
  );
  const anon = await page.context().browser().newContext({ baseURL: base });
  assert.equal(
    (
      await anon.request.post(`/api${root}`, {
        data: { id: crypto.randomUUID(), command: "Get-Location" },
      })
    ).status(),
    401,
  );
  assert.equal(
    (await anon.request.get("/api/agents/ceo/skills")).status(),
    401,
  );
  await anon.close();
  assert.equal(
    (
      await request.post(`/api${root}`, {
        headers: { Origin: "https://example.com" },
        data: { id: crypto.randomUUID(), command: "Get-Location" },
      })
    ).status(),
    403,
  );
  let agent = (await state()).agents.find((a) => a.id === "ceo");
  if (!agent.workdir) {
    assert.equal((await request.get("/api/agents/ceo/skills")).status(), 400);
    assert.equal(
      (
        await request.post(`/api${root}`, {
          data: { id: crypto.randomUUID(), command: "Get-Location" },
        })
      ).status(),
      400,
    );
    await page.goto("/organization/agents/ceo/terminal");
    await expect(
      page.getByRole("button", { name: "Attach a workdir", exact: true }),
    ).toBeVisible();
  }
  const probe = await call("/workspaces/probe", { path: workspace });
  agent = await call(
    "/agents/ceo",
    { ...agent, workdir: probe.workspace },
    "PUT",
  );
  const secret = `terminal-proof-${crypto.randomUUID()}`;
  await writeFile(path.join(workspace, ".env"), `AE_TOOL_TEST=${secret}\n`);
  await page.goto("/organization/agents/ceo/skills");
  await expect(
    page.getByRole("heading", { name: "Workdir skills" }),
  ).toBeVisible();
  await expect(page.getByText("Reading installed skills…")).toBeHidden({
    timeout: 30000,
  });
  const initialSkills = await call("/agents/ceo/skills", undefined, "GET");
  assert(Array.isArray(initialSkills.skills));
  await page.getByRole("button", { name: "Install with CLI" }).click();
  await expect(page).toHaveURL(/\/ceo\/terminal$/);
  const input = page.getByRole("textbox", { name: "PowerShell command" });
  const command =
    "Write-Output 'stream-start'; Start-Sleep -Seconds 3; (Get-Location).Path; Write-Output $env:AE_TOOL_TEST; Write-Output ('inherited-secret=' + [bool]$env:AE_TOKEN)";
  await input.fill(command);
  await input.press("Control+Enter");
  const streaming = await until(async () => {
    const r = (await history()).find((r) => r.command === command);
    if (!r) return false;
    const value = await get(r.id);
    return (
      value.output.includes("stream-start") &&
      value.status === "running" &&
      value
    );
  }, 15000);
  const result = await finished(streaming.id);
  assert.equal(result.status, "completed");
  assert.equal(result.exit_code, 0);
  assert(result.output.includes(workspace));
  assert(result.output.includes("[REDACTED]"));
  assert(!result.output.includes(secret));
  assert(result.output.includes("inherited-secret=False"));
  await expect(page.getByLabel("Command output")).toContainText("[REDACTED]");
  await page.screenshot({
    path: path.join(directory, "agent-terminal.png"),
    animations: "disabled",
  });
  const duplicate = await call(root, { id: result.id, command });
  assert.equal(duplicate.id, result.id);
  assert.equal((await history()).filter((r) => r.id === result.id).length, 1);
  assert.equal(
    (
      await request.post(`/api${root}`, {
        data: { id: result.id, command: "echo different" },
      })
    ).status(),
    400,
  );
  assert.equal(
    (
      await request.post(`/api${root}`, {
        data: { id: crypto.randomUUID(), command: " " },
      })
    ).status(),
    400,
  );
  assert.equal(
    (await request.get(`/api/agents/other/terminal/${result.id}`)).status(),
    400,
  );
  const failed = await finished(
    (await run("Write-Error 'expected CLI failure'; exit 7")).id,
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.exit_code, 7);
  assert(failed.output.includes("expected CLI failure"));
  const childPidPath = path.join(workspace, "child.pid");
  const childScript = `[IO.File]::WriteAllText(${ps(childPidPath)}, [string]$PID); Write-Output 'child-ready'; Start-Sleep -Seconds 60; Set-Content -LiteralPath ${ps(path.join(workspace, "must-not-exist.txt"))} -Value 'not cancelled'`;
  const long = await run(
    `& pwsh -NoProfile -NonInteractive -Command ${ps(childScript)}`,
  );
  await until(
    async () => (await get(long.id)).output.includes("child-ready"),
    15000,
  );
  const childPid = Number(await readFile(childPidPath, "utf8"));
  assert(childPid > 0);
  assert.equal(
    (
      await request.post(`/api${root}`, {
        data: { id: crypto.randomUUID(), command: "Get-Location" },
      })
    ).status(),
    400,
  );
  assert.equal(
    (await request.put("/api/agents/ceo", { data: agent })).status(),
    400,
  );
  assert.equal((await request.delete("/api/agents/ceo")).status(), 400);
  const colleague = await call("/agents", {
    ...agent,
    id: "",
    name: "Shared workdir",
  });
  assert.equal(
    (
      await request.post(`/api/agents/${colleague.id}/terminal`, {
        data: { id: crypto.randomUUID(), command: "Get-Location" },
      })
    ).status(),
    400,
  );
  const queuedMessage = await call("/messages", {
    id: crypto.randomUUID(),
    group_id: "general",
    body: "If executed, reply OK without using tools.",
    recipients: [colleague.id],
  });
  const queued = (await state()).runs.find(
    (r) => r.message_id === queuedMessage.id,
  );
  const queuedAt = Date.now();
  await until(async () => {
    assert.equal(
      (await state()).runs.find((r) => r.id === queued.id).status,
      "queued",
      "Agent work must wait for the manual command in a shared workdir",
    );
    return Date.now() - queuedAt > 1800;
  }, 5000);
  await call(`/runs/${queued.id}/cancel`);
  await page.getByRole("button", { name: "Stop command" }).click();
  const cancelled = await finished(long.id);
  assert.equal(cancelled.status, "cancelled");
  const childAlive = execFileSync(
    "pwsh",
    [
      "-NoProfile",
      "-Command",
      `[bool](Get-Process -Id ${childPid} -ErrorAction SilentlyContinue)`,
    ],
    { encoding: "utf8" },
  ).trim();
  assert.equal(childAlive, "False", "Owned child survived Stop");

  // Install a real upstream skill through the user-facing command entrypoint.
  const install =
    "npx --yes skills@1.7.0 add vercel-labs/agent-skills --skill web-design-guidelines --agent codex --yes";
  await input.fill(install);
  await page.getByRole("button", { name: "Run command" }).click();
  const installRun = await until(
    async () => (await history()).find((r) => r.command === install),
    15000,
  );
  const installed = await finished(installRun.id, 180000);
  assert.equal(installed.status, "completed", installed.output);
  assert.equal(installed.exit_code, 0);
  assert(
    !installed.output.includes("\u001b"),
    "Installer ANSI escapes must not reach the output panel",
  );
  const skillFile = path.join(
    workspace,
    ".agents/skills/web-design-guidelines/SKILL.md",
  );
  const skillText = await readFile(skillFile, "utf8");
  assert(skillText.includes("web-design-guidelines"));
  await page
    .locator(".inspector-tabs")
    .getByRole("button", { name: "Skills", exact: true })
    .click();
  await expect(page).toHaveURL(/\/ceo\/skills$/);
  await expect(
    page
      .locator(".skill-list")
      .getByRole("button", { name: /web-design-guidelines/ }),
  ).toBeVisible({ timeout: 30000 });
  await page.screenshot({
    path: path.join(directory, "agent-skills.png"),
    animations: "disabled",
  });
  const skills = await call("/agents/ceo/skills", undefined, "GET");
  const found = skills.skills.find((s) => s.name === "web-design-guidelines");
  assert(found && found.enabled && found.scope === "repo");
  await page
    .locator(".skill-list")
    .getByRole("button", { name: /web-design-guidelines/ })
    .click();
  await expect(page.getByLabel("Skill instructions")).toContainText(
    "web-design-guidelines",
    { timeout: 30000 },
  );
  assert.equal(
    (
      await call(
        `/agents/ceo/skills?path=${encodeURIComponent(found.path)}`,
        undefined,
        "GET",
      )
    ).text,
    skillText,
  );
  assert.equal(
    (
      await request.get(
        `/api/agents/ceo/skills?path=${encodeURIComponent(path.join(org, ".state/owner.key"))}`,
      )
    ).status(),
    400,
  );
  await page.setViewportSize({ width: 800, height: 900 });
  await page.screenshot({
    path: path.join(directory, "agent-skills-narrow.png"),
    animations: "disabled",
  });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "Horizontal page overflow",
  );
  await page.setViewportSize({ width: 1440, height: 980 });
  const badSkill = path.join(workspace, ".agents/skills/broken/SKILL.md");
  await mkdir(path.dirname(badSkill), { recursive: true });
  await writeFile(
    badSkill,
    "---\nname: broken\n---\nMissing required description\n",
  );
  const invalid = await call("/agents/ceo/skills", undefined, "GET");
  assert(
    invalid.errors.some((e) =>
      e.path.replaceAll("\\", "/").includes("/broken/SKILL.md"),
    ),
    "Discovery errors must be visible",
  );
  // This intentionally malformed file exercises real Codex discovery errors.
  const oversized = await finished(
    (await run("[Console]::Write('x' * (2 * 1024 * 1024 + 1))")).id,
  );
  assert.equal(oversized.status, "failed");
  assert(oversized.error.includes("2 MiB"));
  assert.equal(oversized.output.length, 2 * 1024 * 1024);
  agent = await call("/agents/ceo", { ...agent, timeout_seconds: 10 }, "PUT");
  const timedOut = await finished(
    (await run("Write-Output 'timeout-ready'; Start-Sleep -Seconds 60")).id,
    20000,
  );
  assert.equal(timedOut.status, "timed_out");
  assert(timedOut.error.includes("10 second"));
  agent = await call("/agents/ceo", { ...agent, timeout_seconds: 300 }, "PUT");
  await page.goto("/organization/agents/ceo/terminal");
  const interrupted = await run(
    "Write-Output 'restart-ready'; Start-Sleep -Seconds 60",
  );
  await until(
    async () => (await get(interrupted.id)).output.includes("restart-ready"),
    15000,
  );
  execFileSync(
    "pwsh",
    ["-NoProfile", "-File", "../scripts/Stop.ps1", "-Org", org],
    { stdio: "ignore", timeout: 25000 },
  );
  execFileSync(
    "pwsh",
    [
      "-NoProfile",
      "-File",
      "../scripts/Start.ps1",
      "-Org",
      org,
      "-Port",
      new URL(base).port,
    ],
    { stdio: "ignore", timeout: 25000 },
  );
  assert.equal((await get(interrupted.id)).status, "interrupted");
  assert.equal((await get(result.id)).output, result.output);
  await page.reload();
  await expect(page.getByLabel("Command output")).toContainText(
    "restart-ready",
  );
  const usageMessage = await call("/messages", {
    id: crypto.randomUUID(),
    group_id: "general",
    body: "/usage",
  });
  assert(usageMessage.id);
  const usage = (await call("/groups/general/messages", undefined, "GET")).find(
    (m) => m.usage_report,
  );
  assert(
    usage?.usage_report.buckets.length > 0,
    "Shared Codex RPC must preserve live /usage",
  );
  assert.equal(
    (await state()).runs.filter(
      (r) => r.pid !== null || r.native_session_id !== null,
    ).length,
    0,
    "CLI and skill discovery must not create agent turns",
  );
  assert.equal(
    await readFile(path.join(workspace, "sentinel.txt"), "utf8"),
    "Existing user content\n",
  );
  const proof = {
    workspace,
    streaming: result.id,
    failure: failed.id,
    cancelled: long.id,
    killedChildPid: childPid,
    installed: installed.id,
    skill: found,
    interrupted: interrupted.id,
    outputLimit: oversized.id,
    timeout: timedOut.id,
    sharedWorkdirQueuedThenCancelled: queued.id,
    historyPersisted: true,
    liveUsage: true,
    authorization: true,
    mocks: false,
  };
  await writeFile(
    path.join(directory, "agent-tools-proof.json"),
    JSON.stringify(proof, null, 2),
  );
  return proof;
}
