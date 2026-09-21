import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const [url, keyFile, output] = process.argv.slice(2);
assert(url && keyFile && output, 'Usage: node verify-login-ui.mjs URL OWNER_KEY OUTPUT_DIR');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(url);
  await page.getByRole('heading', { name: 'Welcome back' }).waitFor();
  for (const [width, height] of [[705, 545], [1440, 1000], [375, 667], [320, 568]]) {
    await page.setViewportSize({ width, height });
    const geometry = await page.locator('.login-card').evaluate(card => {
      const inputs = [...card.querySelectorAll('input')];
      const button = card.querySelector('button[type="submit"]');
      return {
        overflow: document.documentElement.scrollWidth > innerWidth,
        inputs: inputs.map(input => ({ height: input.getBoundingClientRect().height, border: getComputedStyle(input).borderTopWidth })),
        submitHeight: button.getBoundingClientRect().height,
        submitBelowFields: button.getBoundingClientRect().top >= inputs.at(-1).getBoundingClientRect().bottom,
      };
    });
    assert.equal(geometry.overflow, false);
    assert(geometry.inputs.every(input => input.height >= 44 && parseFloat(input.border) >= 1));
    assert(geometry.submitHeight >= 44 && geometry.submitBelowFields);
    await page.screenshot({ path: resolve(output, `login-${width}.png`), fullPage: true });
  }
  await page.getByLabel('Username', { exact: true }).fill('invalid-ui-check');
  await page.getByLabel('Password', { exact: true }).fill('not-a-real-password');
  await page.getByRole('button', { name: 'Show password', exact: true }).click();
  assert.equal(await page.getByLabel('Password', { exact: true }).getAttribute('type'), 'text');
  await page.getByRole('button', { name: 'Hide password', exact: true }).click();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /username or password is incorrect/);
  await page.getByRole('button', { name: 'Administrator sign in', exact: true }).click();
  assert.equal(await page.getByLabel('Owner key', { exact: true }).inputValue(), '');
  assert.equal(await page.getByRole('alert').count(), 0);
  await page.getByLabel('Owner key', { exact: true }).fill((await readFile(keyFile, 'utf8')).trim());
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('heading', { name: 'Welcome back' }).waitFor();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ responsiveWidths: [705,1440,375,320], visibleControls: true, invalidLogin: true, passwordReveal: true, administratorLogin: true, logout: true, pageErrors: errors, screenshots: output }));
} finally { await browser.close(); }
