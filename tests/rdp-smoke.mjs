import assert from 'node:assert/strict';
import { cp,mkdir,mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { startRdpFixture,RDP_PRIVATE_MARKERS } from './rdp-fixture-server.mjs';

export async function rdpSmoke(source) {
  const temporary=await mkdtemp(path.join(tmpdir(),'keeper-rdp-qa-'));
  const fixture=await startRdpFixture();
  let context;
  try {
    const extensionDir=path.join(temporary,'extension');await mkdir(extensionDir);
    for(const file of ['manifest.json','service-worker.js','core.js','profiles.js','i18n.js','popup.html','popup.js','options.html','options.js','ui.css','ui-shared.js','icons','_locales'])await cp(path.join(source,file),path.join(extensionDir,file),{recursive:true});
    const manifestPath=path.join(extensionDir,'manifest.json');
    const manifest=JSON.parse(await readFile(manifestPath,'utf8'));manifest.host_permissions=['http://127.0.0.1/*'];
    await writeFile(manifestPath,JSON.stringify(manifest));
    context=await chromium.launchPersistentContext(path.join(temporary,'profile'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extensionDir}`,`--load-extension=${extensionDir}`]});
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
    const extensionId=new URL(worker.url()).host;
    const control=await context.newPage();await control.goto(`chrome-extension://${extensionId}/options.html`);
    const api=request=>control.evaluate(message=>chrome.runtime.sendMessage(message),request);
    const ok=result=>{assert.equal(result?.ok,true,JSON.stringify(result));return result;};
    const idOf=page=>control.evaluate(async url=>(await chrome.tabs.query({})).find(tab=>tab.url===url)?.id,page.url());
    const getState=id=>api({type:'getState',tabId:id}).then(ok);
    async function until(test,reason){for(let attempt=0;attempt<100;attempt++){if(await test())return;await sleep(100);}throw new Error(reason);}
    async function activate(id,endpoint=''){ok(await api({type:'setTab',tabId:id,enabled:true,intervalMinutes:30,endpoint}));}
    const cookie=async()=> (await context.cookies(fixture.origin)).find(item=>item.name==='fixture_rdp_sid')?.value;
    async function seed(){await context.addCookies([{name:'fixture_rdp_sid',value:fixture.seedAuthenticatedSession(),url:fixture.origin,httpOnly:true,sameSite:'Lax'}]);}
    async function privateMetadata(id){
      const snapshot=await getState(id);
      const saved=await control.evaluate(async()=>({session:await chrome.storage.session.get(null),local:await chrome.storage.local.get(null)}));
      const serialized=JSON.stringify({runtime:snapshot.runtime,effective:snapshot.effective,saved});
      for(const marker of RDP_PRIVATE_MARKERS)assert.equal(serialized.includes(marker),false,'Portal identity, form or cookie entered extension metadata');
    }
    async function warning(id){assert.equal(await control.evaluate(tabId=>chrome.action.getBadgeText({tabId}),id),'!');assert.equal((await getState(id)).effective.iconState,'off');}

    await seed();
    const site=await context.newPage();const errors=[];site.on('pageerror',error=>errors.push(error.message));
    await site.goto(`${fixture.origin}/?tab=`);await site.locator('#draft').fill('Dieser Formularentwurf bleibt erhalten.');
    await site.evaluate(()=>history.replaceState(null,'','/?action=logout&command=restart&systemid=123&userid=456#draft'));
    const id=await idOf(site),loadedAt=await site.locator('#loaded').getAttribute('data-at');
    const baseline=await site.evaluate(()=>({scripts:fixtureResponseExecutions,updates:fixtureUpdateStatusCalls,input:fixtureInputEvents}));
    const beforeRequests=fixture.requests.length,beforeCookie=await cookie();
    await activate(id);
    for(let attempt=0;attempt<3;attempt++)ok(await api({type:'testNow',tabId:id}));
    const monitored=await getState(id);
    assert.equal(monitored.runtime.profile,'rdp-secure-access');assert.equal(monitored.runtime.method,'monitor');
    assert.equal(monitored.runtime.status,'success');assert.equal(monitored.runtime.httpStatus,null);
    assert.equal(monitored.runtime.attempts.at(-1).kind,'monitored');assert.equal(monitored.effective.intervalMinutes,30);
    assert.equal((await control.evaluate(tabId=>chrome.alarms.get(`keeper-tab:${tabId}`),id)).periodInMinutes,3);
    assert.equal(fixture.requests.length,beforeRequests,'Monitor activation/test must send no request');
    assert.equal(await cookie(),beforeCookie,'Monitor must not rotate browser session cookie');
    assert.equal(await site.locator('#draft').inputValue(),'Dieser Formularentwurf bleibt erhalten.');
    assert.equal(await site.locator('#loaded').getAttribute('data-at'),loadedAt);
    assert.deepEqual(await site.evaluate(()=>({scripts:fixtureResponseExecutions,updates:fixtureUpdateStatusCalls,input:fixtureInputEvents})),baseline);
    assert.deepEqual(fixture.commands,[]);await privateMetadata(id);
    console.log('PASS RDP monitor checks authenticated DOM at three-minute cadence with zero requests, native calls, input events, cookie changes or lost draft');

    // A normal page navigation is still authenticated because monitoring did
    // not consume/replace the session ID used by the application.
    await site.goto(`${fixture.origin}/?tab=`);await site.locator('#auth-state').waitFor();
    const nativeCookie=await cookie();assert.notEqual(nativeCookie,beforeCookie);
    assert.equal(nativeCookie,fixture.state.authenticatedSession);
    console.log('PASS Ordinary portal navigation retains authentication after zero-network monitoring in rotating-session fixture');

    fixture.expireSession();
    await site.reload();await site.locator('form[method="post"]').waitFor();
    const loginRequests=fixture.requests.length;
    if((await getState(id)).runtime.status!=='paused')ok(await api({type:'testNow',tabId:id}));
    assert.equal((await getState(id)).runtime.status,'paused');await warning(id);
    assert.equal(fixture.requests.length,loginRequests,'Visible login check must not perform an extra GET');
    await privateMetadata(id);
    console.log('PASS Natural HTTP-200 login navigation becomes a visible-DOM auth pause with warning and no extra request');

    const alreadyLogin=await context.newPage();await alreadyLogin.goto(`${fixture.origin}/?tab=`);
    const loginId=await idOf(alreadyLogin),beforeAlreadyLogin=fixture.requests.length;
    await activate(loginId);assert.equal((await getState(loginId)).runtime.attempts.at(-1).kind,'auth-required');
    assert.equal(fixture.requests.length,beforeAlreadyLogin);await warning(loginId);await privateMetadata(loginId);await alreadyLogin.close();
    console.log('PASS Already-visible login form pauses immediately without GET, HEAD, POST or auto-login');

    await site.evaluate(()=>{document.querySelector('form').remove();const note=document.createElement('p');note.id='maintenance';note.textContent='Unknown application state';document.body.append(note);});
    const beforeUnknown=fixture.requests.length;ok(await api({type:'resumeTab',tabId:id}));
    const unknown=await getState(id);assert.equal(unknown.runtime.status,'paused');assert.equal(unknown.runtime.attempts.at(-1).kind,'indeterminate');
    assert.equal(unknown.runtime.httpStatus,null);assert.equal(fixture.requests.length,beforeUnknown);await warning(id);
    console.log('PASS Branded unknown DOM pauses as indeterminate without network or false HTTP-success status');

    const beforeCustom=fixture.requests.length;await activate(id,'/custom');
    const custom=await getState(id);assert.equal(custom.runtime.profile,'generic');assert.equal(custom.runtime.method,'request');
    assert.equal(custom.runtime.status,'success');assert.equal(custom.runtime.httpStatus,200);
    assert.equal((await control.evaluate(tabId=>chrome.alarms.get(`keeper-tab:${tabId}`),id)).periodInMinutes,30);
    assert.deepEqual(fixture.requests.slice(beforeCustom).map(request=>({method:request.method,path:request.path})),[{method:'GET',path:'/custom'}]);
    await privateMetadata(id);assert.deepEqual(fixture.commands,[]);assert.equal(errors.length,0,errors.join('\n'));
    console.log('PASS Explicit custom URL deliberately bypasses monitor profile and keeps generic GET semantics');

    // Reproduce the old full-portal-GET hazard in a controlled local protocol.
    // Both requests capture the same cookie; releases establish response order.
    await seed();
    const legacy=await context.newPage();await legacy.goto(`${fixture.origin}/?tab=`);await legacy.locator('#auth-state').waitFor();
    const original=await cookie();
    const raced=legacy.evaluate(async()=>{
      window.fixtureRaceCompleted=[];
      const run=async label=>{const response=await fetch(`/?tab=&fixture-race=${label}`,{credentials:'same-origin',cache:'no-store'});const body=await response.text();window.fixtureRaceCompleted.push(label);return{label,status:response.status,login:body.includes('name="password"')};};
      return Promise.all([run('first'),run('second')]);
    });
    await until(()=>fixture.racePending.has('first')&&fixture.racePending.has('second'),'Legacy race requests did not reach fixture');
    const participants=fixture.requests.filter(request=>request.parameters['fixture-race']);
    assert.equal(participants.length,2);assert.ok(participants.every(request=>request.incoming===original));
    fixture.releaseRace('first');await legacy.waitForFunction(()=>window.fixtureRaceCompleted.includes('first'));
    const authenticatedCookie=await cookie();assert.notEqual(authenticatedCookie,original);assert.equal(authenticatedCookie,fixture.state.authenticatedSession);
    fixture.releaseRace('second');const outcomes=await raced;
    assert.deepEqual(outcomes.map(result=>[result.status,result.login]),[[200,false],[200,true]]);
    const overwrittenCookie=await cookie();assert.notEqual(overwrittenCookie,authenticatedCookie);assert.notEqual(overwrittenCookie,fixture.state.authenticatedSession);
    await legacy.goto(`${fixture.origin}/?tab=`);await legacy.locator('form[method="post"]').waitFor();
    assert.deepEqual(fixture.commands,[]);
    console.log('PASS Controlled legacy concurrent portal GETs rotate then overwrite the authenticated cookie; next native navigation gets HTTP-200 login, unlike monitor control');
  }finally{await context?.close();await fixture.close();await rm(temporary,{recursive:true,force:true});}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await rdpSmoke(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));
