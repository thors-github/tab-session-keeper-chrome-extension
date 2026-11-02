import http from 'node:http';
import { randomUUID } from 'node:crypto';

/** Dummy authentication only. No real credentials or external requests. */
export async function startFixture({ idleMs = 2000, absoluteMs = 12000, btIdleMs = idleMs, activityThrottleMs = 250 } = {}) {
  const sessions = new Map();
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    const now = Date.now();
    const sid = /(?:^|;\s*)fixture_sid=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    const session = sid && sessions.get(sid);
    const authenticated = session && now - session.lastSeen < session.idleMs && now - session.createdAt < session.absoluteMs;
    const btAuthenticated = session && now - session.btLastActivity < session.btIdleMs && now - session.createdAt < session.absoluteMs;
    requests.push({ path: url.pathname, method: req.method, sid: sid || null, authenticated: Boolean(authenticated), btAuthenticated: Boolean(btAuthenticated), at: now });
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/login') {
      const id = randomUUID();
      const expiresAfter = Math.max(1, Number(url.searchParams.get('absoluteMs')) || absoluteMs);
      const idleAfter = Math.max(1, Number(url.searchParams.get('idleMs')) || idleMs);
      sessions.set(id, { createdAt: now, lastSeen: now, btLastActivity: now, idleMs: idleAfter, absoluteMs: expiresAfter, btIdleMs: Number(url.searchParams.get('btIdleMs')) || btIdleMs });
      res.setHeader('Set-Cookie', `fixture_sid=${id}; Path=/; HttpOnly; SameSite=Lax`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Fixture Anmeldung</title><a href="/app">Anwendung öffnen</a>');
      return;
    }
    if (url.pathname === '/logout') {
      sessions.delete(sid);
      res.setHeader('Set-Cookie', 'fixture_sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
      res.writeHead(200); res.end('Abgemeldet'); return;
    }
    if (url.pathname === '/unauthorized' || url.pathname === '/forbidden') {
      res.writeHead(url.pathname === '/unauthorized' ? 401 : 403); res.end('Zugriff verweigert'); return;
    }
    if (url.pathname === '/redirect') {
      res.writeHead(302, { Location: '/login' }); res.end(); return;
    }
    if (url.pathname === '/slow') {
      const timer = setTimeout(() => { res.writeHead(200); res.end('Langsame Antwort'); }, 20000);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    if (url.pathname === '/bt-status') {
      res.writeHead(btAuthenticated ? 204 : 401); res.end(); return;
    }
    if (url.pathname === '/bt-activity') {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      if (!btAuthenticated) { res.writeHead(401); res.end('Aktivitätssitzung abgelaufen'); return; }
      session.btLastActivity = now;
      res.writeHead(204); res.end(); return;
    }
    if (url.pathname === '/console' || url.pathname.startsWith('/console/')) {
      // Deliberately static HTTP 200: fetching the application shell does NOT
      // renew the separate activity timeout. Only its window handler does that.
      const signedIn = btAuthenticated && url.searchParams.get('loggedOut') !== '1';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html lang="de"><meta charset="utf-8"><title>Aktivitätsgesteuerte Testkonsole</title>
        <bt-app-component>${signedIn ? '<bt-app-header-menu>Angemeldet</bt-app-header-menu>' : '<bt-login-view><input type="password" aria-label="Anmeldung"></bt-login-view>'}</bt-app-component>
        <h1>Testkonsole</h1><input id="draft" aria-label="Ungespeicherte Notiz"><canvas id="remote-canvas" width="300" height="150"></canvas><p id="loaded" data-at="${now}">Geladen ${now}</p>
        <script>
          window.fixtureActivity = {accepted:0,windowMoves:0,canvasMoves:0,canvasClicks:0,canvasKeys:0,lastAt:-Infinity};
          const canvas = document.querySelector('#remote-canvas');
          canvas.addEventListener('mousemove',()=>window.fixtureActivity.canvasMoves++);
          canvas.addEventListener('click',()=>window.fixtureActivity.canvasClicks++);
          canvas.addEventListener('keyup',()=>window.fixtureActivity.canvasKeys++);
          const activity = async event => {
            if(event.type==='mousemove') window.fixtureActivity.windowMoves++;
            if(!document.querySelector('bt-app-header-menu')) return;
            const state=window.fixtureActivity, now=performance.now();
            if(now-state.lastAt<${Number(activityThrottleMs)}) return;
            state.lastAt=now;
            const response=await fetch('/bt-activity',{method:'POST',credentials:'same-origin'});
            if(response.ok) state.accepted++;
          };
          // Scaled test throttle; production evidence observed 30 seconds.
          for(const type of ['click','mousemove','keyup']) window.addEventListener(type,activity);
        </script></html>`);
      return;
    }
    if (url.pathname === '/heartbeat' || url.pathname === '/app') {
      if (!authenticated) { res.writeHead(401); res.end('Sitzung abgelaufen'); return; }
      session.lastSeen = now;
      if (url.pathname === '/heartbeat') {
        res.writeHead(204); res.end(); return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html lang="de"><meta charset="utf-8"><title>Keep-alive Testanwendung</title><h1>Testanwendung</h1><label>Ungespeicherte Notiz <input id="draft" value=""></label><p id="loaded" data-at="${now}">Geladen ${now}</p></html>`);
      return;
    }
    if (url.pathname === '/login-page-200') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Anmeldung erforderlich</title><h1>Bitte anmelden</h1>'); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Fixture Kontrollseite</title><h1>Kontrollseite</h1><input id="draft">');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin, sessions, requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
