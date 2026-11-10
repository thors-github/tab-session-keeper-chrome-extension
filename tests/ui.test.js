import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { executionDetails, readSettings, timeLabel, errorMessage } from '../ui-shared.js';
import { t, uiLocale, localizeRuntime } from '../i18n.js';

const catalogs = {};
for (const locale of ['en', 'de']) catalogs[locale] = JSON.parse(await readFile(new URL(`../_locales/${locale}/messages.json`, import.meta.url), 'utf8'));
function mockApi(language) {
  const catalog = /^de(?:-|_|$)/i.test(language) ? catalogs.de : catalogs.en;
  return { i18n: {
    getUILanguage: () => language,
    getMessage(key, substitutions = []) {
      const entry = catalog[key] || catalogs.en[key];
      if (!entry) return '';
      return entry.message.replace(/\$([a-z]\w*)\$/gi, (_match, name) => {
        const content = entry.placeholders?.[name.toLowerCase()]?.content || '';
        return content.replace(/\$(\d+)/g, (_placeholder, number) => String(substitutions[Number(number) - 1] ?? ''));
      });
    },
  } };
}
const language = locale => { globalThis.chrome = mockApi(locale); };
language('en-US');
const form = (interval, endpoint = '') => ({ querySelector: selector => ({ value: selector.includes('intervalMinutes') ? String(interval) : endpoint }) });

test('German UI and English fallback use matching complete message catalogs', async () => {
  assert.deepEqual(Object.keys(catalogs.en).sort(), Object.keys(catalogs.de).sort());
  for (const key of Object.keys(catalogs.en)) {
    assert.deepEqual(Object.keys(catalogs.en[key].placeholders || {}).sort(), Object.keys(catalogs.de[key].placeholders || {}).sort(), key);
    for (const locale of ['en', 'de']) assert.ok(catalogs[locale][key].message, `${locale}.${key}`);
  }
  for (const file of ['popup.html', 'options.html']) {
    const html = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const [, key] of html.matchAll(/data-i18n(?:-(?:title|aria-label|placeholder))?="([^"]+)"/g)) assert.ok(catalogs.en[key], `${file}: ${key}`);
  }
  for (const file of ['popup.js', 'options.js', 'ui-shared.js', 'i18n.js', 'core.js', 'service-worker.js']) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const [, key] of source.matchAll(/['"]((?:runtime|error)[A-Z]\w+)['"]/g)) assert.ok(catalogs.en[key], `${file}: ${key}`);
    for (const [, key] of source.matchAll(/\bt\(\s*['"](\w+)['"]/g)) assert.ok(catalogs.en[key], `${file}: ${key}`);
  }
  language('de-DE'); assert.equal(t('testNow'), 'Jetzt testen'); assert.equal(uiLocale(), 'de-DE');
  language('en-GB'); assert.equal(t('testNow'), 'Test now'); assert.equal(uiLocale(), 'en-GB');
  language('fr-FR'); assert.equal(t('testNow'), 'Test now'); assert.equal(uiLocale(), 'en');
});

test('BeyondTrust displays actual cadence without changing saved form settings in either language', () => {
  for (const locale of ['en-US', 'de-DE']) {
    language(locale);
    const settings = readSettings(form(5), 'https://support.example');
    const execution = executionDetails(settings, { profile: 'beyondtrust', method: 'activity', actualIntervalMinutes: 1 });
    assert.equal(execution.actualIntervalMinutes, 1);
    assert.equal(execution.configuredIntervalMinutes, 5);
    assert.match(execution.label, /BeyondTrust/);
    assert.ok(execution.label.includes(t('intervalEveryOne')));
    assert.ok(execution.intervalNote.includes(t('intervalEveryMany', [5])));
    assert.deepEqual(settings, { intervalMinutes: 5, endpoint: '' });
    assert.deepEqual(readSettings(form(execution.configuredIntervalMinutes), 'https://support.example'), settings);
  }
});

test('native profiles use renewal labels while custom endpoints retain normal requests', () => {
  language('en-US');
  for (const [profile, name, interval] of [['guacamole', 'Guacamole', 5], ['proxmox-ve', 'Proxmox VE', 15]]) {
    const execution = executionDetails({ intervalMinutes: 30 }, { method: 'renewal', profile, actualIntervalMinutes: interval });
    assert.equal(execution.renewal, true);
    assert.equal(execution.activity, false);
    assert.equal(execution.configuredIntervalMinutes, 30);
    assert.ok(execution.label.includes(name));
    assert.ok(execution.label.includes('Native renewal'));
    assert.ok(execution.intervalNote.includes('Every 30 minutes'));
  }
  const settings = readSettings(form(7, '/heartbeat'), 'https://support.example');
  const execution = executionDetails(settings, { method: 'request', profile: null, actualIntervalMinutes: 7 });
  assert.equal(execution.activity, false);
  assert.equal(execution.renewal, false);
  assert.equal(execution.intervalNote, '');
  assert.equal(execution.label, 'Background request · Every 7 minutes');
  assert.equal(settings.endpoint, 'https://support.example/heartbeat');
});

test('RDP Secure Access is explicitly monitoring with a separate three-minute cadence', () => {
  for (const locale of ['en-US', 'de-DE']) {
    language(locale);
    const settings = readSettings(form(5), 'https://support.example');
    const execution = executionDetails(settings, {profile: 'rdp-secure-access', method: 'monitor', actualIntervalMinutes: 3});
    assert.equal(execution.actualIntervalMinutes, 3);
    assert.equal(execution.configuredIntervalMinutes, 5);
    assert.equal(execution.renewal, false);
    assert.equal(execution.activity, false);
    assert.ok(execution.label.includes('RDP Secure Access'));
    assert.equal(execution.monitor, true);
    assert.ok(execution.label.includes(t('methodMonitor')));
    assert.ok(!execution.label.includes(t('methodRequest')));
    assert.ok(execution.label.includes(t('intervalEveryMany', [3])));
    assert.ok(execution.intervalNote.includes(t('intervalEveryMany', [5])));
    assert.equal(settings.intervalMinutes, 5);
  }
});

test('portal monitoring is translated separately from HTTP success and keeps paused states in all UI locales', () => {
  for (const locale of ['en-US', 'de-DE', 'fr-FR']) {
    const api = mockApi(locale);
    const monitored = localizeRuntime({status: 'success', profile: 'rdp-secure-access', method: 'monitor', httpStatus: null,
      attempts: [{kind: 'monitored', profile: 'rdp-secure-access'}]}, api);
    assert.equal(monitored.message, t('runtimePortalMonitored', ['RDP Secure Access'], api));
    assert.equal(monitored.httpStatus, null);
    assert.notEqual(monitored.message, t('runtimeHttpSuccess', [], api));
    for (const [kind, key] of [['auth-required', 'runtimeAuthRequired'], ['indeterminate', 'runtimeIndeterminate']]) {
      const runtime = {status: 'paused', profile: 'rdp-secure-access', method: 'monitor', httpStatus: null,
        message: 'Veraltete deutsche Meldung', attempts: [{kind, profile: 'rdp-secure-access'}]};
      const localized = localizeRuntime(runtime, api);
      assert.equal(localized.status, 'paused');
      assert.equal(localized.httpStatus, null);
      assert.equal(localized.message, t(key, ['RDP Secure Access'], api));
      assert.notEqual(localized.message, t('runtimeHttpSuccess', [], api));
      const modern = localizeRuntime({...runtime, messageKey: key, messageArgs: ['RDP Secure Access']}, api);
      assert.equal(modern.message, localized.message);
    }
  }
});

test('legacy German runtime messages are rebuilt from metadata in the current UI language', () => {
  const old = {status: 'success', message: 'Anfrage erfolgreich. Die Sitzungsverlängerung bestimmt die Website.', httpStatus: 200, lastAttemptAt: 1234, attempts: [{kind: 'http', status: 'success'}]};
  const english = localizeRuntime(old, mockApi('en-US'));
  assert.equal(english.message, catalogs.en.runtimeHttpSuccess.message);
  assert.equal(english.lastAttemptAt, 1234);
  assert.deepEqual(english.attempts, old.attempts);
  assert.equal(old.message, 'Anfrage erfolgreich. Die Sitzungsverlängerung bestimmt die Website.');
  const activity = localizeRuntime({status: 'success', method: 'activity', profile: 'beyondtrust', message: 'Alter deutscher Text'}, mockApi('en-US'));
  assert.match(activity.message, /BeyondTrust: Activity signal sent/);
  const paused = localizeRuntime({status: 'paused', httpStatus: 401, message: 'Alter deutscher Text'}, mockApi('en-US'));
  assert.match(paused.message, /HTTP 401: Check your login/);
  const modern = localizeRuntime({status: 'waiting', messageKey: 'runtimeAppLoading', messageArgs: ['Apache Guacamole'], message: 'Nicht verwenden'}, mockApi('de-DE'));
  assert.match(modern.message, /Apache Guacamole lädt noch/);
});

test('validation errors are localized using stable keys', () => {
  for (const [locale, expected] of [['de-DE', /ganzen Minuten/], ['en-US', /whole number/]]) {
    language(locale);
    assert.throws(() => readSettings(form(0), 'https://support.example'), error => error.key === 'errorInvalidInterval' && expected.test(errorMessage(error)));
  }
});

test('older attempts include the date in the selected UI locale', () => {
  const now = new Date(2026, 10, 5, 15, 0, 0).getTime();
  const previous = new Date(2026, 10, 2, 14, 12, 10).getTime();
  language('de-DE'); assert.match(timeLabel(previous, now), /02\.11\..*14:12:10/);
  language('en-US');
  assert.ok(timeLabel(previous, now).includes(new Date(previous).toLocaleDateString('en-US', {day: '2-digit', month: '2-digit'})));
  assert.equal(timeLabel(new Date(2026, 10, 5, 14, 12, 10).getTime(), now), new Date(2026, 10, 5, 14, 12, 10).toLocaleTimeString('en-US', {hour: '2-digit', minute: '2-digit', second: '2-digit'}));
});
