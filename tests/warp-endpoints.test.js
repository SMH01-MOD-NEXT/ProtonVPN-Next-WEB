import { test } from "node:test"
import assert from "node:assert/strict"
import { applyWarpOptions, WARP_PORTS, WARP_OFFICIAL_PORTS, WARP_ENDPOINTS, validateWarpOptions } from "../src/lib/warp-endpoints.js"
import { generateWarp } from "../src/lib/warp.js"
import { readFileSync } from "node:fs"
const text = "[Interface]\nPrivateKey = local-secret\nAddress = 172.16.0.2/32\n\n[Peer]\nPublicKey = peer-key\nEndpoint = engage.cloudflareclient.com:2408\nReserved = 1, 2, 3\n"
test("catalog matches the public source snapshot without duplicates or MASQUE ports", () => {
 const catalog = JSON.parse(readFileSync(new URL("../docs/warp-endpoints.json", import.meta.url)))
 assert.deepEqual(WARP_PORTS, catalog.experimental.ports)
 assert.equal(WARP_PORTS.length, 54); assert.equal(new Set(WARP_PORTS).size, 54)
 assert.deepEqual(WARP_OFFICIAL_PORTS, [2408,500,1701,4500])
 assert.equal(WARP_ENDPOINTS.length, 396); assert.equal(new Set(WARP_ENDPOINTS).size, 396)
 assert.ok(!WARP_PORTS.includes(443)); assert.ok(!WARP_PORTS.includes(8443))
 assert.throws(() => validateWarpOptions({ endpoint: "127.0.0.1", port: 2408 }))
 assert.throws(() => validateWarpOptions({ endpoint: "162.159.193.1", port: 443 }))
})
test("endpoint and all published ports override only endpoint, not identity", async () => {
 for (const port of WARP_PORTS) {
  const config = await applyWarpOptions(text, { endpoint: "162.159.193.1", port })
  assert.match(config, new RegExp(`Endpoint = 162\\.159\\.193\\.1:${port}`))
  assert.match(config, /PrivateKey = local-secret/); assert.match(config, /Reserved = 1, 2, 3/)
 }
 assert.equal(await applyWarpOptions(text), text)
})
test("AWG2 keeps standard headers and matches reference profile with fresh QUIC I1", async () => {
 const a = await applyWarpOptions(text, { awg2: true })
 const b = await applyWarpOptions(text, { awg2: true })
 for (const line of ["Jc = 4", "Jmin = 40", "Jmax = 70", "S1 = 0", "S2 = 0", "S3 = 0", "S4 = 0", "H1 = 1", "H2 = 2", "H3 = 3", "H4 = 4"]) assert.ok(a.includes(line))
 assert.match(a, /I1 = <b 0x[0-9a-f]+>/); assert.notEqual(a,b)
 assert.ok(!a.includes("Reserved")); assert.ok(!a.includes("RandomTrailers"))
 assert.ok(a.indexOf("I1 =") < a.indexOf("[Peer]"))
})
test("invalid endpoint cannot cause a registration request", async () => {
 let calls = 0
 await assert.rejects(generateWarp({endpoint:"127.0.0.1",fetcher:async()=>{calls++;throw Error()}}))
 assert.equal(calls,0)
})
