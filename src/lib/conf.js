/**
 * `.conf` rendering, matching the file the CLI hands to its engine
 * (`pvpn_cli/cli/commands/connection.py`).
 *
 * The CLI appends an internal `---END---` delimiter for its own parser; an
 * exported file must not contain it, so it is omitted here.
 *
 * This module also owns the values every client format shares: the addresses
 * Proton assigns, the DNS choices and the `AllowedIPs` presets. `formats.js`
 * builds the WireSock and Clash flavours on top of them, so a change here
 * reaches every format at once.
 */

import { orderedAwgEntries } from "./awg.js"

/** The client address Proton assigns to every WireGuard peer. */
export const CLIENT_ADDRESS = "10.2.0.2/32"
/** The IPv6 address that comes with it. Proton hands out the same one. */
export const CLIENT_ADDRESS_V6 = "2a07:b944::2:2/128"
export const DEFAULT_MTU = "1280"
export const DEFAULT_PORT = 51820

/**
 * DNS choices; `labelKey` resolves through the translation files.
 * `serversV6` is appended only when the configuration carries an IPv6 address,
 * otherwise a resolver that cannot be reached would end up in the file.
 */
export const DNS_PROFILES = [
	{ id: "proton", labelKey: "gen_dns_proton", servers: "10.2.0.1", serversV6: "2a07:b944::2:1" },
	{
		id: "cloudflare",
		labelKey: "gen_dns_cloudflare",
		servers: "1.1.1.1, 1.0.0.1",
		serversV6: "2606:4700:4700::1111, 2606:4700:4700::1001",
	},
	{
		id: "adguard",
		labelKey: "gen_dns_adguard",
		servers: "94.140.14.14, 94.140.15.15",
		serversV6: "2a10:50c0::ad1:ff, 2a10:50c0::ad2:ff",
	},
	{
		id: "google",
		labelKey: "gen_dns_google",
		servers: "8.8.8.8, 8.8.4.4",
		serversV6: "2001:4860:4860::8888, 2001:4860:4860::8844",
	},
]

/** Ports Proton accepts for WireGuard; useful when 51820 is blocked. */
export const AVAILABLE_PORTS = [51820, 443, 88, 1194, 1224, 4500, 4569, 5060, 5995, 80]

/** Everything through the tunnel, both families. */
export const ALLOWED_IPS_ALL = "0.0.0.0/0, ::/0"

/**
 * The same coverage as `ALLOWED_IPS_ALL` minus every address a local network
 * can use, written as the widest prefixes that avoid them. Routing 0.0.0.0/0
 * would swallow the printer, the NAS and the router's web interface; this list
 * leaves RFC1918, CGNAT, link-local and multicast ranges on the LAN while still
 * sending the whole public Internet into the tunnel.
 *
 * It is one string in `AllowedIPs` spelling so it can be dropped into a `.conf`
 * as-is and split on commas for the formats that want a list.
 */
export const LAN_EXCLUDED_IPS = [
	"1.0.0.0/8",
	"2.0.0.0/7",
	"4.0.0.0/6",
	"8.0.0.0/7",
	"11.0.0.0/8",
	"12.0.0.0/6",
	"16.0.0.0/4",
	"32.0.0.0/3",
	"64.0.0.0/3",
	"96.0.0.0/4",
	"112.0.0.0/5",
	"120.0.0.0/6",
	"124.0.0.0/7",
	"126.0.0.0/8",
	"128.0.0.0/3",
	"160.0.0.0/5",
	"168.0.0.0/8",
	"169.0.0.0/9",
	"169.128.0.0/10",
	"169.192.0.0/11",
	"169.224.0.0/12",
	"169.240.0.0/13",
	"169.248.0.0/14",
	"169.252.0.0/15",
	"169.255.0.0/16",
	"170.0.0.0/7",
	"172.0.0.0/12",
	"172.32.0.0/11",
	"172.64.0.0/10",
	"172.128.0.0/9",
	"173.0.0.0/8",
	"174.0.0.0/7",
	"176.0.0.0/4",
	"192.0.0.0/9",
	"192.128.0.0/11",
	"192.160.0.0/13",
	"192.169.0.0/16",
	"192.170.0.0/15",
	"192.172.0.0/14",
	"192.176.0.0/12",
	"192.192.0.0/10",
	"193.0.0.0/8",
	"194.0.0.0/7",
	"196.0.0.0/6",
	"200.0.0.0/5",
	"208.0.0.0/4",
	"224.0.0.0/4",
	"::/1",
	"8000::/2",
	"c000::/3",
	"e000::/4",
	"f000::/5",
	"f800::/6",
	"fe00::/9",
	"fec0::/10",
	"ff00::/8",
].join(", ")

/** Ready-made `AllowedIPs` values offered in the UI. */
export const ALLOWED_IPS_PRESETS = [
	{ id: "all", labelKey: "gen_allowed_preset_all", value: ALLOWED_IPS_ALL },
	{ id: "no-lan", labelKey: "gen_allowed_preset_nolan", value: LAN_EXCLUDED_IPS },
]

/** Which preset a value corresponds to, or `custom` when it is hand-written. */
export function allowedIpsPresetId(value) {
	const normalised = normaliseList(value)
	for (const preset of ALLOWED_IPS_PRESETS) {
		if (normaliseList(preset.value) === normalised) return preset.id
	}
	return "custom"
}

/** Splits a comma separated list into trimmed, non-empty entries. */
export function splitList(value) {
	return String(value ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean)
}

function normaliseList(value) {
	return splitList(value).join(",").toLowerCase()
}

export function dnsProfileById(id) {
	return DNS_PROFILES.find((profile) => profile.id === id) ?? DNS_PROFILES[0]
}

/**
 * The `DNS` value for a configuration. A custom entry wins outright; otherwise
 * the profile is used, extended with its IPv6 resolvers when the interface has
 * an IPv6 address.
 */
export function resolveDns({ dnsId = "cloudflare", customDns = "", ipv6 = false } = {}) {
	if (String(customDns).trim()) return String(customDns).trim()

	const profile = dnsProfileById(dnsId)
	if (!ipv6 || !profile.serversV6) return profile.servers
	return `${profile.servers}, ${profile.serversV6}`
}

/** The `Address` value: IPv4 alone, or both families. */
export function interfaceAddress(ipv6 = false) {
	return ipv6 ? `${CLIENT_ADDRESS}, ${CLIENT_ADDRESS_V6}` : CLIENT_ADDRESS
}

/**
 * Builds the configuration text.
 *
 * @param options.server prepared server from `servers.js`
 * @param options.privateKey base64 WireGuard private key
 * @param options.awgParams obfuscation parameters, possibly empty
 * @param options.ipv6 include the IPv6 address and resolvers
 */
export function buildConfig({
	server,
	privateKey,
	awgParams = {},
	dnsId = "cloudflare",
	customDns = "",
	mtu = DEFAULT_MTU,
	port = DEFAULT_PORT,
	allowedIps = "0.0.0.0/0",
	keepalive = 25,
	ipv6 = false,
}) {
	const dns = resolveDns({ dnsId, customDns, ipv6 })

	const lines = [
		"[Interface]",
		`PrivateKey = ${privateKey}`,
		`Address = ${interfaceAddress(ipv6)}`,
		`DNS = ${dns}`,
	]

	if (mtu) lines.push(`MTU = ${mtu}`)

	for (const [key, value] of orderedAwgEntries(awgParams)) {
		lines.push(`${key} = ${value}`)
	}

	lines.push(
		"",
		"[Peer]",
		`PublicKey = ${server.publicKey}`,
		`Endpoint = ${server.entryIp}:${port || DEFAULT_PORT}`,
		`AllowedIPs = ${allowedIps}`,
		`PersistentKeepalive = ${keepalive}`,
	)

	return `${lines.join("\n")}\n`
}

/** A filesystem-safe form of a server name, such as `NL-FREE-1`. */
export function safeServerName(server) {
	return String(server?.name ?? server?.exitCountry ?? "config").replace(/[^A-Za-z0-9_-]+/g, "-")
}

/** A filesystem-safe name such as `pvpn-next-NL-FREE-1.conf`. */
export function configFileName(server, extension = "conf") {
	return `pvpn-next-${safeServerName(server)}.${extension}`
}

/** Triggers a browser download without ever putting the key on a server. */
export function downloadBlob(blob, fileName) {
	const url = URL.createObjectURL(blob)
	const link = document.createElement("a")
	link.href = url
	link.download = fileName
	document.body.append(link)
	link.click()
	link.remove()
	URL.revokeObjectURL(url)
}

export function downloadConfig(text, fileName) {
	downloadBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), fileName)
}
