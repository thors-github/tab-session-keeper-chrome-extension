import http from 'node:http';

// Behavioral test doubles grounded in these pinned upstream implementations:
export const NATIVE_SOURCES = {
  guacamole: 'https://github.com/apache/guacamole-client/blob/31d2a6f6accc5ed4fecd491c30fc51728db940eb/guacamole/src/main/frontend/src/app/auth/service/authenticationService.js',
  guacamoleDOM: 'https://github.com/apache/guacamole-client/blob/31d2a6f6accc5ed4fecd491c30fc51728db940eb/guacamole/src/main/frontend/src/index.html',
  guacamoleSession: 'https://github.com/apache/guacamole-client/blob/31d2a6f6accc5ed4fecd491c30fc51728db940eb/guacamole/src/main/java/org/apache/guacamole/rest/session/SessionResource.java',
  proxmox: 'https://github.com/proxmox/pve-manager/blob/c79d601b09c00f1b7a7d0ef7ec0fc9326038298e/www/manager6/Workspace.js',
  proxmoxAuth: 'https://github.com/proxmox/proxmox-widget-toolkit/blob/d353f9466dee3e6c35a8af26e83899a6a580169c/src/Utils.js',
};

export const PRIVATE_MARKERS = [
  'FAKE_GUAC_TOKEN_DO_NOT_EXPORT', 'FAKE_PVE_TICKET_DO_NOT_EXPORT',
  'FAKE_CSRF_DO_NOT_EXPORT', 'fixture-identity@not-real.invalid',
  'FAKE_API_TOKEN',
  'fixture-account-b@not-real.invalid',
];

function page(platform, mode) {
  const guac = platform === 'guacamole';
  return `<!doctype html><html ${guac ? 'ng-app="index" ng-controller="indexController"' : ''}>
    <head><meta charset="utf-8"><meta name="build" content="fixture"><title>${guac ? 'Apache Guacamole' : 'Proxmox Virtual Environment'}</title><script src="${guac ? '/guacamole/guacamole-common-js/all.min.js' : '/pve2/js/pvemanagerlib.js'}"></script></head>
    <body class="${guac ? 'main' : 'x-viewport'}">
    ${guac ? '<guac-client-panel><div class="client" id="guac-display"></div></guac-client-panel>' : '<form id="history-form"></form><div id="pve-content" class="pve-std-workspace"></div>'}
    <label>Draft <input id="draft"></label><canvas id="remote-canvas" width="200" height="100"></canvas><p id="loaded"></p>
    <script>
      const initialMode=${JSON.stringify(mode)};
      const native = window.fixtureNative = {
        platform:${JSON.stringify(platform)}, mode:initialMode, calls:0, updates:0,idleAccesses:0,unsafeUpdateCalls:0,
        remoteMoves:0, remoteClicks:0, remoteKeys:0, windowMoves:0, active:0, maxActive:0,
        token:'FAKE_GUAC_TOKEN_DO_NOT_EXPORT_1', ticket:'PVE:FAKE_PVE_TICKET_DO_NOT_EXPORT_1',
        csrf:'FAKE_CSRF_DO_NOT_EXPORT_1', username:'fixture-identity@not-real.invalid', pending:[],
      };
      document.querySelector('#loaded').textContent=String(performance.timeOrigin);
      const canvas=document.querySelector('#remote-canvas');
      canvas.addEventListener('mousemove',()=>native.remoteMoves++);
      canvas.addEventListener('click',()=>native.remoteClicks++);
      canvas.addEventListener('keyup',()=>native.remoteKeys++);
      window.addEventListener('mousemove',()=>native.windowMoves++);
      native.releasePending=()=>native.pending.splice(0).forEach(resolve=>resolve());
      const delay=()=>new Promise(resolve=>native.pending.push(resolve));
      const begin=async()=>{
        native.calls++; native.active++; native.maxActive=Math.max(native.maxActive,native.active);
        if(native.mode==='hang') await delay();
        if(native.mode==='authfail') throw {status:403,type:'INVALID_CREDENTIALS',message:native.token};
      };
      function installGuacamole(){
        native.platform='guacamole';
        const authenticationService={
          getCurrentToken:()=>native.mode==='logged-out'?null:native.token,
          getCurrentUsername:()=>native.mode==='anonymous'?'':native.username,
          isAnonymous:()=>native.mode==='anonymous',
          updateCurrentToken:()=>{native.unsafeUpdateCalls++;throw new Error('Unsafe token mutation must never be called');},
          request:async options=>{
            const capturedToken=native.token;
            try {
              await begin();
              const response=await fetch(options.url,{method:options.method||'GET',headers:{'Guacamole-Token':capturedToken}});
              if(!response.ok) throw {status:response.status,type:'INVALID_CREDENTIALS'};
              const data=await response.json();
              native.idleAccesses++;
              return data;
            } finally {native.active--;}
          },
        };
        if(native.mode==='missing') delete authenticationService.request;
        const injector={get:name=>{if(name!=='authenticationService') throw new Error('Unknown service');return authenticationService;}};
        window.angular={element:()=>({injector:()=>native.mode==='no-injector'?undefined:injector}),noop:()=>{}};
        window.Guacamole={Version:'fixture'};
      }
      function installProxmox(){
        native.platform='proxmox-ve';
        const workspace={xtype:'pveStdWorkspace',isXType:type=>['pveStdWorkspace','pveWorkspace'].includes(type),
          loginData:{ticket:native.ticket,username:native.username},
          updateLoginData(data){this.loginData=data;window.Proxmox.Utils.setAuthData(data);native.updates++;},
        };
        if(native.mode==='missing') delete workspace.updateLoginData;
        window.PVE={Workspace:function(){},StdWorkspace:function(){}};
        window.Proxmox={UserName:native.mode==='logged-out'?'':native.username,LoggedOut:native.mode==='logged-out',
          CSRFPreventionToken:native.csrf,Setup:{auth_cookie_name:'PVEAuthCookie'},
          Utils:{
            authOK:()=>native.mode==='logged-out'?false:native.mode==='api-token'?'PVEAPIToken=fixture!token=FAKE_API_TOKEN':native.mode==='tfa'?'PVE:tfa!fixture':native.ticket,
            getStoredAuth:()=>native.mode==='api-token'?{token:'PVEAPIToken=fixture!token=FAKE_API_TOKEN'}:{},
            setAuthData(data){native.ticket=data.ticket;native.csrf=data.CSRFPreventionToken;native.username=data.username;window.Proxmox.UserName=data.username;window.Proxmox.CSRFPreventionToken=data.CSRFPreventionToken;document.cookie='PVEAuthCookie='+encodeURIComponent(data.ticket)+';Path=/;SameSite=Lax';},
          },
        };
        window.Ext={
          ComponentQuery:{query:selector=>selector==='pveStdWorkspace'?[workspace]:[]},
          decode:JSON.parse,
          Ajax:{request(options){
            const controller=new AbortController();
            (async()=>{
              try {
                await begin();
                const response=await fetch(options.url,{method:options.method||'GET',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(options.params),signal:controller.signal});
                const text=await response.text();
                const result={status:response.status,responseText:text};
                if(response.ok) options.success?.(result,options); else options.failure?.(result,options);
              } catch(error){options.failure?.({status:error.status||0,responseText:''},options);}
              finally {native.active--;}
            })();
            return {abort:()=>controller.abort()};
          }},
          util:{Cookies:{get:()=>native.ticket,set:()=>{}}},
        };
      }
      native.installGuacamole=installGuacamole;
      native.installProxmox=installProxmox;
      ${guac ? 'installGuacamole();' : 'installProxmox();'}
    </script></body></html>`;
}

export async function startNativeFixture() {
  const requests = [];
  let guacGeneration = 1, pveGeneration = 1;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    requests.push({ path: url.pathname, method: req.method, at: Date.now() });
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname.endsWith('.js')) {
      res.writeHead(200, {'Content-Type':'application/javascript'});res.end('/* Native profile fixture fingerprint only. */');return;
    }
    if (url.pathname === '/guacamole/api/session/tunnels') {
      if(req.method!=='GET'||!req.headers['guacamole-token']?.startsWith(PRIVATE_MARKERS[0])){res.writeHead(403);res.end('{}');return;}
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({'fixture-tunnel':{name:PRIVATE_MARKERS[3],identifier:'not-a-real-tunnel'}}));return;
    }
    if (url.pathname === '/guacamole/' || url.pathname === '/pve/') {
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
      res.end(page(url.pathname === '/guacamole/' ? 'guacamole' : 'proxmox-ve', url.searchParams.get('mode') || 'normal'));
      return;
    }
    if (url.pathname === '/guacamole/api/tokens' || url.pathname === '/api2/json/access/ticket') {
      let body='';
      for await (const chunk of req) body+=chunk;
      const params=new URLSearchParams(body);
      if (req.method!=='POST') {res.writeHead(405);res.end();return;}
      res.setHeader('Content-Type','application/json');
      if (url.pathname === '/guacamole/api/tokens') {
        if(!params.get('token')?.startsWith(PRIVATE_MARKERS[0])){res.writeHead(403);res.end('{}');return;}
        res.end(JSON.stringify({authToken:`${PRIVATE_MARKERS[0]}_${++guacGeneration}`,username:PRIVATE_MARKERS[3],dataSource:'fixture'}));
      } else {
        if(!params.get('password')?.startsWith('PVE:FAKE_PVE_TICKET_DO_NOT_EXPORT')||!params.get('username')){res.writeHead(403);res.end('{}');return;}
        res.end(JSON.stringify({data:{ticket:`PVE:${PRIVATE_MARKERS[1]}_${++pveGeneration}`,CSRFPreventionToken:`${PRIVATE_MARKERS[2]}_${pveGeneration}`,username:PRIVATE_MARKERS[3],cap:{}}}));
      }
      return;
    }
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    res.end('<!doctype html><title>Generic fixture</title><input id="draft">');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {origin:`http://127.0.0.1:${server.address().port}`,requests,
    close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
