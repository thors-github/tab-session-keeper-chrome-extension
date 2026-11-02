import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { startFixture } from './fixture-server.mjs';

// Real production manifest, no added host permissions. The DevTools action command
// is equivalent to invoking the toolbar action on the selected browser tab.
export async function releaseSmoke(extensionDir) {
  const profile = await mkdtemp(path.join(tmpdir(), 'keeper-release-qa-'));
  const fixture = await startFixture({ idleMs: 60000, absoluteMs: 120000 });
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true,
      args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    const site = await context.newPage();
    await site.goto(`${fixture.origin}/login`);
    await site.goto(`${fixture.origin}/app`);
    await site.locator('#draft').fill('Auch ohne dauerhafte Berechtigung erhalten.');
    await site.bringToFront();
    const browserCDP = await context.browser().newBrowserCDPSession();
    const { targetInfos } = await browserCDP.send('Target.getTargets', { filter: [{ type: 'tab' }] });
    const tabTarget = targetInfos.find(target => target.url === site.url());
    assert.ok(tabTarget, 'Fixture browser tab target exists');
    await browserCDP.send('Extensions.triggerAction', { id: extensionId, targetId: tabTarget.targetId });
    let popupTarget;
    for (let tries = 0; tries < 30 && !popupTarget; tries++) {
      const targets = await browserCDP.send('Target.getTargets');
      popupTarget = targets.targetInfos.find(target => target.url === `chrome-extension://${extensionId}/popup.html`);
      if (!popupTarget) await sleep(100);
    }
    assert.ok(popupTarget, 'Toolbar popup target opens');
    const { sessionId } = await browserCDP.send('Target.attachToTarget', { targetId: popupTarget.targetId, flatten: false });
    let sequence = 0;
    const pending = new Map();
    browserCDP.on('Target.receivedMessageFromTarget', event => {
      if (event.sessionId !== sessionId) return;
      const message = JSON.parse(event.message);
      if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
    });
    async function command(method, params = {}) {
      const id = ++sequence;
      let timeout;
      const response = new Promise((resolve, reject) => {
        timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Popup CDP timeout: ${method}`)); }, 10000);
        pending.set(id, resolve);
      });
      await browserCDP.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) });
      const message = await response.finally(() => clearTimeout(timeout));
      assert.ok(!message.error, JSON.stringify(message.error));
      return message.result;
    }
    async function evaluate(expression, userGesture = false) {
      const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture });
      assert.ok(!response.exceptionDetails, JSON.stringify(response.exceptionDetails));
      return response.result?.value;
    }
    async function until(expression) {
      for (let tries = 0; tries < 50; tries++) {
        if (await evaluate(expression)) return;
        await sleep(100);
      }
      throw new Error(`Popup state did not settle: ${expression}`);
    }
    await until("document.querySelector('#tab-enabled') && !document.querySelector('#tab-enabled').disabled");
    assert.equal(await evaluate("chrome.permissions.contains({origins:['http://127.0.0.1/*']})"), false);
    await evaluate("document.querySelector('#tab-enabled').click()", true);
    await until("document.querySelector('#tab-enabled').checked && !document.querySelector('#test-now').disabled");
    await evaluate("document.querySelector('details.settings-panel').open=true; document.querySelector('#interval').value='1'; document.querySelector('#endpoint').value='/heartbeat'; document.querySelector('#interval').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#settings-form').requestSubmit()", true);
    await until("!document.querySelector('#test-now').disabled");
    await evaluate("document.querySelector('#test-now').click()", true);
    await until("document.querySelector('#status-box').dataset.status==='success' && !document.querySelector('#test-now').disabled");
    assert.match(await evaluate("document.querySelector('#keeper-logo').getAttribute('src')"),/on128\.png$/);
    assert.equal(await evaluate("chrome.tabs.query({active:true,currentWindow:true}).then(tabs=>chrome.action.getBadgeText({tabId:tabs[0].id}))"),'On');
    assert.equal(await site.locator('#draft').inputValue(), 'Auch ohne dauerhafte Berechtigung erhalten.');
    assert.equal(await evaluate("chrome.permissions.contains({origins:['http://127.0.0.1/*']})"), false);
    await evaluate("document.querySelector('details.settings-panel').open=false");
    const image = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path.join(tmpdir(), 'tab-session-keeper-popup.png'), Buffer.from(image.data, 'base64'));
    console.log('PASS Production manifest: real toolbar action grants activeTab; popup toggle, settings, and test request work without host permission');
    await evaluate("document.querySelector('#tab-enabled').click()", true);
    await until("!document.querySelector('#tab-enabled').checked && !document.querySelector('#tab-enabled').disabled");
    assert.match(await evaluate("document.querySelector('#keeper-logo').getAttribute('src')"),/off128\.png$/);
    assert.equal(await evaluate("chrome.tabs.query({active:true,currentWindow:true}).then(tabs=>chrome.action.getBadgeText({tabId:tabs[0].id}))"),'');
    console.log('PASS Production popup: disable stops temporary activation');

    const control = await context.newPage();
    await control.goto(`chrome-extension://${extensionId}/options.html`);
    const selectedId = await control.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, site.url());
    assert.equal(typeof selectedId, 'number');
    const activated = await control.evaluate(tabId => chrome.runtime.sendMessage({ type: 'setTab', tabId, enabled: true, intervalMinutes: 1, endpoint: '/heartbeat' }), selectedId);
    assert.equal(activated.ok, true);
    const lifecycle = await context.newCDPSession(control);
    const versions = [];
    lifecycle.on('ServiceWorker.workerVersionUpdated', event => versions.push(...event.versions));
    await lifecycle.send('ServiceWorker.enable');
    // Shorten only the test alarm's first deadline; production remains one minute.
    await control.evaluate(tabId => chrome.alarms.create(`keeper-tab:${tabId}`, { when: Date.now() + 5000, periodInMinutes: 1 }), selectedId);
    const before = fixture.requests.filter(request => request.path === '/heartbeat').length;
    await lifecycle.send('ServiceWorker.stopAllWorkers');
    for (let tries = 0; tries < 100 && fixture.requests.filter(request => request.path === '/heartbeat').length === before; tries++) await sleep(100);
    assert.ok(versions.some(version => version.scriptURL === worker.url() && version.runningStatus === 'stopped'), 'Worker was actually stopped before the alarm');
    assert.ok(fixture.requests.filter(request => request.path === '/heartbeat').length > before, 'Alarm wakes worker and sends request without a UI command');
    const resumed = await control.evaluate(tabId => chrome.runtime.sendMessage({ type: 'getState', tabId }), selectedId);
    assert.equal(resumed.effective.enabled, true);
    assert.equal(resumed.runtime.status, 'success');
    console.log('PASS Actual alarm wakes a stopped extension worker, preserves temporary settings, and sends a successful heartbeat');
  } finally {
    await context?.close();
    await fixture.close();
    await rm(profile, { recursive: true, force: true });
  }
}
