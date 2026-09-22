import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test');
const [credentials, output] = process.argv.slice(2);
if (!output) throw new Error('Usage: node src/scripts/verify-reply-jump.mjs credentials.json output-dir');
const creds = JSON.parse(await readFile(resolve(credentials), 'utf8'));
const dir = resolve(output); await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage(), errors = [];
page.setDefaultTimeout(20000); page.on('pageerror', e => errors.push(e.message));
let tenant;
async function api(path, body, method = 'POST') {
  const response = await context.request.fetch(creds.url + '/api' + path, {
    method, headers: tenant ? { 'x-ae-workspace': tenant.id } : {}, data: body,
  });
  assert.equal(response.status(), 200, await response.text()); return response.json();
}
try {
  await page.goto(creds.url);
  await page.getByLabel('Username', { exact: true }).fill(creds.username);
  await page.getByLabel('Password', { exact: true }).fill(creds.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).waitFor();
  tenant = await api('/tenants', { name: 'Reply jump verification ' + randomUUID().slice(0, 6) });
  await writeFile(resolve(dir, 'tenant.json'), JSON.stringify(tenant));
  const group = await api('/groups', { id: randomUUID(), name: 'Reply jump', description: 'Temporary browser verification', member_ids: [] });
  const send = body => api('/messages', { id: randomUUID(), group_id: group.id, ...body });
  const original = await send({ body: 'Original planning message: keep the runtime on this PC.' });
  for (let i = 0; i < 256; i += 8) await Promise.all(Array.from({ length: 8 }, (_, offset) => send({ body: `History message ${i + offset}` })));
  const reply = await send({ body: 'Agreed. This quotes the original planning message.', reply_to: original.id });
  await page.reload();
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption(tenant.id);
  await page.goto(`${creds.url}/groups/${group.id}/chat`);
  const target = page.locator(`#message-${original.id}`), quote = page.locator(`#message-${reply.id} .reply-quote-link`);
  await expect(target).toHaveCount(0);
  await expect(quote).toBeEnabled(); await quote.click();
  await expect(target).toBeFocused();
  async function checkInView() {
    assert(await target.evaluate(node => {
      const rect = node.getBoundingClientRect(), viewport = node.closest('.timeline').getBoundingClientRect();
      return rect.top >= viewport.top && rect.bottom <= viewport.bottom;
    }), 'Original message must be inside the chat viewport');
  }
  await checkInView(); await expect(page.locator('article.message')).toHaveCount(258);
  await page.screenshot({ path: resolve(dir, 'jump-desktop.png'), animations: 'disabled' });
  const top = await page.locator('.timeline').evaluate(node => node.scrollTop);
  const incoming = await send({ body: 'Live update while reading earlier history' });
  await expect(page.locator(`#message-${incoming.id}`)).toHaveCount(1);
  await expect(target).toHaveCount(1); await checkInView();
  assert(Math.abs(await page.locator('.timeline').evaluate(node => node.scrollTop) - top) < 3);
  await quote.scrollIntoViewIfNeeded(); await quote.focus(); await quote.press('Enter');
  await expect(target).toBeFocused(); await checkInView();
  await quote.scrollIntoViewIfNeeded(); await quote.focus(); await quote.press('Space');
  await expect(target).toBeFocused(); await checkInView();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 }); await page.reload();
  await expect(target).toHaveCount(0); await expect(quote).toBeEnabled(); await quote.click();
  await expect(target).toBeFocused(); await checkInView();
  assert.equal(await target.evaluate(node => node.getAnimations().length), 0);
  await page.screenshot({ path: resolve(dir, 'jump-mobile.png'), animations: 'disabled' });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const side = await send({ body: '/btw Discuss this separately', reply_to: original.id });
  await page.goto(`${creds.url}/groups/${group.id}/chat?side=${side.id}`);
  await expect(page.locator(`#message-${side.id} .reply-quote-link`)).toBeEnabled();
  await page.locator(`#message-${side.id} .reply-quote-link`).click();
  await expect(page).not.toHaveURL(/side=/); await expect(target).toBeFocused(); await checkInView();
  assert.deepEqual(errors, []);
  const proof = { clickToOriginal: true, multipleHistoryPages: true, loadedHistoryRetained: true,
    liveUpdatesPreserveScroll: true, keyboardEnterAndSpace: true, mobile390px: true,
    sideToMainOriginal: true, reducedMotion: true, browserErrors: errors, mocks: false };
  await writeFile(resolve(dir, 'proof.json'), JSON.stringify(proof, null, 2)); console.log(JSON.stringify(proof));
} finally {
  if (tenant) await api('/tenants/' + tenant.id, {}, 'DELETE');
  await context.request.post(creds.url + '/api/logout', { data: {} }); await browser.close();
}
