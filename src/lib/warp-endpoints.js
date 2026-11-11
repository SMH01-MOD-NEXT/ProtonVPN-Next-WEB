/** Public candidate catalog, not connectivity results. Sources: docs/warp-endpoints.json. */
import { generateI1FromDomain } from "./quic.js"
export const WARP_OFFICIAL_PORTS = [2408, 500, 1701, 4500]
export const WARP_PORTS = [500, 854, 859, 864, 878, 880, 890, 891, 894, 903, 908, 928, 934, 939, 942, 943, 945, 946, 955, 968, 987, 988, 1002, 1010, 1014, 1018, 1070, 1074, 1180, 1387, 1701, 1843, 2371, 2408, 2506, 3138, 3476, 3581, 3854, 4177, 4198, 4233, 4500, 5279, 5956, 7103, 7152, 7156, 7281, 7559, 8319, 8742, 8854, 8886]
export const WARP_COMMUNITY_PREFIXES = ["162.159.192.", "162.159.195.", "8.6.112.", "8.34.70.", "8.34.146.", "8.35.211.", "8.39.125.", "8.39.204.", "8.39.214.", "8.47.69.", "188.114.96.", "188.114.97.", "188.114.98.", "188.114.99."]
export const WARP_ENDPOINTS = [...new Set([
 ...Array.from({ length: 256 }, (_, n) => `162.159.193.${n}`),
 ...WARP_COMMUNITY_PREFIXES.flatMap(prefix => Array.from({ length: 10 }, (_, n) => prefix + (n + 1))),
])]
/** Custom hosts are configuration data only: never used as a registration URL. */
export function normalizeWarpHost(value) {
 if (typeof value !== "string" || value.length > 253 || value !== value.trim() || /[\s/@?#\\]/.test(value)) throw new RangeError("Invalid endpoint")
 if (!value) return ""
 if (value.includes(":")) {
  const bracketed = value.startsWith("[") ? value : `[${value}]`
  try {
   const url = new URL("https:" + "//" + bracketed + "/")
   if (url.port || !url.hostname.startsWith("[")) throw new Error()
   return url.hostname
  } catch { throw new RangeError("Invalid IPv6 endpoint") }
 }
 if (/^[0-9.]+$/.test(value)) {
  if (!/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(value) || value.split(".").some(n => Number(n) > 255 || (n.length > 1 && n.startsWith("0")))) throw new RangeError("Invalid IPv4 endpoint")
 } else if (!/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(value)) throw new RangeError("Invalid endpoint hostname")
 return value.toLowerCase()
}
export function validateWarpOptions({ endpoint = "", port = null, customEndpoint = false } = {}) {
 if (endpoint && (customEndpoint ? !normalizeWarpHost(endpoint) : !WARP_ENDPOINTS.includes(endpoint))) throw new RangeError("Unknown WARP endpoint")
 if (port != null && !WARP_PORTS.includes(port)) throw new RangeError("Unknown WARP UDP port")
}
export async function applyWarpOptions(text, { endpoint = "", port = null, awg2 = false, customEndpoint = false } = {}) {
 validateWarpOptions({ endpoint, port, customEndpoint })
 const old = text.match(/^Endpoint = (.+)$/m)?.[1]
 if (!old) throw new Error("Missing endpoint")
 const split = old.lastIndexOf(":")
 text = text.replace(/^Endpoint = .+$/m, `Endpoint = ${(endpoint && normalizeWarpHost(endpoint)) || old.slice(0, split)}:${port || old.slice(split + 1)}`)
 if (awg2) {
  // The referenced generator's WARP-compatible AWG2 format uses standard WG headers,
  // no Reserved directive, and only initiator-side junk/QUIC masking. Not MASQUE.
  const i1 = await generateI1FromDomain("www.cloudflare.com")
  text = text.replace(/^Reserved = .*\n?/m, "").replace("[Peer]", `S1 = 0\nS2 = 0\nS3 = 0\nS4 = 0\nJc = 4\nJmin = 40\nJmax = 70\nH1 = 1\nH2 = 2\nH3 = 3\nH4 = 4\nI1 = ${i1}\n\n[Peer]`)
 }
 return text
}
