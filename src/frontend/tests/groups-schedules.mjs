import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect } from "@playwright/test";

export async function verifyGroupsSchedules({
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
    "Use a separate native organization",
  );
  page.setDefaultTimeout(15000);
  const alpha = await call("/groups", {
    id: "",
    name: "Alpha",
    description: "Group sorting proof",
  });
  const zulu = await call("/groups", {
    id: "",
    name: "Zulu",
    description: "Group isolation proof",
  });
  await page.reload();
  const rows = page.locator(".group-row .nav-item");
  const order = () => rows.allTextContents();
  const sort = page.getByRole("button", { name: "Group options", exact: true });
  const chooseSort = async (name) => { await sort.click(); await page.getByRole("menuitem", { name, exact: true }).click(); };
  await chooseSort("A–Z");
  await expect.poll(order).toEqual(["Alpha", "General", "Zulu"]);
  await chooseSort("Z–A");
  await expect.poll(order).toEqual(["Zulu", "General", "Alpha"]);
  await page.getByRole("button", { name: "Pin Alpha", exact: true }).click();
  await expect.poll(order).toEqual(["Alpha", "Zulu", "General"]);
  await page.getByRole("button", { name: "Pin General", exact: true }).click();
  await expect.poll(order).toEqual(["General", "Alpha", "Zulu"]);
  await expect(sort).toBeEnabled();
  await page
    .getByRole("button", { name: "Reorder Alpha", exact: true })
    .dragTo(page.locator('[data-group-id="general"]'));
  await expect.poll(order).toEqual(["Alpha", "General", "Zulu"]);
  assert.equal((await state()).group_preferences.sort, "custom");
  await expect(sort).toBeEnabled();
  await page
    .getByRole("button", { name: "Reorder General", exact: true })
    .focus();
  await page.keyboard.press("ArrowUp");
  await expect.poll(order).toEqual(["General", "Alpha", "Zulu"]);
  await expect(sort).toBeEnabled();
  await page
    .getByRole("button", { name: "Unpin General", exact: true })
    .click();
  await expect.poll(order).toEqual(["Alpha", "General", "Zulu"]);
  await expect(sort).toBeEnabled();
  await page
    .getByRole("button", { name: "Reorder Zulu", exact: true })
    .dragTo(page.locator(`[data-group-id="${alpha.id}"]`));
  await expect.poll(order).toEqual(["Zulu", "Alpha", "General"]);
  const preferences = (await state()).group_preferences;
  assert(
    preferences.pinned.includes(zulu.id),
    "Dragging into pinned section pins the group",
  );
  await page.reload();
  await expect.poll(order).toEqual(["Zulu", "Alpha", "General"]);
  for (const input of [
    { ...preferences, sort: "invalid" },
    { ...preferences, order: [alpha.id, alpha.id] },
    { ...preferences, pinned: ["missing"] },
  ]) {
    assert(
      (
        await request.put("/api/preferences/groups", { data: input })
      ).status() >= 400,
    );
  }
  await page
    .getByRole("navigation", { name: "Groups", exact: true })
    .getByRole("button", { name: "Alpha", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Scheduled tasks", exact: true })
    .click();
  const bookmark = page.url();
  assert(bookmark.endsWith(`/alpha--${alpha.id}/scheduled-tasks`));
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Scheduled tasks", exact: true }),
  ).toBeVisible();

  const future = (ms = 3600000) => new Date(Date.now() + ms).toISOString();
  const input = {
    name: "Validation",
    body: "Only scheduled in Alpha",
    start_at: future(),
    repeat_minutes: null,
  };
  for (const invalid of [
    { ...input, body: " " },
    { ...input, start_at: "invalid" },
    { ...input, start_at: "2000-01-01T00:00:00Z" },
    { ...input, repeat_minutes: 0 },
  ]) {
    assert(
      (
        await request.post(`/api/groups/${alpha.id}/schedules`, {
          data: invalid,
        })
      ).status() >= 400,
    );
  }
  assert.equal(
    (
      await request.post("/api/groups/missing/schedules", { data: input })
    ).status(),
    400,
  );
  assert.equal(
    (
      await request.post(`/api/groups/${alpha.id}/schedules`, {
        data: input,
        headers: { Origin: "https://example.com" },
      })
    ).status(),
    403,
  );
  // Separate browser context uses the real unauthenticated API, without replacing it.
  const anonymous = await page.context().browser().newContext();
  assert.equal(
    (
      await anonymous.request.post(`${base}/api/groups/${alpha.id}/schedules`, {
        data: input,
      })
    ).status(),
    401,
  );
  await anonymous.close();
  const failed = await call(`/groups/${alpha.id}/schedules`, {
    ...input,
    name: "Missing workdir",
    start_at: future(1500),
  });
  await until(
    async () =>
      (await state()).schedules.find((s) => s.id === failed.id)?.last_error,
    15000,
  );
  const failure = (await state()).schedules.find((s) => s.id === failed.id);
  assert.equal(failure.enabled, false);
  assert.equal(failure.last_message_id, null);
  assert.equal(
    (await call(`/groups/${alpha.id}/messages`, undefined, "GET")).length,
    0,
  );
  assert.equal((await state()).runs.length, 0);
  await expect(
    page.getByRole("article", { name: "Missing workdir", exact: true }),
  ).toContainText("Needs attention");
  await call(`/schedules/${failed.id}`, undefined, "DELETE");

  const workspace = path.join(org, "schedule-workdir");
  await mkdir(workspace, { recursive: true });
  await writeFile(
    path.join(workspace, "sentinel.txt"),
    "SCHEDULE_WORKDIR_OK\n",
  );
  const attached = (await call("/workspaces/probe", { path: workspace }))
    .workspace;
  const ceo = (await state()).agents.find((a) => a.id === "ceo");
  await call(
    "/agents/ceo",
    {
      ...ceo,
      workdir: attached,
      reasoning: "low",
      instructions:
        "Follow the user's custom message. Use no delegation when only you are present.",
    },
    "PUT",
  );
  await page.getByRole("button", { name: "New task", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("Scheduled check-in");
  const body =
    "Read sentinel.txt in your workdir. Reply with its exact content and SCHEDULED_MESSAGE_OK. Do not modify files.";
  await dialog.getByLabel("Custom message", { exact: true }).fill(body);
  const local = await page.evaluate((iso) => {
    const d = new Date(iso);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 19);
  }, future(8000));
  await dialog.locator('input[type="datetime-local"]').fill(local);
  await dialog.getByRole("button", { name: "Save task", exact: true }).click();
  const task = await until(
    async () =>
      (await state()).schedules.find((s) => s.name === "Scheduled check-in"),
    15000,
  );
  const card = page.getByRole("article", {
    name: "Scheduled check-in",
    exact: true,
  });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(card).toContainText("Paused");
  await card.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(card).toContainText("Scheduled");
  const sent = await until(async () => {
    const s = (await state()).schedules.find((s) => s.id === task.id);
    return s?.last_message_id && s;
  }, 20000);
  assert.equal(sent.enabled, false);
  assert.equal(sent.next_run_at, null);
  const message = (
    await call(`/groups/${alpha.id}/messages`, undefined, "GET")
  ).find((m) => m.id === sent.last_message_id);
  assert.equal(message.body, body);
  assert.equal(message.schedule_id, task.id);
  assert.equal(message.auto_routed, true);
  console.log(
    `Scheduled custom message ${message.id} dispatched through real CEO queue; waiting for Codex.`,
  );
  const run = await finished(message.id);
  assert.equal(run.status, "succeeded", run.error || run.output);
  assert.match(run.output, /SCHEDULE_WORKDIR_OK/);
  assert.match(run.output, /SCHEDULED_MESSAGE_OK/);
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.locator(".scheduled-message-label")).toBeVisible();
  await expect(page.locator(".message-content .markdown").last()).toContainText(
    "SCHEDULED_MESSAGE_OK",
  );
  await page.screenshot({
    path: path.join(directory, "scheduled-chat.png"),
    fullPage: true,
  });
  await page.goto(bookmark);

  // Native service restart while an occurrence becomes due; do not alter the clock or DB.
  const repeat = await call(`/groups/${alpha.id}/schedules`, {
    ...input,
    name: "Repeating check-in",
    body: "Reply only REPEATING_SCHEDULE_OK. No tools or delegation needed.",
    start_at: future(5000),
    repeat_minutes: 60,
  });
  const scripts = path.resolve("../scripts");
  execFileSync(
    "pwsh",
    ["-NoProfile", "-File", path.join(scripts, "Stop.ps1"), "-Org", org],
    { stdio: "ignore", timeout: 25000 },
  );
  await new Promise((resolve) => setTimeout(resolve, 6000));
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
  const repeated = await until(async () => {
    const s = (await state()).schedules.find((s) => s.id === repeat.id);
    return s?.last_message_id && s;
  }, 20000);
  assert.equal(
    new Date(repeated.next_run_at) - new Date(repeat.start_at),
    3600000,
  );
  await call(`/schedules/${repeat.id}/enabled`, { enabled: false }, "PUT");
  const repeatRun = await finished(repeated.last_message_id);
  assert.equal(
    repeatRun.status,
    "succeeded",
    repeatRun.error || repeatRun.output,
  );
  assert.match(repeatRun.output, /REPEATING_SCHEDULE_OK/);
  await page.reload();
  const repeatCard = page.getByRole("article", {
    name: "Repeating check-in",
    exact: true,
  });
  await repeatCard.getByRole("button", { name: "Edit", exact: true }).click();
  await dialog
    .getByLabel("Custom message", { exact: true })
    .fill("Updated custom message");
  await dialog.getByLabel("Repeat", { exact: true }).selectOption("custom");
  await dialog
    .getByLabel("Minutes between messages", { exact: true })
    .fill("30");
  await dialog.getByRole("button", { name: "Save task", exact: true }).click();
  await expect(repeatCard).toContainText("Updated custom message");
  await expect(repeatCard).toContainText("Paused");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.screenshot({
    path: path.join(directory, "groups-scheduled-tasks.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 775, height: 900 });
  await expect(
    repeatCard.getByRole("button", { name: "Edit", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(directory, "scheduled-tasks-narrow.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 980 });
  await repeatCard
    .getByRole("button", { name: "Delete Repeating check-in", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Delete task", exact: true })
    .click();
  await expect(repeatCard).toHaveCount(0);
  const history = await call(`/groups/${alpha.id}/messages`, undefined, "GET");
  assert.equal(
    history.filter((m) => m.schedule_id === task.id).length,
    1,
    "Completed occurrence was not replayed after restart",
  );
  assert.equal(
    history.filter((m) => m.schedule_id === repeat.id).length,
    1,
    "Overdue repeat dispatched exactly once",
  );
  assert.equal(
    (await call(`/groups/${zulu.id}/messages`, undefined, "GET")).length,
    0,
  );
  assert.deepEqual((await state()).group_preferences, preferences);
  await page
    .getByRole("navigation", { name: "Groups", exact: true })
    .getByRole("button", { name: "Zulu", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Scheduled tasks", exact: true })
    .click();
  await expect(page.getByRole("article")).toHaveCount(0);
  await page.goto(bookmark);
  return {
    groups: [alpha.id, zulu.id],
    preferences,
    runs: [run.id, repeatRun.id],
    schedules: [task.id, repeat.id],
    alphabeticalSort: true,
    pinUnpin: true,
    pointerReorder: true,
    keyboardReorder: true,
    restartPersistence: true,
    scheduledCodexMessages: 2,
    failureRollback: true,
    pauseResumeEditDelete: true,
    missedOccurrenceCoalesced: true,
    completedNotReplayed: true,
    groupIsolation: true,
    authorizationChecked: true,
    narrowViewport: true,
  };
}
