import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { startNativeFixture, PRIVATE_MARKERS } from './native-fixture-server.mjs';

export async function newProfilesSmoke(source) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'keeper-native-qa-'));
  const fixture = await startNativeFixture();
  let context;
  try {
    const extensionDir = path.join(temporary, 'extension');
    await mkdir(extensionDir);
    for (const file of ['manifest.json','service-worker.js','core.js','profiles.js','i18n.js','popup.html','popup.js','options.html','options.js','ui.css','ui-shared.js','icons','_locales']) {
      await cp(path.join(source,file),path.join(extensionDir,file),{recursive:true});
    }
    const manifestPath=path.join(extensionDir,'manifest.json');
    const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
    manifest.host_permissions=['http://127.0.0.1/*'];
    await writeFile(manifestPath,JSON.stringify(manifest));
    const launch=()=>chromium.launchPersistentContext(path.join(temporary,'profile'),{
      channel:'chromium',headless:true,args:[`--disable-extensions-except=${extensionDir}`,`--load-extension=${extensionDir}`],
    });
    context=await launch();
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
    const extensionId=new URL(worker.url()).host;
    let control=await context.newPage();
    await control.goto(`chrome-extension://${extensionId}/options.html`);
    let api=request=>control.evaluate(message=>chrome.runtime.sendMessage(message),request);
    const results=[],errors=[];
    const ok=result=>{results.push(result);assert.equal(result?.ok,true,JSON.stringify(result));return result;};
    const tabId=page=>control.evaluate(async url=>(await chrome.tabs.query({})).find(tab=>tab.url===url)?.id,page.url());
    const state=id=>api({type:'getState',tabId:id}).then(ok);
    async function until(test,description){for(let attempt=0;attempt<100;attempt++){if(await test())return;await sleep(100);}throw new Error(description);}
    async function open(platform,mode='normal'){
      const page=await context.newPage();
      page.on('pageerror',error=>errors.push(error.message));
      await page.goto(`${fixture.origin}/${platform==='guacamole'?'guacamole':'pve'}/?mode=${mode}`);
      const id=await tabId(page);
      return {page,id};
    }
    async function activate(id,intervalMinutes=30){ok(await api({type:'setTab',tabId:id,enabled:true,intervalMinutes,endpoint:''}));}
    async function assertMetadataOnly(){
      const saved=await control.evaluate(async()=>({local:await chrome.storage.local.get(null),session:await chrome.storage.session.get(null)}));
      const serialized=JSON.stringify({saved,results,errors});
      for(const marker of PRIVATE_MARKERS)assert.equal(serialized.includes(marker),false,`Private native data crossed extension boundary: ${marker}`);
    }

    let guac;
    for(const platform of ['guacamole','proxmox-ve']){
      const current=await open(platform);
      await current.page.locator('#draft').fill('Native renewal must preserve this draft.');
      const loaded=await current.page.locator('#loaded').innerText();
      await activate(current.id);
      await until(async()=> (await state(current.id)).runtime.status==='success',`${platform} did not renew`);
      const result=await state(current.id);
      assert.equal(result.runtime.profile,platform);
      assert.equal(result.runtime.method,'renewal');
      assert.equal(result.effective.intervalMinutes,30);
      const alarm=await control.evaluate(id=>chrome.alarms.get(`keeper-tab:${id}`),current.id);
      assert.equal(alarm.periodInMinutes,platform==='guacamole'?5:15);
      const native=await current.page.evaluate(()=>window.fixtureNative);
      if(platform==='guacamole'){
        assert.ok(native.idleAccesses>0);
        assert.equal(native.updates,0);
        assert.equal(native.unsafeUpdateCalls,0);
        assert.equal(native.token,`${PRIVATE_MARKERS[0]}_1`);
      }
      else{
        assert.ok(native.updates>0);
        assert.notEqual(native.ticket,`PVE:${PRIVATE_MARKERS[1]}_1`);
        assert.equal(await current.page.evaluate(()=>Proxmox.CSRFPreventionToken),native.csrf);
      }
      assert.deepEqual([native.remoteMoves,native.remoteClicks,native.remoteKeys,native.windowMoves],[0,0,0,0]);
      assert.equal(await current.page.locator('#draft').inputValue(),'Native renewal must preserve this draft.');
      assert.equal(await current.page.locator('#loaded').innerText(),loaded);
      assert.equal(await control.evaluate(id=>chrome.action.getBadgeText({tabId:id}),current.id),'On');
      if(platform==='guacamole')guac=current;else await current.page.close();
      await assertMetadataOnly();
      console.log(`PASS ${platform}: native session operation succeeds, caps cadence, preserves document, sends no remote input and exports metadata only`);
    }

    // Catalog simulation is confined to disposable extension pages. macOS does
    // not reliably change chrome.i18n's UI language through Chromium --lang.
    for(const locale of ['en','de','fr']){
      const catalog=JSON.parse(await readFile(path.join(source,'_locales',locale==='de'?'de':'en','messages.json'),'utf8'));
      const popup=await context.newPage();
      await popup.setViewportSize({width:400,height:600});
      await popup.emulateMedia({reducedMotion:'reduce'});
      await popup.addInitScript(({locale,catalog})=>{
        function message(catalog,key,substitutions=[]){
          const entry=catalog[key];if(!entry)return '';
          const args=Array.isArray(substitutions)?substitutions:[substitutions];
          return entry.message.replace(/\$([a-zA-Z_][\w]*)\$/g,(_,name)=>{
            const placeholder=Object.entries(entry.placeholders||{}).find(([key])=>key.toLowerCase()===name.toLowerCase())?.[1];
            return (placeholder?.content||'').replace(/\$(\d+)/g,(__,index)=>String(args[Number(index)-1]??''));
          }).replace(/\$(\d+)/g,(_,index)=>String(args[Number(index)-1]??''));
        }
        chrome.i18n.getUILanguage=()=>locale;
        chrome.i18n.getMessage=(key,args)=>message(catalog,key,args);
      },{locale,catalog});
      await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${guac.id}`);
      await until(async()=> (await popup.locator('#method-summary').innerText()).includes('Guacamole'),'Localized native summary absent');
      assert.equal(await popup.locator('html').getAttribute('lang'),locale==='de'?'de':'en');
      assert.equal(await popup.locator('#tab-enabled').isChecked(),true);
      assert.match(await popup.locator('#keeper-logo').getAttribute('src'),/on128\.png$/);
      assert.equal(await popup.locator('#test-now').innerText(),locale==='de'?'Jetzt testen':'Test now');
      await popup.evaluate(async()=>{for(const animation of document.getAnimations()){try{animation.finish();}catch{}}await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
      if(locale!=='fr')await popup.screenshot({path:path.join(tmpdir(),`tab-session-keeper-1.2-popup-${locale}.png`),fullPage:false});
      await popup.close();
    }
    console.log('PASS Disposable catalog simulation: English, German and unsupported-language English fallback; active native popup screenshots');
    await guac.page.close();

    for(const [platform,mode] of [['guacamole','anonymous'],['guacamole','logged-out'],['guacamole','missing'],['guacamole','no-injector'],['proxmox-ve','api-token'],['proxmox-ve','tfa'],['proxmox-ve','missing'],['proxmox-ve','logged-out']]){
      const current=await open(platform,mode);
      const before=fixture.requests.length;
      await activate(current.id);
      const result=await state(current.id);
      assert.notEqual(result.runtime.status,'success',`${platform}/${mode} unexpectedly succeeded`);
      assert.equal(await current.page.evaluate(()=>window.fixtureNative.calls),0);
      assert.equal(fixture.requests.slice(before).some(request=>request.method==='POST'),false);
      assert.equal(fixture.requests.slice(before).some(request=>request.path===`/${platform==='guacamole'?'guacamole':'pve'}/`),false,'Unsupported native profile must not silently fetch shell');
      const badge=await control.evaluate(id=>chrome.action.getBadgeText({tabId:id}),current.id);
      assert.equal(badge,result.effective.warning?'!':result.effective.iconState==='on'?'On':'');
      await current.page.close();
    }
    console.log('PASS Anonymous/logged-out Guacamole, missing capabilities, API tokens and TFA are excluded without fallback shell requests');

    const rejected=await open('guacamole','authfail');
    await activate(rejected.id);
    assert.equal((await state(rejected.id)).runtime.status,'paused');
    await assertMetadataOnly();
    await rejected.page.close();
    console.log('PASS Native authentication rejection pauses and discards sensitive exception text');

    for(const platform of ['guacamole','proxmox-ve']){
      for(const transition of ['logout','account-switch']){
        const current=await open(platform,'hang');
        const started=api({type:'setTab',tabId:current.id,enabled:true,intervalMinutes:30,endpoint:''});
        await current.page.waitForFunction(()=>window.fixtureNative.active===1);
        const expected=await current.page.evaluate(transition=>{
          const native=window.fixtureNative;
          if(transition==='logout'){
            native.mode='logged-out';native.token=null;native.ticket=null;native.username=null;native.csrf=null;
            if(window.Proxmox){Proxmox.LoggedOut=true;Proxmox.UserName='';Proxmox.CSRFPreventionToken=null;}
          }else{
            native.mode='normal';native.token='FAKE_GUAC_TOKEN_DO_NOT_EXPORT_ACCOUNT_B';
            native.ticket='PVE:FAKE_PVE_TICKET_DO_NOT_EXPORT_ACCOUNT_B';
            native.username='fixture-account-b@not-real.invalid';native.csrf='FAKE_CSRF_DO_NOT_EXPORT_ACCOUNT_B';
            if(window.Proxmox){Proxmox.UserName=native.username;Proxmox.CSRFPreventionToken=native.csrf;}
          }
          const expected={token:native.token,ticket:native.ticket,username:native.username,csrf:native.csrf};
          native.releasePending();return expected;
        },transition);
        ok(await started);
        const native=await current.page.evaluate(()=>({token:fixtureNative.token,ticket:fixtureNative.ticket,username:fixtureNative.username,csrf:fixtureNative.csrf,updates:fixtureNative.updates,unsafeUpdateCalls:fixtureNative.unsafeUpdateCalls}));
        assert.deepEqual({token:native.token,ticket:native.ticket,username:native.username,csrf:native.csrf},expected,`${platform}/${transition} restored stale authentication`);
        assert.equal(native.updates,0);
        assert.equal(native.unsafeUpdateCalls,0);
        assert.notEqual((await state(current.id)).runtime.status,'success');
        await assertMetadataOnly();
        await current.page.close();
      }
    }
    console.log('PASS Pending Guacamole/Proxmox operations cannot resurrect logout or replace a newly selected account');

    const pending=await open('guacamole','hang');
    const activation=api({type:'setTab',tabId:pending.id,enabled:true,intervalMinutes:30,endpoint:''});
    await pending.page.waitForFunction(()=>window.fixtureNative.active===1);
    const timeoutResult=ok(await activation);
    assert.equal(timeoutResult.ok,true);
    const timedOut=await state(pending.id);
    assert.equal(timedOut.runtime.attempts.at(-1).kind,'timeout');
    assert.equal(await pending.page.evaluate(()=>window.fixtureNative.active),1);
    await pending.page.evaluate(()=>{
      document.documentElement.removeAttribute('ng-app');document.documentElement.removeAttribute('ng-controller');
      document.querySelector('guac-client-panel').remove();document.querySelector('script[src]').remove();
      const script=document.createElement('script');script.src='/pve2/js/pvemanagerlib.js';document.head.append(script);
      const form=document.createElement('form');form.id='history-form';document.body.append(form);
      window.fixtureNative.mode='normal';window.fixtureNative.installProxmox();
    });
    ok(await api({type:'testNow',tabId:pending.id}));
    assert.equal(await pending.page.evaluate(()=>window.fixtureNative.calls),1,'Unsettled native renewal cannot overlap after timeout/profile change');
    assert.equal(await pending.page.evaluate(()=>window.fixtureNative.maxActive),1);
    await pending.page.evaluate(()=>window.fixtureNative.releasePending());
    await pending.page.waitForFunction(()=>window.fixtureNative.active===0&&!document.documentElement.hasAttribute('data-tab-session-keeper-operation'));
    ok(await api({type:'testNow',tabId:pending.id}));
    const afterProfileChange=await state(pending.id);
    assert.equal(afterProfileChange.runtime.profile,'proxmox-ve');
    assert.equal(afterProfileChange.runtime.status,'success');
    assert.equal(await pending.page.evaluate(()=>window.fixtureNative.maxActive),1);
    await assertMetadataOnly();
    await pending.page.close();
    console.log('PASS Native timeout retains cross-world lock; profile change cannot overlap until original native operation settles');

    ok(await api({type:'saveRule',rule:{origin:fixture.origin,enabled:true,intervalMinutes:30,endpoint:''}}));
    await control.setViewportSize({width:375,height:812});
    await control.reload();
    await control.locator('.rule-card').waitFor();
    assert.equal(await control.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await control.screenshot({path:path.join(tmpdir(),'tab-session-keeper-1.2-options-375.png'),fullPage:true});
    await context.close();context=await launch();
    const restarted=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
    assert.equal(new URL(restarted.url()).host,extensionId);
    control=await context.newPage();
    await control.goto(`chrome-extension://${extensionId}/options.html`);
    api=request=>control.evaluate(message=>chrome.runtime.sendMessage(message),request);
    assert.ok((ok(await api({type:'getState'}))).rules.some(rule=>rule.origin===fixture.origin&&rule.enabled));
    const restored=await open('proxmox-ve');
    await until(async()=> (await state(restored.id)).runtime.status==='success','Persistent native rule did not resume');
    assert.equal((await state(restored.id)).effective.source,'site');
    await assertMetadataOnly();
    assert.equal(errors.length,0,errors.join('\n'));
    console.log('PASS Real Chromium restart retains website rule and renews reopened native profile; narrow options fit');
  }finally{
    await context?.close();await fixture.close();await rm(temporary,{recursive:true,force:true});
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await newProfilesSmoke(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));
