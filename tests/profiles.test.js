import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {profileOperation, PROFILE_REGISTRY} from '../profiles.js';

const plain = value => JSON.parse(JSON.stringify(value));
const LOCK = 'data-tab-session-keeper-operation';

function environment(profile = 'generic', shared = null) {
  const attrs = shared?.attrs || new Map();
  const markers = new Set();
  const scripts = [];
  const calls = {fetch: [], events: [], native: [], apply: [], updates: 0};
  const timers = new Map();
  let timerId = 0;
  const root = {
    getAttribute: key => attrs.get(key) ?? null,
    hasAttribute: key => attrs.has(key),
    setAttribute: (key, value) => attrs.set(key, value),
    removeAttribute: key => attrs.delete(key),
  };
  const document = {readyState: 'complete', documentElement: root,
    querySelector: selector => selector.split(',').some(item => markers.has(item.trim())) ? {} : null,
    querySelectorAll: selector => selector === 'script[src]' ? scripts.map(src => ({src})) : [],
  };
  const sandbox = {URL, AbortController, Promise, document, location: new URL('https://example.com/'),
    crypto: {randomUUID: () => 'operation-random-token'},
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, {callback, delay}); return id; },
    clearTimeout(id) { timers.delete(id); },
    MouseEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    fetch: async (url, options) => { calls.fetch.push({url, options}); return {status: 204, type: 'basic', body: {async cancel() {}}}; },
    dispatchEvent(event) { calls.events.push(event); return true; },
  };
  sandbox.window = sandbox;
  let auth = {token: 'SECRET-GUAC-TOKEN', username: 'PRIVATE-USER'};
  const service = {
    getCurrentToken: () => auth.token,
    getCurrentUsername: () => auth.username,
    isAnonymous: () => auth.username === '',
    request(options) { calls.native.push(options); return Promise.resolve(['PRIVATE-TUNNEL-ID']); },
    updateCurrentToken() { calls.updates++; throw new Error('Token rotation must never be called'); },
    getValidity() { throw new Error('HEAD validity is not keep-alive'); },
  };
  const workspace = {updateLoginData(data) { calls.apply.push(data); }};
  const app = {Setup: {auth_cookie_name: 'PVEAuthCookie'}, UserName: 'PRIVATE-PVE-USER', LoggedOut: false,
    Utils: {authOK: () => 'PVE:PRIVATE-TICKET', getStoredAuth: () => ({})}};
  function configure(name) {
    markers.clear(); scripts.length = 0; attrs.delete('ng-app'); attrs.delete('ng-controller');
    delete sandbox.Guacamole; delete sandbox.angular; delete sandbox.Proxmox; delete sandbox.PVE; delete sandbox.Ext;
    sandbox.location = new URL('https://example.com/');
    if (name === 'beyondtrust') {
      sandbox.location = new URL('https://example.com/console');
      markers.add('bt-app-component'); markers.add('bt-app-header-menu');
    } else if (name === 'guacamole') {
      attrs.set('ng-app', 'index'); attrs.set('ng-controller', 'indexController');
      scripts.push('https://example.com/guacamole/guacamole-common-js/all.min.js');
      sandbox.Guacamole = {};
      sandbox.angular = {element: () => ({injector: () => ({get: () => service})})};
    } else if (name === 'proxmox-ve') {
      scripts.push('https://example.com/pve2/js/pvemanagerlib.js?ver=9'); markers.add('#history-form');
      sandbox.Proxmox = app; sandbox.PVE = {};
      sandbox.Ext = {ComponentQuery: {query: () => [workspace]}, decode: JSON.parse,
        Ajax: {request(options) { calls.native.push(options); }} };
    }
  }
  configure(profile);
  const context = vm.createContext(sandbox);
  // This is the same serialization boundary as scripting.executeScript({func}).
  const execute = vm.runInContext(`(${profileOperation.toString()})`, context);
  return {attrs, markers, scripts, sandbox, document, service, app, workspace, calls, timers, configure,
    setAuth: value => { auth = value; },
    run: (endpoint = '', id = 'auto', detectOnly = false) => execute('https://example.com', endpoint, id, detectOnly),
    fireDeadline() { for (const [id, entry] of [...timers]) { if (entry.delay === 15000) { timers.delete(id); entry.callback(); } } },
  };
}

test('registry defines finite worlds and cadence limits; serialized functions require no module closures', async () => {
  assert.equal(PROFILE_REGISTRY.guacamole.world, 'MAIN');
  assert.equal(PROFILE_REGISTRY['proxmox-ve'].maxIntervalMinutes, 15);
  for (const profile of Object.keys(PROFILE_REGISTRY)) {
    const env = environment(profile);
    const detected = plain(await env.run('', 'auto', true));
    assert.deepEqual(detected, {kind: 'detected', profile});
    assert.equal(env.calls.native.length, 0);
  }
});

test('generic uses cookie request without hash; custom endpoint bypasses app adapters', async () => {
  const env = environment('guacamole');
  const value = plain(await env.run('https://example.com/heartbeat#ignored'));
  assert.deepEqual(value, {kind: 'http', profile: 'generic', method: 'request', status: 204});
  assert.equal(env.calls.native.length, 0);
  assert.equal(env.calls.fetch[0].url, 'https://example.com/heartbeat');
  assert.equal(env.calls.fetch[0].options.credentials, 'same-origin');
  assert.equal(env.calls.fetch[0].options.redirect, 'manual');
  assert.equal(env.attrs.has(LOCK), false);
});

test('strong partial fingerprints pause instead of silently falling back to HTML GET', async () => {
  const guac = environment('guacamole');
  guac.attrs.delete('ng-controller');
  assert.equal((await guac.run()).kind, 'unsupported');
  assert.equal(guac.calls.fetch.length, 0);
  const pve = environment('proxmox-ve');
  pve.markers.delete('#history-form');
  assert.equal((await pve.run()).kind, 'unsupported');
  assert.equal(pve.calls.native.length, 0);
  const unrelated = environment();
  unrelated.attrs.set('ng-app', 'index'); unrelated.attrs.set('ng-controller', 'indexController');
  assert.equal((await unrelated.run()).kind, 'http');
});

test('BeyondTrust sends only the neutral window mouse event and waits while bootstrapping', async () => {
  const env = environment('beyondtrust');
  assert.equal((await env.run()).kind, 'activity');
  assert.equal(env.calls.events.length, 1);
  assert.equal(env.calls.events[0].type, 'mousemove');
  assert.equal(env.calls.events[0].bubbles, false);
  assert.equal(env.calls.events[0].buttons, 0);
  env.markers.delete('bt-app-header-menu');
  assert.equal((await env.run()).kind, 'app-loading');
  env.markers.add('bt-login-view');
  assert.equal((await env.run()).kind, 'auth-required');
  assert.equal(env.calls.events.length, 1);
});

test('Guacamole uses native authenticated idle touch, discarding response and avoiding token rotation', async () => {
  const env = environment('guacamole');
  const value = plain(await env.run());
  assert.deepEqual(value, {kind: 'renewed', profile: 'guacamole', method: 'renewal'});
  assert.deepEqual(plain(env.calls.native[0]), {method: 'GET', url: 'api/session/tunnels', timeout: 15000});
  assert.equal(env.calls.updates, 0);
  assert.doesNotMatch(JSON.stringify(value), /SECRET|PRIVATE/);
  env.setAuth({token: 'anonymous-token', username: ''});
  assert.equal((await env.run()).kind, 'auth-required');
  assert.equal(env.calls.native.length, 1);
});

test('Guacamole pending request cannot restore logout or replace another account', async () => {
  for (const replacement of [{token: null, username: null}, {token: 'ACCOUNT-B-TOKEN', username: 'ACCOUNT-B'}]) {
    const env = environment('guacamole');
    let finish;
    env.service.request = options => { env.calls.native.push(options); return new Promise(resolve => { finish = resolve; }); };
    const pending = env.run();
    env.setAuth(replacement);
    finish({authToken: 'MUST-NOT-APPLY', username: 'MUST-NOT-APPLY'});
    const value = await pending;
    assert.equal(value.kind, replacement.token ? 'busy' : 'auth-required');
    assert.equal(env.service.getCurrentToken(), replacement.token);
    assert.equal(env.calls.updates, 0);
    assert.doesNotMatch(JSON.stringify(value), /ACCOUNT|MUST|PRIVATE/);
  }
});

test('native timeout keeps shared cross-world/document lock until actual promise settles', async () => {
  const env = environment('guacamole');
  let finish;
  env.service.request = () => new Promise(resolve => { finish = resolve; });
  const pending = env.run();
  assert.equal(env.attrs.get(LOCK), 'operation-random-token');
  env.fireDeadline();
  assert.equal((await pending).kind, 'timeout');
  assert.equal(env.attrs.has(LOCK), true);
  const isolated = environment('generic', env);
  assert.equal((await isolated.run('https://example.com/heartbeat')).kind, 'busy');
  assert.equal(isolated.calls.fetch.length, 0);
  finish(['PRIVATE-RESPONSE']);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(env.attrs.has(LOCK), false);
  assert.equal((await isolated.run('https://example.com/heartbeat')).kind, 'http');
});

test('Proxmox uses native ticket renewal and applies returned auth only inside the same current page session', async () => {
  const env = environment('proxmox-ve');
  const pending = env.run();
  const options = env.calls.native[0];
  assert.equal(options.url, '/api2/json/access/ticket');
  assert.equal(options.method, 'POST');
  assert.equal(options.params.password, 'PVE:PRIVATE-TICKET');
  options.success({responseText: JSON.stringify({data: {username: env.app.UserName, ticket: 'PVE:PRIVATE-NEW', CSRFPreventionToken: 'PRIVATE-CSRF'}})});
  const value = plain(await pending);
  assert.deepEqual(value, {kind: 'renewed', profile: 'proxmox-ve', method: 'renewal', status: 200});
  assert.equal(env.calls.apply.length, 1);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE|TICKET|CSRF/);
});

test('Proxmox excludes API tokens/TFA and waits for workspace construction', async () => {
  const env = environment('proxmox-ve');
  env.app.Utils.getStoredAuth = () => ({token: 'PRIVATE-API-TOKEN'});
  assert.equal((await env.run()).kind, 'unsupported-auth');
  env.app.Utils.getStoredAuth = () => ({});
  env.app.Utils.authOK = () => 'PVE:!tfa!challenge';
  assert.equal((await env.run()).kind, 'unsupported-auth');
  assert.equal(env.calls.native.length, 0);
  env.sandbox.Ext.ComponentQuery.query = () => [];
  assert.equal((await env.run()).kind, 'app-loading');
});

test('Proxmox delayed callback cannot undo logout, account switch, ticket rotation, or changed app fingerprint', async () => {
  for (const change of ['logout', 'account', 'ticket', 'fingerprint']) {
    const env = environment('proxmox-ve');
    const pending = env.run();
    const options = env.calls.native[0];
    if (change === 'logout') { env.app.LoggedOut = true; env.app.Utils.authOK = () => false; }
    if (change === 'account') env.app.UserName = 'OTHER-ACCOUNT';
    if (change === 'ticket') env.app.Utils.authOK = () => 'PVE:OTHER-TICKET';
    if (change === 'fingerprint') env.markers.delete('#history-form');
    options.success({responseText: JSON.stringify({data: {username: 'PRIVATE-PVE-USER', ticket: 'PVE:NEW', CSRFPreventionToken: 'PRIVATE-CSRF'}})});
    assert.notEqual((await pending).kind, 'renewed');
    assert.equal(env.calls.apply.length, 0, change);
  }
});

test('origin changes prevent any operation, and native missing capabilities are explicit unsupported results', async () => {
  const env = environment('guacamole');
  env.sandbox.location = new URL('https://other.example/');
  assert.equal((await env.run()).kind, 'waiting');
  assert.equal(env.calls.native.length, 0);
  env.sandbox.location = new URL('https://example.com/');
  delete env.service.request;
  assert.equal((await env.run()).kind, 'unsupported');
  assert.equal(env.calls.fetch.length, 0);
});
