import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { startFixture } from './fixture-server.mjs';

/** Local replica of an activity-based session, not a live customer console. */
export async function beyondTrustSmoke(source) {
  const temp = await mkdtemp(path.join(tmpdir(), 'keeper-activity-qa-'));
  const fixture = await startFixture({ idleMs: 60000, btIdleMs: 2000, absoluteMs: 120000, activityThrottleMs: 200 });
  let context;
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
    const launch = () => chromium.launchPersistentContext(path.join(temp, 'profile'), {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
    });
    context = await launch();
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    let control = await context.newPage();
    await control.goto(`chrome-extension://${extensionId}/options.html`);
    let api = request => control.evaluate(message => chrome.runtime.sendMessage(message), request);
    const ok = result => { assert.equal(result?.ok, true, JSON.stringify(result)); return result; };
    const idOf = page => control.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, page.url());
    async function waitState(tabId, predicate) {
      let state;
      for (let tries = 0; tries < 100; tries++) {
        state = ok(await api({ type: 'getState', tabId }));
        if (predicate(state)) return state;
        await sleep(100);
      }
      throw new Error(`Activity state did not settle: ${JSON.stringify(state)}`);
    }

    const site = await context.newPage();
    await site.goto(`${fixture.origin}/login`);
    await site.goto(`${fixture.origin}/console`);
    await site.locator('#draft').fill('Kein Neuladen und keine Eingabe an die Fernsteuerung.');
    const loadedAt = await site.locator('#loaded').getAttribute('data-at');
    let tabId = await idOf(site);
    ok(await api({ type: 'setTab', tabId, enabled: true, intervalMinutes: 5, endpoint: '' }));
    const first = await waitState(tabId, state => state.runtime.method === 'activity' && state.runtime.status === 'success');
    assert.equal(first.runtime.profile, 'beyondtrust');
    assert.equal(first.effective.intervalMinutes, 5, 'User configuration remains visible');
    const alarm = await control.evaluate(async tabId => chrome.alarms.get(`keeper-tab:${tabId}`), tabId);
    assert.equal(alarm.periodInMinutes, 1, 'Detected activity profile is scheduled at most one minute apart');
    assert.equal(await control.evaluate(id=>chrome.action.getBadgeText({tabId:id}),tabId),'On');
    await site.waitForFunction(() => window.fixtureActivity.accepted > 0);
    console.log('PASS Activity adapter immediately reaches MAIN-world window handler from ISOLATED world; detected schedule is one minute');

    const oldLogin = await fetch(`${fixture.origin}/login`);
    const controlCookie = oldLogin.headers.get('set-cookie').split(';')[0];
    await oldLogin.text();
    for (let i = 0; i < 5; i++) {
      await sleep(500);
      assert.equal((await fetch(`${fixture.origin}/console`, { headers: { Cookie: controlCookie } })).status, 200);
      ok(await api({ type: 'testNow', tabId }));
    }
    await site.waitForFunction(() => window.fixtureActivity.accepted >= 5);
    assert.equal((await fetch(`${fixture.origin}/bt-status`, { headers: { Cookie: controlCookie } })).status, 401, 'Old static GET approach lets the control activity session expire');
    assert.equal(await site.evaluate(async () => (await fetch('/bt-status')).status), 204, 'Activity adapter keeps selected activity session alive');
    const activity = await site.evaluate(() => window.fixtureActivity);
    assert.equal(activity.canvasMoves, 0);
    assert.equal(activity.canvasClicks, 0);
    assert.equal(activity.canvasKeys, 0);
    assert.equal(await site.locator('#draft').inputValue(), 'Kein Neuladen und keine Eingabe an die Fernsteuerung.');
    assert.equal(await site.locator('#loaded').getAttribute('data-at'), loadedAt);
    console.log('PASS Repeated static HTTP 200 does not keep control alive; activity does, without canvas mouse/click/key input or lost form state');

    const popup = await context.newPage();
    await popup.setViewportSize({ width: 400, height: 600 });
    await popup.emulateMedia({ reducedMotion: 'reduce' });
    await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
    await popup.locator('#method-summary').filter({ hasText: 'BeyondTrust' }).waitFor();
    assert.equal(await popup.locator('#tab-enabled').isChecked(), true);
    assert.equal((await popup.locator('#last-attempt').innerText()).includes('HTTP'), false);
    await popup.evaluate(async () => {
      for (const animation of document.getAnimations()) { try { animation.finish(); } catch {} }
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await popup.screenshot({ path: path.join(tmpdir(), 'tab-session-keeper-beyondtrust-popup.png'), fullPage: false });
    await popup.close();
    console.log('PASS 400×600 popup shows BeyondTrust activity and actual one-minute cadence without an HTTP result');

    const beforeMoves = await site.evaluate(() => window.fixtureActivity.windowMoves);
    ok(await api({ type: 'setTab', tabId, enabled: true, intervalMinutes: 5, endpoint: '/console' }));
    await waitState(tabId, state => state.runtime.method === 'request' && state.runtime.status === 'success');
    assert.equal(await site.evaluate(() => window.fixtureActivity.windowMoves), beforeMoves);
    console.log('PASS Explicit endpoint retains ordinary HTTP method and does not dispatch activity');

    await site.evaluate(() => document.querySelector('bt-app-header-menu').remove());
    const beforeBootstrap = await site.evaluate(() => window.fixtureActivity.windowMoves);
    ok(await api({ type: 'setTab', tabId, enabled: true, intervalMinutes: 5, endpoint: '' }));
    await waitState(tabId, state => state.runtime.status === 'waiting');
    assert.equal(await control.evaluate(id=>chrome.action.getBadgeText({tabId:id}),tabId),'On');
    assert.equal(await site.evaluate(() => window.fixtureActivity.windowMoves), beforeBootstrap);
    await site.evaluate(() => document.querySelector('bt-app-component').append(document.createElement('bt-app-header-menu')));
    ok(await api({ type: 'testNow', tabId }));
    await waitState(tabId, state => state.runtime.method === 'activity' && state.runtime.status === 'success');
    assert.ok(await site.evaluate(before => window.fixtureActivity.windowMoves > before, beforeBootstrap));
    console.log('PASS Console bootstrap without header/login waits; header appearing allows the next activity attempt');

    await site.evaluate(() => {
      document.querySelector('bt-app-header-menu').remove();
      document.querySelector('bt-app-component').append(document.createElement('bt-login-view'));
    });
    const beforeAuthMissing = await site.evaluate(() => window.fixtureActivity.windowMoves);
    ok(await api({ type: 'setTab', tabId, enabled: true, intervalMinutes: 5, endpoint: '' }));
    ok(await api({ type: 'testNow', tabId }));
    await waitState(tabId, state => state.runtime.status === 'paused');
    assert.equal(await site.evaluate(() => window.fixtureActivity.windowMoves), beforeAuthMissing);
    console.log('PASS Missing authenticated header/login view pauses activity without dispatching another event');

    ok(await api({ type: 'saveRule', tabId, rule: { origin: fixture.origin, enabled: true, intervalMinutes: 5, endpoint: '' } }));
    await context.close();
    context = await launch();
    const restarted = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    assert.equal(new URL(restarted.url()).host, extensionId);
    control = await context.newPage();
    await control.goto(`chrome-extension://${extensionId}/options.html`);
    api = request => control.evaluate(message => chrome.runtime.sendMessage(message), request);
    const restored = ok(await api({ type: 'getState' }));
    assert.equal(restored.rules.some(rule => rule.origin === fixture.origin && rule.enabled && !rule.endpoint), true);
    const reopened = await context.newPage();
    await reopened.goto(`${fixture.origin}/login`);
    await reopened.goto(`${fixture.origin}/console`);
    tabId = await idOf(reopened);
    const resumed = await waitState(tabId, state => state.runtime.method === 'activity' && state.runtime.status === 'success');
    assert.equal(resumed.effective.source, 'site');
    await reopened.waitForFunction(() => window.fixtureActivity.accepted > 0);
    const resumedAlarm = await control.evaluate(async tabId => chrome.alarms.get(`keeper-tab:${tabId}`), tabId);
    assert.equal(resumedAlarm.periodInMinutes, 1);
    console.log('PASS Restart preserves default-endpoint site rule; navigation from login into console promptly detects activity and renews it');
  } finally {
    await context?.close();
    await fixture.close();
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await beyondTrustSmoke(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
}
