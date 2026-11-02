import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { startFixture } from './fixture-server.mjs';
import { releaseSmoke } from './release-smoke.mjs';
import { beyondTrustSmoke } from './beyondtrust-smoke.mjs';
import { newProfilesSmoke } from './newprofiles-smoke.mjs';

// Browser plugin not available. All browser work uses a disposable Playwright profile.
// The temporary copy gets loopback-only host access to automate script injection.
// The release manifest is unchanged; Chrome's permission prompt remains a manual check.
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(path.join(tmpdir(), 'tab-session-keeper-qa-'));
const fixture = await startFixture({ idleMs: 1900, absoluteMs: 60000 });
const second = await startFixture({ idleMs: 60000, absoluteMs: 60000 });
let context;
const errors = [];
const passed = [];
const note = text => { passed.push(text); console.log(`PASS ${text}`); };
try {
  const extensionDir = path.join(temp, 'extension');
  await mkdir(extensionDir);
  for (const filename of ['manifest.json', 'service-worker.js', 'core.js', 'profiles.js', 'i18n.js', 'popup.html', 'popup.js', 'options.html', 'options.js', 'ui.css', 'ui-shared.js', 'icons', '_locales']) {
    try { await cp(path.join(source, filename), path.join(extensionDir, filename), { recursive: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const manifestPath = path.join(extensionDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const profile = path.join(temp, 'profile');
  const launch = () => chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, viewport: { width: 1000, height: 800 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  context = await launch();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  let control = await context.newPage();
  control.on('pageerror', error => errors.push(error.message));
  await control.goto(`chrome-extension://${extensionId}/options.html`);
  let api = payload => control.evaluate(message => chrome.runtime.sendMessage(message), payload);
  const assertOK = result => { assert.equal(result?.ok, true, JSON.stringify(result)); return result; };
  const tabId = page => control.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, page.url());
  const site = await context.newPage();
  await site.goto(`${fixture.origin}/login`);
  await site.goto(`${fixture.origin}/app`);
  await site.locator('#draft').fill('Diese Eingabe muss erhalten bleiben.');
  const loadedAt = await site.locator('#loaded').getAttribute('data-at');
  let selectedId = await tabId(site);
  assert.equal(typeof selectedId, 'number');
  assertOK(await api({ type: 'setTab', tabId: selectedId, enabled: true, intervalMinutes: 1, endpoint: '/heartbeat' }));
  assert.equal(assertOK(await api({ type: 'getState', tabId: selectedId })).effective.enabled, true);
  const controlLogin = await fetch(`${fixture.origin}/login`);
  const controlCookie = controlLogin.headers.get('set-cookie').split(';')[0];
  await controlLogin.text();
  for (let i = 0; i < 4; i++) {
    await sleep(650);
    assertOK(await api({ type: 'testNow', tabId: selectedId }));
    const state = assertOK(await api({ type: 'getState', tabId: selectedId }));
    assert.equal(state.runtime.status, 'success', JSON.stringify(state.runtime));
  }
  assert.equal((await fetch(`${fixture.origin}/heartbeat`, { headers: { Cookie: controlCookie } })).status, 401);
  assert.equal(await site.locator('#draft').inputValue(), 'Diese Eingabe muss erhalten bleiben.');
  assert.equal(await site.locator('#loaded').getAttribute('data-at'), loadedAt);
  note('Injected cookie requests extend idle session, control expires, form and document stay intact');

  const sibling = await context.newPage();
  await sibling.goto(`${fixture.origin}/`);
  const siblingId = await tabId(sibling);
  assert.equal(assertOK(await api({ type: 'getState', tabId: siblingId })).effective.enabled, false);
  note('A second unselected tab remains disabled');

  for (const endpoint of ['/unauthorized', '/forbidden', '/redirect']) {
    assertOK(await api({ type: 'setTab', tabId: selectedId, enabled: true, intervalMinutes: 1, endpoint }));
    await api({ type: 'testNow', tabId: selectedId });
    const state = assertOK(await api({ type: 'getState', tabId: selectedId }));
    assert.equal(state.runtime.status, 'paused', `${endpoint}: ${JSON.stringify(state.runtime)}`);
  }
  note('401, 403, and redirect pause requests');

  assertOK(await api({ type: 'setTab', tabId: selectedId, enabled: true, intervalMinutes: 1, endpoint: '/login-page-200' }));
  assertOK(await api({ type: 'testNow', tabId: selectedId }));
  assert.equal(assertOK(await api({ type: 'getState', tabId: selectedId })).runtime.status, 'success');
  note('HTTP 200 is reported as request success only');

  await site.goto(`${second.origin}/`);
  await sleep(150);
  assert.equal(assertOK(await api({ type: 'getState', tabId: selectedId })).effective.enabled, false);
  note('Cross-origin navigation removes the temporary activation');

  assertOK(await api({ type: 'saveRule', rule: { origin: fixture.origin, enabled: true, intervalMinutes: 1, endpoint: '/heartbeat' } }));
  const ruleState = assertOK(await api({ type: 'getState', tabId: siblingId }));
  assert.equal(ruleState.effective.enabled, true);
  assert.equal(ruleState.effective.source, 'site');
  assertOK(await api({ type: 'setTab', tabId: siblingId, enabled: false }));
  assert.equal(assertOK(await api({ type: 'getState', tabId: siblingId })).effective.enabled, false);
  note('Persistent site rule activates matching tabs; per-tab disable takes precedence');

  // A clean close and launch of the same profile is a real browser restart.
  await context.close(); context = await launch();
  const restartedWorker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  assert.equal(new URL(restartedWorker.url()).host, extensionId);
  control = await context.newPage();
  control.on('pageerror', error => errors.push(error.message));
  await control.goto(`chrome-extension://${extensionId}/options.html`);
  api = payload => control.evaluate(message => chrome.runtime.sendMessage(message), payload);
  const restored = assertOK(await api({ type: 'getState' }));
  assert.equal(restored.rules.some(rule => rule.origin === fixture.origin && rule.enabled), true);
  const newSite = await context.newPage();
  await newSite.goto(`${fixture.origin}/login?idleMs=60000`);
  await newSite.goto(`${fixture.origin}/app`);
  selectedId = await tabId(newSite);
  const resumed = assertOK(await api({ type: 'getState', tabId: selectedId }));
  assert.equal(resumed.effective.enabled, true);
  assert.equal(resumed.effective.source, 'site');
  assertOK(await api({ type: 'testNow', tabId: selectedId }));
  assert.equal(assertOK(await api({ type: 'getState', tabId: selectedId })).runtime.status, 'success');
  note('Actual Chromium restart preserves website rule and auto-activates a newly opened matching tab');

  await control.reload();
  const card = control.locator('.rule-card').filter({ hasText: fixture.origin });
  await card.locator('[name="intervalMinutes"]').fill('2');
  await card.locator('button[type="submit"]').click();
  await control.locator('#page-feedback').waitFor({ state: 'visible' });
  assert.equal(assertOK(await api({ type: 'getState', tabId: selectedId })).effective.intervalMinutes, 2);
  await control.screenshot({ path: path.join(tmpdir(), 'tab-session-keeper-options.png'), fullPage: true });
  await control.setViewportSize({ width: 375, height: 812 });
  await control.screenshot({ path: path.join(tmpdir(), 'tab-session-keeper-options-mobile.png'), fullPage: true });
  assert.equal(await control.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Options fit narrow viewport');
  await control.setViewportSize({ width: 1000, height: 800 });
  await card.locator('.delete-rule').click();
  await control.locator('.rule-card').waitFor({ state: 'detached' });
  assert.equal(assertOK(await api({ type: 'getState', tabId: selectedId })).effective.enabled, false);
  note('Options form edits the actual interval; deleting its rule stops automatic activation');

  await control.bringToFront();
  assert.match(await control.title(), /Keeper|Website|Regeln/i);
  assert.ok((await control.locator('body').innerText()).length > 80);
  const popup = await context.newPage();
  popup.on('pageerror', error => errors.push(error.message));
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${selectedId}`);
  await popup.locator('#tab-origin').filter({ hasText: fixture.origin }).waitFor();
  assert.equal(await popup.locator('#tab-origin').innerText(), fixture.origin);
  assert.equal(errors.length, 0, errors.join('\n'));
  note('Popup/options render meaningful content without page errors; screenshots saved outside source');
  console.log(`\n${passed.length} browser scenarios passed. Permission prompts and real OS sleep need manual checking.`);
} finally {
  if (context) await context.close();
  await Promise.all([fixture.close(), second.close()]);
  await rm(temp, { recursive: true, force: true });
}
await releaseSmoke(source);
await beyondTrustSmoke(source);
await newProfilesSmoke(source);
