import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium, expect } from "@playwright/test";

// Real service, real SQLite/LanceDB and (in the codex phase) the signed-in CLI.
const org = path.resolve(process.env.AE_TEST_ORG || "../../org");
const base = process.env.AE_TEST_URL || "http://127.0.0.1:8765";
const directory = path.join(org, ".state/verification");
await mkdir(directory, { recursive: true });
const proofPath = path.join(directory, "proof.json");
const proof = existsSync(proofPath)
  ? JSON.parse(await readFile(proofPath, "utf8"))
  : {};
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({
  baseURL: base,
  viewport: { width: 1440, height: 980 },
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const request = context.request;
const ownerKey = (
  await readFile(path.join(org, ".state/owner.key"), "utf8")
).trim();
async function call(route, data, method = "POST") {
  const result = await request.fetch(`/api${route}`, {
    method,
    ...(data === undefined ? {} : { data }),
  });
  assert(
    result.ok(),
    `${method} ${route}: ${result.status()} ${await result.text()}`,
  );
  return result.json();
}
const state = () => call("/state", undefined, "GET");
async function until(fn, timeout = 300000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Timed out waiting for real application state");
}
async function finished(messageId) {
  return until(async () => {
    const r = (await state()).runs.find((r) => r.message_id === messageId);
    return r && !["queued", "starting", "running", "waiting"].includes(r.status)
      ? r
      : false;
  });
}
try {
  assert.equal((await request.get("/api/state")).status(), 401);
  assert.equal(
    (
      await request.get("/api/health", {
        headers: { Origin: "https://example.com" },
      })
    ).status(),
    403,
  );
  await call("/login", { token: ownerKey });
  const firstAgent = (await state()).agents[0];
  const appRoutes = ["/", "/organization", "/groups/general/chat"];
  if (firstAgent) appRoutes.push(`/organization/agents/${firstAgent.id}/profile`);
  for (const route of appRoutes) {
    const response = await request.get(route);
    assert.equal(response.status(), 200, `SPA document ${route}`);
    assert.match(response.headers()["content-type"], /text\/html/);
  }
  assert.equal((await request.get("/api/unknown-route")).status(), 404);
  proof.routes = { documents: appRoutes, status: 200, missingApiStatus: 404 };
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "General", exact: true }),
  ).toBeVisible();
  const phase = process.argv[2] || "basic";
  if (phase === "workspace-navigation") {
    const { verifyWorkspaceNavigation } = await import("./workspace-navigation.mjs");
    proof.workspaceNavigation = await verifyWorkspaceNavigation({ page, request, call, state, until, finished, org, directory, base });
    console.log("PASS persisted sections, sort menu, archived restore, hidden deleted groups, mobile navigation, recorded model badges and real run activity");
  } else if (phase === "message-files") {
    const { verifyMessageFiles } = await import("./message-files.mjs");
    proof.messageFiles = await verifyMessageFiles({ page, request, call, state, until, finished, org, directory, base });
    console.log("PASS real agent Markdown file links, image decoding/opening, reports, saved workdir, authentication and containment");
  } else if (phase === "chat-composer") {
    const { verifyChatComposer } = await import("./chat-composer.mjs");
    proof.chatComposer = await verifyChatComposer({ page, call, state, until, org, directory });
    console.log("PASS compact expanding composer, shared side composer, multi-agent mentions, scoped participant dialog and narrow layout");
  } else if (phase === "group-sessions") {
    const { verifyGroupSessions } = await import("./group-sessions.mjs");
    proof.groupSessions = await verifyGroupSessions({ page, request, call, state, until, finished, org, directory });
    console.log("PASS lazy group sessions, parallel independent side sessions and queues, inherited context, delegation, scoped reset and process exit");
  } else if (phase === "agent-permissions") {
    const { verifyAgentPermissions } = await import("./agent-permissions.mjs");
    proof.agentPermissions = await verifyAgentPermissions({ page, request, call, state, until, finished, org, directory });
    console.log("PASS three access choices, native YOLO resume/delegation, API validation, revision history and persisted restart");
  } else if (phase === "workdir-env") {
    const { verifyWorkdirEnv } = await import("./workdir-env.mjs");
    proof.workdirEnv = await verifyWorkdirEnv({ page, request, call, state, until, finished, org, directory });
    console.log("PASS workdir dotenv, real Codex resume, terminal isolation, redaction, removed UI/API and invalid-file failures");
  } else if (phase === "group-scope") {
    const { verifyGroupScope } = await import("./group-scope.mjs");
    proof.groupScope = await verifyGroupScope({ page, request, call, state, until, finished, org, base, directory });
    console.log("PASS level-scoped creation/editing, Position badges, private delegation, direct/mention guards, scheduled routing and restart");
  } else if (phase === "private-network") {
    const { verifyPrivateNetwork } = await import("./private-network.mjs");
    proof.privateNetwork = await verifyPrivateNetwork({ page, request, call, state, until, org, base, directory });
    console.log("PASS private-interface login, host/origin guards, HTTP chat/terminal, launcher validation and persisted restart");
  } else if (phase === "organization-reporting") {
    const { verifyOrganizationReporting } = await import("./organization-reporting.mjs");
    proof.organizationReporting = await verifyOrganizationReporting({ page, call, state, base, directory });
    console.log("PASS live owner/manager connectors, reparenting, deletion/restore, drag/resize and saved organization knowledge");
  } else if (phase === "group-lifecycle") {
    const { verifyGroupLifecycle } = await import("./group-lifecycle.mjs");
    proof.groupLifecycle = await verifyGroupLifecycle({ page, request, call, state, until, finished, org, base, directory });
    console.log("PASS archive, recoverable deletion, restoration, read-only history, schedule isolation and restart");
  } else if (phase === "org-context") {
    const { verifyOrganizationContext } = await import("./org-context.mjs");
    proof.organizationContext = await verifyOrganizationContext({ page, request, call, state, until, finished, org, base, directory });
    console.log("PASS Position editing, full org relationships, real delegation and refreshed organization knowledge in resumed Codex sessions");
  } else if (phase === "agent-tools") {
    const { verifyAgentTools } = await import("./agent-tools.mjs");
    proof.agentTools = await verifyAgentTools({
      page,
      request,
      call,
      state,
      until,
      org,
      base,
      directory,
    });
    console.log(
      "PASS native terminal execution, streaming, failure, stop, restart, environment isolation and installed workdir skills",
    );
  } else if (phase === "chat-commands") {
    const { verifyChatCommands } = await import("./chat-commands.mjs");
    proof.chatCommands = await verifyChatCommands({
      page,
      request,
      call,
      state,
      until,
      finished,
      org,
      base,
      directory,
    });
    console.log(
      "PASS slash picker, live Codex usage, complete group session reset, fresh native context, restart and authorization",
    );
  } else if (phase === "groups-schedules") {
    const { verifyGroupsSchedules } = await import("./groups-schedules.mjs");
    proof.groupsSchedules = await verifyGroupsSchedules({
      page,
      request,
      call,
      state,
      until,
      finished,
      org,
      base,
      directory,
    });
    console.log(
      "PASS group sorting, pinning, pointer/keyboard reorder, scheduled custom messages through real Codex, pause/edit/delete, restart and authorization",
    );
  } else if (phase === "navigation") {
    page.setDefaultTimeout(15000);
    assert(
      process.env.AE_TEST_ORG &&
        process.env.AE_TEST_URL &&
        base !== "http://127.0.0.1:8765",
      "Use a separate native organization for navigation verification",
    );
    const project = path.join(org, "Browse proof", "codebase with spaces");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "sentinel.txt"), "BROWSED_WORKDIR_OK\n");
    const initial = await state();
    const profile = initial.agents.find((a) => a.id === "ceo");
    await call(
      "/agents/ceo",
      {
        ...profile,
        reasoning: "low",
        instructions: "For every answer, include PRIMARY_RULE_OK.",
        agents_md: "For every answer, also include LEGACY_RULE_OK.",
        workdir: null,
      },
      "PUT",
    );
    await call("/preferences/panels", { sidebar: 258, inspector: 370 }, "PUT");
    await page.reload();
    await expect(page).toHaveURL(`${base}/groups/general/chat`);
    await page.getByRole("button", { name: "Add group or section", exact: true }).click();
  await page.getByRole("menuitem", { name: "Create group", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByLabel("Name", { exact: true })
      .fill("Product planning");
    await page.getByRole("button", { name: "Save group", exact: true }).click();
    await expect(page).toHaveURL(
      /\/groups\/product-planning--[a-f0-9-]+\/chat$/,
    );
    const group = (await state()).groups.findLast(
      (g) => g.name === "Product planning",
    );
    const duplicate = await call("/groups", {
      id: "",
      name: "Product planning",
      description: "Duplicate-name routing check",
    });
    assert.notEqual(group.id, duplicate.id);
    await page.getByRole("button", { name: "Knowledge", exact: true }).click();
    const bookmark = page.url();
    await page.getByRole("button", { name: "Runs", exact: true }).click();
    await page.goBack();
    await expect(page).toHaveURL(bookmark);
    await expect(
      page.getByRole("button", { name: "Knowledge", exact: true }),
    ).toHaveClass(/active/);
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${group.id}/chat$`));
    await page.goForward();
    await expect(page).toHaveURL(bookmark);
    const fresh = await context.newPage();
    await fresh.goto(bookmark);
    await expect(
      fresh.getByRole("heading", { name: "Product planning", exact: true }),
    ).toBeVisible();
    await expect(
      fresh.getByRole("button", { name: "Knowledge", exact: true }),
    ).toHaveClass(/active/);
    await fresh.close();
    await page
      .getByRole("button", { name: "Manage group", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByLabel("Name", { exact: true })
      .fill("Product roadmap");
    await page.getByRole("button", { name: "Save group", exact: true }).click();
    await page.goto(bookmark);
    await expect(
      page.getByRole("heading", { name: "Product roadmap", exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(
      new RegExp(`/groups/product-roadmap--${group.id}/knowledge$`),
    );
    await page
      .getByRole("button", { name: "Organization", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Configure CEO", exact: true })
      .click();
    await expect(page).toHaveURL(`${base}/organization/agents/ceo/profile`);
    await expect(
      page.getByRole("button", { name: "AGENTS.md", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Instructions", exact: true })
      .click();
    await expect(page.getByLabel("Role and task instructions")).toHaveValue(
      /PRIMARY_RULE_OK[\s\S]*LEGACY_RULE_OK/,
    );
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await until(
      async () => !(await state()).agents.find((a) => a.id === "ceo").agents_md,
    );
    assert.match(
      (await state()).agents.find((a) => a.id === "ceo").instructions,
      /LEGACY_RULE_OK/,
    );
    await expect(page).toHaveURL(
      `${base}/organization/agents/ceo/instructions`,
    );
    await page.getByRole("button", { name: "Workdir", exact: true }).click();
    async function browseProject() {
      await page
        .getByRole("button", { name: "Browse folders", exact: true })
        .click();
      const picker = page.getByRole("dialog");
      await picker
        .getByRole("button", { name: path.basename(org), exact: true })
        .click();
      await picker
        .getByRole("button", { name: "Browse proof", exact: true })
        .click();
      await picker.getByLabel("Filter folders").fill("codebase");
      await picker
        .getByRole("button", { name: "codebase with spaces", exact: true })
        .click();
      await expect(picker.locator(".folder-toolbar")).toContainText(project);
      return picker;
    }
    await browseProject();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByLabel("Absolute directory path")).toHaveValue("");
    assert.equal(
      (await state()).agents.find((a) => a.id === "ceo").workdir,
      null,
    );
    const picker = await browseProject();
    await picker
      .getByRole("button", { name: "Parent folder", exact: true })
      .click();
    await page.screenshot({
      path: path.join(directory, "workdir-folder-picker.png"),
      fullPage: true,
    });
    await picker
      .getByRole("button", { name: "codebase with spaces", exact: true })
      .click();
    await picker
      .getByRole("button", { name: "Select folder", exact: true })
      .click();
    await expect(page.getByLabel("Absolute directory path")).toHaveValue(
      project,
    );
    await page
      .getByRole("button", { name: "Attach workdir", exact: true })
      .click();
    await until(
      async () =>
        (await state()).agents.find((a) => a.id === "ceo").workdir?.path ===
        project,
    );
    for (const invalid of [
      "relative",
      path.join(project, "sentinel.txt"),
      path.join(project, "missing"),
      path.join(org, ".state"),
    ]) {
      const response = await request.get(
        `/api/workspaces/directories?path=${encodeURIComponent(invalid)}`,
      );
      assert.equal(response.status(), 400, invalid);
    }
    const denied = await browser.newContext({ baseURL: base });
    assert.equal(
      (await denied.request.get("/api/workspaces/directories")).status(),
      401,
    );
    await denied.close();
    async function resize(label, dx, selector) {
      const separator = page.getByRole("separator", {
        name: label,
        exact: true,
      });
      const before = await page.locator(selector).boundingBox();
      const handle = await separator.boundingBox();
      await page.mouse.move(
        handle.x + handle.width / 2,
        handle.y + handle.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        handle.x + handle.width / 2 + dx,
        handle.y + handle.height / 2,
        { steps: 10 },
      );
      await page.mouse.up();
      const after = await page.locator(selector).boundingBox();
      assert(after.width > before.width + 40, `${label} failed to resize`);
    }
    await resize("Resize main navigation", 70, ".sidebar");
    await resize("Resize agent configuration", -100, ".inspector");
    const handle = page.getByRole("separator", {
      name: "Resize main navigation",
      exact: true,
    });
    const beforeKey = await page.locator(".sidebar").boundingBox();
    await handle.press("ArrowLeft");
    assert(
      (await page.locator(".sidebar").boundingBox()).width < beforeKey.width,
      "Keyboard resizing must work",
    );
    const widths = {
      sidebar: Math.round((await page.locator(".sidebar").boundingBox()).width),
      inspector: Math.round(
        (await page.locator(".inspector").boundingBox()).width,
      ),
    };
    await until(async () => {
      const sizes = (await state()).panel_sizes;
      return Object.entries(widths).every(
        ([key, value]) => Math.abs(sizes[key] - value) < 2,
      );
    }, 10000);
    const rejected = await request.put("/api/preferences/panels", {
      data: { sidebar: 1, inspector: 500 },
    });
    assert.equal(rejected.status(), 400);
    assert.deepEqual(
      (await state()).panel_sizes,
      widths,
      "Invalid layout must not overwrite saved widths",
    );
    await page.reload();
    await expect(page.getByLabel("Absolute directory path")).toHaveValue(
      project,
    );
    for (const [key, width] of Object.entries(widths))
      assert(
        Math.abs((await page.locator(`.${key}`).boundingBox()).width - width) <
          2,
        `${key} width changed after reload`,
      );
    await page.screenshot({
      path: path.join(directory, "resizable-navigation.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 775, height: 980 });
    await expect(
      page.getByRole("button", { name: "Browse folders", exact: true }),
    ).toBeVisible();
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "Narrow page overflows",
    );
    await page.setViewportSize({ width: 1440, height: 980 });
    await page.goto(`${base}/groups/unknown-group/chat`);
    await expect(
      page.getByRole("heading", { name: "Page not found", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Open General", exact: true })
      .click();
    await expect(page).toHaveURL(`${base}/groups/general/chat`);
    await page
      .getByRole("navigation", { name: "Groups" })
      .getByRole("button", { name: "Product roadmap", exact: true })
      .last()
      .click();
    const body =
      "Read sentinel.txt in your attached codebase and report its content. Follow your configured instruction acknowledgments. Do not modify files.";
    await page.getByLabel("Message", { exact: true }).fill(body);
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    const message = await until(async () =>
      (await call(`/groups/${group.id}/messages`, undefined, "GET")).find(
        (m) => m.body === body,
      ),
    );
    const run = await finished(message.id);
    assert.equal(run.status, "succeeded", run.error);
    for (const marker of [
      "BROWSED_WORKDIR_OK",
      "PRIMARY_RULE_OK",
      "LEGACY_RULE_OK",
    ])
      assert(run.output.includes(marker), `Missing ${marker}: ${run.output}`);
    assert.equal(run.cwd, project);
    assert.equal(
      await readFile(path.join(project, "sentinel.txt"), "utf8"),
      "BROWSED_WORKDIR_OK\n",
    );
    await expect(
      page.locator(".message-content .markdown").last(),
    ).toContainText("LEGACY_RULE_OK");
    proof.navigation = {
      group: group.id,
      workdir: project,
      run: run.id,
      folderSelectionWithoutTyping: true,
      cancelPreservesPath: true,
      unifiedInstructions: true,
      backForward: true,
      directLinks: true,
      renameStable: true,
      duplicateNames: true,
      widths,
      keyboardResize: true,
      widthsPersisted: true,
      invalidPathsRejected: true,
      unauthorizedBrowseRejected: true,
      notFound: true,
      browserErrors: errors.length,
    };
    console.log(
      `PASS navigation: popup folder attachment, consolidated instructions executed in ${run.id}, slug links, Back/Forward, renamed and duplicate names, persisted drag/keyboard resizing, errors/auth and 775px viewport`,
    );
  } else if (phase === "coordination") {
    assert(
      process.env.AE_TEST_ORG &&
        process.env.AE_TEST_URL &&
        base !== "http://127.0.0.1:8765",
      "Use a separate native organization for coordination verification",
    );
    const initial = await state();
    const leadHome = await mkdtemp(path.join(tmpdir(), "Agentic lead "));
    const workHome = await mkdtemp(path.join(tmpdir(), "Agentic project "));
    await writeFile(
      path.join(leadHome, "README.md"),
      "# Coordinator workspace\n",
    );
    await writeFile(path.join(workHome, "status.txt"), "OLD\n");
    await writeFile(path.join(workHome, "sentinel.txt"), "PRESERVE\n");
    const leadWorkspace = (await call("/workspaces/probe", { path: leadHome }))
      .workspace;
    const workerWorkspace = (
      await call("/workspaces/probe", { path: workHome })
    ).workspace;
    const lead = await call(
      "/agents/ceo",
      {
        ...initial.agents.find((a) => a.id === "ceo"),
        workdir: leadWorkspace,
        permission: "read-only",
        reasoning: "low",
      },
      "PUT",
    );
    const worker = await call("/agents", {
      ...lead,
      id: "",
      name: "Project Engineer",
      role: "Owns project file changes and project-specific environment variables. Implements requested changes in the attached project.",
      reports_to: lead.id,
      workdir: workerWorkspace,
      permission: "workspace-write",
      instructions:
        "Perform the delegated project task using your own configured environment. Preserve unrelated files. Report the real result.",
      revision: 1,
    });
    await writeFile(path.join(workerWorkspace.path, ".env"), "AE_PROJECT_STATUS=READY\n");
    const child = await call("/agents", {
      ...lead,
      id: "",
      name: "Project Assistant",
      role: "Project support",
      reports_to: worker.id,
      workdir: null,
      enabled: false,
      revision: 1,
    });
    await page
      .getByRole("button", { name: "Organization", exact: true })
      .click();
    await page.getByLabel("Chat lead", { exact: true }).selectOption(lead.id);
    assert.equal((await state()).chat_lead_id, lead.id);
    const invalidLead = await request.put("/api/organization/chat-lead", {
      data: { agent_id: worker.id },
    });
    assert.equal(
      invalidLead.status(),
      400,
      "A subordinate cannot become the owner's direct report implicitly",
    );
    await expect(page.locator(".org-resize-handle").first()).toHaveCSS(
      "opacity",
      "0",
    );
    await page
      .getByRole("navigation", { name: "Groups" })
      .getByRole("button", { name: "General", exact: true })
      .click();
    await expect(page.locator(".chat-lead-hint")).toContainText(
      "CEO will handle your message",
    );
    const directBody = {
      id: crypto.randomUUID(),
      group_id: "general",
      body: "Reply exactly DIRECT_LEAD_OK. Do not use tools.",
      recipients: [],
      reply_to: null,
      artifacts: [],
    };
    const direct = await call("/messages", directBody);
    const cannotDelete = await request.delete("/api/agents/ceo");
    assert.equal(cannotDelete.status(), 400);
    assert.match(await cannotDelete.text(), /active work/);
    assert.equal(
      (await call("/messages", directBody)).id,
      direct.id,
      "Auto-routing retry must be idempotent",
    );
    const directRun = await finished(direct.id);
    assert.equal(directRun.status, "succeeded", directRun.error);
    assert.equal(directRun.output, "DIRECT_LEAD_OK");
    assert.equal(directRun.kind, "coordinator");
    assert.equal(
      (await state()).runs.filter((r) => r.message_id === direct.id).length,
      1,
    );
    await page
      .getByLabel("Message", { exact: true })
      .fill(
        "Set status.txt in our project to the value of the project's AE_PROJECT_STATUS environment variable. Report what changed and preserve every other file.",
      );
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    const message = await until(async () =>
      (await call("/groups/general/messages", undefined, "GET")).find(
        (m) => m.sender === "owner" && m.body.startsWith("Set status.txt"),
      ),
    );
    assert(message.auto_routed);
    assert.deepEqual(message.recipients, [lead.id]);
    const completed = await until(async () => {
      const runs = (await state()).runs.filter(
        (r) => r.message_id === message.id,
      );
      const summary = runs.find((r) => r.kind === "summary");
      const root = runs.find((r) => r.kind === "coordinator");
      if (root?.status === "failed") throw new Error(root.error);
      if (summary?.status === "failed") throw new Error(summary.error);
      return summary?.status === "succeeded" ? runs : false;
    });
    const root = completed.find((r) => r.kind === "coordinator");
    const delegated = completed.find((r) => r.kind === "delegate");
    const summary = completed.find((r) => r.kind === "summary");
    assert.equal(delegated.agent_id, worker.id);
    assert.equal(delegated.status, "succeeded", delegated.error);
    assert.equal(delegated.profile.permission, "workspace-write");
    assert.equal(root.profile.permission, "read-only");
    assert.equal(
      root.native_session_id,
      directRun.native_session_id,
      "Lead must resume its group conversation",
    );
    assert.equal(
      summary.native_session_id,
      root.native_session_id,
      "Summary must resume the lead's conversation",
    );
    assert.equal(summary.parent_run_id, root.id);
    assert.equal(
      (await readFile(path.join(workHome, "status.txt"), "utf8")).trim(),
      "READY",
    );
    assert.equal(
      await readFile(path.join(workHome, "sentinel.txt"), "utf8"),
      "PRESERVE\n",
    );
    assert.match(summary.output, /status\.txt/);
    await expect(
      page.locator(".delivery").filter({ hasText: "CEO · summary: succeeded" }),
    ).toBeVisible();
    await expect(
      page
        .locator(".message")
        .filter({
          has: page.locator(".message-heading strong", { hasText: /^CEO$/ }),
        })
        .last()
        .locator(".markdown"),
    ).toContainText("status.txt");
    await page.screenshot({
      path: path.join(directory, "seamless-chat.png"),
      fullPage: true,
    });
    const historyBefore = (
      await call("/groups/general/messages", undefined, "GET")
    ).length;
    await page
      .getByRole("button", { name: "Organization", exact: true })
      .click();
    await page
      .getByRole("button", { name: `Configure ${worker.name}`, exact: true })
      .click();
    await page
      .getByRole("button", { name: "Delete agent", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: `Delete ${worker.name}`, exact: true })
      .click();
    await expect(
      page.locator(`.org-card[data-agent-id="${worker.id}"]`),
    ).toHaveCount(0);
    let after = await state();
    assert(after.deleted_agents.some((a) => a.id === worker.id));
    assert.equal(
      after.agents.find((a) => a.id === child.id).reports_to,
      lead.id,
    );
    assert.equal(
      (await call("/groups/general/messages", undefined, "GET")).length,
      historyBefore,
    );
    const deletedSend = await request.post("/api/messages", {
      data: { ...directBody, id: crypto.randomUUID(), recipients: [worker.id] },
    });
    assert.equal(deletedSend.status(), 400);
    assert.match(await deletedSend.text(), /deleted/);
    await page
      .getByRole("button", { name: "Deleted agents", exact: true })
      .click();
    await page.screenshot({
      path: path.join(directory, "deleted-agents.png"),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: `Restore ${worker.name}`, exact: true })
      .click();
    await until(async () =>
      (await state()).agents.some((a) => a.id === worker.id),
    );
    after = await state();
    assert.equal(after.agents.find((a) => a.id === worker.id).enabled, false);
    const pausedSend = await request.post("/api/messages", {
      data: { ...directBody, id: crypto.randomUUID(), recipients: [worker.id] },
    });
    assert.equal(pausedSend.status(), 400);
    assert.match(await pausedSend.text(), /disabled/);
    assert(
      (await call(`/agents/${worker.id}/organization-context`, undefined, "GET")).members.find((m) => m.id === worker.id).environment_keys.includes(
        "AE_PROJECT_STATUS",
      ),
    );
    proof.coordination = {
      directRun: directRun.id,
      coordinator: root.id,
      worker: delegated.id,
      summary: summary.id,
      untaggedRouting: true,
      scopeBasedDelegation: true,
      scopedEnvironment: true,
      resumedSession: root.native_session_id,
      idempotency: true,
      deleteActiveRejected: true,
      deleteRestore: true,
      historyPreserved: true,
      childrenReparented: true,
      hiddenResizeMarkers: true,
      browserErrors: errors.length,
    };
    console.log(
      `PASS seamless chat: direct ${directRun.id}; coordinator ${root.id}; worker ${delegated.id}; summary ${summary.id}; real project edit READY, scoped environment, resume, idempotency, deletion/restoration/history and invisible resize handles`,
    );
  } else if (phase === "groups") {
    assert(
      process.env.AE_TEST_ORG &&
        process.env.AE_TEST_URL &&
        base !== "http://127.0.0.1:8765",
      "Run groups against a separate disposable native organization",
    );
    const initial = await state();
    assert.equal(initial.groups.length, 1, "Use a fresh organization");
    assert.equal(initial.agents.length, 1, "Use a fresh organization");
    await page.getByRole("button", { name: "Add group or section", exact: true }).click();
  await page.getByRole("menuitem", { name: "Create group", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("checkbox")).toHaveCount(0);
    await expect(
      dialog.getByText(
        "Choose who participates in this conversation. Lower levels can still receive delegated work.",
      ),
    ).toBeVisible();
    await dialog
      .getByLabel("Name", { exact: true })
      .fill("Organization access");
    await dialog
      .getByLabel("Description")
      .fill("All organization agents are available here.");
    await dialog.getByRole("button", { name: "Save group" }).click();
    await expect(
      page.getByRole("heading", { name: "Organization access", exact: true }),
    ).toBeVisible();
    const group = (await state()).groups.find(
      (g) => g.name === "Organization access",
    );
    assert(!("members" in group));
    // Existing clients and stored JSON can still include the obsolete field.
    const legacy = await call("/groups", {
      id: "legacy",
      name: "Legacy group",
      description: "",
      members: ["removed-agent"],
    });
    assert(!("members" in legacy));
    const invalidGroup = await request.post("/api/groups", {
      data: { id: "", name: " ", description: "" },
    });
    assert.equal(invalidGroup.status(), 400);
    const observer = await context.newPage();
    await observer.goto("/");
    await expect(
      observer.getByRole("heading", { name: "General", exact: true }),
    ).toBeVisible();
    await observer.getByRole("button", { name: "View group agents" }).click();
    await page
      .getByRole("button", { name: "Organization", exact: true })
      .click();
    await page.getByRole("button", { name: "Add agent", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("OrgProbe");
    await page
      .getByLabel("Role", { exact: true })
      .fill("Verify organization-wide chat access.");
    await page
      .getByRole("button", { name: "Create agent", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "OrgProbe", exact: true }),
    ).toBeVisible();
    await expect(
      observer
        .getByRole("list", { name: "Group agents" })
        .getByText("OrgProbe", { exact: true }),
    ).toBeVisible();
    await observer.close();
    const added = (await state()).agents.find((a) => a.name === "OrgProbe");
    const requestBody = (recipient) => ({
      id: crypto.randomUUID(),
      group_id: group.id,
      body: "Validation probe",
      recipients: [recipient],
      reply_to: null,
      artifacts: [],
    });
    const unknown = await request.post("/api/messages", {
      data: requestBody("missing-agent"),
    });
    assert(!unknown.ok());
    const unattached = await request.post("/api/messages", {
      data: requestBody(added.id),
    });
    assert.equal(unattached.status(), 400);
    assert.match(await unattached.text(), /Attach a workdir/);
    const workspace = await mkdtemp(
      path.join(tmpdir(), "Organization chat verification "),
    );
    await writeFile(
      path.join(workspace, "README.md"),
      "# Organization chat verification\n",
    );
    execFileSync("git", ["init", workspace], { stdio: "ignore" });
    await page.getByRole("button", { name: "Workdir", exact: true }).click();
    await page.getByLabel("Absolute directory path").fill(workspace);
    await page.getByLabel("Access mode").selectOption("read-only");
    await page
      .getByRole("button", { name: "Attach workdir", exact: true })
      .click();
    const configured = await until(async () =>
      (await state()).agents.find((a) => a.id === added.id && a.workdir),
    );
    const disabled = await call(
      `/agents/${added.id}`,
      { ...configured, enabled: false },
      "PUT",
    );
    const rejected = await request.post("/api/messages", {
      data: requestBody(added.id),
    });
    assert.equal(rejected.status(), 400);
    assert.match(await rejected.text(), /Agent is disabled/);
    await call(`/agents/${added.id}`, { ...disabled, enabled: true }, "PUT");
    assert.equal(
      (await call(`/groups/${group.id}/messages`, undefined, "GET")).length,
      0,
      "Failed requests must not persist messages",
    );
    await page.getByRole("button", { name: "Close agent settings" }).click();
    for (const saved of (await state()).groups) {
      await page
        .getByRole("navigation", { name: "Groups" })
        .getByRole("button", { name: saved.name, exact: true })
        .click();
      await page.getByRole("button", { name: "View group agents" }).click();
      await expect(
        page
          .getByRole("list", { name: "Group agents" })
          .getByText("CEO", { exact: true }),
      ).toBeVisible();
      await expect(
        page
          .getByRole("list", { name: "Group agents" })
          .getByText("OrgProbe", { exact: true }),
      ).toBeVisible();
      await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
    }
    await page
      .getByRole("navigation", { name: "Groups" })
      .getByRole("button", { name: group.name, exact: true })
      .click();
    await page
      .getByRole("button", { name: "Manage group", exact: true })
      .click();
    await expect(dialog.getByRole("checkbox")).toHaveCount(0);
    await expect(dialog.getByLabel("Description")).toHaveValue(
      group.description,
    );
    await page.screenshot({
      path: path.join(directory, "group-dialog.png"),
      fullPage: true,
    });
    await dialog.getByRole("button", { name: "Save group" }).click();
    await page
      .getByLabel("Message", { exact: true })
      .fill(
        "@OrgProbe Reply exactly ORG_WIDE_OK. Do not use tools or change files.",
      );
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    const sent = await until(async () =>
      (await call(`/groups/${group.id}/messages`, undefined, "GET")).find(
        (m) => m.sender === "owner",
      ),
    );
    assert.deepEqual(sent.recipients, [added.id]);
    const run = await finished(sent.id);
    assert.equal(run.status, "succeeded", run.error);
    await expect(page.getByText("ORG_WIDE_OK", { exact: true })).toBeVisible();
    await page.reload();
    await page
      .getByRole("navigation", { name: "Groups" })
      .getByRole("button", { name: group.name, exact: true })
      .click();
    await expect(page.getByText("ORG_WIDE_OK", { exact: true })).toBeVisible();
    assert.equal(
      (await call(`/groups/general/messages`, undefined, "GET")).length,
      0,
    );
    assert.equal(
      (await call(`/groups/${legacy.id}/messages`, undefined, "GET")).length,
      0,
    );
    assert.equal(
      await readFile(path.join(workspace, "README.md"), "utf8"),
      "# Organization chat verification\n",
    );
    proof.groups = {
      groups: 3,
      agents: 2,
      noMembershipChecklist: true,
      futureAgentAvailableLive: true,
      legacyFieldIgnored: true,
      validationPreserved: true,
      separateHistory: true,
      run: run.id,
      nativeSession: run.native_session_id,
      browserErrors: errors.length,
    };
    console.log(
      `PASS groups: all 3 groups see both agents, including one added later; no checklist; validation and separate history preserved; real Codex run ${run.id} returned ORG_WIDE_OK`,
    );
  } else if (phase === "basic") {
    proof.workspace = await mkdtemp(
      path.join(tmpdir(), "Agentic Enterprise codebase "),
    );
    execFileSync("git", ["init", proof.workspace], { stdio: "ignore" });
    await writeFile(
      path.join(proof.workspace, "README.md"),
      "# Harness verification\nAn existing codebase for a real edit.\n",
    );
    await writeFile(
      path.join(proof.workspace, "AGENTS.md"),
      "Only change requested files. Preserve sentinel.txt.\n",
    );
    await writeFile(
      path.join(proof.workspace, "sentinel.txt"),
      "Existing dirty user content. Preserve exactly.\n",
    );
    await page.getByRole("button", { name: "Add group or section", exact: true }).click();
  await page.getByRole("menuitem", { name: "Create group", exact: true }).click();
    await page
      .getByLabel("Name", { exact: true })
      .fill("Platform verification");
    await page.getByRole("button", { name: "Save group", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Platform verification", exact: true }),
    ).toBeVisible();
    proof.group = (await state()).groups.findLast(
      (g) => g.name === "Platform verification",
    ).id;
    await page
      .getByRole("button", { name: "Organization", exact: true })
      .click();
    await page.getByRole("button", { name: "Add agent", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("Engineer");
    await page
      .getByLabel("Role", { exact: true })
      .fill("Validate the native agent workspace with real execution.");
    await page
      .getByRole("button", { name: "Create agent", exact: true })
      .last()
      .click();
    await expect(
      page.getByRole("heading", { name: "Engineer", exact: true }),
    ).toBeVisible();
    proof.agent = (await state()).agents.findLast(
      (a) => a.name === "Engineer",
    ).id;
    await page.getByRole("button", { name: "Workdir", exact: true }).click();
    await page.getByLabel("Absolute directory path").fill(proof.workspace);
    await page.getByLabel("Access mode").selectOption("workspace-write");
    await page
      .getByRole("button", { name: "Attach workdir", exact: true })
      .click();
    await until(
      async () =>
        (await state()).agents.find((a) => a.id === proof.agent)?.workdir,
    );
    await page
      .getByRole("button", { name: "Instructions", exact: true })
      .click();
    await page
      .getByLabel("Role and task instructions")
      .fill(
        "Follow requests directly. Work only in the attached repository. Preserve existing files unless a change is requested. Keep responses concise.",
      );
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await until(
      async () =>
        (await state()).agents.find((a) => a.id === proof.agent)?.revision >= 3,
    );
    await page.getByRole("button", { name: "Close agent settings" }).click();
    await page
      .getByRole("navigation", { name: "Groups" })
      .getByRole("button", { name: "Platform verification" })
      .last()
      .click();
    await expect(
      page.getByRole("button", { name: "Work", exact: true }),
    ).toHaveCount(0);
    const message = {
      id: crypto.randomUUID(),
      group_id: proof.group,
      body: "Native API and browser wiring verified.",
      recipients: [],
      reply_to: null,
      artifacts: [],
    };
    await call("/messages", message);
    await call("/messages", message);
    const messages = await call(
      `/groups/${proof.group}/messages`,
      undefined,
      "GET",
    );
    assert.equal(messages.filter((m) => m.id === message.id).length, 1);
    const values = { AE_PROBE_VALUE: 'literal-$HOME-"quoted"-sample' };
    await writeFile(path.join(proof.workspace, ".env"), `AE_PROBE_VALUE='${values.AE_PROBE_VALUE}'\n`);
    proof.envProbeValue = values.AE_PROBE_VALUE;
    assert.equal((await request.get(`/api/agents/${proof.agent}/env?reveal=true`)).status(), 404);
    assert.equal(
      (
        await request.post("/api/workspaces/probe", {
          data: { path: "relative/path" },
        })
      ).status(),
      400,
    );
    assert.equal(
      (await request.get(`/api/agents/${proof.agent}/files?path=..`)).status(),
      400,
    );
    assert.equal(
      (
        await request.get(`/api/agents/${proof.agent}/files?path=.env`)
      ).status(),
      400,
    );
    await page.screenshot({
      path: path.join(directory, "workspace.png"),
      fullPage: true,
    });
    proof.basic = {
      passed: true,
      at: new Date().toISOString(),
      duplicateCount: 1,
    };
    console.log(
      "PASS browser: create group/agent, attach existing workdir, save instructions; API: auth/origin, idempotency, env round trip, traversal",
    );
  } else if (phase === "codex") {
    const agent = (await state()).agents.find((a) => a.id === proof.agent);
    await call(
      `/agents/${proof.agent}`,
      { ...agent, reasoning: "low", timeout_seconds: 300 },
      "PUT",
    );
    await page
      .getByRole("navigation", { name: "Groups" })
      .getByRole("button", { name: "Platform verification" })
      .last()
      .click();
    const body =
      `@${agent.id} Create verified.txt containing exactly NATIVE_CODEX_OK followed by a newline. Do not change any other files. Read sentinel.txt to verify it remains unchanged. Reply with the file path and what you verified.`;
    await page.getByLabel("Message", { exact: true }).fill(body);
    await page.getByRole("button", { name: "Send message" }).click();
    const message = await until(async () =>
      (
        await call(`/groups/${proof.group}/messages`, undefined, "GET")
      ).findLast((m) => m.body === body),
    );
    const run = await finished(message.id);
    console.log(
      JSON.stringify({
        status: run.status,
        error: run.error,
        pid: run.pid,
        cwd: run.cwd,
        native_session: run.native_session_id,
        output: run.output,
      }),
    );
    assert.equal(
      run.status,
      "succeeded",
      run.error || "Codex did not complete",
    );
    assert.equal(
      (
        await readFile(path.join(proof.workspace, "verified.txt"), "utf8")
      ).trim(),
      "NATIVE_CODEX_OK",
    );
    assert.equal(
      await readFile(path.join(proof.workspace, "sentinel.txt"), "utf8"),
      "Existing dirty user content. Preserve exactly.\n",
    );
    assert.equal(
      await readFile(path.join(proof.workspace, "AGENTS.md"), "utf8"),
      "Only change requested files. Preserve sentinel.txt.\n",
    );
    const next = await call("/messages", {
      id: crypto.randomUUID(),
      group_id: proof.group,
      body: "Without editing files, tell me the exact contents of the file you just created.",
      recipients: [proof.agent],
      reply_to: message.id,
      artifacts: [],
    });
    const resumed = await finished(next.id);
    assert.equal(resumed.status, "succeeded", resumed.error);
    assert.equal(resumed.native_session_id, run.native_session_id);
    assert.match(resumed.output, /NATIVE_CODEX_OK/);
    const cancelMessage = await call("/messages", {
      id: crypto.randomUUID(),
      group_id: proof.group,
      body: "Use a shell command to sleep for 120 seconds, then report done.",
      recipients: [proof.agent],
      reply_to: null,
      artifacts: [],
    });
    const cancelling = await until(async () =>
      (await state()).runs.find(
        (r) => r.message_id === cancelMessage.id && r.status === "running",
      ),
    );
    await call(`/runs/${cancelling.id}/cancel`);
    assert.equal((await finished(cancelMessage.id)).status, "cancelled");
    await page.screenshot({
      path: path.join(directory, "codex-execution.png"),
      fullPage: true,
    });
    proof.codex = {
      passed: true,
      run: run.id,
      resumed: resumed.id,
      native_session: run.native_session_id,
      cancelled: cancelling.id,
      cwd: run.cwd,
      pid: run.pid,
    };
    console.log(
      "PASS real Codex: browser dispatch, workspace edit, native continuation, cancellation, unchanged sentinel and AGENTS.md",
    );
  } else if (phase === "knowledge") {
    for (const old of (await state()).artifacts.filter(
      (a) =>
        a.group_id === proof.group &&
        ["red-circle.png", "blue-square.png"].includes(a.name),
    ))
      await call(`/artifacts/${old.id}`, undefined, "DELETE");
    const file = await request.post("/api/artifacts", {
      multipart: {
        group_id: proof.group,
        file: {
          name: "native-platform.md",
          mimeType: "text/plain",
          buffer: Buffer.from(
            "Agentic Enterprise runs natively on Windows. Rust provides orchestration. Codex edits attached existing codebases. Local multimodal search uses CLIP and LanceDB.",
          ),
        },
      },
    });
    assert(file.ok());
    const artifact = await file.json();
    await call(`/artifacts/${artifact.id}/index`);
    const indexed = await until(async () => {
      const a = (await state()).artifacts.find((a) => a.id === artifact.id);
      return a.status !== "indexing" ? a : false;
    }, 600000);
    assert.equal(indexed.status, "indexed", indexed.error);
    const found = await call(
      `/search?semantic=true&group_id=${proof.group}&q=Windows%20native%20agent%20codebase`,
      undefined,
      "GET",
    );
    assert(found.artifacts.some((a) => a.id === artifact.id));
    const drawing = await context.newPage();
    await drawing.setViewportSize({ width: 256, height: 256 });
    await drawing.setContent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><rect width="240" height="240" fill="white"/><circle cx="120" cy="120" r="90" fill="red"/></svg>',
    );
    const png = await drawing.screenshot();
    await drawing.close();
    const uploaded = await request.post("/api/artifacts", {
      multipart: {
        group_id: proof.group,
        file: { name: "red-circle.png", mimeType: "image/png", buffer: png },
      },
    });
    assert(uploaded.ok());
    const picture = await uploaded.json();
    await call(`/artifacts/${picture.id}/index`);
    const imageResult = await until(async () => {
      const a = (await state()).artifacts.find((a) => a.id === picture.id);
      return a.status !== "indexing" ? a : false;
    }, 600000);
    assert.equal(imageResult.status, "indexed", imageResult.error);
    const contrastPage = await context.newPage();
    await contrastPage.setViewportSize({ width: 256, height: 256 });
    await contrastPage.setContent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><rect width="240" height="240" fill="white"/><rect x="30" y="30" width="180" height="180" fill="blue"/></svg>',
    );
    const blue = await contrastPage.screenshot();
    await contrastPage.close();
    const contrastUpload = await request.post("/api/artifacts", {
      multipart: {
        group_id: proof.group,
        file: { name: "blue-square.png", mimeType: "image/png", buffer: blue },
      },
    });
    assert(contrastUpload.ok());
    const contrast = await contrastUpload.json();
    await call(`/artifacts/${contrast.id}/index`);
    await until(async () =>
      (await state()).artifacts.find(
        (a) => a.id === contrast.id && a.status === "indexed",
      ),
    );
    const imageHits = await call(
      `/search?semantic=true&media=images&group_id=${proof.group}&q=a%20red%20circle%20on%20a%20white%20background`,
      undefined,
      "GET",
    );
    assert.equal(imageHits.artifacts[0].id, picture.id);
    const scoped = await call(
      "/search?semantic=true&media=images&group_id=general&q=red%20circle",
      undefined,
      "GET",
    );
    assert(!scoped.artifacts.some((a) => a.id === picture.id));
    const bad = await request.post("/api/artifacts", {
      multipart: {
        group_id: proof.group,
        file: {
          name: "invalid.png",
          mimeType: "image/png",
          buffer: Buffer.from("invalid image data"),
        },
      },
    });
    const broken = await bad.json();
    await call(`/artifacts/${broken.id}/index`);
    const failed = await until(async () =>
      (await state()).artifacts.find(
        (a) => a.id === broken.id && a.status === "failed",
      ),
    );
    assert.match(failed.error, /image|format/i);
    await call(`/artifacts/${broken.id}`, undefined, "DELETE");
    await page
      .getByRole("navigation", { name: "Groups" })
      .getByRole("button", { name: "Platform verification" })
      .last()
      .click();
    await page.getByRole("button", { name: "Knowledge", exact: true }).click();
    await expect(
      page.getByText("red-circle.png", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: path.join(directory, "knowledge.png"),
      fullPage: true,
    });
    const visualMessage = await call("/messages", {
      id: crypto.randomUUID(),
      group_id: proof.group,
      body: "Look at the attached image. Name its shape and color. Do not run commands or change files.",
      recipients: [proof.agent],
      reply_to: null,
      artifacts: [picture.id],
    });
    const visualRun = await finished(visualMessage.id);
    assert.equal(visualRun.status, "succeeded", visualRun.error);
    assert.match(visualRun.output, /red/i);
    assert.match(visualRun.output, /circle/i);
    proof.knowledge = {
      text: artifact.id,
      image: picture.id,
      imageRank: 1,
      isolatedGroups: true,
      invalidImageRejected: true,
      visualRun: visualRun.id,
    };
    console.log(
      "PASS real CLIP text/image embeddings and LanceDB retrieval; image ranked first; group isolation, invalid image and deletion verified",
    );
  } else if (phase === "recovery") {
    await rm(path.join(proof.workspace, "sleeping-pid.txt"), { force: true });
    const send = (body) =>
      call("/messages", {
        id: crypto.randomUUID(),
        group_id: proof.group,
        body,
        recipients: [proof.agent],
        reply_to: null,
        artifacts: [],
      });
    const message = await send(
      "Run a PowerShell command that writes its process ID to sleeping-pid.txt in the current directory, then sleeps for 120 seconds. Do not use a background job. This will be cancelled for a process-lifecycle test.",
    );
    const sleeping = await until(async () => {
      const r = (await state()).runs.find((r) => r.message_id === message.id);
      if (!r || !existsSync(path.join(proof.workspace, "sleeping-pid.txt")))
        return false;
      assert.equal(r.status, "running", r.error || r.output);
      return r;
    });
    const shellPid = Number(
      (await readFile(path.join(proof.workspace, "sleeping-pid.txt"), "utf8"))
        .replace(/^\uFEFF/, "")
        .trim(),
    );
    assert(shellPid > 0);
    const queued = await send("Create SHOULD_NOT_RUN.txt and reply done.");
    const waiting = (await state()).runs.find(
      (r) => r.message_id === queued.id,
    );
    assert.equal(waiting.status, "queued");
    await call(`/runs/${waiting.id}/cancel`);
    assert.equal((await finished(queued.id)).status, "cancelled");
    await call(`/runs/${sleeping.id}/cancel`);
    assert.equal((await finished(message.id)).status, "cancelled");
    await until(() => {
      try {
        process.kill(shellPid, 0);
        return false;
      } catch (e) {
        if (e.code === "ESRCH") return true;
        throw e;
      }
    }, 20000);
    assert(!existsSync(path.join(proof.workspace, "SHOULD_NOT_RUN.txt")));
    const agent = (await state()).agents.find((a) => a.id === proof.agent);
    const invalid = await request.put(`/api/agents/${proof.agent}`, {
      data: { ...agent, model: "invalid-verification-model" },
    });
    assert.equal(invalid.status(), 400);
    assert.match(await invalid.text(), /catalog/);
    const before = await state();
    execFileSync(
      "pwsh",
      ["-NoProfile", "-File", "../scripts/Stop.ps1", "-Org", org],
      { stdio: "pipe" },
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
    const after = await state();
    assert.equal(after.runs.length, before.runs.length);
    const resumedMessage = await send(
      "Without changing files, read verified.txt and report its contents.",
    );
    const resumed = await finished(resumedMessage.id);
    assert.equal(resumed.status, "succeeded", resumed.error);
    assert.equal(resumed.native_session_id, proof.codex.native_session);
    assert.match(resumed.output, /NATIVE_CODEX_OK/);
    const backup = await call("/export");
    const archive = path.join(directory, "organization.zip");
    const downloaded = await request.get(backup.url);
    assert(downloaded.ok());
    await writeFile(archive, await downloaded.body());
    const restore = path.join(directory, "restore-" + Date.now());
    execFileSync(
      "pwsh",
      [
        "-NoProfile",
        "-File",
        "../scripts/Restore.ps1",
        "-Archive",
        archive,
        "-Destination",
        restore,
      ],
      { stdio: "pipe" },
    );
    assert(!existsSync(path.join(restore, ".state/owner.key")));
    assert(!existsSync(path.join(restore, proof.agent, ".env")));
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(restore, ".state/app.sqlite3"), {
      readOnly: true,
    });
    const count = db
      .prepare("SELECT COUNT(*) AS count FROM messages")
      .get().count;
    assert(count > 0);
    assert.equal(
      db.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
    db.close();
    execFileSync(
      "pwsh",
      [
        "-NoProfile",
        "-File",
        "../scripts/Start.ps1",
        "-Org",
        restore,
        "-Port",
        "8766",
      ],
      { stdio: "ignore", timeout: 25000 },
    );
    try {
      const token = (
        await readFile(path.join(restore, ".state/owner.key"), "utf8")
      ).trim();
      const restored = await fetch("http://127.0.0.1:8766/api/sessions", {
        headers: { Authorization: `Bearer ${token}` },
      }).then((r) => r.json());
      assert(restored.every((s) => !s.active));
    } finally {
      execFileSync(
        "pwsh",
        ["-NoProfile", "-File", "../scripts/Stop.ps1", "-Org", restore],
        { stdio: "pipe" },
      );
    }
    proof.recovery = {
      cancelledShellPid: shellPid,
      queuedNeverRan: true,
      invalidModel: "rejected before execution",
      resumedAfterRestart: resumed.id,
      backupMessages: count,
      restore,
      integrity: "ok",
    };
    console.log(
      "PASS running shell process terminated, queued run never executed, invalid model rejected, session resumed after service restart, export/restore integrity and credential exclusion",
    );
  } else if (phase === "ui") {
    await page
      .getByRole("navigation", { name: "Groups" })
      .getByRole("button", { name: "Platform verification" })
      .last()
      .click();
    await page.getByRole("button", { name: /Search your workspace/ }).click();
    await page.getByLabel("Semantic document & image search").check();
    await page.getByLabel("Search file type").selectOption("images");
    await page
      .getByLabel("Search query")
      .fill("a red circle on a white background");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.locator(".search-results a").first()).toContainText(
      "red-circle.png",
    );
    await page.screenshot({
      path: path.join(directory, "image-search.png"),
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Knowledge", exact: true }).click();
    await page.screenshot({
      path: path.join(directory, "knowledge.png"),
      fullPage: true,
    });
    const agent = (await state()).agents.find((a) => a.id === proof.agent);
    await page
      .getByRole("button", { name: "Organization", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Configure Engineer", exact: true })
      .last()
      .click();
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await page
      .getByRole("button", { name: "verified.txt", exact: true })
      .click();
    await expect(page.locator(".file-preview")).toContainText(
      "NATIVE_CODEX_OK",
    );
    await page.getByLabel("Agent-owned scripts").check();
    await page.getByLabel("Script filename").fill("verify.ps1");
    await page
      .getByLabel("Script content")
      .fill("Get-Content -LiteralPath verified.txt\n");
    await page
      .getByRole("button", { name: "Save script", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "verify.ps1", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Environment", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Workdir", exact: true }).click();
    await page
      .getByRole("button", { name: "Detach workdir", exact: true })
      .click();
    await until(
      async () =>
        (await state()).agents.find((a) => a.id === proof.agent).workdir ===
        null,
    );
    assert.equal(
      (
        await readFile(path.join(proof.workspace, "verified.txt"), "utf8")
      ).trim(),
      "NATIVE_CODEX_OK",
    );
    const detached = (await state()).agents.find((a) => a.id === proof.agent);
    await call(
      `/agents/${proof.agent}`,
      { ...detached, workdir: agent.workdir },
      "PUT",
    );
    const ceo = (await state()).agents.find((a) => a.id === "ceo");
    const workspace = await call("/workspaces/probe", {
      path: path.resolve(".."),
    });
    await call("/agents/ceo", { ...ceo, workdir: workspace.workspace }, "PUT");
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "General", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Organization", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Configure CEO", exact: true })
      .click();
    await page.getByRole("button", { name: "Workdir", exact: true }).click();
    await expect(page.getByLabel("Absolute directory path")).toHaveValue(
      path.resolve(".."),
    );
    await page.screenshot({
      path: path.join(directory, "final-workspace.png"),
      fullPage: true,
    });
    proof.ui = {
      imageSearch: true,
      scriptsSaved: true,
      workdirDetachedWithoutDeleting: true,
      ceoWorkdir: path.resolve(".."),
      browserErrors: errors.length,
    };
    console.log(
      "PASS final UI: code preview, script save, masked environment, detach/reattach without deleting files, CEO attached to platform source",
    );
  } else if (phase === "organization-editing") {
    assert(
      process.env.AE_TEST_ORG &&
        process.env.AE_TEST_URL &&
        base !== "http://127.0.0.1:8765",
      "Use a separate native test organization for chart editing",
    );
    const before = await state();
    const original = before.agents.at(-1);
    const geometry = (id) =>
      page.locator(`.react-flow__node[data-id="${id}"]`).evaluate((node) => {
        const position = new DOMMatrixReadOnly(
          getComputedStyle(node).transform,
        );
        return {
          x: position.e,
          y: position.f,
          width: node.offsetWidth,
          height: node.offsetHeight,
        };
      });
    const drag = async (target, dx, dy) => {
      let previousBox;
      await expect
        .poll(async () => {
          const current = JSON.stringify(await target.boundingBox());
          const stable = current === previousBox;
          previousBox = current;
          return stable;
        })
        .toBe(true);
      const box = await target.boundingBox();
      assert(box, "Gesture target must be visible");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(
        box.x + box.width / 2 + dx,
        box.y + box.height / 2 + dy,
        { steps: 12 },
      );
      await page.mouse.up();
    };
    const waitSaved = async (id) => {
      const expected = await geometry(id);
      await until(async () => {
        const saved = (await state()).organization_layout[id];
        return (
          saved &&
          Object.keys(expected).every(
            (key) => Math.abs(saved[key] - expected[key]) < 1,
          )
        );
      }, 15000);
    };
    try {
      await page
        .getByRole("button", { name: "Organization", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Auto arrange", exact: true })
        .click();
      await waitSaved("owner");
      for (const id of [
        "owner",
        ...before.agents.map((a) => `agent:${a.id}`),
      ]) {
        const node = page.locator(`.react-flow__node[data-id="${id}"]`);
        const initial = await geometry(id);
        await drag(node.locator(".org-card-person"), 55, 30);
        const moved = await geometry(id);
        assert(
          moved.x > initial.x + 15 && moved.y > initial.y + 10,
          `Card did not move: ${id}`,
        );
        await expect(
          page.getByRole("button", { name: "Close agent settings" }),
        ).toHaveCount(0);
        await waitSaved(id);
        await drag(node.locator(".org-resize-handle.bottom.right"), 42, 28);
        const resized = await geometry(id);
        assert(
          resized.width > moved.width + 20 &&
            resized.height > moved.height + 10,
          `Card did not resize: ${id}`,
        );
        await waitSaved(id);
        await expect(
          page.getByRole("button", { name: "Close agent settings" }),
        ).toHaveCount(0);
      }
      const saved = (await state()).organization_layout;
      await page.reload();
      await page
        .getByRole("button", { name: "Organization", exact: true })
        .click();
      for (const [id, expected] of Object.entries(saved)) {
        await expect
          .poll(async () => {
            const actual = await geometry(id);
            return Object.entries(expected).every(
              ([key, value]) => Math.abs(actual[key] - value) < 1,
            );
          })
          .toBe(true);
      }
      for (const agent of before.agents) {
        const card = page.locator(`.org-card[data-agent-id="${agent.id}"]`);
        await card.locator(".org-card-person").click();
        await expect(
          page.getByLabel("Display name", { exact: true }),
        ).toHaveValue(agent.name);
        await page
          .getByRole("button", { name: "Close agent settings" })
          .click();
        await card
          .getByRole("button", { name: `Configure ${agent.name}`, exact: true })
          .click();
        await expect(
          page.getByLabel("Display name", { exact: true }),
        ).toHaveValue(agent.name);
        await page
          .getByRole("button", { name: "Close agent settings" })
          .click();
      }
      const nodeId = `agent:${original.id}`;
      const target = page.locator(`.react-flow__node[data-id="${nodeId}"]`);
      await page
        .getByRole("button", { name: "Auto arrange", exact: true })
        .click();
      await waitSaved(nodeId);
      await drag(target.locator(".org-resize-handle.bottom.right"), -300, -240);
      await expect.poll(async () => (await geometry(nodeId)).width).toBe(248);
      await expect.poll(async () => (await geometry(nodeId)).height).toBe(176);
      await waitSaved(nodeId);
      const validLayout = (await state()).organization_layout;
      for (const invalid of [
        { ...validLayout, [nodeId]: { ...validLayout[nodeId], width: 1 } },
        { ...validLayout, [nodeId]: { ...validLayout[nodeId], x: 100001 } },
        { "agent:missing": { x: 0, y: 0, width: 248, height: 176 } },
      ]) {
        const response = await request.put("/api/organization/layout", {
          data: invalid,
        });
        assert.equal(response.status(), 400);
        assert.deepEqual((await state()).organization_layout, validLayout);
      }
      await context.setOffline(true);
      await drag(target.locator(".org-card-person"), -25, 10);
      await expect(page.locator(".org-layout-error")).toContainText(
        "Layout could not be saved",
      );
      await context.setOffline(false);
      await page
        .locator(".org-layout-error")
        .getByRole("button", { name: "Retry" })
        .click();
      await waitSaved(nodeId);
      await expect(page.locator(".org-layout-error")).toHaveCount(0);
      await target
        .getByRole("button", { name: `Configure ${original.name}` })
        .press("Enter");
      await page
        .getByLabel("Role", { exact: true })
        .fill(`${original.role} Chart edit checked.`);
      await page
        .getByRole("button", { name: "Save changes", exact: true })
        .click();
      await until(async () =>
        (await state()).agents
          .find((a) => a.id === original.id)
          ?.role.endsWith("Chart edit checked."),
      );
      await page.getByRole("button", { name: "Close agent settings" }).click();
      await page.setViewportSize({ width: 775, height: 648 });
      await page.getByRole("button", { name: "Fit View", exact: true }).click();
      await target
        .getByRole("button", { name: `Configure ${original.name}` })
        .click();
      await expect(
        page.getByLabel("Display name", { exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: path.join(directory, "organization-editing.png"),
        fullPage: true,
      });
      await page.getByRole("button", { name: "Close agent settings" }).click();
      await page.setViewportSize({ width: 1440, height: 980 });
      await page
        .getByRole("button", { name: "Auto arrange", exact: true })
        .click();
      await waitSaved(nodeId);
      const arranged = await page.locator(".org-card").evaluateAll((cards) =>
        cards.map((c) => {
          const r = c.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        }),
      );
      for (let i = 0; i < arranged.length; i++)
        for (let j = i + 1; j < arranged.length; j++) {
          const a = arranged[i],
            b = arranged[j];
          assert(
            a.x + a.width <= b.x ||
              b.x + b.width <= a.x ||
              a.y + a.height <= b.y ||
              b.y + b.height <= a.y,
            "Auto arrange overlaps resized cards",
          );
        }
      proof.organizationEditing = {
        cards: before.agents.length + 1,
        drag: true,
        resize: true,
        reloadPersistence: true,
        clickAndEditButton: true,
        minimumSize: true,
        invalidLayoutRejected: true,
        offlineRetry: true,
        profileSave: true,
        narrowViewport: 775,
        autoArrange: true,
        browserErrors: errors.length,
      };
      console.log(
        `PASS organization editing: ${before.agents.length + 1} cards dragged/resized/saved; body click and Edit, reload persistence, minimum sizes, invalid input, offline retry, profile save, 775px viewport and auto arrange`,
      );
    } finally {
      await context.setOffline(false);
      await call("/organization/layout", before.organization_layout, "PUT");
      const current = (await state()).agents.find((a) => a.id === original.id);
      if (current.role !== original.role)
        await call(
          `/agents/${original.id}`,
          { ...current, role: original.role },
          "PUT",
        );
    }
  } else if (phase === "organization") {
    const before = await state();
    await page
      .getByRole("button", { name: "Organization", exact: true })
      .click();
    await expect(page.locator(".org-card")).toHaveCount(
      before.agents.length + 1,
    );
    await expect(page.locator(".react-flow__edge")).toHaveCount(
      before.agents.length,
    );
    await page.evaluate(() => document.fonts.ready);
    async function inspectGraph() {
      // ResizeObserver refits the viewport after opening/closing the inspector.
      await expect
        .poll(() =>
          page.locator(".org-chart-canvas").evaluate((canvas) => {
            const bounds = canvas.getBoundingClientRect();
            return Array.from(canvas.querySelectorAll(".org-card")).every(
              (card) => {
                const r = card.getBoundingClientRect();
                return (
                  r.left >= bounds.left - 1 &&
                  r.right <= bounds.right + 1 &&
                  r.top >= bounds.top - 1 &&
                  r.bottom <= bounds.bottom + 1
                );
              },
            );
          }),
        )
        .toBe(true);
      const result = await page
        .locator(".org-chart-canvas")
        .evaluate((canvas) => {
          const bounds = canvas.getBoundingClientRect();
          const cards = Array.from(canvas.querySelectorAll(".org-card")).map(
            (card) => {
              const rect = card.getBoundingClientRect();
              const avatar = card.querySelector(".avatar");
              const avatarBox = avatar.getBoundingClientRect();
              const range = document.createRange();
              range.selectNodeContents(
                avatar.querySelector(".avatar-initials"),
              );
              const text = range.getBoundingClientRect();
              return {
                id: card.getAttribute("data-agent-id") || "owner",
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                overflow: card.scrollHeight - card.clientHeight,
                avatarX:
                  text.x + text.width / 2 - avatarBox.x - avatarBox.width / 2,
                avatarY:
                  text.y + text.height / 2 - avatarBox.y - avatarBox.height / 2,
                visible:
                  rect.left >= bounds.left - 1 &&
                  rect.right <= bounds.right + 1 &&
                  rect.top >= bounds.top - 1 &&
                  rect.bottom <= bounds.bottom + 1,
              };
            },
          );
          return {
            cards,
            headerY: document
              .querySelector(".organization-header")
              .getBoundingClientRect().top,
          };
        });
      assert(
        result.headerY >= 20,
        `Organization heading clipped: ${result.headerY}`,
      );
      for (const card of result.cards) {
        assert(card.visible, `Card outside fitted viewport: ${card.id}`);
        assert.equal(card.overflow, 0, `Card content overflows: ${card.id}`);
        assert(
          Math.abs(card.avatarX) < 1 && Math.abs(card.avatarY) < 1.5,
          `Avatar not centered: ${JSON.stringify(card)}`,
        );
      }
      for (let i = 0; i < result.cards.length; i++)
        for (let j = i + 1; j < result.cards.length; j++) {
          const a = result.cards[i],
            b = result.cards[j];
          assert(
            a.x + a.width <= b.x ||
              b.x + b.width <= a.x ||
              a.y + a.height <= b.y ||
              b.y + b.height <= a.y,
            `Overlapping cards: ${a.id}, ${b.id}`,
          );
        }
      return result;
    }
    const graph = await inspectGraph();
    const edgeOffsets = [];
    for (const agent of before.agents) {
      const edge = page.locator(
        `.react-flow__edge[data-id="reports:${agent.id}"] .react-flow__edge-path`,
      );
      const points = await edge.evaluate((path) => {
        const matrix = path.getScreenCTM();
        const start = path.getPointAtLength(0).matrixTransform(matrix);
        const end = path
          .getPointAtLength(path.getTotalLength())
          .matrixTransform(matrix);
        return {
          start: { x: start.x, y: start.y },
          end: { x: end.x, y: end.y },
        };
      });
      const manager = graph.cards.find(
        (c) => c.id === (agent.reports_to || "owner"),
      );
      const target = graph.cards.find((c) => c.id === agent.id);
      const sourceOffset = Math.hypot(
        points.start.x - manager.x - manager.width / 2,
        points.start.y - manager.y - manager.height,
      );
      const targetOffset = Math.hypot(
        points.end.x - target.x - target.width / 2,
        points.end.y - target.y,
      );
      assert(
        sourceOffset < 5 && targetOffset < 5,
        `Connector misses card: ${agent.name}, ${sourceOffset}, ${targetOffset}`,
      );
      edgeOffsets.push({ agent: agent.id, sourceOffset, targetOffset });
    }
    await page.screenshot({
      path: path.join(directory, "organization-chart.png"),
      fullPage: true,
    });
    for (const agent of before.agents) {
      await page.locator(`.org-card[data-agent-id="${agent.id}"]`).click();
      await expect(
        page.getByLabel("Display name", { exact: true }),
      ).toHaveValue(agent.name);
      await expect(page.getByLabel("Reports to", { exact: true })).toHaveValue(
        agent.reports_to || "",
      );
      await expect(
        page.locator(`.org-card[data-agent-id="${agent.id}"]`),
      ).toHaveAttribute("data-selected", "true");
      await inspectGraph();
      await page.getByRole("button", { name: "Close agent settings" }).click();
    }
    const zoom = () =>
      page
        .locator(".react-flow__viewport")
        .evaluate(
          (element) =>
            new DOMMatrixReadOnly(getComputedStyle(element).transform).a,
        );
    await expect
      .poll(
        async () =>
          (await page.locator(".org-card").first().boundingBox()).width,
      )
      .toBeCloseTo(graph.cards[0].width, 1);
    const startZoom = await zoom();
    await page.getByRole("button", { name: /^zoom in$/i }).click();
    await expect.poll(zoom).toBeGreaterThan(startZoom);
    await page.getByRole("button", { name: /^zoom out$/i }).click();
    await page.getByRole("button", { name: /^fit view$/i }).click();
    await expect.poll(zoom).toBeCloseTo(startZoom, 2);
    const viewport = page.locator(".react-flow__viewport");
    const transformBefore = await viewport.getAttribute("style");
    const canvasBox = await page.locator(".org-chart-canvas").boundingBox();
    await page.mouse.move(canvasBox.x + 40, canvasBox.y + 35);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + 95, canvasBox.y + 75, { steps: 5 });
    await page.mouse.up();
    assert.notEqual(
      await viewport.getAttribute("style"),
      transformBefore,
      "Canvas did not pan",
    );
    await page.getByRole("button", { name: /^fit view$/i }).click();
    for (const dimensions of [
      { width: 1024, height: 768 },
      { width: 1920, height: 1080 },
    ]) {
      await page.setViewportSize(dimensions);
      await expect
        .poll(async () => {
          try {
            await inspectGraph();
            return true;
          } catch {
            return false;
          }
        })
        .toBe(true);
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
    }
    await page.setViewportSize({ width: 1440, height: 980 });
    const firstAgent = before.agents[0];
    const firstCard = page.locator(
      `.org-card[data-agent-id="${firstAgent.id}"] .org-card-edit`,
    );
    await firstCard.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
      firstAgent.name,
    );
    await page.getByRole("button", { name: "Close agent settings" }).click();
    await page.getByRole("button", { name: "Add agent", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    assert.deepEqual(
      (await state()).agents,
      before.agents,
      "Read-only chart checks changed profiles",
    );
    proof.organization = {
      nodes: graph.cards.length,
      edges: edgeOffsets.length,
      maxAvatarOffset: Math.max(
        ...graph.cards.flatMap((c) => [
          Math.abs(c.avatarX),
          Math.abs(c.avatarY),
        ]),
      ),
      allCardsOpenCorrectProfile: true,
      connectors: edgeOffsets,
      noOverlap: true,
      panZoomFit: true,
      keyboard: true,
      responsiveWidths: [1024, 1440, 1920],
      browserErrors: errors.length,
    };
    console.log(
      `PASS organization: all ${graph.cards.length} nodes and ${edgeOffsets.length} connectors checked; centered avatars, no overlaps/clipping, every profile opens, pan/zoom/fit, keyboard, responsive layouts, profiles unchanged`,
    );
  } else if (phase === "design") {
    const original = (await state()).agents.find((a) => a.id === proof.agent);
    assert(
      original,
      "Run the basic phase to create the real verification agent first",
    );
    const catalog = await call("/codex/settings", undefined, "GET");
    const localCache = JSON.parse(
      await readFile(
        path.join(
          process.env.CODEX_HOME ||
            path.join(process.env.USERPROFILE, ".codex"),
          "models_cache.json",
        ),
        "utf8",
      ),
    );
    assert.deepEqual(
      catalog.models.map((m) => m.slug),
      localCache.models
        .filter((m) => m.visibility === "list" || m.slug === catalog.model)
        .map((m) => m.slug),
    );
    assert.deepEqual(Object.keys(catalog).sort(), [
      "fetched_at",
      "model",
      "models",
      "reasoning",
    ]);
    assert.equal(
      (await request.post("/api/work-items", { data: {} })).status(),
      405,
    );
    await expect(
      page.getByRole("navigation", { name: "Agents", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Work", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Connected locally", { exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Organization", exact: true })
      .click();
    await page.getByRole("button", { name: "Add agent", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("Engineer");
    await page
      .getByLabel("Role", { exact: true })
      .fill("Build and maintain our products");
    const dialog = page.getByRole("dialog");
    await dialog.evaluate((element) =>
      Promise.all(
        element
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished),
      ),
    );
    const dialogBox = await dialog.boundingBox();
    const inputBox = await page
      .getByLabel("Name", { exact: true })
      .boundingBox();
    assert(
      dialogBox.width >= 550,
      `Dialog is still narrow: ${dialogBox.width}`,
    );
    assert(
      inputBox.height >= 44 && inputBox.width >= 490,
      `Input dimensions: ${JSON.stringify(inputBox)}`,
    );
    const padding = await page
      .getByLabel("Name", { exact: true })
      .evaluate((input) => {
        const css = getComputedStyle(input);
        return { top: css.paddingTop, bottom: css.paddingBottom };
      });
    assert.equal(padding.top, padding.bottom);
    await page.screenshot({
      path: path.join(directory, "agent-dialog-redesign.png"),
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    const uploaded = [];
    try {
      await page
        .getByRole("button", { name: "Configure Engineer", exact: true })
        .last()
        .click();
      const rich = catalog.models.find((m) =>
        m.supported_reasoning_levels.some((r) => r.effort === "max"),
      );
      const limited = catalog.models.find(
        (m) => !m.supported_reasoning_levels.some((r) => r.effort === "max"),
      );
      assert(
        rich && limited,
        "This machine should expose different model reasoning capabilities",
      );
      await expect(page.getByLabel("Model", { exact: true })).toBeEnabled();
      await page.getByLabel("Model", { exact: true }).selectOption(rich.slug);
      await page
        .getByLabel("Reasoning effort", { exact: true })
        .selectOption("max");
      await page.getByLabel("Reports to", { exact: true }).selectOption("ceo");
      await page
        .getByRole("button", { name: "Save changes", exact: true })
        .click();
      await until(async () => {
        const a = (await state()).agents.find((a) => a.id === original.id);
        return (
          a.model === rich.slug &&
          a.reasoning === "max" &&
          a.reports_to === "ceo"
        );
      });
      await page.reload();
      await page
        .getByRole("button", { name: "Organization", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Configure Engineer", exact: true })
        .last()
        .click();
      await expect(page.getByLabel("Model", { exact: true })).toHaveValue(
        rich.slug,
      );
      await expect(page.getByLabel("Reports to", { exact: true })).toHaveValue(
        "ceo",
      );
      await expect(
        page.locator(`.react-flow__edge[data-id="reports:${original.id}"]`),
      ).toHaveAttribute("aria-label", "Engineer reports to CEO");
      const ceo = (await state()).agents.find((a) => a.id === "ceo");
      const cycle = await request.put("/api/agents/ceo", {
        data: { ...ceo, reports_to: original.id },
      });
      assert.equal(cycle.status(), 400);
      assert.match(await cycle.text(), /cycle/);
      const current = (await state()).agents.find((a) => a.id === original.id);
      assert.equal(
        (
          await request.put(`/api/agents/${original.id}`, {
            data: { ...current, model: limited.slug, reasoning: "max" },
          })
        ).status(),
        400,
      );
      await page
        .getByLabel("Model", { exact: true })
        .selectOption(limited.slug);
      await expect(
        page.getByLabel("Reasoning effort", { exact: true }),
      ).toHaveValue("");
      await expect(
        page.locator('#profile-reasoning option[value="max"]'),
      ).toHaveCount(0);
      await page.getByLabel("Model", { exact: true }).selectOption("");
      await page
        .getByRole("button", { name: "Save changes", exact: true })
        .click();
      await until(async () => {
        const a = (await state()).agents.find((a) => a.id === original.id);
        return a.model === "" && a.reasoning === "";
      });
      await page.screenshot({
        path: path.join(directory, "organization-redesign.png"),
        fullPage: true,
      });
      await page
        .getByRole("navigation", { name: "Groups" })
        .getByRole("button", { name: "Platform verification" })
        .last()
        .click();
      await page
        .getByRole("button", { name: "Knowledge", exact: true })
        .click();
      const prefix = `explorer-check-${Date.now()}`;
      await page.getByLabel("Upload attachment").setInputFiles([
        {
          name: `${prefix}.md`,
          mimeType: "text/markdown",
          buffer: Buffer.from(
            "# Explorer verification\nThis is a real uploaded document.\n",
          ),
        },
        {
          name: `${prefix}-second.txt`,
          mimeType: "text/plain",
          buffer: Buffer.from(
            "Second upload verifies multiple-file selection.\n",
          ),
        },
      ]);
      const fresh = await until(async () => {
        const files = (await state()).artifacts.filter((a) =>
          a.name.startsWith(prefix),
        );
        return files.length === 2 ? files : false;
      });
      uploaded.push(...fresh.map((a) => a.id));
      await page.getByLabel("Filter files").fill(prefix);
      await expect(
        page
          .getByRole("table", { name: "Files", exact: true })
          .locator("tbody tr"),
      ).toHaveCount(2);
      await page
        .getByRole("button", { name: `${prefix}.md`, exact: true })
        .click();
      await expect(page.locator(".preview-content pre")).toContainText(
        "real uploaded document",
      );
      await page
        .getByRole("button", { name: "Make searchable", exact: true })
        .click();
      const doc = fresh.find((a) => a.name.endsWith(".md"));
      await until(
        async () =>
          (await state()).artifacts.find((a) => a.id === doc.id).status ===
          "indexed",
      );
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("link", { name: "Download", exact: true }).click(),
      ]);
      assert.equal(download.suggestedFilename(), `${prefix}.md`);
      assert.match(
        await readFile(await download.path(), "utf8"),
        /real uploaded document/,
      );
      await page.getByLabel("Filter files").fill("nothing-matches-this-name");
      await expect(
        page.getByText("No matching files", { exact: true }),
      ).toBeVisible();
      await page.getByLabel("Filter files").fill("");
      await page
        .getByRole("navigation", { name: "File categories" })
        .getByRole("button", { name: /^Images/ })
        .click();
      await page
        .getByRole("button", { name: "red-circle.png", exact: true })
        .click();
      await expect(page.locator(".preview-content img")).toBeVisible();
      await until(async () =>
        page
          .locator(".preview-content img")
          .evaluate((img) => img.naturalWidth > 0),
      );
      await page.screenshot({
        path: path.join(directory, "knowledge-explorer-redesign.png"),
        fullPage: true,
      });
      await page.setViewportSize({ width: 1024, height: 768 });
      await expect(
        page.getByRole("button", { name: "red-circle.png", exact: true }),
      ).toBeVisible();
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.setViewportSize({ width: 1440, height: 980 });
      await page
        .getByRole("navigation", { name: "File categories" })
        .getByRole("button", { name: /^Documents/ })
        .click();
      await page
        .getByRole("button", { name: `${prefix}.md`, exact: true })
        .click();
      await page
        .getByRole("button", { name: `Delete ${prefix}.md`, exact: true })
        .click();
      await until(
        async () => !(await state()).artifacts.some((a) => a.id === doc.id),
      );
      const updated = (await state()).agents.find((a) => a.id === original.id);
      await call(
        `/agents/${original.id}`,
        { ...updated, permission: "read-only" },
        "PUT",
      );
      const message = await call("/messages", {
        id: crypto.randomUUID(),
        group_id: proof.group,
        body: "Reply with MODEL_SETTINGS_OK. Do not run tools or change files.",
        recipients: [original.id],
        reply_to: null,
        artifacts: [],
      });
      const run = await finished(message.id);
      assert.equal(run.status, "succeeded", run.error);
      assert(run.output.includes("MODEL_SETTINGS_OK"));
      assert.equal(
        run.arguments[run.arguments.indexOf("--model") + 1],
        catalog.model,
      );
      assert(
        run.arguments.includes(`model_reasoning_effort="${catalog.reasoning}"`),
      );
      proof.design = {
        dialogWidth: dialogBox.width,
        inputHeight: inputBox.height,
        models: catalog.models.map((m) => m.slug),
        modelSpecificReasoning: true,
        reportingPersisted: true,
        cycleRejected: true,
        multiUpload: true,
        textPreview: true,
        imagePreview: true,
        download: true,
        index: true,
        delete: true,
        defaultSettingsRun: run.id,
        browserErrors: errors.length,
      };
      console.log(
        "PASS redesigned UI: 560px dialog/44px inputs, organization hierarchy persistence/cycle rejection, real Codex model/effort dropdowns and inherited run, file list/multiple uploads/filter/previews/index/download/delete, responsive layout",
      );
    } finally {
      const current = (await state()).agents.find((a) => a.id === original.id);
      await call(
        `/agents/${original.id}`,
        { ...original, revision: current.revision },
        "PUT",
      );
      for (const id of uploaded)
        if ((await state()).artifacts.some((a) => a.id === id))
          await call(`/artifacts/${id}`, undefined, "DELETE");
    }
  } else if (phase === "privacy") {
    const agent = (await state()).agents.find((a) => a.id === proof.agent);
    await call(
      `/agents/${agent.id}`,
      { ...agent, permission: "read-only" },
      "PUT",
    );
    try {
      const values = { AE_PROBE_VALUE: proof.envProbeValue };
      assert.equal(typeof values.AE_PROBE_VALUE, "string");
      const message = await call("/messages", {
        id: crypto.randomUUID(),
        group_id: proof.group,
        body: "For a harness test, run PowerShell Write-Output $env:AE_PROBE_VALUE to check that the explicitly configured test variable reached the shell. Then reply ENV_CHECK_DONE. Do not change files.",
        recipients: [agent.id],
        reply_to: null,
        artifacts: [],
      });
      const run = await finished(message.id);
      assert.equal(run.status, "succeeded", run.error);
      const events = await call(`/runs/${run.id}/events`, undefined, "GET");
      const lines = events.map((e) => String(e.payload.line || ""));
      assert(
        lines.some((l) => l.includes("[REDACTED]")),
        "Expected actual shell output to be redacted",
      );
      const encoded = JSON.stringify(values.AE_PROBE_VALUE).slice(1, -1);
      assert(
        lines.every(
          (l) => !l.includes(values.AE_PROBE_VALUE) && !l.includes(encoded),
        ),
        "Secret leaked into normalized events",
      );
      assert.equal(
        await readFile(path.join(proof.workspace, "sentinel.txt"), "utf8"),
        "Existing dirty user content. Preserve exactly.\n",
      );
      proof.privacy = {
        run: run.id,
        readOnlyExecution: true,
        scopedEnvironment: true,
        redactedEvents: true,
      };
      console.log(
        "PASS real read-only Codex shell, scoped environment delivery, escaped-value redaction and preserved workdir files",
      );
    } finally {
      const current = (await state()).agents.find((a) => a.id === agent.id);
      await call(
        `/agents/${agent.id}`,
        { ...current, permission: agent.permission },
        "PUT",
      );
    }
  } else {
    throw new Error(`Unknown phase: ${phase}`);
  }
  assert.deepEqual(errors, [], "Browser JavaScript errors");
  await writeFile(proofPath, JSON.stringify(proof, null, 2));
} catch (error) {
  console.error(String(error.message).replaceAll(ownerKey, "[REDACTED]"));
  process.exitCode = 1;
} finally {
  await browser.close();
}
