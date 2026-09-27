import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";

export async function verifyOrganizationReporting({ page, call, state, base, directory }) {
  assert(process.env.AE_TEST_ORG && base !== "http://127.0.0.1:8765", "Use a separate native organization");
  const original = (await state()).agents;
  const template = original[0] ?? (await state()).deleted_agents[0];
  assert(template);
  for (const agent of original) await call(`/agents/${agent.id}`, undefined, "DELETE");
  await page.goto("/organization");
  await expect(page.locator(".org-card")).toHaveCount(1);
  await expect(page.locator(".org-card-owner")).toContainText("0 direct reports");
  // Let the existing owner card finish measurement before it gains its first report.
  await expect.poll(() => page.locator('.react-flow__node[data-id="owner"]').evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThan(100);
  const create = (name, reports_to = null) => call("/agents", { ...template, id: "", deleted_at: null, enabled: true, revision: 1, name, position: name, reports_to, workdir: null });
  const node = (id) => page.locator(`.react-flow__node[data-id="${id === "owner" ? id : `agent:${id}`}"]`);
  const checks = [];
  async function connector(agent, manager = "owner") {
    const edge = page.locator(`.react-flow__edge[data-id="reports:${agent.id}"] .react-flow__edge-path`);
    await expect(edge).toHaveCount(1, { timeout: 6000 });
    await expect.poll(async () => {
      const points = await edge.evaluate((line) => {
        const matrix = line.getScreenCTM();
        const a = line.getPointAtLength(0).matrixTransform(matrix);
        const b = line.getPointAtLength(line.getTotalLength()).matrixTransform(matrix);
        const style = getComputedStyle(line);
        return { x1: a.x, y1: a.y, x2: b.x, y2: b.y, length: line.getTotalLength(), stroke: style.stroke, opacity: style.opacity };
      });
      const source = await node(manager).boundingBox();
      const target = await node(agent.id).boundingBox();
      return points.length > 0 && points.stroke !== "none" && Number(points.opacity) > 0 && Math.hypot(points.x1 - source.x - source.width / 2, points.y1 - source.y - source.height) < 5 && Math.hypot(points.x2 - target.x - target.width / 2, points.y2 - target.y) < 5;
    }).toBe(true);
    checks.push({ agent: agent.name, manager });
  }
  let manager = await create("Manager");
  await expect(page.locator(".org-card-owner")).toContainText("1 direct report");
  try { await connector(manager); }
  catch (error) { await page.screenshot({ path: path.join(directory, "missing-owner-connector.png") }); throw error; }
  let worker = await create("Engineer", manager.id);
  await connector(worker, manager.id);
  const update = async (agent, reports_to) => call(`/agents/${agent.id}`, { ...(await state()).agents.find((a) => a.id === agent.id), reports_to }, "PUT");
  worker = await update(worker, null); await connector(worker);
  manager = await update(manager, worker.id); await connector(manager, worker.id);
  manager = await update(manager, null); await connector(manager);
  worker = await update(worker, manager.id); await connector(worker, manager.id);
  await call(`/agents/${worker.id}`, undefined, "DELETE");
  await expect(page.locator(".react-flow__edge-path")).toHaveCount(1);
  await call(`/agents/${worker.id}/restore`); await connector(worker, manager.id);
  // Real pointer gestures must keep the existing connector anchored to resized/moved cards.
  await page.getByRole("button", { name: "Auto arrange", exact: true }).click();
  await connector(manager); await connector(worker, manager.id);
  const box = await node(manager.id).boundingBox();
  await page.mouse.move(box.x + 25, box.y + 25); await page.mouse.down();
  await page.mouse.move(box.x + 75, box.y + 45, { steps: 10 }); await page.mouse.up();
  await connector(manager); await connector(worker, manager.id);
  const resize = node(manager.id).locator(".org-resize-handle.bottom.right");
  await expect(resize).toHaveCount(1);
  const handle = await resize.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
  await page.mouse.move(handle.x + 45, handle.y + 35, { steps: 10 }); await page.mouse.up();
  await connector(manager); await connector(worker, manager.id);
  await page.getByRole("button", { name: "Auto arrange", exact: true }).click();
  await page.locator(`.org-card[data-agent-id="${manager.id}"]`).click();
  await expect(page.getByLabel("Reports to", { exact: true })).toHaveValue("");
  await page.getByText("Organization knowledge", { exact: true }).click();
  await expect(page.getByLabel("Organization relationships")).toContainText("Owner (Owner)");
  await connector(manager); await connector(worker, manager.id);
  await page.screenshot({ path: path.join(directory, "organization-reporting-fixed.png"), animations: "disabled" });
  await page.setViewportSize({ width: 800, height: 900 }); await connector(manager); await connector(worker, manager.id);
  await page.screenshot({ path: path.join(directory, "organization-reporting-narrow.png"), animations: "disabled" });
  await page.setViewportSize({ width: 1440, height: 980 });
  await page.reload(); await connector(manager); await connector(worker, manager.id);
  const knowledge = await call(`/agents/${manager.id}/organization-context`, undefined, "GET");
  assert.equal(knowledge.manager_id, "owner"); assert(knowledge.direct_report_ids.includes(worker.id));
  const proof = { checks, manager: manager.id, worker: worker.id, managerReportsTo: knowledge.manager_id, noReloadRequired: true, mocks: false };
  await writeFile(path.join(directory, "organization-reporting-proof.json"), JSON.stringify(proof, null, 2));
  return proof;
}
