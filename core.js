import {getProfile, profileOperation} from './profiles.js';

export const DEFAULT_INTERVAL = 5;
export const RULES_KEY = 'keeperRules';
export const TABS_KEY = 'keeperTabs';
export const ALARM_PREFIX = 'keeper-tab:';

export class KeeperError extends Error {
  constructor(errorKey, errorArgs = []) {
    super(errorKey);
    this.errorKey = errorKey;
    this.errorArgs = errorArgs;
  }
}

export function pageOrigin(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.origin;
  } catch { return null; }
}

export function supportedPage(value) {
  if (!pageOrigin(value)) return false;
  const url = new URL(value);
  return !(url.hostname === 'chromewebstore.google.com' ||
    (url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore')));
}

export function permissionPattern(origin) {
  if (pageOrigin(origin) !== origin) throw new KeeperError('errorInvalidWebsite');
  // Chrome host patterns cover all ports of a host. Rules themselves compare exact origins.
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
}

export function intervalMinutes(value = DEFAULT_INTERVAL) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 60) {
    throw new KeeperError('errorInvalidInterval');
  }
  return number;
}

export function normalizeEndpoint(value, origin) {
  const input = String(value ?? '').trim();
  if (!input) return '';
  let url;
  try { url = new URL(input, `${origin}/`); } catch { throw new KeeperError('errorInvalidEndpoint'); }
  if (url.origin !== origin || !pageOrigin(url.href)) {
    throw new KeeperError('errorEndpointOrigin');
  }
  url.hash = '';
  return url.href;
}

export function normalizeRule(rule) {
  if (!rule || pageOrigin(rule.origin) !== rule.origin || !supportedPage(rule.origin)) {
    throw new KeeperError('errorInvalidWebsite');
  }
  return {
    origin: rule.origin,
    enabled: rule.enabled !== false,
    intervalMinutes: intervalMinutes(rule.intervalMinutes),
    endpoint: normalizeEndpoint(rule.endpoint, rule.origin),
  };
}

export function emptyRuntime() {
  return {status: 'idle', messageKey: 'runtimeIdle', messageArgs: [], lastAttemptAt: null, nextAttemptAt: null, httpStatus: null,
    profile: null, method: null, actualIntervalMinutes: null, attempts: []};
}

export function actualInterval(effective, runtime) {
  if (effective.endpoint) return effective.intervalMinutes;
  if (runtime?.status === 'waiting' && runtime.waitReason === 'app') return Math.min(effective.intervalMinutes, 1);
  const cap = getProfile(runtime?.profile).maxIntervalMinutes;
  return cap ? Math.min(effective.intervalMinutes, cap) : effective.intervalMinutes;
}

export function indicatorState(enabled, runtime = emptyRuntime(), now = Date.now()) {
  const warning = ['error', 'paused', 'permission'].includes(runtime.status);
  const runnable = enabled && !['paused', 'permission'].includes(runtime.status) &&
    (runtime.status !== 'error' || Number(runtime.nextAttemptAt) > now);
  return {iconState: runnable ? 'on' : 'off', warning};
}

export function recordAttempt(runtime, result, at) {
  const classified = classifyResult(result);
  const profile = result.profile ?? runtime?.profile ?? null;
  const method = result.method === null ? null : result.method || getProfile(profile).method;
  const attempt = {at, kind: result.kind, status: classified.status, httpStatus: classified.httpStatus, profile, method};
  if (result.code) attempt.errorCode = result.code;
  if (result.errorName) attempt.errorName = result.errorName;
  const {message: ignored, ...previous} = runtime;
  return {...previous, ...classified, profile, method, waitReason: classified.waitReason ?? null,
    attempts: [...(runtime.attempts || []), attempt].slice(-10)};
}

export function effectiveSettings(origin, record, rules) {
  const override = record?.origin === origin ? record.override : null;
  if (override) {
    return {enabled: override.enabled, source: override.enabled ? 'tab' : 'off',
      intervalMinutes: override.intervalMinutes ?? DEFAULT_INTERVAL, endpoint: override.endpoint ?? ''};
  }
  const rule = rules.find(item => item.origin === origin && item.enabled);
  return rule ? {enabled: true, source: 'site', intervalMinutes: rule.intervalMinutes, endpoint: rule.endpoint}
    : {enabled: false, source: 'off', intervalMinutes: DEFAULT_INTERVAL, endpoint: ''};
}

export function classifyResult(result) {
  const profile = getProfile(result?.profile).name;
  const response = (status, messageKey, messageArgs = [], extra = {}) => ({status, messageKey, messageArgs, httpStatus: null, ...extra});
  if (result?.kind === 'app-loading') return response('waiting', 'runtimeAppLoading', [profile], {waitReason: 'app'});
  if (result?.kind === 'activity') return response('success', 'runtimeActivitySent', [profile]);
  if (result?.kind === 'renewed') return response('success', 'runtimeRenewalSent', [profile], {httpStatus: result.status ?? null});
  if (result?.kind === 'auth-required') return response('paused', 'runtimeAuthRequired', [profile]);
  if (result?.kind === 'unsupported') return response('paused', 'runtimeUnsupported', [profile]);
  if (result?.kind === 'unsupported-auth') return response('paused', 'runtimeUnsupportedAuth', [profile]);
  if (result?.kind === 'native-error') return response('error', 'runtimeNativeError', [profile]);
  if (result?.kind === 'injection-error') return response('error', result.code === 'permission' ? 'runtimeInjectionPermission' : 'runtimeInjectionUnavailable');
  if (result?.kind === 'scheduler-error') return response('error', 'runtimeSchedulerError');
  if (result?.kind === 'busy') return response('waiting', 'runtimeBusy', [], {waitReason: 'busy'});
  if (result?.kind === 'waiting') return response('waiting', 'runtimeWaitingDocument', [], {waitReason: 'document'});
  if (result?.kind === 'redirect') return response('paused', 'runtimeRedirect');
  if (result?.status === 401 || result?.status === 403) {
    return response('paused', 'runtimeHttpAuth', [result.status], {httpStatus: result.status});
  }
  if (result?.kind === 'http') {
    return response(result.status >= 200 && result.status < 300 ? 'success' : 'error',
      result.status >= 200 && result.status < 300 ? 'runtimeHttpSuccess' : 'runtimeHttpError',
      result.status >= 200 && result.status < 300 ? [] : [result.status], {httpStatus: result.status});
  }
  return response('error', result?.kind === 'timeout' ? 'runtimeTimeout' : 'runtimeNetworkError');
}

export function normalizeRuntime(runtime = {}) {
  const {message: ignored, ...data} = runtime;
  const normalized = {...emptyRuntime(), ...data};
  if (data.messageKey) return normalized;
  const last = data.attempts?.at(-1);
  let derived;
  if (data.status === 'permission') derived = {messageKey: 'runtimePermissionMissing', messageArgs: []};
  else if (data.status === 'idle') derived = {messageKey: 'runtimeIdle', messageArgs: []};
  else if (data.status === 'waiting') derived = classifyResult({kind: data.waitReason === 'app' ? 'app-loading' : data.waitReason === 'busy' ? 'busy' : 'waiting', profile: data.profile});
  else if (last?.kind) derived = classifyResult({kind: last.kind, profile: data.profile || last.profile, status: data.httpStatus, code: last.errorCode});
  else if (data.status === 'success') derived = classifyResult({kind: data.method === 'activity' ? 'activity' : data.method === 'renewal' ? 'renewed' : 'http', profile: data.profile, status: data.httpStatus || 200});
  else if (data.status === 'paused') derived = classifyResult({kind: data.httpStatus ? 'http' : 'redirect', status: data.httpStatus});
  else if (Number.isInteger(data.httpStatus)) derived = classifyResult({kind: 'http', status: data.httpStatus});
  else derived = classifyResult({kind: 'network'});
  return {...normalized, messageKey: derived.messageKey, messageArgs: derived.messageArgs};
}

export {profileOperation as sendHeartbeat};
