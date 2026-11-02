import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createKeeper} from '../service-worker.js';
import {pageOrigin, normalizeEndpoint, normalizeRule, permissionPattern, classifyResult, sendHeartbeat, indicatorState, normalizeRuntime} from '../core.js';

const clone = value => structuredClone(value);
const catalogs = Object.fromEntries(await Promise.all(['en', 'de'].map(async locale => [locale,
  JSON.parse(await readFile(new URL(`../_locales/${locale}/messages.json`, import.meta.url), 'utf8'))])));
function pageDocument(querySelector = () => null) {
  const attributes = new Map();
  return {readyState: 'complete', querySelector, querySelectorAll: () => [], documentElement: {
    getAttribute: key => attributes.get(key) ?? null, hasAttribute: key => attributes.has(key),
    setAttribute: (key, value) => attributes.set(key, value), removeAttribute: key => attributes.delete(key),
  }};
}
function fixture({language = 'en-US'} = {}) {
  let time = 1000000;
  const data = {local: {}, session: {}};
  const tabs = new Map([
    [1, {id: 1, url: 'https://example.com/app#edit', title: 'Beispiel', status: 'complete', autoDiscardable: true, active: true}],
    [2, {id: 2, url: 'https://example.com/other', title: 'Anderer Tab', status: 'complete', autoDiscardable: false, active: false}],
  ]);
  const alarms = new Map();
  const grants = new Set();
  const calls = [];
  const icons = new Map();
  const badges = new Map();
  const probes = [];
  let detectedProfile = null;
  let execution = async () => [{result: {kind: 'http', status: 200}}];
  const event = () => ({listeners: [], addListener(listener) { this.listeners.push(listener); }});
  const area = name => ({
    async get(key) { return {[key]: clone(data[name][key])}; },
    async set(value) { Object.assign(data[name], clone(value)); },
    async setAccessLevel() {},
  });
  const api = {
    i18n: {
      getUILanguage: () => language,
      getMessage(key, substitutions = []) {
        const catalog = /^de(?:-|_|$)/i.test(language) ? catalogs.de : catalogs.en;
        const entry = catalog[key] || catalogs.en[key];
        if (!entry) return '';
        return entry.message.replace(/\$([a-z]\w*)\$/gi, (_match, name) => {
          const content = entry.placeholders?.[name.toLowerCase()]?.content || '';
          return content.replace(/\$(\d+)/g, (_placeholder, number) => String(substitutions[Number(number) - 1] ?? ''));
        });
      },
    },
    storage: {local: area('local'), session: area('session')},
    tabs: {
      async get(id) { if (!tabs.has(id)) throw new Error('No tab'); return clone(tabs.get(id)); },
      async query(query) { return clone([...tabs.values()].filter(tab => !query.active || tab.active)); },
      async update(id, value) { Object.assign(tabs.get(id), value); return clone(tabs.get(id)); },
      onCreated: event(), onUpdated: event(), onRemoved: event(), onReplaced: event(),
    },
    permissions: {async contains({origins}) { return origins.every(origin => grants.has(origin)); }, onAdded: event(), onRemoved: event()},
    alarms: {
      async create(name, options) { alarms.set(name, {name, ...options, scheduledTime: time + options.periodInMinutes * 60000}); },
      async get(name) { return clone(alarms.get(name)); },
      async getAll() { return clone([...alarms.values()]); },
      async clear(name) { return alarms.delete(name); }, onAlarm: event(),
    },
    scripting: {async executeScript(options) {
      if (options.args[3]) {
        probes.push(options);
        return [{result: {kind: 'detected', profile: detectedProfile || (new URL(tabs.get(options.target.tabId).url).pathname.startsWith('/console') ? 'beyondtrust' : 'generic')}}];
      }
      calls.push(options); return execution(options);
    }},
    action: {async setIcon(value) { icons.set(value.tabId, value.path); }, async setBadgeText(value) { badges.set(value.tabId, value.text); }, async setBadgeBackgroundColor() {}, async setTitle() {}},
    runtime: {id: 'test', getURL: path => `chrome-extension://test/${path}`, onMessage: event(), onStartup: event(), onInstalled: event()},
  };
  return {api, tabs, alarms, grants, data, calls, icons, badges, probes, detect: value => { detectedProfile = value; }, keeper: createKeeper(api, {now: () => time}),
    tick: value => { time += value; }, execute: value => { execution = value; }};
}

test('normalization rejects foreign endpoints and credentials; exact origin retains ports', () => {
  assert.equal(pageOrigin('https://example.com:8443/a'), 'https://example.com:8443');
  assert.equal(pageOrigin('https://name:secret@example.com'), null);
  assert.equal(normalizeEndpoint('/heartbeat#top', 'https://example.com'), 'https://example.com/heartbeat');
  assert.throws(() => normalizeEndpoint('https://other.example/heartbeat', 'https://example.com'));
  assert.throws(() => normalizeEndpoint('//other.example/heartbeat', 'https://example.com'));
  assert.throws(() => normalizeRule({origin: 'https://example.com/path'}));
  assert.throws(() => normalizeRule({origin: 'https://example.com', intervalMinutes: 0.5}));
  assert.equal(permissionPattern('https://example.com:8443'), 'https://example.com/*');
});

test('temporary activation sends only in its selected tab and restores discard state', async () => {
  const f = fixture();
  assert.equal((await f.keeper.message({type: 'setTab', tabId: 1, enabled: true, intervalMinutes: 1})).ok, true);
  assert.equal(f.tabs.get(1).autoDiscardable, false);
  assert.equal(f.alarms.size, 1);
  await f.keeper.runTab(1);
  await f.keeper.runTab(2);
  assert.deepEqual(f.calls.map(call => call.target.tabId), [1, 1]);
  assert.equal(f.calls[0].world, 'ISOLATED');
  assert.equal((await f.keeper.message({type: 'getState', tabId: 1})).runtime.status, 'success');
  await f.keeper.message({type: 'setTab', tabId: 1, enabled: false});
  assert.equal(f.alarms.size, 0);
  assert.equal(f.tabs.get(1).autoDiscardable, true);
  await f.keeper.runTab(1);
  assert.equal(f.calls.length, 2);
});

test('site rules require permission, survive restart, and apply only exact origin', async () => {
  const f = fixture();
  const rule = {origin: 'https://example.com', enabled: true, intervalMinutes: 3, endpoint: '/heartbeat'};
  assert.equal((await f.keeper.message({type: 'saveRule', rule})).ok, false);
  f.grants.add('https://example.com/*');
  assert.equal((await f.keeper.message({type: 'saveRule', rule})).ok, true);
  assert.equal(f.alarms.size, 2);
  f.data.session = {}; // A real Chrome restart clears session storage and tab IDs can change.
  f.tabs.clear();
  f.tabs.set(21, {id: 21, url: 'https://example.com/reopened', status: 'complete', autoDiscardable: true});
  f.tabs.set(22, {id: 22, url: 'https://example.com:8443/reopened', status: 'complete', autoDiscardable: true});
  f.tabs.set(23, {id: 23, url: 'https://sub.example.com/', status: 'complete', autoDiscardable: true});
  const restarted = createKeeper(f.api);
  await restarted.init();
  assert.deepEqual([...f.alarms.keys()], ['keeper-tab:21']);
  await restarted.runTab(21);
  assert.equal(f.calls[0].args[1], 'https://example.com/heartbeat');
  assert.equal((await restarted.message({type: 'getState', tabId: 21})).effective.source, 'site');
});

test('tab exception wins over remembered rule, can be cleared, and rule deletion preserves manual activation', async () => {
  const f = fixture();
  f.grants.add('https://example.com/*');
  await f.keeper.message({type: 'saveRule', rule: {origin: 'https://example.com'}});
  await f.keeper.message({type: 'setTab', tabId: 1, enabled: false});
  await f.keeper.reconcile();
  let state = await f.keeper.message({type: 'getState', tabId: 1});
  assert.equal(state.effective.enabled, false);
  assert.equal(state.effective.hasOverride, true);
  await f.keeper.message({type: 'clearTabOverride', tabId: 1});
  state = await f.keeper.message({type: 'getState', tabId: 1});
  assert.equal(state.effective.source, 'site');
  assert.equal(state.effective.hasOverride, false);
  await f.keeper.message({type: 'setTab', tabId: 1, enabled: true});
  await f.keeper.message({type: 'deleteRule', origin: 'https://example.com'});
  assert.deepEqual([...f.alarms.keys()], ['keeper-tab:1']);
  assert.equal(f.tabs.get(2).autoDiscardable, false);
});

test('saving website rule atomically clears only that tab override', async () => {
  const f = fixture();
  f.grants.add('https://example.com/*');
  await f.keeper.message({type: 'setTab', tabId: 1, enabled: false});
  await f.keeper.message({type: 'setTab', tabId: 2, enabled: false});
  await f.keeper.message({type: 'saveRule', tabId: 1, rule: {origin: 'https://example.com'}});
  assert.equal((await f.keeper.message({type: 'getState', tabId: 1})).effective.source, 'site');
  assert.equal((await f.keeper.message({type: 'getState', tabId: 2})).effective.enabled, false);
});

test('temporary selection survives worker restart and same-origin navigation but ends across origin', async () => {
  const f = fixture();
  await f.keeper.message({type: 'setTab', tabId: 1, enabled: true});
  f.tabs.get(1).url = 'https://example.com/next';
  const freshWorker = createKeeper(f.api);
  await freshWorker.init();
  assert.equal((await freshWorker.message({type: 'getState', tabId: 1})).effective.enabled, true);
  f.tabs.get(1).url = 'https://other.example/';
  await freshWorker.reconcile();
  assert.equal((await freshWorker.message({type: 'getState', tabId: 1})).effective.enabled, false);
  assert.equal(f.tabs.get(1).autoDiscardable, true);
  assert.equal(f.data.session.keeperTabs['1'], undefined);
});

test('auth failures pause until explicit resume, while HTTP 200 does not promise authentication', async () => {
  const f = fixture();
  await f.keeper.message({type: 'setTab', tabId: 1, enabled: true});
  f.execute(async () => [{result: {kind: 'http', status: 401}}]);
  await f.keeper.runTab(1);
  assert.equal(f.alarms.size, 0);
  assert.equal((await f.keeper.message({type: 'getState', tabId: 1})).runtime.status, 'paused');
  assert.equal((await f.keeper.message({type: 'testNow', tabId: 1})).ok, false);
  f.execute(async () => [{result: {kind: 'http', status: 200}}]);
  await f.keeper.message({type: 'resumeTab', tabId: 1});
  assert.equal(f.alarms.size, 1);
  f.execute(async () => [{result: {kind: 'http', status: 200}}]);
  await f.keeper.runTab(1);
  const state = await f.keeper.message({type: 'getState', tabId: 1});
  assert.equal(state.runtime.messageKey, 'runtimeHttpSuccess');
});

test('permissions loss pauses a site rule and restoration resumes it', async () => {
  const f = fixture();
  f.grants.add('https://example.com/*');
  await f.keeper.message({type: 'saveRule', rule: {origin: 'https://example.com'}});
  f.grants.clear();
  await f.keeper.reconcile();
  assert.equal(f.alarms.size, 0);
  assert.equal(f.tabs.get(1).autoDiscardable, true);
  assert.equal((await f.keeper.message({type: 'getState', tabId: 1})).runtime.status, 'permission');
  assert.equal(f.data.local.keeperRules.length, 1);
  f.grants.add('https://example.com/*');
  await f.keeper.reconcile();
  assert.equal(f.alarms.size, 2);
});

test('revoking a grant with hidden tab URL preserves rule and blocks stale in-flight results', async () => {
  const f = fixture();
  f.grants.add('https://example.com/*');
  await f.keeper.message({type: 'saveRule', rule: {origin: 'https://example.com'}});
  let finish;
  let started;
  const running = new Promise(resolve => { started = resolve; });
  f.execute(() => { started(); return new Promise(resolve => { finish = resolve; }); });
  const pending = f.keeper.runTab(1);
  await running;
  f.grants.clear();
  // First revoke while URL is still visible: even that branch must invalidate the claim.
  await f.keeper.reconcile();
  finish([{result: {kind: 'http', status: 200}}]);
  await pending;
  assert.equal((await f.keeper.message({type: 'getState', tabId: 1})).runtime.status, 'permission');
  delete f.tabs.get(1).url;
  await f.keeper.reconcile();
  assert.equal(f.data.session.keeperTabs[1].runtime.status, 'permission');
  assert.equal(f.data.local.keeperRules.length, 1);
  assert.equal(f.alarms.size, 0);
  assert.equal(f.tabs.get(1).autoDiscardable, true);
});

test('discarded/frozen/loading tabs wait without forced reload and resume when loaded', async () => {
  const f = fixture();
  f.tabs.get(1).discarded = true;
  await f.keeper.message({type: 'setTab', tabId: 1, enabled: true});
  await f.keeper.runTab(1);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.keeper.message({type: 'getState', tabId: 1})).runtime.status, 'waiting');
  f.tabs.get(1).discarded = false;
  await f.keeper.reconcile();
  await f.keeper.runTab(1);
  assert.equal(f.calls.length, 1);
});

test('in-flight guard prevents overlap and ignores a late result after disable', async () => {
  const f = fixture();
  await f.keeper.message({type: 'setTab', tabId: 1, enabled: true});
  let finish;
  let started;
  const running = new Promise(resolve => { started = resolve; });
  f.execute(() => { started(); return new Promise(resolve => { finish = resolve; }); });
  const first = f.keeper.runTab(1);
  await running;
  await f.keeper.runTab(1);
  assert.equal(f.calls.length, 2);
  await f.keeper.message({type: 'setTab', tabId: 1, enabled: false});
  finish([{result: {kind: 'http', status: 200}}]);
  await first;
  const state = await f.keeper.message({type: 'getState', tabId: 1});
  assert.equal(state.effective.enabled, false);
  assert.equal(state.runtime.status, 'idle');
});

test('network and redirect results have truthful distinct statuses', () => {
  assert.equal(classifyResult({kind: 'redirect'}).status, 'paused');
  assert.equal(classifyResult({kind: 'timeout'}).status, 'error');
  assert.equal(classifyResult({kind: 'http', status: 500}).httpStatus, 500);
});

test('getState is read-only and repeated reconciliation leaves disabled overrides stable', async () => {
  const f = fixture();
  await f.keeper.message({type: 'setTab', tabId: 1, enabled: false});
  const stored = clone(f.data);
  await f.keeper.message({type: 'getState', tabId: 1});
  await f.keeper.message({type: 'getState', tabId: 1});
  await f.keeper.reconcile();
  await f.keeper.reconcile();
  assert.deepEqual(f.data, stored);
});

test('manual testing reports the real existing periodic alarm deadline', async () => {
  const f = fixture();
  await f.keeper.message({type: 'setTab', tabId: 1, enabled: true, intervalMinutes: 1});
  const deadline = f.alarms.get('keeper-tab:1').scheduledTime;
  f.tick(30000);
  await f.keeper.message({type: 'testNow', tabId: 1});
  const state = await f.keeper.message({type: 'getState', tabId: 1});
  assert.equal(state.runtime.nextAttemptAt, deadline);
});

test('runtime messages accept own extension options tab and reject web content senders', async () => {
  const f = fixture();
  f.keeper.register();
  await f.keeper.init();
  const listener = f.api.runtime.onMessage.listeners[0];
  const trusted = await new Promise(resolve => {
    assert.equal(listener({type: 'getState'}, {id: 'test', url: 'chrome-extension://test/options.html', tab: {id: 8}}, resolve), true);
  });
  assert.equal(trusted.ok, true);
  const untrusted = await new Promise(resolve => {
    assert.equal(listener({type: 'getState'}, {id: 'test', url: 'https://example.com/', tab: {id: 1}}, resolve), false);
  });
  assert.equal(untrusted.ok, false);
});

test('injected heartbeat uses page cookie context, strips hash, discards body, and refuses origin races', async () => {
  const original = {location: globalThis.location, document: globalThis.document, fetch: globalThis.fetch};
  globalThis.location = {origin: 'https://example.com', href: 'https://example.com/app?view=1#edit'};
  globalThis.document = pageDocument();
  let called = 0;
  globalThis.fetch = async (url, options) => {
    called++;
    assert.equal(url, 'https://example.com/app?view=1');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.cache, 'no-store');
    return {status: 200, type: 'basic', body: {async cancel() {}}};
  };
  try {
    assert.deepEqual(await sendHeartbeat('https://example.com', ''), {kind: 'http', profile: 'generic', method: 'request', status: 200});
    assert.deepEqual(await sendHeartbeat('https://other.example', ''), {kind: 'waiting', profile: 'generic', method: 'request'});
    assert.equal(called, 1);
  } finally {
    globalThis.fetch = original.fetch;
    for (const key of ['location', 'document']) {
      if (original[key] === undefined) delete globalThis[key]; else globalThis[key] = original[key];
    }
  }
});

test('isolated-page lock prevents overlap across configuration generations', async () => {
  const f = fixture();
  await f.keeper.message({type: 'setTab', tabId: 1, enabled: true});
  const original = {location: globalThis.location, document: globalThis.document, fetch: globalThis.fetch};
  globalThis.location = {origin: 'https://example.com', href: 'https://example.com/app'};
  globalThis.document = pageDocument();
  let finish;
  let started;
  let networkCalls = 0;
  const running = new Promise(resolve => { started = resolve; });
  globalThis.fetch = async () => {
    networkCalls++;
    started();
    return new Promise(resolve => { finish = () => resolve({status: 200, type: 'basic', body: {async cancel() {}}}); });
  };
  f.execute(async options => [{result: await options.func(...options.args)}]);
  try {
    const pending = f.keeper.runTab(1);
    await running;
    await f.keeper.message({type: 'setTab', tabId: 1, enabled: true, intervalMinutes: 2});
    await f.keeper.runTab(1);
    assert.equal(networkCalls, 1);
    finish();
    await pending;
    assert.equal((await f.keeper.message({type: 'getState', tabId: 1})).runtime.status, 'waiting');
  } finally {
    globalThis.fetch = original.fetch;
    for (const key of ['location', 'document']) {
      if (original[key] === undefined) delete globalThis[key]; else globalThis[key] = original[key];
    }
  }
});

test('activation and explicit resume run immediately; unchanged saves and worker restart preserve history', async () => {
  const f = fixture();
  await f.keeper.message({type: 'setTab', tabId: 1, enabled: true, intervalMinutes: 5, endpoint: '/heartbeat'});
  assert.equal(f.calls.length, 1);
  const first = (await f.keeper.message({type: 'getState', tabId: 1})).runtime;
  await f.keeper.message({type: 'setTab', tabId: 1, enabled: true, intervalMinutes: 5, endpoint: '/heartbeat'});
  assert.equal(f.calls.length, 1);
  assert.deepEqual((await f.keeper.message({type: 'getState', tabId: 1})).runtime, first);
  const restarted = createKeeper(f.api);
  await restarted.init();
  assert.equal(f.calls.length, 1);
  await restarted.message({type: 'resumeTab', tabId: 1});
  assert.equal(f.calls.length, 2);
  assert.equal((await restarted.message({type: 'getState', tabId: 1})).runtime.attempts.length, 2);
});

test('BeyondTrust profile caps actual interval without replacing configured setting and bounds metadata', async () => {
  const f = fixture();
  f.tabs.get(1).url = 'https://example.com/console';
  f.execute(async () => [{result: {kind: 'activity', profile: 'beyondtrust', method: 'activity'}}]);
  await f.keeper.message({type: 'setTab', tabId: 1, enabled: true, intervalMinutes: 5});
  let state = await f.keeper.message({type: 'getState', tabId: 1});
  assert.equal(state.effective.intervalMinutes, 5);
  assert.equal(state.runtime.actualIntervalMinutes, 1);
  assert.equal(f.alarms.get('keeper-tab:1').periodInMinutes, 1);
  assert.equal(state.runtime.method, 'activity');
  assert.equal(state.runtime.httpStatus, null);
  assert.equal(state.runtime.messageKey, 'runtimeActivitySent');
  await f.keeper.reconcile();
  assert.equal(f.calls.length, 1);
  for (let i = 0; i < 12; i++) await f.keeper.runTab(1);
  state = await f.keeper.message({type: 'getState', tabId: 1});
  assert.equal(state.runtime.attempts.length, 10);
  assert.equal(state.runtime.attempts[0].kind, 'activity');
});

test('navigation from generic login page into console rechecks profile immediately once', async () => {
  const f = fixture();
  f.tabs.get(1).url = 'https://example.com/login';
  await f.keeper.message({type: 'setTab', tabId: 1, enabled: true, intervalMinutes: 5});
  assert.equal(f.calls.length, 1);
  f.execute(async () => [{result: {kind: 'activity', profile: 'beyondtrust', method: 'activity'}}]);
  f.tabs.get(1).url = 'https://example.com/console';
  await f.keeper.reconcile({runPending: true, navigationTabId: 1});
  assert.equal(f.calls.length, 2);
  await f.keeper.reconcile({runPending: true});
  assert.equal(f.calls.length, 2);
  assert.equal((await f.keeper.message({type: 'getState', tabId: 1})).runtime.actualIntervalMinutes, 1);
});

test('app bootstrap stays waiting and auth-required pauses with history intact', async () => {
  const f = fixture();
  f.tabs.get(1).url = 'https://example.com/console';
  f.execute(async () => [{result: {kind: 'app-loading', profile: 'beyondtrust', method: 'activity'}}]);
  await f.keeper.message({type: 'setTab', tabId: 1, enabled: true});
  let state = await f.keeper.message({type: 'getState', tabId: 1});
  assert.equal(state.runtime.status, 'waiting');
  assert.equal(state.runtime.waitReason, 'app');
  assert.equal(state.runtime.actualIntervalMinutes, 1);
  await f.keeper.reconcile();
  assert.equal((await f.keeper.message({type: 'getState', tabId: 1})).runtime.status, 'waiting');
  f.execute(async () => [{result: {kind: 'auth-required', profile: 'beyondtrust', method: 'activity'}}]);
  await f.keeper.runTab(1);
  state = await f.keeper.message({type: 'getState', tabId: 1});
  assert.equal(state.runtime.status, 'paused');
  assert.equal(state.runtime.attempts.length, 2);
  assert.equal(f.alarms.size, 0);
});

test('categorized injection and scheduler errors remain visible without leaking raw error URLs', async () => {
  const f = fixture();
  f.execute(async () => { throw new TypeError('Cannot access https://example.com/console?token=secret-token'); });
  await f.keeper.message({type: 'setTab', tabId: 1, enabled: true});
  let state = await f.keeper.message({type: 'getState', tabId: 1});
  assert.equal(state.runtime.status, 'error');
  assert.equal(state.runtime.attempts[0].errorName, 'TypeError');
  assert.equal(state.runtime.attempts[0].errorCode, 'permission');
  assert.doesNotMatch(JSON.stringify(state.runtime), /secret-token|https:/);
  f.api.alarms.create = async () => { throw new Error('private-url'); };
  f.alarms.clear();
  await f.keeper.reconcile();
  state = await f.keeper.message({type: 'getState', tabId: 1});
  assert.equal(state.runtime.messageKey, 'runtimeSchedulerError');
  assert.equal(state.runtime.nextAttemptAt, null);
  assert.doesNotMatch(JSON.stringify(state.runtime), /private-url/);
});

test('BeyondTrust adapter sends a neutral window-only event; login and bootstrap send none; custom endpoint uses GET', async () => {
  const keys = ['location', 'document', 'window', 'MouseEvent', 'fetch'];
  const originals = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  let markers = new Set(['bt-app-component', 'bt-app-header-menu']);
  const signals = [];
  let requests = 0;
  globalThis.location = {origin: 'https://example.com', href: 'https://example.com/console', pathname: '/console'};
  globalThis.document = pageDocument(selector => markers.has(selector) ? {} : null);
  globalThis.window = {dispatchEvent(event) { signals.push(event); return true; }};
  globalThis.MouseEvent = class { constructor(type, options) { this.type = type; Object.assign(this, options); } };
  globalThis.fetch = async () => { requests++; return {status: 204, body: {async cancel() {}}}; };
  try {
    assert.deepEqual(await sendHeartbeat('https://example.com', ''), {kind: 'activity', profile: 'beyondtrust', method: 'activity'});
    assert.equal(signals.length, 1);
    assert.equal(signals[0].type, 'mousemove');
    assert.equal(signals[0].view, globalThis.window);
    assert.equal(signals[0].bubbles, false);
    assert.equal(signals[0].cancelable, false);
    assert.equal(signals[0].buttons, 0);
    assert.equal(requests, 0);
    markers = new Set(['bt-app-component']);
    assert.equal((await sendHeartbeat('https://example.com', '')).kind, 'app-loading');
    markers.add('bt-login-view');
    assert.equal((await sendHeartbeat('https://example.com', '')).kind, 'auth-required');
    assert.equal(signals.length, 1);
    assert.deepEqual(await sendHeartbeat('https://example.com', 'https://example.com/heartbeat'), {kind: 'http', profile: 'generic', method: 'request', status: 204});
    assert.equal(requests, 1);
    assert.equal(signals.length, 1);
  } finally {
    for (const key of keys) {
      if (originals[key] === undefined) delete globalThis[key]; else globalThis[key] = originals[key];
    }
  }
});

test('registry selects native MAIN world and applies distinct Guacamole/Proxmox cadence caps', async () => {
  for (const [profile, interval] of [['guacamole', 5], ['proxmox-ve', 15]]) {
    const f = fixture();
    f.detect(profile);
    f.execute(async () => [{result: {kind: 'renewed', profile, method: 'renewal'}}]);
    await f.keeper.message({type: 'setTab', tabId: 1, enabled: true, intervalMinutes: 60});
    assert.equal(f.probes[0].world, 'ISOLATED');
    assert.equal(f.calls[0].world, 'MAIN');
    assert.equal(f.calls[0].args[2], profile);
    const state = await f.keeper.message({type: 'getState', tabId: 1});
    assert.equal(state.effective.intervalMinutes, 60);
    assert.equal(state.runtime.actualIntervalMinutes, interval);
    assert.equal(state.runtime.messageKey, 'runtimeRenewalSent');
    assert.equal(f.alarms.get('keeper-tab:1').periodInMinutes, interval);
  }
});

test('two-state icons use localized active badges and preserve warning priority', async () => {
  const f = fixture();
  f.badges.set(undefined, 'AN');
  await f.keeper.init();
  assert.equal(f.badges.get(undefined), '');
  await f.keeper.message({type: 'setTab', tabId: 1, enabled: true});
  assert.equal(f.icons.get(1)[16], 'icons/on16.png');
  assert.equal(f.badges.get(1), 'On');
  f.execute(async () => [{result: {kind: 'http', status: 401}}]);
  await f.keeper.runTab(1);
  let state = await f.keeper.message({type: 'getState', tabId: 1});
  assert.equal(state.effective.iconState, 'off');
  assert.equal(state.effective.warning, true);
  assert.equal(f.icons.get(1)[16], 'icons/off16.png');
  assert.equal(f.badges.get(1), '!');
  await f.keeper.message({type: 'setTab', tabId: 1, enabled: false});
  assert.equal(f.badges.get(1), '');
  assert.deepEqual(indicatorState(true, {status: 'error', nextAttemptAt: 200}, 100), {iconState: 'on', warning: true});
  assert.deepEqual(indicatorState(true, {status: 'error', nextAttemptAt: null}, 100), {iconState: 'off', warning: true});
  assert.deepEqual(indicatorState(true, {status: 'waiting', nextAttemptAt: 200}, 100), {iconState: 'on', warning: false});
});

test('active badges follow the browser UI language with English fallback and never hide warnings', async () => {
  for (const [language, activeText] of [['de-DE', 'An'], ['en-GB', 'On'], ['fr-FR', 'On']]) {
    const f = fixture({language});
    await f.keeper.init();
    assert.equal(f.badges.get(1), '', `${language}: disabled tab`);
    await f.keeper.message({type: 'setTab', tabId: 1, enabled: true});
    assert.equal(f.badges.get(1), activeText, language);
    f.execute(async () => [{result: {kind: 'network'}}]);
    await f.keeper.runTab(1);
    assert.equal(f.icons.get(1)[16], 'icons/on16.png');
    assert.equal(f.badges.get(1), '!', `${language}: retrying warning takes priority`);
    f.execute(async () => [{result: {kind: 'http', status: 401}}]);
    await f.keeper.runTab(1);
    assert.equal(f.icons.get(1)[16], 'icons/off16.png');
    assert.equal(f.badges.get(1), '!', `${language}: paused authentication warning has no active label`);
    await f.keeper.message({type: 'setTab', tabId: 1, enabled: false});
    assert.equal(f.badges.get(1), '', `${language}: disabling clears warnings and active labels`);
  }
});

test('runtime stores only stable message metadata and migrates historical HTTP meaning without German parsing', async () => {
  const f = fixture();
  await f.keeper.message({type: 'setTab', tabId: 1, enabled: true});
  assert.equal(Object.hasOwn(f.data.session.keeperTabs[1].runtime, 'message'), false);
  assert.equal(f.data.session.keeperTabs[1].runtime.messageKey, 'runtimeHttpSuccess');
  const migrated = normalizeRuntime({status: 'error', httpStatus: 500, message: 'Beliebiger alter deutscher Text'});
  assert.equal(migrated.messageKey, 'runtimeHttpError');
  assert.deepEqual(migrated.messageArgs, [500]);
  assert.equal(Object.hasOwn(migrated, 'message'), false);
  f.tabs.get(1).url = 'chrome://settings/';
  const error = await f.keeper.message({type: 'setTab', tabId: 1, enabled: true});
  assert.equal(error.errorKey, 'errorUnsupportedTab');
  assert.deepEqual(error.errorArgs, []);
});
