import { send, readSettings, requestSiteAccess, errorMessage } from './ui-shared.js';
import { t, localizeDocument } from './i18n.js';

localizeDocument();
document.getElementById('extension-version').textContent = t('footerVersion', [chrome.runtime.getManifest().version]);

const list = document.getElementById('rules-list');
const empty = document.getElementById('empty-state');
const template = document.getElementById('rule-template');
const feedback = document.getElementById('page-feedback');
let mutating = false;
let refreshTimer;

function showFeedback(element, message, error = false) {
  element.textContent = message;
  element.hidden = !message;
  element.dataset.kind = error ? 'error' : 'success';
}

function renderRule(rule) {
  const card = template.content.firstElementChild.cloneNode(true);
  localizeDocument(card);
  const enabled = card.querySelector('.rule-enabled');
  const interval = card.querySelector('[name="intervalMinutes"]');
  const endpoint = card.querySelector('[name="endpoint"]');
  const grant = card.querySelector('.grant-access');
  const localFeedback = card.querySelector('.rule-feedback');
  card.dataset.origin = rule.origin;
  card.querySelector('.rule-origin').textContent = rule.origin;
  enabled.checked = rule.enabled;
  enabled.setAttribute('aria-label', t('ruleEnabledAria', [rule.origin]));
  interval.value = rule.intervalMinutes;
  endpoint.value = rule.endpoint || '';
  const permission = card.querySelector('.permission-state');
  permission.textContent = t(!rule.enabled ? 'ruleOff' : rule.hasPermission ? 'ruleAccessGranted' : 'ruleAccessMissing');
  permission.dataset.missing = String(rule.enabled && !rule.hasPermission);
  grant.hidden = Boolean(rule.hasPermission);

  async function act(operation, success) {
    if (mutating) return;
    mutating = true;
    card.setAttribute('aria-busy', 'true');
    card.querySelectorAll('input, button').forEach(element => { element.disabled = true; });
    showFeedback(localFeedback, '');
    try {
      await operation();
      await refresh(rule.origin);
      showFeedback(feedback, success);
    } catch (error) {
      showFeedback(localFeedback, errorMessage(error), true);
    } finally {
      mutating = false;
      card.setAttribute('aria-busy', 'false');
      card.querySelectorAll('input, button').forEach(element => { element.disabled = false; });
    }
  }

  card.addEventListener('input', () => { card.dataset.dirty = 'true'; });
  card.addEventListener('submit', event => {
    event.preventDefault();
    void act(async () => {
      const settings = readSettings(card, rule.origin);
      if (enabled.checked) await requestSiteAccess(rule.origin);
      await send('saveRule', { rule: { origin: rule.origin, enabled: enabled.checked, ...settings } });
    }, t('ruleSavedNotice'));
  });
  grant.addEventListener('click', () => {
    void act(async () => {
      const settings = readSettings(card, rule.origin);
      await requestSiteAccess(rule.origin);
      await send('saveRule', { rule: { origin: rule.origin, enabled: enabled.checked, ...settings } });
    }, t('ruleAccessNotice'));
  });
  card.querySelector('.delete-rule').addEventListener('click', () => {
    void act(() => send('deleteRule', { origin: rule.origin }), t('ruleDeletedNotice'));
  });
  return card;
}

async function refresh(forceOrigin = null) {
  const { rules } = await send('getState');
  const entries = [...rules].sort((a, b) => a.origin.localeCompare(b.origin));
  const existing = new Map([...list.children].map(card => [card.dataset.origin, card]));
  for (const rule of entries) {
    const old = existing.get(rule.origin);
    existing.delete(rule.origin);
    if (old && old.dataset.dirty === 'true' && rule.origin !== forceOrigin) continue;
    const card = renderRule(rule);
    if (old) old.replaceWith(card); else list.append(card);
  }
  for (const old of existing.values()) old.remove();
  empty.hidden = entries.length > 0;
  list.setAttribute('aria-busy', 'false');
}

chrome.storage.onChanged.addListener(() => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { if (!mutating) void refresh().catch(error => showFeedback(feedback, errorMessage(error), true)); }, 200);
});
chrome.permissions.onAdded.addListener(() => { if (!mutating) void refresh().catch(error => showFeedback(feedback, errorMessage(error), true)); });
chrome.permissions.onRemoved.addListener(() => { if (!mutating) void refresh().catch(error => showFeedback(feedback, errorMessage(error), true)); });
void refresh().catch(error => {
  list.setAttribute('aria-busy', 'false');
  showFeedback(feedback, errorMessage(error), true);
});
