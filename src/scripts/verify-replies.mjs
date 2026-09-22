import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test');
const [credentials, output, tenant, runtime, workdir] = process.argv.slice(2);
if (!workdir) throw new Error('Usage: node src/scripts/verify-replies.mjs credentials.json output-dir workspace-id runtime-id workdir (uses two real Codex turns)');
const creds = JSON.parse(await readFile(resolve(credentials), 'utf8'));
const dir = resolve(output); await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage(), errors = [];
page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
let agent, group, completed = false;
async function api(path, body, method = 'POST') {
  const response = await context.request.fetch(creds.url + '/api' + path, {
    method, headers: { 'x-ae-workspace': tenant }, data: body,
  });
  assert.equal(response.status(), 200, await response.text()); return response.json();
}
try {
  await page.goto(creds.url);
  await page.getByLabel('Username', { exact: true }).fill(creds.username);
  await page.getByLabel('Password', { exact: true }).fill(creds.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption(tenant);
  const before = await api('/state', undefined, 'GET');
  const workspace = (await api('/workspaces/probe', { runtime_id: runtime, path: workdir })).workspace;
  agent = await api('/agents', { ...before.agents[0], id: randomUUID(), name: 'ReplyVerifier',
    position: 'Verification', reports_to: null, project_id: null, workdir: workspace,
    model: 'gpt-5.6-sol', reasoning: 'low', permission: 'read-only', enabled: true, deleted_at: null,
    instructions: 'Follow the requested reply exactly. Do not use tools, delegate, or modify files.',
    agents_md: '', revision: 1, timeout_seconds: 120,
  });
  group = await api('/groups', { id: randomUUID(), name: 'Reply verification', description: 'Temporary real reply smoke test', member_ids: [agent.id] });
  await writeFile(resolve(dir, 'ids.json'), JSON.stringify({ agent: agent.id, group: group.id }));
  await page.goto(`${creds.url}/groups/${group.id}/chat`);
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('@ReplyVerifier Reply with exactly REPLY_READY.'); await composer.press('Enter');
  const answers = page.locator('article.message-agent');
  await expect(answers).toHaveCount(1, { timeout: 180000 });
  await expect(answers.first().locator('.reply-quote')).toContainText('You');
  await expect(answers.first().locator('.markdown')).toContainText('REPLY_READY');
  await answers.first().getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(page.locator('.reply-preview')).toContainText('ReplyVerifier');
  await expect(page.locator('.reply-preview')).toContainText('REPLY_READY');
  await page.getByRole('button', { name: 'Cancel reply' }).click();
  await expect(page.locator('.reply-preview')).toHaveCount(0);
  await answers.first().getByRole('button', { name: 'Reply', exact: true }).click();
  const followup = 'Reply with exactly REPLY_CONFIRMED.';
  await composer.fill(followup); await composer.press('Enter');
  await expect(answers).toHaveCount(2, { timeout: 180000 });
  await expect(answers.last().locator('.reply-quote')).toContainText(followup);
  await expect(answers.last().locator('.reply-quote strong')).toHaveText('You');
  await expect(answers.last().locator('.markdown')).toContainText('REPLY_CONFIRMED');
  const humanReply = page.locator('article.message-self').last();
  await expect(humanReply.locator('.reply-quote strong')).toHaveText('ReplyVerifier');
  await expect(humanReply.locator('.reply-quote')).toContainText('REPLY_READY');
  let history = await api(`/groups/${group.id}/messages?main=true`, undefined, 'GET');
  const userMessage = history.find(m => m.body === followup), answer = history.find(m => m.reply_to === userMessage.id);
  assert.deepEqual(userMessage.recipients, [agent.id]); assert.equal(answer.sender, agent.id);
  const replay = await api('/messages', { ...userMessage, recipients: [] }); assert.equal(replay.id, userMessage.id);
  const runs = (await api('/state', undefined, 'GET')).runs.filter(r => r.group_id === group.id);
  assert.equal(runs.length, 2); assert(runs.every(r => r.status === 'succeeded'));
  await page.reload();
  await expect(page.locator('article.message-agent .reply-quote')).toHaveCount(2);
  await page.screenshot({ path: resolve(dir, 'replies-desktop.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('article.message-agent').last().locator('.reply-quote')).toContainText(followup);
  await page.screenshot({ path: resolve(dir, 'replies-mobile.png'), animations: 'disabled' });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  // Force the original outside the loaded 50-message page, then quote it.
  for (let i = 0; i < 51; i++) await api('/messages', { id: randomUUID(), group_id: group.id, body: `History pagination ${i}` });
  await api('/messages', { id: randomUUID(), group_id: group.id, body: 'Reply to earlier human message', reply_to: userMessage.id });
  await page.reload();
  await expect(page.locator('article.message-self').last().locator('.reply-quote')).toContainText(followup);
  const side = await api('/messages', { id: randomUUID(), group_id: group.id, body: '/btw' });
  const sideReply = await api('/messages', { id: randomUUID(), group_id: group.id, side_chat_id: side.id, body: 'Side reply', reply_to: side.id });
  assert.deepEqual(await api(`/groups/${group.id}/messages?main=true&id=${sideReply.id}`, undefined, 'GET'), []);
  assert.equal((await api(`/groups/${group.id}/messages?side_chat_id=${side.id}&id=${sideReply.id}`, undefined, 'GET'))[0].id, sideReply.id);
  const rejected = await context.request.post(creds.url + '/api/messages', { headers: { 'x-ae-workspace': tenant }, data: {
    id: randomUUID(), group_id: group.id, body: 'Invalid cross-side reply', reply_to: sideReply.id,
  } });
  assert.equal(rejected.status(), 400);
  assert.equal((await api('/state', undefined, 'GET')).runs.filter(r => r.group_id === group.id).length, 2);
  const anonymous = await browser.newContext();
  assert.equal((await anonymous.request.get(`${creds.url}/api/groups/${group.id}/messages?id=${userMessage.id}`)).status(), 401);
  await anonymous.close(); assert.deepEqual(errors, []);
  const proof = { embeddedQuotes: true, composerPreviewAndCancel: true, replyWithoutMention: true,
    agentAnswerQuotesUser: true, idempotency: true, persistence: true, olderParentLookup: true,
    sideIsolation: true, authentication: true, mobile390px: true, browserErrors: errors,
    runs: runs.map(r => ({ id: r.id, status: r.status, runtime: r.profile.workdir.runtime_id, cwd: r.cwd })),
  };
  await writeFile(resolve(dir, 'proof.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof)); completed = true;
} finally {
  // Keep failed verification evidence and any active run available for inspection.
  if (completed) {
    await api('/groups/' + group.id, undefined, 'DELETE');
    await api('/agents/' + agent.id, undefined, 'DELETE');
  }
  await context.request.post(creds.url + '/api/logout', { data: {} });
  await browser.close();
}
