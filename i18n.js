// Chrome selects _locales/de for German UI languages and defaults to _locales/en.
// Refer to the API only inside functions so pure modules remain importable in Node.
export function t(key, args = [], api = globalThis.chrome) {
  const substitutions = Array.isArray(args) ? args.map(String) : [String(args)];
  return api?.i18n?.getMessage(key, substitutions) || key;
}

export function uiLocale(api = globalThis.chrome) {
  const raw = api?.i18n?.getUILanguage?.() || 'en';
  const locale = String(raw).replaceAll('_', '-');
  return /^(de|en)(-|$)/i.test(locale) ? locale : 'en';
}

export function localizeDocument(root = document) {
  if (root.documentElement) root.documentElement.lang = /^de(-|$)/i.test(uiLocale()) ? 'de' : 'en';
  const attributes = [['data-i18n', null], ['data-i18n-title', 'title'], ['data-i18n-aria-label', 'aria-label'], ['data-i18n-placeholder', 'placeholder']];
  for (const [attribute, target] of attributes) {
    const nodes = [...root.querySelectorAll(`[${attribute}]`)];
    if (root.matches?.(`[${attribute}]`)) nodes.unshift(root);
    for (const node of nodes) {
      const value = t(node.getAttribute(attribute));
      if (target) node.setAttribute(target, value); else node.textContent = value;
    }
  }
}

function legacyRuntimeKey(runtime) {
  const last = Array.isArray(runtime.attempts) ? runtime.attempts.at(-1) : null;
  const kind = last?.kind;
  if (runtime.status === 'permission') return 'runtimePermissionMissing';
  if (runtime.status === 'idle') return 'runtimeIdle';
  if (runtime.status === 'waiting') return runtime.waitReason === 'app' ? 'runtimeAppLoading' : runtime.waitReason === 'busy' ? 'runtimeBusy' : 'runtimeWaitingDocument';
  if (runtime.status === 'paused') {
    if (kind === 'indeterminate') return 'runtimeIndeterminate';
    if (kind === 'unsupported') return 'runtimeUnsupported';
    if (kind === 'unsupported-auth') return 'runtimeUnsupportedAuth';
    if (kind === 'auth-required') return 'runtimeAuthRequired';
    if (runtime.httpStatus === 401 || runtime.httpStatus === 403) return 'runtimeHttpAuth';
    return 'runtimeRedirect';
  }
  if (runtime.status === 'success') return runtime.method === 'activity' ? 'runtimeActivitySent' : runtime.method === 'renewal' ? 'runtimeRenewalSent' : runtime.method === 'monitor' ? 'runtimePortalMonitored' : 'runtimeHttpSuccess';
  if (kind === 'timeout') return 'runtimeTimeout';
  if (kind === 'native-error') return 'runtimeNativeError';
  if (kind === 'scheduler-error') return 'runtimeSchedulerError';
  if (kind === 'injection-error') return last?.errorCode === 'permission' ? 'runtimeInjectionPermission' : 'runtimeInjectionUnavailable';
  if (Number.isInteger(runtime.httpStatus)) return 'runtimeHttpError';
  return 'runtimeNetworkError';
}

export function runtimeMessage(runtime = {}, api = globalThis.chrome) {
  const key = runtime.messageKey || legacyRuntimeKey(runtime);
  const profileKeys = ['runtimeAppLoading', 'runtimeAuthRequired', 'runtimeActivitySent', 'runtimeRenewalSent', 'runtimeUnsupported', 'runtimeUnsupportedAuth', 'runtimeNativeError', 'runtimePortalMonitored', 'runtimeIndeterminate'];
  const last = Array.isArray(runtime.attempts) ? runtime.attempts.at(-1) : null;
  const profile = {beyondtrust: 'BeyondTrust', guacamole: 'Apache Guacamole', 'proxmox-ve': 'Proxmox VE', 'rdp-secure-access': 'RDP Secure Access'}[runtime.profile || last?.profile] || t('application', [], api);
  const args = runtime.messageKey ? runtime.messageArgs || [] : profileKeys.includes(key) ? [profile] : Number.isInteger(runtime.httpStatus) ? [runtime.httpStatus] : [];
  return t(key, args, api);
}

export function localizeRuntime(runtime = {}, api = globalThis.chrome) {
  return { ...runtime, message: runtimeMessage(runtime, api) };
}

export class I18nError extends Error {
  constructor(key, args = []) {
    super(t(key, args));
    this.name = 'I18nError';
    this.key = key;
    this.args = args;
  }
}
