// Only this metadata lives in the extension. Injected code returns no auth data.
export const PROFILE_REGISTRY = Object.freeze({
  generic: {id: 'generic', name: 'HTTP', world: 'ISOLATED', maxIntervalMinutes: null, method: 'request'},
  beyondtrust: {id: 'beyondtrust', name: 'BeyondTrust', world: 'ISOLATED', maxIntervalMinutes: 1, method: 'activity'},
  guacamole: {id: 'guacamole', name: 'Apache Guacamole', world: 'MAIN', maxIntervalMinutes: 5, method: 'renewal'},
  'proxmox-ve': {id: 'proxmox-ve', name: 'Proxmox VE', world: 'MAIN', maxIntervalMinutes: 15, method: 'renewal'},
  'rdp-secure-access': {id: 'rdp-secure-access', name: 'RDP Secure Access', world: 'ISOLATED', maxIntervalMinutes: 3, method: 'monitor'},
});

export const getProfile = id => PROFILE_REGISTRY[id] || PROFILE_REGISTRY.generic;

/**
 * Self-contained: Chrome serializes this function, not its module scope.
 * detectOnly runs in ISOLATED; a selected native operation runs in MAIN.
 * The DOM lock contains a random operation token only and is shared by worlds.
 */
export async function profileOperation(expectedOrigin, configuredEndpoint = '', requestedProfile = 'auto', detectOnly = false) {
  const result = (kind, profile, extra = {}) => ({kind, profile,
    method: profile === 'rdp-secure-access' ? 'monitor' : profile === 'beyondtrust' ? 'activity' : ['guacamole', 'proxmox-ve'].includes(profile) ? 'renewal' : 'request', ...extra});
  if (location.origin !== expectedOrigin || document.readyState === 'loading') return result('waiting', 'generic');
  const has = selector => Boolean(document.querySelector(selector));
  const scripts = () => Array.from(document.querySelectorAll('script[src]'));
  const scriptPath = expression => scripts().some(script => {
    try { return expression.test(new URL(script.src || script.getAttribute('src'), location.href).pathname); } catch { return false; }
  });
  function portalState(doc) {
    const title = String(doc.title || doc.querySelector('title')?.textContent || '').trim();
    const logo = Array.from(doc.querySelectorAll('img[src]')).some(image => {
      try {
        const url = new URL(image.getAttribute('src'), `${expectedOrigin}/`);
        return url.origin === expectedOrigin && url.pathname === '/img/sec_acs_logo_wht.png';
      } catch { return false; }
    });
    const candidate = title === 'RDP Secure Access - Web Protection Technology' || logo;
    if (!candidate) return {candidate: false, product: false, state: 'unknown'};
    const text = String(doc.body?.innerText || doc.body?.textContent || '');
    const branded = logo || text.replace(/\s+/g, '').toLowerCase().includes('webprotectiontechnology');
    const product = title === 'RDP Secure Access - Web Protection Technology' && branded;
    const login = Array.from(doc.querySelectorAll('form')).some(form =>
      String(form.getAttribute('method') || '').toLowerCase() === 'post' &&
      form.querySelector('input[name="username"][type="text"]') && form.querySelector('input[name="password"][type="password"]') &&
      form.querySelector('input[name="2fa"][type="password"]') && form.querySelector('[name="Anmelden"][type="submit"]'));
    const logout = Array.from(doc.querySelectorAll('a[href]')).some(anchor => {
      try {
        const url = new URL(anchor.getAttribute('href'), `${expectedOrigin}/`);
        return url.origin === expectedOrigin && url.pathname === '/' && url.searchParams.get('action') === 'logout';
      } catch { return false; }
    });
    const authenticated = /Sie\s+sind\s+angemeldet\s+als/i.test(text) && logout;
    return {candidate, product, state: login ? 'login' : authenticated ? 'authenticated' : 'unknown'};
  }
  function detect() {
    if (configuredEndpoint) return {profile: 'generic', supported: true};
    if (has('bt-app-component')) return {profile: 'beyondtrust', supported: /^\/console(?:\/|$)/.test(location.pathname)};
    const guacScript = scriptPath(/(?:^|\/)guacamole-common-js\/all\.min\.js$/);
    const guacRoot = document.documentElement?.getAttribute('ng-app') === 'index' &&
      document.documentElement?.getAttribute('ng-controller') === 'indexController';
    if (guacScript || has('guac-login, guac-client-panel')) return {profile: 'guacamole', supported: guacScript && guacRoot};
    const pveScript = scriptPath(/^\/pve2\/js\/pvemanagerlib\.js$/);
    if (pveScript) return {profile: 'proxmox-ve', supported: has('#history-form')};
    const portal = portalState(document);
    if (portal.candidate) return {profile: 'rdp-secure-access', supported: location.pathname === '/' && portal.product};
    return {profile: 'generic', supported: true};
  }
  const detected = detect();
  if (detectOnly) return {kind: detected.supported ? 'detected' : 'unsupported', profile: detected.profile};
  const profile = configuredEndpoint ? 'generic' : requestedProfile === 'auto' ? detected.profile : requestedProfile;
  if (!configuredEndpoint && (!detected.supported || detected.profile !== profile)) return result('unsupported', profile);
  const lockElement = document.documentElement;
  const lockAttribute = 'data-tab-session-keeper-operation';
  if (!lockElement || lockElement.hasAttribute(lockAttribute)) return result('busy', profile);
  const lockToken = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  lockElement.setAttribute(lockAttribute, lockToken);
  const unlock = () => { if (lockElement.getAttribute(lockAttribute) === lockToken) lockElement.removeAttribute(lockAttribute); };
  let ownsNativeOperation = false;
  try {
    if (location.origin !== expectedOrigin) return result('waiting', profile);
    if (profile === 'beyondtrust') {
      if (has('bt-login-view')) return result('auth-required', profile);
      if (!has('bt-app-header-menu')) return result('app-loading', profile);
      window.dispatchEvent(new MouseEvent('mousemove', {bubbles: false, cancelable: false, view: window,
        clientX: 0, clientY: 0, buttons: 0}));
      return result('activity', profile);
    }

    if (profile === 'rdp-secure-access') {
      const page = portalState(document);
      if (!page.product || location.pathname !== '/') return result('unsupported', profile);
      if (page.state === 'login') return result('auth-required', profile);
      if (page.state !== 'authenticated') return result('indeterminate', profile);
      // The portal rotates its session cookie on page requests. Observe the current
      // document only; extra GETs could race its own refresh/favicon requests.
      return result('monitored', profile);
    }

    if (profile === 'guacamole' || profile === 'proxmox-ve') {
      let operation;
      if (profile === 'guacamole') {
        if (!window.Guacamole || typeof window.angular?.element !== 'function') return result('unsupported', profile);
        let service;
        try {
          const injector = window.angular.element(document.documentElement).injector();
          if (!injector) return result('app-loading', profile);
          service = injector.get('authenticationService');
        } catch { return result('unsupported', profile); }
        if (!['getCurrentToken', 'getCurrentUsername', 'isAnonymous', 'request'].every(key => typeof service?.[key] === 'function')) return result('unsupported', profile);
        const token = service.getCurrentToken();
        const username = service.getCurrentUsername();
        if (!token || service.isAnonymous() || username === '') return result('auth-required', profile);
        if (typeof username !== 'string' || !username) return result('app-loading', profile);
        if (location.origin !== expectedOrigin) return result('waiting', profile);
        // This native authenticated read touches session.access() on the server.
        // Unlike updateCurrentToken(), it cannot replace login state after logout/account changes.
        const native = service.request({method: 'GET', url: 'api/session/tunnels', timeout: 15000});
        if (!native || typeof native.then !== 'function') return result('unsupported', profile);
        operation = Promise.resolve(native).then(() => {
          if (!service.getCurrentToken() || service.isAnonymous()) return result('auth-required', profile);
          if (service.getCurrentToken() !== token || service.getCurrentUsername() !== username) return result('busy', profile);
          return result('renewed', profile);
        }, error => {
          const auth = ['INVALID_CREDENTIALS', 'INSUFFICIENT_CREDENTIALS', 'PERMISSION_DENIED'].includes(error?.type) || [401, 403].includes(Number(error?.status));
          return result(auth ? 'auth-required' : 'native-error', profile);
        });
      } else {
        const app = window.Proxmox;
        const ext = window.Ext;
        if (!app || !window.PVE || !ext) return result('app-loading', profile);
        if (app.Setup?.auth_cookie_name !== 'PVEAuthCookie' || typeof app.Utils?.authOK !== 'function' ||
          typeof ext.ComponentQuery?.query !== 'function' || typeof ext.Ajax?.request !== 'function' || typeof ext.decode !== 'function') return result('unsupported', profile);
        let workspace;
        try { workspace = ext.ComponentQuery.query('pveStdWorkspace')[0]; } catch { return result('unsupported', profile); }
        if (!workspace) return result('app-loading', profile);
        if (typeof workspace.updateLoginData !== 'function') return result('unsupported', profile);
        let stored;
        try { stored = app.Utils.getStoredAuth?.(); } catch { return result('unsupported', profile); }
        if (stored?.token) return result('unsupported-auth', profile);
        const ticket = app.Utils.authOK();
        const username = app.UserName;
        if (!ticket || !username) return result('auth-required', profile);
        if (typeof ticket !== 'string' || !ticket.startsWith('PVE:') || ticket.includes('tfa!')) return result('unsupported-auth', profile);
        if (location.origin !== expectedOrigin) return result('waiting', profile);
        operation = new Promise(resolve => {
          try {
            ext.Ajax.request({url: '/api2/json/access/ticket', method: 'POST', timeout: 15000,
              params: {username, password: ticket},
              success(response) {
                try {
                  if (location.origin !== expectedOrigin) { resolve(result('waiting', profile)); return; }
                  const current = detect();
                  if (!current.supported || current.profile !== profile || window.Proxmox !== app ||
                    ext.ComponentQuery.query('pveStdWorkspace')[0] !== workspace) {
                    resolve(result('unsupported', profile)); return;
                  }
                  if (app.LoggedOut || !app.Utils.authOK()) { resolve(result('auth-required', profile)); return; }
                  if (app.UserName !== username || app.Utils.authOK() !== ticket) { resolve(result('busy', profile)); return; }
                  const data = ext.decode(response.responseText)?.data;
                  if (!data || data.NeedTFA || typeof data.ticket !== 'string' || data.ticket.includes('tfa!')) {
                    resolve(result('auth-required', profile)); return;
                  }
                  if (data.username !== username || typeof data.CSRFPreventionToken !== 'string') {
                    resolve(result('native-error', profile)); return;
                  }
                  workspace.updateLoginData(data);
                  resolve(result('renewed', profile, {status: 200}));
                } catch { resolve(result('native-error', profile)); }
              },
              failure(response) {
                resolve(result([401, 403].includes(Number(response?.status)) ? 'auth-required' : 'native-error', profile));
              },
            });
          } catch { resolve(result('native-error', profile)); }
        });
      }
      ownsNativeOperation = true;
      let deadline;
      // A timeout reports uncertainty; it must NOT unlock a still-running native request.
      const settled = operation.then(value => {
        clearTimeout(deadline);
        unlock();
        return value;
      }, () => {
        clearTimeout(deadline);
        unlock();
        return result('native-error', profile);
      });
      const timeout = new Promise(resolve => { deadline = setTimeout(() => resolve(result('timeout', profile)), 15000); });
      return await Promise.race([settled, timeout]);
    }

    if (profile !== 'generic') return result('unsupported', profile);
    const url = new URL(configuredEndpoint || location.href);
    if (url.origin !== expectedOrigin || url.username || url.password) return result('waiting', profile);
    url.hash = '';
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url.href, {method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'manual', signal: controller.signal});
      if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) return result('redirect', profile);
      const status = response.status;
      try { await response.body?.cancel(); } catch { /* Headers already determine the HTTP result. */ }
      return result('http', profile, {status});
    } catch { return result(controller.signal.aborted ? 'timeout' : 'network', profile); }
    finally { clearTimeout(deadline); }
  } catch { return result('native-error', profile); }
  finally { if (!ownsNativeOperation) unlock(); }
}
