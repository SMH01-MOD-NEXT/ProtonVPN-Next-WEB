import { test } from "node:test"
import assert from "node:assert/strict"
import { generateWarp, warpConfig, WARP_API } from "../src/lib/warp.js"
import { handleWarpRegistration, WARP_REGISTRATION_URL } from "../proxy/warp.js"
import { handleProxyRequest } from "../proxy/core.js"
const key = Buffer.alloc(32, 1).toString("base64")
const result = { config: { client_id: "AQID", interface: { addresses: { v4: "172.16.0.2", v6: "2606:4700:110:1234::2" } }, peers: [{ public_key: key, endpoint: { host: "engage.cloudflareclient.com:2408" } }] } }
test("WARP config preserves reserved bytes, local key and dual-stack addresses", () => {
 const conf = warpConfig(key, result)
 assert.match(conf, /Reserved = 1, 2, 3/)
 assert.match(conf, /Address = 172\.16\.0\.2\/32, 2606:4700:110:1234::2\/128/)
 assert.match(conf, /PrivateKey = /)
 assert.throws(() => warpConfig(key, { config: { ...result.config, interface: { addresses: { v4: "172.16.0.2\nPostUp = bad" } } } }))
 assert.throws(() => warpConfig(key, { config: { ...result.config, peers: [{ public_key: key, endpoint: { host: "server:65536" } }] } }))
 assert.throws(() => warpConfig(key, { config: {} }))
 assert.throws(() => warpConfig(key, { config: { ...result.config, client_id: "AQI=" } }))
})
test("direct mode never falls back to a mirror and never sends private material", async () => {
 const calls = []
 const conf = await generateWarp({ bypass: false, fetcher: async (url, options) => {
  calls.push(url); const body = JSON.parse(options.body)
  assert.equal(body.type, "Android"); assert.equal(Buffer.from(body.key, "base64").length, 32)
  assert.equal(Object.hasOwn(body, "privateKey"), false)
  assert.equal(options.credentials, "omit")
  return Response.json(result)
 } })
 assert.deepEqual(calls, [WARP_API]); assert.match(conf, /\[Interface\]/)
 const failed = []
 await assert.rejects(generateWarp({ bypass: false, fetcher: async url => { failed.push(url); throw new TypeError("CORS") } }))
 assert.deepEqual(failed, [WARP_API])
})
test("bypass retries only the two mirror routing forms", async () => {
 const calls = []
 await generateWarp({ fetcher: async url => { calls.push(url); return calls.length === 1 ? new Response("missing", { status: 404 }) : Response.json(result) } })
 assert.deepEqual(calls, ["/api/warp/reg", "/api?__path=%2Fwarp%2Freg"])
})
test("fixed WARP registration route sanitizes input, strips secrets and preserves CORS", async t => {
 let called = 0
 t.mock.method(globalThis, "fetch", async (url, options) => {
  called++; assert.equal(url, WARP_REGISTRATION_URL); assert.equal(options.redirect, "error")
  assert.equal(options.headers.authorization, undefined)
  assert.deepEqual(Object.keys(JSON.parse(options.body)).sort(), ["key", "install_id", "fcm_token", "tos", "type", "locale", "warp_enabled"].sort())
  return Response.json({ ...result, token: "must-not-escape", id: "device" })
 })
 const req = () => new Request("https://mirror.invalid/api/warp/reg", { method: "POST", headers: { origin: "http://localhost:3000", authorization: "Bearer secret" }, body: JSON.stringify({ key, token: "ignore", url: "http://127.0.0.1" }) })
 const response = await handleProxyRequest(req(), "/warp/reg")
 assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store")
 assert.deepEqual(await response.json(), result); assert.equal(called, 1)
 assert.equal((await handleWarpRegistration(new Request("https://mirror.invalid", { method: "GET" }))).status, 405)
 assert.equal((await handleWarpRegistration(new Request("https://mirror.invalid", { method: "POST", body: '{"key":"bad"}' }))).status, 502)
 assert.equal(called, 1)
})

test("Vercel path and query forms use the fixed WARP handler", async t => {
 t.mock.method(globalThis, "fetch", async () => Response.json(result))
 const { default: handler } = await import("../api/index.ts")
 for (const url of ["/api/warp/reg", "/api?__path=%2Fwarp%2Freg"]) {
  const headers = {}; let text = ""
  const res = { statusCode: 0, setHeader: (k,v) => { headers[k] = v }, end: value => { text = value } }
  await handler({ url, method: "POST", headers: {}, body: { key } }, res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(text), result)
  assert.equal(headers["cache-control"], "no-store")
 }
})
