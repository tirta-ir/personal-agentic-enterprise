import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test');
const [credentials, output, workspaceId] = process.argv.slice(2);
if (!workspaceId) throw new Error('Usage: node src/scripts/verify-org-runtimes.mjs credentials.json output-dir workspace-id');
const creds = JSON.parse(await readFile(resolve(credentials), 'utf8'));
const dir = resolve(output); await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const context = await browser.newContext({ viewport: { width: 1683, height: 1000 } });
const page = await context.newPage(), errors = [];
page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(20000);
async function get(path, tenant = workspaceId) {
  const response = await context.request.get(creds.url + '/api' + path, { headers: { 'x-ae-workspace': tenant } });
  assert.equal(response.status(), 200, await response.text()); return response.json();
}
try {
  await page.goto(creds.url);
  await page.getByLabel('Username', { exact: true }).fill(creds.username);
  await page.getByLabel('Password', { exact: true }).fill(creds.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption(workspaceId);
  const state = await get('/state'), runtimes = await get('/runtimes');
  const label = workdir => !workdir ? 'Not assigned' : workdir.runtime_id
    ? runtimes.find(runtime => runtime.id === workdir.runtime_id)?.name ?? 'Runtime unavailable'
    : workdir.ssh_host ? state.workstations.find(host => host.id === workdir.ssh_host)?.name ?? workdir.ssh_host : 'Local';
  async function check(agents, project) {
    await expect(page.locator('.org-card[data-agent-id]')).toHaveCount(agents.length);
    for (const agent of agents) {
      const workdir = project?.workdir ?? state.groups.find(group => group.id === agent.project_id)?.project?.workdir ?? agent.workdir;
      const card = page.locator(`.org-card[data-agent-id="${agent.id}"]`), badge = card.locator('.org-card-runtime');
      await expect(badge).toHaveText(label(workdir));
      await expect(badge).toHaveAttribute('title', 'Runtime: ' + label(workdir));
      await expect(card.locator('.org-card-kind')).toHaveText(agent.project_id ? 'Project agent' : 'Organization agent');
    }
    await page.evaluate(() => document.fonts.ready);
    assert(await page.locator('.org-card[data-agent-id]').evaluateAll(cards => cards.every(card => {
      const kind = card.querySelector('.org-card-kind').getBoundingClientRect();
      const badge = card.querySelector('.org-card-runtime').getBoundingClientRect();
      const edit = card.querySelector('.org-card-edit').getBoundingClientRect();
      return badge.width > 0 && badge.left >= kind.right && badge.right <= edit.left && Math.abs(badge.top + badge.height / 2 - kind.top - kind.height / 2) < 1;
    })), 'Runtime badge must fit beside the kind label without overlapping Edit');
    await expect(page.locator('.org-card-owner .org-card-runtime')).toHaveCount(0);
  }
  await page.goto(creds.url + '/organization'); await check(state.agents);
  await page.screenshot({ path: resolve(dir, 'organization.png'), animations: 'disabled' });
  const projects = state.groups.filter(group => group.project && !group.deleted_at);
  for (const group of projects) {
    const members = state.agents.filter(agent => group.project.members.some(member => member.agent_id === agent.id));
    await page.goto(`${creds.url}/projects/${group.id}/structure`); await check(members, group.project);
    await page.getByRole('button', { name: 'Hide team editor', exact: true }).click();
    await expect.poll(() => page.locator('.org-card[data-agent-id]').first().evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(100);
    await page.screenshot({ path: resolve(dir, `project-${group.id}.png`), animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 }); await check(members, group.project);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.setViewportSize({ width: 1683, height: 1000 });
  }
  const after = await get('/state');
  for (const key of ['agents', 'groups', 'organization_layout', 'project_layouts']) assert.deepEqual(after[key], state[key]);
  assert.deepEqual(errors, []);
  const proof = { agentsChecked: state.agents.length, projectsChecked: projects.length,
    runtimeNames: runtimes.map(runtime => runtime.name), badgesBesideKind: true, noOverlap: true,
    fullNameTooltip: true, savedLayoutsPreserved: true, browserErrors: errors, mocks: false };
  await writeFile(resolve(dir, 'proof.json'), JSON.stringify(proof, null, 2)); console.log(JSON.stringify(proof));
} finally {
  await context.request.post(creds.url + '/api/logout', { data: {} }); await browser.close();
}
