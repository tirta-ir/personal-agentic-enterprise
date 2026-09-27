import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect } from "@playwright/test";

export async function verifyWorkspaceNavigation({ page, request, call, state, until, finished, org, directory, base }) {
  assert(process.env.AE_TEST_ORG && path.resolve(org) !== path.resolve("../../org"), "Use a disposable organization");
  page.setDefaultTimeout(15000);
  const prefs = async () => (await state()).group_preferences;
  const create = (name) => call("/groups", { id: "", name, description: "Workspace navigation verification" });
  const alpha = await create("Alpha"), zulu = await create("Zulu"), archived = await create("Archive me"), deleted = await create("Hidden deleted group");
  await call(`/groups/${archived.id}/archive`);
  await call(`/groups/${deleted.id}`, undefined, "DELETE");
  await page.reload();
  const options = page.getByRole("button", { name: "Group options", exact: true });
  const sort = async (name) => { await options.click(); await page.getByRole("menuitem", { name, exact: true }).click(); await expect(options).toBeEnabled(); };
  const order = () => page.locator(".group-row .nav-item").allTextContents();
  await expect(page.getByRole("combobox", { name: "Sort groups", exact: true })).toHaveCount(0);
  await sort("A–Z"); await expect.poll(order).toEqual(["Alpha", "General", "Zulu"]);
  await sort("Z–A"); await expect.poll(order).toEqual(["Zulu", "General", "Alpha"]);
  await page.getByRole("button", { name: "Pin Alpha", exact: true }).click();
  await expect.poll(order).toEqual(["Alpha", "Zulu", "General"]);
  await page.getByRole("button", { name: "Collapse Pinned", exact: true }).click();
  await expect(page.locator(`[data-group-id="${alpha.id}"]`)).toBeHidden();
  await page.reload(); await expect(page.getByRole("button", { name: "Expand Pinned", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Expand Pinned", exact: true }).click();
  await page.getByRole("button", { name: "Add group or section", exact: true }).click(); await page.getByRole("menuitem", { name: "Create section", exact: true }).click();
  await page.getByRole("textbox", { name: "Section name", exact: true }).fill("Engineering");
  await page.getByRole("button", { name: "Save section", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByRole("button", { name: "Move Zulu to section", exact: true }).click();
  await page.getByRole("menuitem", { name: "Engineering", exact: true }).click();
  const engineering = await until(async () => (await prefs()).sections.find((s) => s.name === "Engineering" && s.groups.includes(zulu.id)));
  await page.getByRole("button", { name: "Section options for Engineering", exact: true }).click();
  await page.getByRole("menuitem", { name: "Rename section", exact: true }).click();
  await page.getByRole("textbox", { name: "Section name", exact: true }).fill("Product team");
  await page.getByRole("button", { name: "Save section", exact: true }).click();
  await expect(page.getByRole("button", { name: "Collapse Product team", exact: true })).toBeVisible();
  await options.click(); await page.getByRole("menuitem", { name: "Create section", exact: true }).click();
  await page.getByRole("textbox", { name: "Section name", exact: true }).fill("Product team");
  await page.getByRole("button", { name: "Save section", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("unique");
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Reorder Alpha", exact: true }).dragTo(page.locator(`[data-section-id="${engineering.id}"] .group-section-heading`));
  await expect.poll(async () => (await prefs()).sections.find((s) => s.id === engineering.id).groups.sort()).toEqual([alpha.id, zulu.id].sort());
  assert(!(await prefs()).pinned.includes(alpha.id));
  await sort("A–Z");
  await page.getByRole("button", { name: "Reorder Zulu", exact: true }).focus();
  await page.keyboard.press("ArrowUp");
  await expect.poll(order).toEqual(["Zulu", "Alpha", "General"]);
  assert.equal((await prefs()).sort, "custom");
  await page.getByRole("button", { name: "Collapse Product team", exact: true }).click();
  await page.reload(); await expect(page.getByRole("button", { name: "Expand Product team", exact: true })).toBeVisible();
  const saved = await prefs();
  for (const invalid of [
    { ...saved, sections: [{ id: "pinned", name: "Reserved", groups: [] }] },
    { ...saved, sections: [{ id: "other", name: "", groups: [] }] },
    { ...saved, sections: [{ id: "other", name: "Other", groups: ["missing"] }] },
    { ...saved, sections: [...saved.sections, { id: "other", name: "Other", groups: [zulu.id] }] },
    { ...saved, collapsed: ["missing"] },
  ]) assert((await request.put("/api/preferences/groups", { data: invalid })).status() >= 400);
  assert.deepEqual(await prefs(), saved, "Rejected writes must preserve saved sections");
  assert.equal((await request.put("/api/preferences/groups", { data: saved, headers: { Origin: "https://example.com" } })).status(), 403);
  const anonymous = await page.context().browser().newContext({ baseURL: base });
  assert.equal((await anonymous.request.put("/api/preferences/groups", { data: saved })).status(), 401);
  assert.equal((await anonymous.request.get("/api/runs/missing")).status(), 401);
  await anonymous.close();
  await expect(page.getByText("Deleted groups", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Export organization", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Archived groups", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Archived groups" })).toBeVisible();
  await expect(page.getByText("Hidden deleted group", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: path.join(directory, "archive-modal.png") });
  await page.getByRole("button", { name: "Restore Archive me", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Archive me restored" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Restore Archive me", exact: true })).toHaveCount(0);
  assert.equal((await state()).groups.find((g) => g.id === archived.id).archived_at, null);
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await page.goto(`/groups/hidden--${deleted.id}/chat`);
  await expect(page.getByRole("heading", { name: "Page not found", exact: true })).toBeVisible();
  await page.goto("/groups/general/chat");
  const edge = page.getByRole("separator", { name: "Resize main navigation", exact: true });
  await edge.click(); await expect(page.getByRole("button", { name: "Show navigation", exact: true })).toBeVisible();
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await page.getByRole("button", { name: "Show navigation", exact: true }).click();
  await expect(page.locator(".sidebar")).toBeVisible();
  const edgeBox = await edge.boundingBox(), oldWidth = (await page.locator(".sidebar").boundingBox()).width;
  await page.mouse.move(edgeBox.x + edgeBox.width / 2, edgeBox.y + 100); await page.mouse.down();
  await page.mouse.move(edgeBox.x + 65, edgeBox.y + 100, { steps: 8 }); await page.mouse.up();
  assert((await page.locator(".sidebar").boundingBox()).width > oldWidth + 35, "Dragging still resizes without collapsing");
  await expect.poll(async () => (await state()).panel_sizes.sidebar).toBeGreaterThan(oldWidth + 35);
  await page.getByRole("button", { name: "Expand Product team", exact: true }).click();
  await page.screenshot({ path: path.join(directory, "desktop-sections.png") });

  const workdir = path.join(org, "navigation-workdir"); await mkdir(workdir, { recursive: true });
  await writeFile(path.join(workdir, "proof.txt"), "WORKSPACE_ACTIVITY_OK");
  const workspace = (await call("/workspaces/probe", { path: workdir })).workspace;
  const catalog = await call("/codex/settings", undefined, "GET");
  const model = catalog.models.find((m) => m.slug === "gpt-5.6-luna") ?? catalog.models.find((m) => m.slug === catalog.model);
  const effort = model.supported_reasoning_levels.find((r) => r.effort === "low")?.effort ?? model.default_reasoning_level;
  const original = (await state()).agents.find((a) => a.id === "ceo");
  const agent = await call("/agents/ceo", { ...original, name: "Navigation agent", position: "Director", model: model.slug, reasoning: effort, workdir: workspace, timeout_seconds: 180 }, "PUT");
  await page.reload();
  const message = await call("/messages", { id: crypto.randomUUID(), group_id: "general", recipients: [agent.id], body: `Run a PowerShell command to wait 5 seconds and read this absolute path: ${path.join(workdir, "proof.txt")}. Return its exact contents. Do not delegate.` });
  await expect(page.getByRole("button", { name: /Chat activity: (Working|Queued)/ })).toBeVisible({ timeout: 30000 });
  assert(await page.locator(".chat-activity .activity-spinner").count());
  await page.screenshot({ path: path.join(directory, "chat-working.png") });
  const run = await finished(message.id); assert.equal(run.status, "succeeded", run.error);
  assert(run.output.includes("WORKSPACE_ACTIVITY_OK"));
  await expect(page.getByRole("button", { name: "Chat activity: Done", exact: true })).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".chat-activity.done")).toHaveCSS("color", "rgb(20, 125, 62)");
  const badge = page.locator(".message-agent .model-badge").last();
  await expect(badge).toContainText(`${model.display_name}`); await expect(badge).toContainText(effort);
  const heading = page.locator(".message-agent .message-heading").last();
  assert(await heading.locator(".bot-badge + .model-badge").count(), "Model follows Position");
  const recorded = await call(`/runs/${run.id}`, undefined, "GET");
  assert(recorded.arguments.includes(model.slug)); assert(recorded.arguments.includes(`model_reasoning_effort="${effort}"`));
  const nextEffort = model.supported_reasoning_levels.find((r) => r.effort !== effort)?.effort ?? effort;
  await call("/agents/ceo", { ...agent, reasoning: nextEffort }, "PUT");
  await page.reload(); await expect(badge).toContainText(effort); assert(!(await badge.textContent()).includes(nextEffort) || nextEffort === effort);
  await page.screenshot({ path: path.join(directory, "chat-model-done.png") });

  // Real dotenv validation produces a failed run without sending a paid provider request.
  const envPath = path.join(workdir, ".env"); await writeFile(envPath, "=invalid\n");
  const failedMessage = await call("/messages", { id: crypto.randomUUID(), group_id: "general", recipients: [agent.id], body: "This should fail before Codex starts because the attached dotenv is invalid." });
  const failed = await finished(failedMessage.id); assert.equal(failed.status, "failed");
  await expect(page.getByRole("button", { name: "Chat activity: Needs attention", exact: true })).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".chat-activity.done")).toHaveCount(0);
  await rm(envPath);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("/btw");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("region", { name: "Side chat", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Chat activity: No recent activity", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to main chat", exact: true }).click();
  await expect(page.getByRole("button", { name: "Chat activity: Needs attention", exact: true })).toBeVisible();

  const mobileProof = await verifyMobileNavigation({ page, directory });
  await page.setViewportSize({ width: 1440, height: 980 });
  await page.goto("/groups/general/chat");
  const beforeRestart = await prefs();
  execFileSync("pwsh", ["-NoProfile", "-File", "../scripts/Stop.ps1", "-Org", org], { stdio: "ignore", timeout: 25000 });
  execFileSync("pwsh", ["-NoProfile", "-File", "../scripts/Start.ps1", "-Org", org, "-Port", new URL(base).port], { stdio: "ignore", timeout: 25000 });
  assert.deepEqual(await prefs(), beforeRestart);
  await page.reload();
  await page.getByRole("button", { name: "Section options for Product team", exact: true }).click();
  await page.getByRole("menuitem", { name: "Remove section", exact: true }).click();
  await expect(page.getByRole("button", { name: "Collapse Product team", exact: true })).toHaveCount(0);
  await expect(page.locator(`[data-section-id="all"] [data-group-id="${zulu.id}"]`)).toBeVisible();
  assert((await state()).groups.some((g) => g.id === alpha.id));
  return { run: run.id, recordedModel: model.slug, catalogName: model.display_name, reasoning: effort, failedRun: failed.id, restored: archived.id, hidden: deleted.id, sectionsPersistedAcrossRestart: true, mobile: mobileProof, mocks: false };
}

export async function verifyMobileNavigation({ page, directory }) {
  const mobileProof = [];
  for (const width of [390, 320, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/groups/general/chat");
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), { message: `No page overflow at ${width}px` }).toBe(true);
    if (width < 768) {
      await page.getByRole("button", { name: "Show navigation", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Workspace navigation", exact: true })).toBeVisible();
      const drawer = await page.getByRole("dialog", { name: "Workspace navigation", exact: true }).boundingBox();
      assert(drawer.x >= 0 && drawer.y >= 0 && drawer.x + drawer.width <= width && drawer.y + drawer.height <= 844, "Drawer stays entirely within the viewport");
      await expect(page.getByRole("button", { name: "Group options", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Archived groups", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Archived groups", exact: true })).toBeVisible();
      await page.getByRole("dialog", { name: "Archived groups", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("navigation", { name: "Groups", exact: true }).getByRole("button", { name: "General", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Workspace navigation", exact: true })).toHaveCount(0);
      await page.screenshot({ path: path.join(directory, `mobile-chat-${width}.png`) });
      for (const view of ["knowledge", "runs", "scheduled-tasks"]) {
        await page.goto(`/groups/general/${view}`);
        await expect(page.getByRole("button", { name: "Manage group", exact: true })).toBeVisible();
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), { message: `${view} overflow at ${width}px` }).toBe(true);
      }
      await page.goto("/organization/agents/ceo/profile");
      await expect(page.getByRole("textbox", { name: "Display name", exact: true })).toBeVisible();
      assert((await page.locator(".inspector").boundingBox()).width >= width - 2, "Mobile inspector uses full width");
      await page.screenshot({ path: path.join(directory, `mobile-profile-${width}.png`) });
      await page.getByRole("button", { name: "Close agent settings", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Organization", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Show navigation", exact: true })).toBeVisible();
    }
    mobileProof.push({ width, overflow: false });
  }
  const phone = await page.context().browser().newContext({ baseURL: new URL(page.url()).origin, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await page.context().storageState() });
  try {
    const touch = await phone.newPage();
    await touch.goto("/groups/general/chat");
    await touch.getByRole("button", { name: "Show navigation", exact: true }).tap();
    await touch.getByRole("button", { name: "Group options", exact: true }).tap();
    await expect(touch.getByRole("menuitem", { name: "A–Z", exact: true })).toBeVisible();
    await touch.getByRole("menuitem", { name: "A–Z", exact: true }).tap();
    await touch.getByRole("button", { name: "Archived groups", exact: true }).tap();
    await expect(touch.getByRole("dialog", { name: "Archived groups", exact: true })).toBeVisible();
    await touch.screenshot({ path: path.join(directory, "mobile-touch-archive.png") });
  } finally { await phone.close(); }
  return mobileProof;
}
