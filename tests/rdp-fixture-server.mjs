import http from 'node:http';

export const RDP_PRIVATE_MARKERS = [
  'FAKE_RDP_IDENTITY_DO_NOT_EXPORT',
  'FAKE_RDP_PASSWORD_DO_NOT_EXPORT',
  'FAKE_RDP_TFA_DO_NOT_EXPORT',
  'FAKE_RDP_HTTPONLY_SESSION_',
];

const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';

function html(mode) {
  const content = mode === 'login' ? `<form action="/" method="post">
    <input name="username" type="text" value="${RDP_PRIVATE_MARKERS[0]}">
    <input name="password" type="password" value="${RDP_PRIVATE_MARKERS[1]}">
    <input name="2fa" type="password" value="${RDP_PRIVATE_MARKERS[2]}">
    <button type="submit" name="Anmelden">Anmelden</button></form>` : mode === 'unknown'
    ? '<p id="maintenance">Application state is unknown.</p>'
    : `<p id="auth-state">Sie sind angemeldet als <b>${RDP_PRIVATE_MARKERS[0]}</b></p>
      <a href="?action=logout">Abmelden</a><a href="?tab=">Aktualisieren</a>
      <label>Ungespeicherte Notiz <input id="draft"></label>
      <p id="loaded" data-at="${Date.now()}">Dokument bleibt erhalten</p>`;
  return `<!doctype html><html lang="de"><head><meta charset="utf-8">
    <title>RDP Secure Access - Web Protection Technology</title>
    <link rel="icon" href="data:image/png;base64,${pixel}">
    <meta http-equiv="refresh" content="600;url=/?tab=">
    </head><body onload="UpdateStatus()">
    <img id="sllogo" src="/img/sec_acs_logo_wht.png" alt="Secure Access">
    ${content}<footer>Web Protection Technology</footer>
    <script>
      window.fixtureResponseExecutions=(window.fixtureResponseExecutions||0)+1;
      window.fixtureUpdateStatusCalls=window.fixtureUpdateStatusCalls||0;
      window.fixtureInputEvents=window.fixtureInputEvents||0;
      window.UpdateStatus=()=>{window.fixtureUpdateStatusCalls++;};
      for(const type of ['click','keyup','mousemove'])document.addEventListener(type,()=>{window.fixtureInputEvents++;});
    </script></body></html>`;
}

/**
 * Controlled protocol model, not an implementation of the real portal.
 * A valid HTML GET rotates and invalidates its old session ID. An overlapping
 * stale-ID GET returns login HTML and sets a different anonymous ID. This makes
 * the consequences of an extra portal GET reproducible without live access.
 */
export async function startRdpFixture() {
  const state = { mode: 'authenticated', authenticatedSession: null, generation: 0 };
  const requests = [], commands = [], racePending = new Map();
  const nextId = () => `${RDP_PRIVATE_MARKERS[3]}${++state.generation}`;
  const seedAuthenticatedSession = () => {
    state.mode = 'authenticated';
    state.authenticatedSession = nextId();
    return state.authenticatedSession;
  };
  const releaseRace = label => { const resolve = racePending.get(label); racePending.delete(label); resolve?.(); };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    const parameters = Object.fromEntries(url.searchParams);
    const incoming = /(?:^|;\s*)fixture_rdp_sid=([^;]+)/.exec(req.headers.cookie || '')?.[1] || null;
    const record = { method: req.method, path: url.pathname, parameters, at: Date.now(), incoming };
    requests.push(record);
    if (['action','command','systemid','userid'].some(name=>url.searchParams.has(name)) || req.method !== 'GET') commands.push(record);
    res.setHeader('Cache-Control','no-store');
    if (url.pathname === '/img/sec_acs_logo_wht.png') {
      res.writeHead(200,{'Content-Type':'image/png'});res.end(Buffer.from(pixel,'base64'));return;
    }
    if (url.pathname === '/custom') {
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html('login'));return;
    }
    if (url.pathname === '/') {
      const race = url.searchParams.get('fixture-race');
      if (race) await new Promise(resolve=>racePending.set(race,resolve));
      if (res.destroyed) return;
      const authenticated = state.mode === 'authenticated' && incoming && incoming === state.authenticatedSession;
      const outgoing = nextId();
      if (authenticated) state.authenticatedSession = outgoing;
      record.authenticated = Boolean(authenticated);
      record.outgoing = outgoing;
      res.setHeader('Set-Cookie',`fixture_rdp_sid=${outgoing}; Path=/; HttpOnly; SameSite=Lax`);
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
      res.end(html(state.mode === 'unknown' ? 'unknown' : authenticated ? 'authenticated' : 'login'));
      return;
    }
    res.writeHead(404);res.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {
    origin:`http://127.0.0.1:${server.address().port}`,state,requests,commands,racePending,
    seedAuthenticatedSession,releaseRace,
    expireSession:()=>{state.authenticatedSession=null;},
    close:async()=>{for(const label of [...racePending.keys()])releaseRace(label);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));},
  };
}
