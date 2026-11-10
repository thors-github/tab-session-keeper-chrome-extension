import { t, uiLocale, I18nError } from './i18n.js';

export async function send(type, values = {}) {
  let result;
  try { result = await chrome.runtime.sendMessage({ type, ...values }); }
  catch { throw new I18nError('errorExtensionUnavailable'); }
  if (!result?.ok) throw new I18nError(result?.errorKey || 'errorActionFailed', result?.errorArgs || []);
  return result;
}

export function readSettings(form, origin) {
  const intervalMinutes = Number(form.querySelector('[name="intervalMinutes"]').value);
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 60) throw new I18nError('errorInvalidInterval');
  const value = form.querySelector('[name="endpoint"]').value.trim();
  let endpoint = '';
  if (value) {
    let url;
    try { url = new URL(value, `${origin}/`); } catch { throw new I18nError('errorInvalidEndpoint'); }
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new I18nError('errorEndpointScope');
    url.hash = '';
    endpoint = url.href;
  }
  return { intervalMinutes, endpoint };
}

export function hostPattern(origin) {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
}

export async function requestSiteAccess(origin) {
  let granted;
  try { granted = await chrome.permissions.request({ origins: [hostPattern(origin)] }); }
  catch { throw new I18nError('errorPermissionRequest'); }
  if (!granted) throw new I18nError('errorPermissionDenied');
}

export function timeLabel(timestamp, now = Date.now()) {
  if (!timestamp) return '–';
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '–';
  const locale = uiLocale();
  const time = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return time;
  const calendar = date.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
  return `${calendar} · ${time}`;
}

export function cadence(minutes) {
  return Number(minutes) === 1 ? t('intervalEveryOne') : t('intervalEveryMany', [minutes]);
}

export function executionDetails(effective = {}, runtime = {}) {
  const configuredIntervalMinutes = Number(effective.intervalMinutes) || 5;
  const actual = Number(runtime.actualIntervalMinutes);
  const actualIntervalMinutes = Number.isFinite(actual) && actual >= 1 && actual <= 60 ? actual : configuredIntervalMinutes;
  const activity = runtime.method === 'activity';
  const renewal = runtime.method === 'renewal';
  const monitor = runtime.method === 'monitor';
  const profileName = { beyondtrust: 'BeyondTrust', guacamole: 'Guacamole', 'proxmox-ve': 'Proxmox VE', 'rdp-secure-access': 'RDP Secure Access' }[runtime.profile] || '';
  const methodName = t(activity ? 'methodActivity' : renewal ? 'methodRenewal' : monitor ? 'methodMonitor' : 'methodRequest');
  const method = profileName ? `${profileName} · ${methodName}` : methodName;
  const intervalNote = activity && runtime.profile === 'beyondtrust'
    ? t('beyondTrustIntervalNote', [cadence(actualIntervalMinutes), cadence(configuredIntervalMinutes)])
    : runtime.profile === 'rdp-secure-access' && monitor
      ? t('portalIntervalNote', [profileName, cadence(actualIntervalMinutes), cadence(configuredIntervalMinutes)])
    : renewal && profileName ? t('nativeIntervalNote', [profileName, cadence(actualIntervalMinutes), cadence(configuredIntervalMinutes)]) : '';
  return { configuredIntervalMinutes, actualIntervalMinutes, activity, renewal, monitor,
    label: t('executionLabel', [method, cadence(actualIntervalMinutes)]), intervalNote };
}

export function errorMessage(error) {
  return error?.key ? t(error.key, error.args || []) : t('errorActionFailed');
}
