import { generateWarp } from "./warp.js"
import { generateI1FromDomain } from "./quic.js"
import { WARP_QUIC_PRESET, WARP_SIP_PRESET } from "./warp-packets.js"
import { generateMasque } from "./warp-masque.js"

export const WARP_FORMATS = [
 { id: "amneziawg", labelKey: "gen_format_amneziawg", extension: "conf" },
 { id: "clash", labelKey: "gen_format_clash", extension: "yaml" },
 { id: "wiresock", labelKey: "gen_format_wiresock", extension: "conf" },
 { id: "xray", labelKey: "warp_format_xray", extension: "json" },
 { id: "clash-masque", labelKey: "warp_format_masque", extension: "yaml" },
 { id: "wireguard", labelKey: "warp_format_wireguard", extension: "conf" },
]
export function warpFormat(id) {
 const format = WARP_FORMATS.find(f => f.id === id)
 if (!format) throw new RangeError("Unknown WARP format")
 return format
}
const BASE = "S1 = 0\nS2 = 0\nS3 = 0\nS4 = 0\nJc = 4\nJmin = 40\nJmax = 70\nH1 = 1\nH2 = 2\nH3 = 3\nH4 = 4"
const field = (conf, key) => conf.match(new RegExp(`^${key} = (.+)$`, "m"))?.[1]
const quote = JSON.stringify // JSON strings are valid YAML scalars, including custom IPv6 hosts.
export async function renderWarpClient(conf, { format = "amneziawg", variant = 2 } = {}) {
 warpFormat(format)
 if (![1,2,3].includes(variant)) throw new RangeError("Unknown AWG variant")
 if (format === "clash-masque") throw new RangeError("MASQUE requires a P-256 registration")
 if (format === "wireguard") return conf.replace(/^Reserved = .*\n?/m, "") // Official WG clients reject non-standard Reserved.
 const packet = variant === 1 ? WARP_QUIC_PRESET : variant === 3 ? WARP_SIP_PRESET : `I1 = ${await generateI1FromDomain("www.cloudflare.com")}`
 const plain = conf.replace(/^Reserved = .*\n?/m, "")
 if (format === "amneziawg" || format === "wiresock") {
  const masking = format === "wiresock" ? "Id = www.cloudflare.com\nIp = quic\nIb = curl" : packet
  return plain.replace("[Peer]", `${BASE}\n${masking}\n\n[Peer]`)
 }
 const endpoint = field(conf, "Endpoint"), colon = endpoint.lastIndexOf(":")
 const server = endpoint.slice(0, colon).replace(/^\[|\]$/g, ""), port = Number(endpoint.slice(colon + 1))
 const addresses = field(conf, "Address").split(/,\s*/)
 const privateKey = field(conf, "PrivateKey"), publicKey = field(conf, "PublicKey")
 if (format === "clash") {
  const lines = ["mixed-port: 7890", "allow-lan: false", "mode: rule", "ipv6: true", "proxies:", "  - name: WARP", "    type: wireguard", `    server: ${quote(server)}`, `    port: ${port}`, `    ip: ${quote(addresses[0].split("/")[0])}`]
  if (addresses[1]) lines.push(`    ipv6: ${quote(addresses[1].split("/")[0])}`)
  lines.push(`    private-key: ${quote(privateKey)}`, `    public-key: ${quote(publicKey)}`, '    allowed-ips: ["0.0.0.0/0", "::/0"]', "    udp: true", "    mtu: 1280", "    remote-dns-resolve: true", '    dns: ["1.1.1.1"]', "    persistent-keepalive: 25", "    amnezia-wg-option:", "      version: 3")
  for (const line of `${BASE}\n${packet}`.split("\n")) { const [key, value] = line.split(" = "); lines.push(`      ${key.toLowerCase()}: ${/^\d+$/.test(value) ? value : quote(value)}`) }
  return lines.concat(["proxy-groups:", "  - name: WARP-select", "    type: select", "    proxies: [WARP]", "rules:", "  - MATCH,WARP-select", ""]).join("\n")
 }
 const hex = packet.match(/I1 = <b 0x([a-f0-9]+)>/i)?.[1]
 return JSON.stringify({ dns: { servers: ["1.1.1.1"] }, log: { loglevel: "warning" }, inbounds: [
  { listen: "127.0.0.1", port: 10808, protocol: "socks", settings: { auth: "noauth", udp: true }, tag: "socks-in" },
  { listen: "127.0.0.1", port: 10809, protocol: "http", settings: {}, tag: "http-in" },
 ], outbounds: [
  { protocol: "wireguard", tag: "warp", settings: { secretKey: privateKey, address: addresses, mtu: 1280, reserved: field(conf, "Reserved")?.split(/,\s*/).map(Number), peers: [{ publicKey, endpoint, allowedIPs: ["0.0.0.0/0", "::/0"], keepAlive: 25 }] }, streamSettings: { sockopt: { dialerProxy: "noise-out" } } },
  { protocol: "freedom", tag: "noise-out", settings: { domainStrategy: "AsIs", noises: [{ delay: "1-2", packet: hex, type: "hex" }, ...Array.from({length: 4}, () => ({delay: "1-3", packet: "40-70", type: "rand"}))] } },
 ], routing: { domainStrategy: "IPIfNonMatch", rules: [{ type: "field", port: "53", outboundTag: "noise-out" }, { type: "field", network: "tcp,udp", outboundTag: "warp" }] } }, null, 2) + "\n"
}
export async function generateWarpClient({ format = "amneziawg", variant = 2, ...options } = {}) {
 warpFormat(format)
 if (![1,2,3].includes(variant)) throw new RangeError("Unknown AWG variant")
 if (format === "clash-masque") return generateMasque(options)
 return renderWarpClient(await generateWarp({ ...options, awg2: false }), { format, variant })
}
