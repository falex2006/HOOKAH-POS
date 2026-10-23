import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const playwrightPath = process.env.PLAYWRIGHT_PACKAGE_PATH;
if (!playwrightPath) throw new Error('Set PLAYWRIGHT_PACKAGE_PATH');
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const child = spawn(process.execPath, ['server.js'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true,
  env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: '', AUTH_REQUIRED: 'false', DEMO_MODE: 'false', NODE_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });
let browser;
try {
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Staff drawer QA server did not start: ${output}`)), 15000);
    child.once('error', reject);
    child.stdout.on('data', () => {
      const match = output.match(/CRM running on http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 320, height: 500 }, locale: 'ru-RU' });
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-username').fill('admin');
  await page.locator('#login-password').fill('admin');
  await page.locator('#login-form button[type="submit"]').click();
  await page.waitForURL(url => !url.pathname.includes('/login'));
  await page.route('**/api/staff', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }));
  await page.goto(`${base}/admin#staff`, { waitUntil: 'networkidle' });
  const screenshotDir = fileURLToPath(new URL('../docs/ai-team/responsive-emulator/', import.meta.url));
  await mkdir(screenshotDir, { recursive: true });
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 500 });
    await page.locator('.staff-add-button').click();
    const panel = page.locator('.staff-drawer-panel');
    await panel.evaluate(node => { node.scrollTop = node.scrollHeight; });
    const geometry = await page.locator('.staff-drawer-close').evaluate(node => {
      const rect = node.getBoundingClientRect();
      const panelRect = node.closest('.staff-drawer-panel').getBoundingClientRect();
      return {
        position: getComputedStyle(node.closest('.staff-drawer-head')).position,
        top: rect.top,
        bottom: rect.bottom,
        panelTop: panelRect.top,
        panelBottom: panelRect.bottom,
        visible: rect.bottom > panelRect.top && rect.top < panelRect.bottom,
        fits: rect.top >= panelRect.top - 1 && rect.bottom <= panelRect.bottom + 1,
      };
    });
    assert.equal(geometry.position, 'sticky', `header sticks at ${width}px`);
    assert.equal(geometry.visible, true, `close button stays visible at ${width}px: ${JSON.stringify(geometry)}`);
    assert.equal(geometry.fits, true, `close button stays inside the drawer at ${width}px: ${JSON.stringify(geometry)}`);
    if ([320, 1440].includes(width)) await page.screenshot({ path: path.join(screenshotDir, `staff-drawer-sticky-${width}.png`) });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.staff-drawer').getAttribute('aria-hidden'), 'true');
  }
  console.log('STAFF DRAWER STICKY BROWSER QA: PASS (close remains visible while scrolling at 320, 768, and 1440px)');
} finally {
  await browser?.close();
  child.kill();
  if (child.exitCode === null) await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]);
}
