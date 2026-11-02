import { send, readSettings, requestSiteAccess, timeLabel, errorMessage, executionDetails, cadence } from './ui-shared.js';
import { t, localizeDocument, runtimeMessage } from './i18n.js';

localizeDocument();

const $ = id => document.getElementById(id);
let view;
let busy = false;
let dirty = false;
let refreshTimer;
const requestedTab = new URLSearchParams(location.search).get('tabId');
const initialTabId = requestedTab !== null && /^\d+$/.test(requestedTab) && Number.isSafeInteger(Number(requestedTab)) ? Number(requestedTab) : null;

function feedback(message = '', error = false) {
  $('feedback').textContent = message;
  $('feedback').hidden = !message;
  $('feedback').dataset.kind = error ? 'error' : 'success';
}

function renderHistory(attempts) {
  const recent = Array.isArray(attempts) ? attempts.slice(-10).reverse() : [];
  $('diagnostics').hidden = recent.length === 0;
  $('diagnostics-count').textContent = t('diagnosticCount', [recent.length]);
  const rows = recent.map(attempt => {
    const row = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = timeLabel(attempt.at);
    const result = document.createElement('span');
    const activity = attempt.method === 'activity';
    const labels = { success: t(activity ? 'historyActivitySent' : attempt.method === 'renewal' ? 'historyRenewalSent' : 'historyRequestSuccess'), paused: t('historyPaused'), error: t('historyError'), waiting: t('historyWaiting') };
    const http = !activity && Number.isInteger(attempt.httpStatus) ? ` · ${t('httpStatus', [attempt.httpStatus])}` : '';
    result.textContent = `${labels[attempt.status] || t('historyCompleted')}${http}`;
    row.dataset.status = attempt.status || 'idle';
    row.append(time, result);
    return row;
  });
  $('attempt-history').replaceChildren(...rows);
}

function render(data, replaceSettings = false) {
  view = data;
  const { tab, effective = {}, runtime = {}, rules = [] } = data;
  const execution = executionDetails(effective, runtime);
  const supported = Boolean(tab?.supported);
  const rule = rules.find(item => item.origin === tab?.origin);
  $('tab-title').textContent = tab?.title || t(supported ? 'noTitle' : 'unsupportedTabTitle');
  $('tab-origin').textContent = tab?.origin || tab?.url || t('noWebsite');
  $('unsupported').hidden = supported;
  $('tab-enabled').checked = Boolean(effective.enabled);
  $('activation-source').textContent = effective.hasOverride && rule?.enabled
    ? t(effective.enabled ? 'tabCustomSettings' : 'tabException')
    : t(effective.source === 'site' ? 'sourceSite' : effective.enabled ? 'sourceTab' : 'off');
  $('status-message').textContent = effective.enabled ? runtimeMessage(runtime) : t('offStatus');
  $('keeper-logo').src = `icons/${effective.iconState === 'on' ? 'on' : 'off'}128.png`;
  $('status-box').dataset.status = runtime.status || 'idle';
  $('method-summary').textContent = execution.label;
  $('method-summary').hidden = !effective.enabled;
  $('profile-settings-note').textContent = execution.intervalNote;
  $('profile-settings-note').hidden = !execution.intervalNote;
  $('last-attempt-label').textContent = t(execution.activity ? 'lastActivity' : execution.renewal ? 'lastRenewal' : 'lastRequest');
  $('last-attempt').textContent = `${timeLabel(runtime.lastAttemptAt)}${!execution.activity && runtime.httpStatus ? ` · ${t('httpStatus', [runtime.httpStatus])}` : ''}`;
  $('next-attempt').textContent = runtime.status === 'paused' || runtime.status === 'permission' ? t('paused') : timeLabel(runtime.nextAttemptAt);
  $('resume-tab').hidden = !effective.enabled || runtime.status !== 'paused';
  $('reset-override').hidden = !rule?.enabled || !effective.hasOverride;
  $('rule-description').textContent = rule?.enabled
    ? t(rule.hasPermission === false ? 'ruleMissingAccess' : 'ruleSavedDescription')
    : t(rule ? 'ruleStoredOff' : 'ruleAutoDescription');
  $('remember-site').textContent = rule?.enabled
    ? t(rule.hasPermission === false ? 'allowWebsiteAccess' : 'updateSiteRule')
    : t('rememberSite');
  $('interval-summary').textContent = cadence(execution.configuredIntervalMinutes);
  if (!dirty || replaceSettings) {
    $('interval').value = execution.configuredIntervalMinutes;
    $('endpoint').value = effective.endpoint || '';
    dirty = false;
  }
  renderHistory(runtime.attempts);
  document.querySelectorAll('main button, main input').forEach(element => { element.disabled = busy || !supported; });
  $('test-now').disabled = busy || !supported || !effective.enabled || runtime.status === 'paused' || runtime.status === 'permission';
  $('popup-main').setAttribute('aria-busy', String(busy));
}

async function refresh(replaceSettings = false) {
  const tabId = view?.tab?.id ?? initialTabId;
  const data = await send('getState', Number.isInteger(tabId) ? { tabId } : {});
  render(data, replaceSettings);
}

async function act(operation, success = '') {
  if (busy) return;
  busy = true;
  feedback();
  if (view) render(view);
  try {
    await operation();
    await refresh(true);
    feedback(success);
  } catch (error) {
    feedback(errorMessage(error), true);
    try { await refresh(); } catch { /* Keep the actionable error visible. */ }
  } finally {
    busy = false;
    if (view) render(view);
    else $('popup-main').setAttribute('aria-busy', 'false');
  }
}

$('tab-enabled').addEventListener('change', event => {
  const enabled = event.target.checked;
  const settings = () => enabled ? readSettings($('settings-form'), view.tab.origin) : {
    intervalMinutes: view.effective.intervalMinutes || 5,
    endpoint: view.effective.endpoint || '',
  };
  void act(() => send('setTab', { tabId: view.tab.id, enabled, ...settings() }));
});

$('settings-form').addEventListener('input', () => { dirty = true; });
$('settings-form').addEventListener('submit', event => {
  event.preventDefault();
  void act(() => send('setTab', { tabId: view.tab.id, enabled: Boolean(view.effective.enabled), ...readSettings($('settings-form'), view.tab.origin) }), t('settingsOnlyTab'));
});

$('remember-site').addEventListener('click', () => {
  void act(async () => {
    const settings = readSettings($('settings-form'), view.tab.origin);
    await requestSiteAccess(view.tab.origin);
    await send('saveRule', { tabId: view.tab.id, rule: { origin: view.tab.origin, enabled: true, ...settings } });
  }, t('ruleSavedSuccess'));
});

$('test-now').addEventListener('click', () => { void act(() => send('testNow', { tabId: view.tab.id })); });
$('resume-tab').addEventListener('click', () => { void act(() => send('resumeTab', { tabId: view.tab.id })); });
$('reset-override').addEventListener('click', () => { void act(() => send('clearTabOverride', { tabId: view.tab.id }), t('tabRuleRestoredSuccess')); });
$('open-options').addEventListener('click', () => { chrome.runtime.openOptionsPage().catch(error => feedback(errorMessage(error), true)); });

chrome.storage.onChanged.addListener(() => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { if (!busy) void refresh().catch(error => feedback(errorMessage(error), true)); }, 150);
});

void refresh().catch(error => {
  feedback(errorMessage(error), true);
  $('popup-main').setAttribute('aria-busy', 'false');
});
