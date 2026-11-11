// Browser regression checks against an already-running build and CDP browser.
// Registration responses are mocked; this script never creates live WARP accounts.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const timeout=setTimeout(()=>{console.error('QA timeout');process.exit(1)},30000);
const pages=await fetch(`${process.env.CDP_URL || 'http://127.0.0.1:9226'}/json`).then(r=>r.json());
const page=pages.find(p=>p.type==='page');const ws=new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
let id=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result)}};
const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}))});
async function evaluate(expression){const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value}
await send('Page.enable');await send('Page.addScriptToEvaluateOnNewDocument',{source:'localStorage.setItem("preferredLang","ru")'});
await send('Page.navigate',{url:process.env.BASE_URL || 'http://127.0.0.1:4174/'});await new Promise(r=>setTimeout(r,1200));
for(const width of [1440,390]){
 await send('Emulation.setDeviceMetricsOverride',{width,height:1100,deviceScaleFactor:1,mobile:false});
 const check=await evaluate(`(()=>{const r=document.querySelector('#warp-root');return {select:r.querySelector('#warp-endpoint').tagName,options:r.querySelector('#warp-endpoint').options.length,ports:r.querySelector('#warp-port').options.length,custom:!!r.querySelector('#warp-custom-endpoint'),datalist:!!r.querySelector('datalist'),experimental:r.innerText.includes('экспериментально'),overflow:document.documentElement.scrollWidth>innerWidth}})()`);
 assert.deepEqual(check,{select:'SELECT',options:398,ports:54,custom:false,datalist:false,experimental:false,overflow:false});console.log('default layout',width,check);
}
await evaluate(`(()=>{const r=document.querySelector('#warp-root');r.querySelectorAll('details')[1].open=true; const e=r.querySelector('#warp-endpoint');e.value='custom';e.dispatchEvent(new Event('change'))})()`);
assert.equal(await evaluate(`!!document.querySelector('#warp-custom-endpoint')`),true);
await evaluate(`(()=>{const r=document.querySelector('#warp-root');window.__requests=0;window.fetch=async()=>{window.__requests++;return Response.json({config:{client_id:'AQID',interface:{addresses:{v4:'172.16.0.2',v6:'2606:4700:110::2'}},peers:[{public_key:btoa(String.fromCharCode(...new Uint8Array(32).fill(1))),endpoint:{host:'engage.cloudflareclient.com:2408'}}]}})}; r.querySelector('button.btn-primary').click()})()`);
assert.equal(await evaluate(`window.__requests`),0);assert.equal(await evaluate(`!!document.querySelector('#warp-root [role="alert"]')`),true);
await evaluate(`(()=>{const r=document.querySelector('#warp-root');const i=r.querySelector('#warp-custom-endpoint');i.value='vpn.example.com';i.dispatchEvent(new Event('input'));const p=r.querySelector('#warp-port');p.value='500';p.dispatchEvent(new Event('change'));[...r.querySelectorAll('button')].find(b=>b.textContent==='WARP #3').click()})()`);
assert.equal(await evaluate(`document.querySelector('#warp-custom-endpoint').value`),'vpn.example.com');
assert.equal(await evaluate(`document.querySelector('#warp-port').value`),'500');
await evaluate(`document.querySelector('#warp-root').scrollIntoView({block:'start'});document.querySelector('#warp-root details:nth-child(2)').open=true`);
await new Promise(r=>setTimeout(r,100));
if (process.env.QA_SCREENSHOT) { const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await fs.writeFile(process.env.QA_SCREENSHOT,Buffer.from(shot.data,'base64')); }
await evaluate(`document.querySelector('#warp-root button.btn-primary').click()`);await new Promise(r=>setTimeout(r,150));
assert.equal(await evaluate(`window.__requests`),1);
const result=await evaluate(`(()=>{const r=document.querySelector('#warp-root'),text=r.querySelector('pre')?.textContent||'';return {endpoint:text.includes('Endpoint = vpn.example.com:500'),sip:text.includes('I2 ='),buttons:[...r.querySelectorAll('button')].map(b=>b.textContent),overflow:document.documentElement.scrollWidth>innerWidth}})()`);
assert.equal(result.endpoint,true);assert.equal(result.sip,true);assert.equal(result.overflow,false);assert.equal(result.buttons.length,3);console.log('generated result',result);
await evaluate(`[...document.querySelectorAll('#warp-root button')].at(-1).click()`);
await evaluate(`[...document.querySelectorAll('#warp-root button')].find(b=>b.textContent==='Clash / MASQUE').click()`);
const masque=await evaluate(`(()=>{const r=document.querySelector('#warp-root');return {port:r.querySelector('#warp-port').value,ports:r.querySelector('#warp-port').options.length,endpoints:r.querySelector('#warp-endpoint').options.length,custom:!!r.querySelector('#warp-custom-endpoint')}})()`);
assert.deepEqual(masque,{port:'443',ports:7,endpoints:4,custom:false});console.log('MASQUE protocol separation',masque);
ws.close();clearTimeout(timeout);console.log('UI QA PASSED');
