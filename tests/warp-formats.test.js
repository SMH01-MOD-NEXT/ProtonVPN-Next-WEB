import { test } from "node:test"
import assert from "node:assert/strict"
import { createPrivateKey, createPublicKey } from "node:crypto"
import { applyWarpOptions, normalizeWarpHost } from "../src/lib/warp-endpoints.js"
import { renderWarpClient, generateWarpClient, WARP_FORMATS } from "../src/lib/warp-formats.js"
import { generateMasque, requestMasqueRegistration, masqueSec1, MASQUE_API, MASQUE_PORTS } from "../src/lib/warp-masque.js"
import { handleWarpRegistration } from "../proxy/warp.js"
import { WARP_QUIC_PRESET, WARP_SIP_PRESET } from "../src/lib/warp-packets.js"
const key = Buffer.alloc(32, 1).toString("base64")
const conf = `[Interface]\nPrivateKey = ${key}\nAddress = 172.16.0.2/32, 2606:4700:110::2/128\nDNS = 1.1.1.1\nMTU = 1280\n\n[Peer]\nPublicKey = ${key}\nEndpoint = [2606:4700:100::1]:2408\nAllowedIPs = 0.0.0.0/0, ::/0\nPersistentKeepalive = 25\nReserved = 1, 2, 3\n`
const b64 = bytes => Buffer.from(bytes).toString("base64")
async function fixture() {
 const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign","verify"])
 const pub = b64(await crypto.subtle.exportKey("spki", pair.publicKey))
 return { pub, jwk: await crypto.subtle.exportKey("jwk", pair.privateKey), result: {config:{ interface:{ addresses:{v4:"172.16.0.2",v6:"2606:4700:110::2"}},peers:[{public_key:pub,endpoint:{v4:"162.159.198.2:443",ports:MASQUE_PORTS}}]}} }
}
const id = "00000000-0000-4000-8000-000000000001"

test("custom endpoints accept IP/IPv6/DNS, reject configuration injection before registration", async () => {
 for (const [input, output] of [["203.0.113.1","203.0.113.1"],["VPN.example.com","vpn.example.com"],["2001:db8::1","[2001:db8::1]"],["[2001:db8::1]","[2001:db8::1]"]]) {
  assert.equal(normalizeWarpHost(input),output)
  const text = await applyWarpOptions(conf,{endpoint:input,customEndpoint:true,port:500})
  assert.ok(text.includes(`Endpoint = ${output}:500`))
 }
 for (const bad of ["host\nPostUp=bad","https://host","user@host","host/path","host:443","999.1.1.1","01.1.1.1","[::1]:500","[not-ip]","-host"] ) {
  assert.throws(()=>normalizeWarpHost(bad))
  let calls=0
  await assert.rejects(generateWarpClient({endpoint:bad,customEndpoint:true,fetcher:async()=>{calls++;throw Error()}}))
  assert.equal(calls,0)
 }
})
test("WARP #1/#2/#3 have distinct reference packets and standard WARP headers", async () => {
 const first=await renderWarpClient(conf,{variant:1}), second=await renderWarpClient(conf,{variant:2}), third=await renderWarpClient(conf,{variant:3})
 assert.ok(first.includes(WARP_QUIC_PRESET)); assert.ok(third.includes(WARP_SIP_PRESET))
 assert.match(second,/I1 = <b 0x[a-f0-9]+>/);assert.notEqual(second,await renderWarpClient(conf,{variant:2}))
 assert.match(third,/I2 = /)
 for (const text of [first,second,third]) {
  for (const line of ["Jc = 4","Jmin = 40","Jmax = 70","H1 = 1","H4 = 4","S3 = 0","S4 = 0"]) assert.ok(text.includes(line))
  assert.ok(!text.includes("Reserved"));assert.ok(text.indexOf("I1 =")<text.indexOf("[Peer]"))
 }
})
test("WireSock has Id/Ip/Ib, standard WG has no unsupported directives",async()=>{
 const wiresock=await renderWarpClient(conf,{format:"wiresock"})
 assert.match(wiresock,/Id = www.cloudflare.com\nIp = quic\nIb = curl/);assert.ok(!wiresock.includes("I1 ="));assert.ok(!wiresock.includes("Reserved"))
 const wg=await renderWarpClient(conf,{format:"wireguard"});assert.ok(!wg.includes("Reserved"));assert.ok(!wg.includes("Jc ="));assert.ok(wg.includes(key))
})
test("Clash exports all three profiles with WARP addresses and no Proton constants",async()=>{
 for (const variant of [1,2,3]) {
  const yaml=await renderWarpClient(conf,{format:"clash",variant})
  assert.match(yaml,/server: "2606:4700:100::1"/);assert.match(yaml,/ip: "172.16.0.2"/)
  assert.match(yaml,/amnezia-wg-option:\n      version: 3/);assert.match(yaml,/jc: 4/);assert.match(yaml,/MATCH,WARP-select/)
  if(variant===3)assert.match(yaml,/i2:/)
  assert.ok(!yaml.includes("Proton"))
 }
})
test("Xray produces valid JSON with local listeners, actual addresses, reserved and noise",async()=>{
 const data=JSON.parse(await renderWarpClient(conf,{format:"xray"}))
 assert.ok(data.inbounds.every(i=>i.listen==="127.0.0.1"))
 assert.equal(data.outbounds[0].settings.secretKey,key);assert.deepEqual(data.outbounds[0].settings.reserved,[1,2,3])
 assert.deepEqual(data.outbounds[0].settings.address,["172.16.0.2/32","2606:4700:110::2/128"])
 assert.equal(data.outbounds[0].settings.peers[0].endpoint,"[2606:4700:100::1]:2408")
 assert.equal(data.outbounds[0].streamSettings.sockopt.dialerProxy,"noise-out");assert.match(data.outbounds[1].settings.noises[0].packet,/^[a-f0-9]+$/)
})
test("unsupported client/profile fails before network",async()=>{
 assert.equal(WARP_FORMATS.length,6)
 for(const options of [{format:"unknown"},{variant:4}]){
  let calls=0;await assert.rejects(generateWarpClient({...options,fetcher:async()=>{calls++;throw Error()}}));assert.equal(calls,0)
 }
})
test("MASQUE SEC1 DER contains the same P-256 key as its WebCrypto SPKI",async()=>{
 const f=await fixture(),pem=createPrivateKey({key:Buffer.from(masqueSec1(f.jwk),"base64"),format:"der",type:"sec1"})
 assert.equal(b64(createPublicKey(pem).export({format:"der",type:"spki"})),f.pub)
})
test("MASQUE direct flow registers and enrolls locally generated public keys, never private keys",async()=>{
 const f=await fixture(),calls=[]
 const text=await generateMasque({bypass:false,fetcher:async(url,options)=>{
  calls.push({url,options});const body=JSON.parse(options.body)
  assert.equal(options.credentials,"omit")
  assert.equal(body.privateKey,undefined);assert.equal(body.private_key,undefined)
  if(calls.length===1){assert.equal(url,MASQUE_API);assert.equal(Buffer.from(body.key,"base64").length,32);return Response.json({id,token:"test-token"})}
  assert.equal(url,`${MASQUE_API}/${id}`);assert.equal(options.method,"PATCH");assert.equal(body.key_type,"secp256r1");assert.equal(body.tunnel_type,"masque");assert.equal(options.headers.authorization,"Bearer test-token")
  return Response.json(f.result)
 }})
 assert.equal(calls.length,2);assert.match(text,/type: masque/);assert.ok(!text.includes("test-token"));assert.match(text,/port: 443/)
 const secret=JSON.parse(text.match(/private-key: (.+)/)[1]);const parsed=createPrivateKey({key:Buffer.from(secret,"base64"),format:"der",type:"sec1"})
 assert.equal(b64(createPublicKey(parsed).export({format:"der",type:"spki"})),JSON.parse(calls[1].options.body).key)
})
test("MASQUE mirror performs fixed two-step flow and strips registration identifiers/tokens",async t=>{
 const f=await fixture();let calls=0
 t.mock.method(globalThis,"fetch",async(url,options)=>{
  calls++;assert.equal(options.redirect,"error");assert.equal(options.headers["CF-Client-Version"],"a-6.35-4471")
  if(calls===1){assert.equal(url,MASQUE_API);assert.equal(options.headers.authorization,undefined);return Response.json({id,token:"private-token"})}
  assert.equal(url,`${MASQUE_API}/${id}`);assert.equal(options.headers.authorization,"Bearer private-token");return Response.json({...f.result,id,token:"private-token",account:{id:"private-account"}})
 })
 const response=await handleWarpRegistration(new Request("https://mirror.invalid/api/warp/reg",{method:"POST",headers:{authorization:"Bearer proton-token"},body:JSON.stringify({key,masque_key:f.pub,url:"http://127.0.0.1"})}))
 assert.equal(response.status,200);assert.deepEqual(await response.json(),f.result);assert.equal(calls,2)
 assert.equal(response.headers.get("cache-control"),"no-store")
})
test("MASQUE rejects malformed public keys and path-injection identities without fetching arbitrary targets",async()=>{
 const f=await fixture();let calls=0
 await assert.rejects(requestMasqueRegistration(key,"invalid",{fetcher:async()=>{calls++;throw Error()}}));assert.equal(calls,0)
 await assert.rejects(requestMasqueRegistration(key,f.pub,{fetcher:async()=>{calls++;return Response.json({id:"../other?target=bad",token:"token"})}}));assert.equal(calls,1)
})
test("MASQUE direct failures never fall back to mirrors and WG ports are not MASQUE ports",async()=>{
 const urls=[];await assert.rejects(generateMasque({bypass:false,fetcher:async url=>{urls.push(url);throw Error()}}));assert.deepEqual(urls,[MASQUE_API])
 let calls=0;await assert.rejects(generateMasque({port:854,fetcher:async()=>{calls++;throw Error()}}));assert.equal(calls,0)
})
test("MASQUE bypass sends only public keys and supports both mirror routing forms",async()=>{
 const f=await fixture(),calls=[]
 const text=await generateMasque({fetcher:async(url,options)=>{calls.push(url);assert.deepEqual(Object.keys(JSON.parse(options.body)).sort(),["key","masque_key"]);return calls.length===1?new Response('{}',{status:404}):Response.json(f.result)}})
 assert.deepEqual(calls,["/api/warp/reg","/api?__path=%2Fwarp%2Freg"]);assert.match(text,/type: masque/)
})
