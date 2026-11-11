import { normalizeWarpHost } from "./warp-endpoints.js"

export const MASQUE_API = "https://api.cloudflareclient.com/v0a4471/reg"
export const MASQUE_PORTS = [443, 500, 1701, 4500, 4443, 8443, 8095]
export const MASQUE_ENDPOINTS = ["162.159.197.1", "162.159.198.2"]
const encode = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)))
const decode = s => Uint8Array.from(atob(s), c => c.charCodeAt(0))
const fromUrl = s => decode(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="))

export async function validateMasquePublicKey(key) {
 if (typeof key !== "string" || !/^[A-Za-z0-9+/]{122}==$/.test(key)) throw new Error("Invalid P-256 SPKI")
 await crypto.subtle.importKey("spki", decode(key), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
}

/** Fixed two-step API flow. Tokens never leave this scope or enter exports/logs.
 * Protocol reference: 6Kmfi6HP/warp-reg-gw/internal/registration (not copied code).
 */
export async function requestMasqueRegistration(key, masqueKey, { fetcher = fetch, signal, clientHeaders = false } = {}) {
 if (!/^[A-Za-z0-9+/]{43}=$/.test(key)) throw new Error("Invalid X25519 public key")
 await validateMasquePublicKey(masqueKey)
 const headers = { "content-type": "application/json", ...(clientHeaders ? { "CF-Client-Version": "a-6.35-4471", "user-agent": "WARP for Android" } : {}) }
 const options = { redirect: "error", credentials: "omit", cache: "no-store", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000) }
 const response = await fetcher(MASQUE_API, { ...options, method: "POST", headers, body: JSON.stringify({ key, key_type: "curve25519", tunnel_type: "wireguard", install_id: "", fcm_token: "", tos: new Date().toISOString(), model: "PC", locale: "en_US", warp_enabled: true }) })
 if (!response.ok) throw new Error("MASQUE initial registration failed")
 const created = await response.json()
 if (!/^[a-f0-9-]{36}$/i.test(created.id ?? "") || typeof created.token !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(created.token)) throw new Error("Invalid registration identity")
 const enrolled = await fetcher(`${MASQUE_API}/${created.id}`, { ...options, method: "PATCH", headers: { ...headers, authorization: `Bearer ${created.token}` }, body: JSON.stringify({ key: masqueKey, key_type: "secp256r1", tunnel_type: "masque" }) })
 if (!enrolled.ok) throw new Error("MASQUE enrollment failed")
 const result = await enrolled.json()
 return { config: result.config }
}

/** SEC1 ECPrivateKey DER for mihomo, generated entirely in this browser.
 * ASN.1 fixed lengths: scalar 32 bytes; P-256 OID; uncompressed public point 65.
 */
export function masqueSec1(jwk) {
 const scalar = fromUrl(jwk.d), x = fromUrl(jwk.x), y = fromUrl(jwk.y)
 if ([scalar,x,y].some(b => b.length !== 32)) throw new Error("Invalid P-256 key")
 return encode(Uint8Array.from([0x30,0x77,0x02,0x01,0x01,0x04,0x20,...scalar,0xa0,0x0a,0x06,0x08,0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07,0xa1,0x44,0x03,0x42,0x00,0x04,...x,...y]))
}

export async function renderMasque(privateKey, result, { endpoint = "", port = 443 } = {}) {
 const peer = result?.config?.peers?.[0], ip = result?.config?.interface?.addresses
 if (!peer || !ip?.v4 || !/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ip.v4) || ip.v4.split(".").some(n=>Number(n)>255) || (ip.v6 && !/^[a-f0-9:]+$/i.test(ip.v6))) throw new Error("Invalid MASQUE addresses")
 const publicKey = String(peer.public_key ?? "").replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, "")
 await validateMasquePublicKey(publicKey)
 const rawHost = peer.endpoint?.v4 || peer.endpoint?.host
 if (typeof rawHost !== "string") throw new Error("Missing MASQUE endpoint")
 const apiHost = rawHost.replace(/:\d+$/, "")
 const server = normalizeWarpHost(endpoint || apiHost).replace(/^\[|\]$/g, "")
 if (!server || !MASQUE_PORTS.includes(port)) throw new Error("Invalid MASQUE endpoint or port")
 const q = JSON.stringify
 const lines = ["mixed-port: 7890", "allow-lan: false", "mode: rule", "ipv6: true", "proxies:", "  - name: WARP-MASQUE", "    type: masque", `    server: ${q(server)}`, `    port: ${port}`, `    private-key: ${q(privateKey)}`, `    public-key: ${q(publicKey)}`, `    ip: ${q(ip.v4)}`]
 if (ip.v6) lines.push(`    ipv6: ${q(ip.v6)}`)
 lines.push("    mtu: 1280", "    udp: true", "    network: quic", "    sni: consumer-masque.cloudflareclient.com", "    uri: https://cloudflareaccess.com", "    remote-dns-resolve: true", '    dns: ["1.1.1.1"]', "proxy-groups:", "  - name: WARP-select", "    type: select", "    proxies: [WARP-MASQUE]", "rules:", "  - MATCH,WARP-select", "")
 return lines.join("\n")
}

export async function generateMasque({ bypass = true, fetcher = fetch, signal, endpoint = "", port = 443, customEndpoint = false } = {}) {
 if (!MASQUE_PORTS.includes(port) || (endpoint && (!normalizeWarpHost(endpoint) || (!customEndpoint && !MASQUE_ENDPOINTS.includes(endpoint))))) throw new RangeError("Invalid MASQUE options")
 const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
 const wg = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])
 const key = encode(await crypto.subtle.exportKey("raw", wg.publicKey))
 const masqueKey = encode(await crypto.subtle.exportKey("spki", keys.publicKey))
 const privateKey = masqueSec1(await crypto.subtle.exportKey("jwk", keys.privateKey))
 if (!bypass) return renderMasque(privateKey, await requestMasqueRegistration(key, masqueKey, { fetcher, signal }), { endpoint, port })
 for (const route of ["/api/warp/reg", "/api?__path=%2Fwarp%2Freg"]) {
  signal?.throwIfAborted()
  let response
  try { response = await fetcher(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, masque_key: masqueKey }), credentials: "omit", cache: "no-store", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(55000)]) : AbortSignal.timeout(55000) }) }
  catch (error) { if (signal?.aborted) throw error; continue }
  if (!response.ok) continue
  return renderMasque(privateKey, await response.json(), { endpoint, port })
 }
 throw new Error("MASQUE registration failed")
}
