import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect } from "@playwright/test";

export async function verifyChatCommands({
  page,
  request,
  call,
  state,
  until,
  finished,
  org,
  base,
  directory,
}) {
  assert(
    process.env.AE_TEST_ORG && base !== "http://127.0.0.1:8765",
    "Use a separate organization",
  );
  page.setDefaultTimeout(15000);
  const messages = () => call("/groups/general/messages", undefined, "GET");
  const sessions = () => call("/sessions", undefined, "GET");
  const send = (body, recipients = [], group_id = "general") =>
    call("/messages", { id: crypto.randomUUID(), body, group_id, recipients });
  const allFinished = (message) =>
    until(async () => {
      const runs = (await state()).runs.filter(
        (r) => r.message_id === message.id,
      );
      return (
        runs.length === 2 &&
        runs.every(
          (r) =>
            !["queued", "starting", "running", "waiting"].includes(r.status),
        ) &&
        runs
      );
    });
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("/");
  await expect(
    page.getByRole("listbox", { name: "Chat commands" }),
  ).toBeVisible();
  await expect(
    page.getByRole("listbox", { name: "Chat commands" }).getByRole("option"),
  ).toHaveCount(3);
  await page.screenshot({
    path: path.join(directory, "slash-commands.png"),
    animations: "disabled",
  });
  await input.press("ArrowDown");
  await input.press("ArrowDown");
  await input.press("Tab");
  await expect(input).toHaveValue("/usage");
  const runCount = (await state()).runs.length;
  await input.press("Enter");
  await expect(input).toHaveValue("");
  const usage = (await messages()).filter((m) => m.usage_report).at(-1);
  assert(usage.usage_report.buckets.length > 0);
  assert(
    usage.usage_report.buckets[0].primary ||
      usage.usage_report.buckets[0].secondary,
  );
  await expect(
    page.getByRole("region", { name: "Codex account usage" }).last(),
  ).toContainText("remaining");
  assert.equal(
    (await state()).runs.length,
    runCount,
    "/usage must not invoke an agent",
  );
  const usageCommand = (await messages())
    .filter((m) => m.command === "usage" && m.sender === "owner")
    .at(-1);
  const count = (await messages()).length;
  await call("/messages", {
    id: usageCommand.id,
    body: usageCommand.body,
    group_id: "general",
  });
  assert.equal((await messages()).length, count);
  await page.screenshot({
    path: path.join(directory, "codex-usage-command.png"),
    animations: "disabled",
  });
  await input.fill("/us");
  await expect(
    page.getByRole("listbox", { name: "Chat commands" }).getByRole("option"),
  ).toHaveCount(1);
  await input.press("Escape");
  await expect(
    page.getByRole("listbox", { name: "Chat commands" }),
  ).toHaveCount(0);
  await input.fill("/unknown");
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeEnabled();
  await input.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Unknown chat command");
  assert.equal((await state()).runs.length, runCount);
  await input.fill("");
  const commandInput = {
    id: crypto.randomUUID(),
    body: "/reset",
    group_id: "general",
  };
  assert.equal(
    (
      await request.post("/api/messages", {
        data: { ...commandInput, recipients: ["ceo"] },
      })
    ).status(),
    400,
  );
  assert.equal(
    (
      await request.post("/api/messages", {
        data: commandInput,
        headers: { Origin: "https://example.com" },
      })
    ).status(),
    403,
  );
  const anonymous = await page.context().browser().newContext();
  assert.equal(
    (
      await anonymous.request.post(`${base}/api/messages`, {
        data: commandInput,
      })
    ).status(),
    401,
  );
  await anonymous.close();

  const workspace = path.join(org, "reset-workdir");
  await mkdir(workspace, { recursive: true });
  await writeFile(
    path.join(workspace, "sentinel.txt"),
    "PRESERVED_AFTER_RESET\n",
  );
  const attached = (await call("/workspaces/probe", { path: workspace }))
    .workspace;
  let ceo = (await state()).agents.find((a) => a.id === "ceo");
  ceo = await call(
    "/agents/ceo",
    {
      ...ceo,
      workdir: attached,
      reasoning: "low",
      instructions:
        "Give short literal answers. Do not read or write files unless asked. Do not delegate if your task only requires a reply.",
    },
    "PUT",
  );
  const worker = await call("/agents", {
    ...ceo,
    id: "",
    name: "Engineer",
    reports_to: "ceo",
    revision: 1,
  });
  const other = await call("/groups", {
    id: "",
    name: "Other context",
    description: "Reset isolation proof",
  });
  const marker = `CONTEXT_BEFORE_RESET_${crypto.randomUUID()}`;
  const original = await send(
    `Remember this marker in this conversation only: ${marker}. Do not save it to files. Reply only ACKNOWLEDGED.`,
    [ceo.id, worker.id],
  );
  const blocked = await request.post("/api/messages", { data: commandInput });
  assert.equal(blocked.status(), 400);
  assert.match(await blocked.text(), /active runs/);
  assert(!(await messages()).some((m) => m.id === commandInput.id));
  const beforeRuns = await allFinished(original);
  assert(beforeRuns.every((r) => r.status === "succeeded"));
  const otherRun = await finished(
    (await send("Reply only OTHER_GROUP_OK. No tools needed.", [], other.id))
      .id,
  );
  assert.equal(otherRun.status, "succeeded", otherRun.error);
  const otherSession = (await sessions()).find(
    (s) => s.id === otherRun.session_id,
  );
  const profiles = (await state()).agents;
  const schedule = await call("/groups/general/schedules", {
    name: "Preserved schedule",
    body: "A future message",
    start_at: new Date(Date.now() + 86400000).toISOString(),
    repeat_minutes: null,
  });
  await call(`/schedules/${schedule.id}/enabled`, { enabled: false }, "PUT");

  await input.fill("/re");
  await page
    .getByRole("listbox", { name: "Chat commands" })
    .getByRole("option")
    .click();
  await expect(input).toHaveValue("/reset");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect(page.locator(".message-content .markdown").last()).toContainText(
    "Fresh conversation started for every agent",
  );
  const reset = (await messages()).findLast(
    (m) => m.command === "reset" && m.sender === "owner",
  );
  assert((await messages()).some((m) => m.id === original.id));
  assert.equal(
    (await sessions()).filter((s) => s.group_id === "general" && s.active)
      .length,
    0,
  );
  assert.deepEqual(
    (await sessions()).find((s) => s.id === otherRun.session_id),
    otherSession,
  );
  assert.deepEqual((await state()).agents, profiles);
  assert((await state()).schedules.some((s) => s.id === schedule.id));
  assert.equal(
    await readFile(path.join(workspace, "sentinel.txt"), "utf8"),
    "PRESERVED_AFTER_RESET\n",
  );
  await page.screenshot({
    path: path.join(directory, "reset-chat-command.png"),
    animations: "disabled",
  });
  const afterMessage = await send(
    "This is a fresh conversation. If there is any earlier remembered marker in your available context, report it. Otherwise reply only FRESH_SESSION_OK. Do not use tools or read old sessions.",
    [ceo.id, worker.id],
  );
  await call("/messages", {
    id: reset.id,
    group_id: "general",
    body: reset.body,
  });
  const afterRuns = await allFinished(afterMessage);
  for (const run of afterRuns) {
    assert.equal(run.status, "succeeded", run.error || run.output);
    assert.match(run.output, /FRESH_SESSION_OK/);
    const prior = beforeRuns.find((r) => r.agent_id === run.agent_id);
    assert.notEqual(run.session_id, prior.session_id);
    assert.notEqual(run.native_session_id, prior.native_session_id);
    assert(!run.arguments.includes("resume"));
    const nativeDirectory = path.join(
      org,
      ".state/runtime",
      run.agent_id,
      "codex/sessions",
    );
    const files = await readdir(nativeDirectory, { recursive: true });
    const transcriptPath = files.find(
      (name) => name.endsWith(".jsonl") && name.includes(run.native_session_id),
    );
    assert(transcriptPath, "Real fresh native transcript exists");
    const transcript = await readFile(
      path.join(nativeDirectory, transcriptPath),
      "utf8",
    );
    assert(
      !transcript.includes(marker),
      "Pre-reset context leaked into native input",
    );
    assert(
      !transcript.includes("Codex account usage"),
      "Usage command was forwarded into agent context",
    );
  }
  assert.equal(
    (await sessions()).filter((s) => s.group_id === "general" && s.active)
      .length,
    2,
  );
  console.log(
    `PASS real reset: ${afterRuns.map((r) => r.id).join(", ")} have fresh native sessions and no old context.`,
  );
  const scripts = path.resolve("../scripts");
  execFileSync(
    "pwsh",
    ["-NoProfile", "-File", path.join(scripts, "Stop.ps1"), "-Org", org],
    { stdio: "ignore", timeout: 25000 },
  );
  execFileSync(
    "pwsh",
    [
      "-NoProfile",
      "-File",
      path.join(scripts, "Start.ps1"),
      "-Org",
      org,
      "-Port",
      new URL(base).port,
    ],
    { stdio: "ignore", timeout: 25000 },
  );
  await page.reload();
  assert.equal(
    (await sessions()).filter((s) => s.group_id === "general" && s.active)
      .length,
    2,
  );
  assert((await messages()).some((m) => m.id === reset.id));
  assert((await messages()).some((m) => m.id === usage.id));
  await page.setViewportSize({ width: 775, height: 900 });
  await input.fill("/");
  await expect(
    page.getByRole("listbox", { name: "Chat commands" }).getByRole("option"),
  ).toHaveCount(3);
  await page.screenshot({
    path: path.join(directory, "slash-commands-narrow.png"),
    animations: "disabled",
  });
  await input.fill("");
  assert.deepEqual(
    (await readdir(path.join(org, ".state/runtime"))).filter((name) =>
      name.startsWith("usage-"),
    ),
    [],
    "Usage probe cleaned up",
  );
  return {
    usageBuckets: usage.usage_report.buckets.length,
    liveUsageWithoutRun: true,
    keyboardCompletion: true,
    pointerCompletion: true,
    unknownRejected: true,
    authorizationChecked: true,
    blockedWhileActive: true,
    resetMessage: reset.id,
    oldRuns: beforeRuns.map((r) => r.id),
    newRuns: afterRuns.map((r) => r.id),
    nativeSessionsChanged: true,
    oldContextAbsent: true,
    entireGroupReset: true,
    otherGroupPreserved: true,
    historyFilesProfilesSchedulesPreserved: true,
    idempotent: true,
    restartPersisted: true,
    usageProbeCleanedUp: true,
    narrowViewport: true,
  };
}
