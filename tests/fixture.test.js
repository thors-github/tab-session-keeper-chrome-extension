import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { startFixture } from './fixture-server.mjs';

async function login(origin, query = '') {
  const response = await fetch(`${origin}/login${query}`);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  await response.text();
  return cookie;
}

test('heartbeat extends an idle session while an inactive control expires', async t => {
  const fixture = await startFixture({ idleMs: 240, absoluteMs: 4000 });
  t.after(fixture.close);
  const selected = await login(fixture.origin);
  const control = await login(fixture.origin);
  for (let i = 0; i < 4; i++) {
    await sleep(100);
    assert.equal((await fetch(`${fixture.origin}/heartbeat`, { headers: { Cookie: selected } })).status, 204);
  }
  assert.equal((await fetch(`${fixture.origin}/heartbeat`, { headers: { Cookie: control } })).status, 401);
});

test('absolute expiration remains effective despite heartbeat requests', async t => {
  const fixture = await startFixture({ idleMs: 1000, absoluteMs: 260 });
  t.after(fixture.close);
  const cookie = await login(fixture.origin);
  assert.equal((await fetch(`${fixture.origin}/heartbeat`, { headers: { Cookie: cookie } })).status, 204);
  await sleep(300);
  assert.equal((await fetch(`${fixture.origin}/heartbeat`, { headers: { Cookie: cookie } })).status, 401);
});

test('fixture covers explicit authentication failures, redirects, and HTTP-200 login pages', async t => {
  const fixture = await startFixture();
  t.after(fixture.close);
  assert.equal((await fetch(`${fixture.origin}/unauthorized`)).status, 401);
  assert.equal((await fetch(`${fixture.origin}/forbidden`)).status, 403);
  assert.equal((await fetch(`${fixture.origin}/redirect`, { redirect: 'manual' })).status, 302);
  assert.equal((await fetch(`${fixture.origin}/login-page-200`)).status, 200);
});

test('static console GET remains HTTP 200 but cannot refresh the separate activity session', async t => {
  const fixture = await startFixture({ idleMs: 1000, btIdleMs: 220, absoluteMs: 4000 });
  t.after(fixture.close);
  const cookie = await login(fixture.origin);
  for (let i = 0; i < 3; i++) {
    await sleep(100);
    assert.equal((await fetch(`${fixture.origin}/console`, { headers: { Cookie: cookie } })).status, 200);
  }
  assert.equal((await fetch(`${fixture.origin}/bt-status`, { headers: { Cookie: cookie } })).status, 401);
});

test('real activity requests refresh activity idle timeout while absolute expiry still wins', async t => {
  const fixture = await startFixture({ idleMs: 1000, btIdleMs: 220, absoluteMs: 750 });
  t.after(fixture.close);
  const cookie = await login(fixture.origin);
  for (let i = 0; i < 4; i++) {
    await sleep(100);
    assert.equal((await fetch(`${fixture.origin}/bt-activity`, { method: 'POST', headers: { Cookie: cookie } })).status, 204);
  }
  assert.equal((await fetch(`${fixture.origin}/bt-status`, { headers: { Cookie: cookie } })).status, 204);
  await sleep(400);
  assert.equal((await fetch(`${fixture.origin}/bt-activity`, { method: 'POST', headers: { Cookie: cookie } })).status, 401);
});
