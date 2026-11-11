import { applyWarpOptions, validateWarpOptions } from "./warp-endpoints.js"
/** Keys stay on the client; only the X25519 public key is registered. */
export const WARP_API = "https://api.cloudflareclient.com/v0a2158/reg"
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
export function warpConfig(privateKey, result) {
 const config = result?.config, peer = config?.peers?.[0]
 const ip = config?.interface?.addresses
 const endpoint = peer?.endpoint?.host
 if (!/^[A-Za-z0-9+/]{43}=$/.test(privateKey) || !/^[A-Za-z0-9+/]{43}=$/.test(peer?.public_key ?? "") || !ip?.v4 || !/^(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\]):[0-9]{1,5}$/.test(endpoint ?? "")) throw new Error("Invalid WARP response")
 const port = Number(endpoint.slice(endpoint.lastIndexOf(":") + 1))
 if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ip.v4) || ip.v4.split(".").some(x => Number(x) > 255) ||
     (ip.v6 && (!/^[a-fA-F0-9:]+$/.test(ip.v6) || !ip.v6.includes(":")))) throw new Error("Invalid WARP address")
 const reserved = config.client_id ? [...Uint8Array.from(atob(config.client_id), c => c.charCodeAt(0))] : []
 if (reserved.length !== 3) throw new Error("Invalid WARP reserved bytes")
 const addresses = [ip.v4 + "/32", ...(ip.v6 ? [ip.v6 + "/128"] : [])]
 return `[Interface]\nPrivateKey = ${privateKey}\nAddress = ${addresses.join(", ")}\nDNS = 1.1.1.1\nMTU = 1280\n\n[Peer]\nPublicKey = ${peer.public_key}\nEndpoint = ${endpoint}\nAllowedIPs = 0.0.0.0/0, ::/0\nPersistentKeepalive = 25\nReserved = ${reserved.join(", ")}\n`
}
export async function generateWarp({ bypass = true, signal, fetcher = fetch, endpoint = "", port = null, awg2 = false } = {}) {
 validateWarpOptions({ endpoint, port })
 const keys = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])
 const pub = b64(await crypto.subtle.exportKey("raw", keys.publicKey))
 const jwk = await crypto.subtle.exportKey("jwk", keys.privateKey)
 const secret = jwk.d.replace(/-/g, "+").replace(/_/g, "/") + "="
 const body = bypass ? { key: pub } : { key: pub, install_id: "", fcm_token: "", tos: new Date().toISOString(), type: "Android", locale: "en_US", warp_enabled: true }
 const routes = bypass ? ["/api/warp/reg", "/api?__path=%2Fwarp%2Freg"] : [WARP_API]
 for (const route of routes) {
  signal?.throwIfAborted()
  let response
  try { response = await fetcher(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000), credentials: "omit", cache: "no-store" }) }
  catch (error) { if (signal?.aborted) throw error; continue }
  if (!response.ok) continue
  try { return await applyWarpOptions(warpConfig(secret, await response.json()), { endpoint, port, awg2 }) } catch { /* Try the other routing form, never change privacy mode. */ }
 }
 throw new Error("WARP registration failed")
}
