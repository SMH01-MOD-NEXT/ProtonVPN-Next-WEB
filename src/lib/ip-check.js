/*
 * Copyright (C) 2026 SMH01
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * The visitor's own address and country, as seen from the outside.
 *
 * There is deliberately no single source. Russian networks started blocking
 * the endpoints this kind of check normally relies on, so the sources are
 * tried in an order that depends on where the visitor appears to be, and the
 * first usable answer wins.
 *
 * Nothing here persists anything. The result lives in the caller's variable
 * for as long as the page is open; it never reaches `localStorage`,
 * `sessionStorage`, a cookie or the diagnostics buffer, because the point of
 * the feature is that neither the site nor its operator ends up holding a list
 * of addresses. The deployment echoes answer above their quota gate for the
 * same reason — see `proxy/core.js`.
 */

const REQUEST_TIMEOUT_MS = 6000

/** Where the site's own copies of the proxy live. */
const CLOUDFLARE_BASE = "https://home.protonnext.qzz.io"
const DENO_BASE = "https://protonvpn-next-web--main.smh01-mirrors.deno.net"
const VERCEL_BASE = "https://proton-vpn-next-web.vercel.app"

/**
 * The same timezone set the Android client carries, so both halves of the
 * project agree on who counts as being in Russia.
 */
const RUSSIAN_TIMEZONES = new Set([
	"Europe/Kaliningrad",
	"Europe/Moscow",
	"Europe/Simferopol",
	"Europe/Kirov",
	"Europe/Astrakhan",
	"Europe/Volgograd",
	"Europe/Saratov",
	"Europe/Ulyanovsk",
	"Europe/Samara",
	"Asia/Yekaterinburg",
	"Asia/Omsk",
	"Asia/Novosibirsk",
	"Asia/Barnaul",
	"Asia/Tomsk",
	"Asia/Novokuznetsk",
	"Asia/Krasnoyarsk",
	"Asia/Irkutsk",
	"Asia/Chita",
	"Asia/Yakutsk",
	"Asia/Khandyga",
	"Asia/Vladivostok",
	"Asia/Ust-Nera",
	"Asia/Magadan",
	"Asia/Sakhalin",
	"Asia/Srednekolymsk",
	"Asia/Kamchatka",
	"Asia/Anadyr",
])

/**
 * Whether the visitor looks Russian, from the browser alone.
 *
 * Only ever used to pick an order to try endpoints in, never to decide what
 * the visitor is allowed to do, so a wrong guess costs one failed request.
 */
export function looksRussian() {
	try {
		const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
		if (zone && RUSSIAN_TIMEZONES.has(zone)) return true
	} catch {
		// A browser without a resolvable timezone falls through to the locale.
	}

	try {
		const candidates =
			typeof navigator !== "undefined" && Array.isArray(navigator.languages)
				? navigator.languages
				: [typeof navigator !== "undefined" ? navigator.language : ""]
		// The region subtag, not the language: `ru-KZ` is not Russia and `en-RU`
		// is.
		for (const candidate of candidates) {
			if (String(candidate ?? "").toLowerCase().endsWith("-ru")) return true
		}
	} catch {
		// Nothing else to consult.
	}

	return false
}

/** `key=value` lines, the format Cloudflare's trace endpoint answers in. */
export function parseTrace(text) {
	const fields = {}
	for (const line of String(text ?? "").split("\n")) {
		const separator = line.indexOf("=")
		if (separator < 1) continue
		fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
	}
	return fields
}

function cleanCountry(value) {
	const code = String(value ?? "").trim().toUpperCase()
	// XX and T1 are Cloudflare's "unknown" and "Tor" placeholders, not countries.
	if (!/^[A-Z]{2}$/.test(code) || code === "XX" || code === "T1") return ""
	return code
}

function cleanIp(value) {
	const address = String(value ?? "").trim()
	// Only shape is checked. Deciding whether an address is "real" is exactly
	// the judgement this feature exists to hand to the visitor.
	if (!address || address.length > 45) return ""
	return /^[0-9a-fA-F:.]+$/.test(address) ? address : ""
}

/**
 * Public resolvers, tried after the project's own deployments.
 *
 * These necessarily see the address — that is what asking them means — so they
 * are last, and the panel names whichever one answered so the visitor can tell
 * whom they just talked to. Sources that report the country in the same
 * response come first, to avoid a second call that would disclose the address
 * again.
 */
export const PUBLIC_RESOLVERS = [
	{
		id: "cloudflare-trace",
		url: `${CLOUDFLARE_BASE}/cdn-cgi/trace`,
		kind: "text",
		read: (text) => {
			const fields = parseTrace(text)
			return { ip: fields.ip, country: fields.loc }
		},
	},
	{
		id: "cloudflare-meta",
		url: "https://speed.cloudflare.com/meta",
		kind: "json",
		read: (data) => ({ ip: data?.clientIp, country: data?.country }),
	},
	{
		id: "country.is",
		url: "https://api.country.is/",
		kind: "json",
		read: (data) => ({ ip: data?.ip, country: data?.country }),
	},
	{
		id: "ipwho.is",
		url: "https://ipwho.is/",
		kind: "json",
		read: (data) => ({ ip: data?.ip, country: data?.country_code }),
	},
	{
		id: "ipapi.co",
		url: "https://ipapi.co/json/",
		kind: "json",
		read: (data) => ({ ip: data?.ip, country: data?.country_code }),
	},
	{
		id: "freeipapi",
		url: "https://freeipapi.com/api/json",
		kind: "json",
		read: (data) => ({ ip: data?.ipAddress, country: data?.countryCode }),
	},
	{
		id: "ident.me",
		url: "https://api.ident.me/json",
		kind: "json",
		read: (data) => ({ ip: data?.ip, country: data?.cc }),
	},
	{
		id: "ipify",
		url: "https://api64.ipify.org?format=json",
		kind: "json",
		read: (data) => ({ ip: data?.ip, country: "" }),
	},
]

/**
 * Both URL forms a deployment's echo may answer on.
 *
 * Vercel routes to the proxy only through `/api`, so there the Proton path has
 * to ride in `__path` on that exact path; asking for the plain path returns the
 * static site's 404 instead of an address. Every other copy serves the plain
 * path, so trying both shapes keeps one list of bases usable against all.
 */
export function echoUrls(base) {
	const trimmed = String(base ?? "").replace(/\/+$/, "")
	if (!trimmed) return []
	return [`${trimmed}/__proxy/whoami`, `${trimmed}/api?__path=/__proxy/whoami`]
}

/**
 * Whether an Event Bypass entry may be used right now.
 *
 * Mirrors the CLI contract in `scripts/event-bypass.js`: an expiry is
 * `dd-mm-yyyy`, the literal `forever`, or blank for "unknown", and only a date
 * that has passed disqualifies an entry.
 */
export function isBypassUsable(event, now = new Date()) {
	if (!event?.enabled || !event?.url) return false

	const expiry = String(event.expiresAt ?? "").trim().toLowerCase()
	if (!expiry || expiry === "forever") return true

	const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(expiry)
	if (!match) return true

	const [, day, month, year] = match
	// End of the stated day, so an entry does not disappear at midnight UTC of
	// the day it is still supposed to work on.
	const deadline = Date.UTC(Number(year), Number(month) - 1, Number(day), 23, 59, 59)
	return now.getTime() <= deadline
}

/** Usable Event Bypass bases, or an empty list when the file is absent. */
export async function fetchEventBypassBases(signal) {
	try {
		const response = await fetch("/event-bypass.json", { cache: "no-cache", signal })
		if (!response.ok) return []

		const config = await response.json()
		if (!Array.isArray(config?.events)) return []

		return config.events
			.filter((event) => isBypassUsable(event))
			.map((event) => ({ id: `bypass:${event.id}`, base: event.url }))
	} catch (error) {
		if (error?.name === "AbortError") throw error
		return []
	}
}

/**
 * The order the sources are tried in.
 *
 * The visitor's own origin goes first. It is the only source that can answer
 * without the address leaving infrastructure the visitor already chose to
 * trust by loading the page, so asking anyone else ahead of it would disclose
 * the address for no reason. The mirrors and the public APIs sit behind it,
 * for a deployment whose own echo cannot be reached.
 *
 * Among the mirrors, Cloudflare is de-prioritised in Russia because it is the
 * endpoint currently being blocked there, and preferred everywhere else
 * because it resolves the country at the edge in the same response. Vercel does
 * that too, so it follows Cloudflare outside Russia and stands in for it
 * inside, where the Deno deployment answers but cannot name a country.
 */
export function resolverChain({ russian = false, bypasses = [] } = {}) {
	const cloudflare = { id: "cloudflare", base: CLOUDFLARE_BASE }
	const deno = { id: "deno", base: DENO_BASE }
	const vercel = { id: "vercel", base: VERCEL_BASE }
	const sameOrigin = { id: "same-origin", base: "" }

	const mirrors = russian
		? [deno, ...bypasses, vercel, cloudflare]
		: [cloudflare, vercel, deno, ...bypasses]

	const sources = []
	for (const deployment of [sameOrigin, ...mirrors]) {
		// The same origin has no base to build from, but it still needs both
		// shapes: a copy of the page served by Vercel answers only the second.
		const urls = deployment.base
			? echoUrls(deployment.base)
			: ["/__proxy/whoami", "/api?__path=/__proxy/whoami"]

		for (const url of urls) {
			sources.push({ id: deployment.id, url, kind: "json", read: (data) => ({ ip: data?.ip, country: data?.country }) })
		}
	}

	return [...sources, ...PUBLIC_RESOLVERS]
}

/** One request, with its own timeout, never cached and never credentialed. */
async function askSource(source, signal) {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
	const forwardAbort = () => controller.abort()
	signal?.addEventListener("abort", forwardAbort, { once: true })

	try {
		const response = await fetch(source.url, {
			signal: controller.signal,
			// Nothing about this request should be reusable by anyone else, and no
			// cookie has any business riding along with it.
			cache: "no-store",
			credentials: "omit",
			mode: "cors",
		})
		if (!response.ok) return null

		const payload =
			source.kind === "text" ? await response.text() : await response.json()
		const { ip, country } = source.read(payload) ?? {}

		const address = cleanIp(ip)
		return address ? { ip: address, country: cleanCountry(country), source: source.id } : null
	} catch {
		// A CORS rejection, a timeout and a dead host are indistinguishable here
		// and all mean the same thing: try the next source.
		return null
	} finally {
		clearTimeout(timer)
		signal?.removeEventListener("abort", forwardAbort)
	}
}

/**
 * The country of a known address, asked in a fixed order.
 *
 * Only reached when a source reported an address but no country, which is what
 * happens when the deployment that answered runs somewhere that does not
 * resolve the country at the edge: the Deno one, which returns the field empty.
 * Our own copies are asked first, so the question normally stays inside this
 * project's infrastructure, and a third party is the last resort. Neither
 * answer is stored.
 *
 * Exported because the order is the whole behaviour here. Asking a host that is
 * blocked before one that answers costs a full timeout, during which the panel
 * has an address and no country to show beside it.
 */
export function countryProbes(ip, { russian = false } = {}) {
	const trace = {
		id: "cloudflare-trace",
		url: `${CLOUDFLARE_BASE}/cdn-cgi/trace`,
		kind: "text",
		read: (text) => {
			const fields = parseTrace(text)
			return { ip: fields.ip, country: fields.loc }
		},
	}

	// The second shape echoUrls builds, which is the only one Vercel answers.
	const vercel = {
		id: "vercel-whoami",
		url: echoUrls(VERCEL_BASE)[1],
		kind: "json",
		read: (data) => ({ ip: data?.ip, country: data?.country }),
	}

	const thirdParty = {
		id: "country.is",
		url: `https://api.country.is/${encodeURIComponent(ip)}`,
		kind: "json",
		read: (data) => ({ ip: data?.ip, country: data?.country }),
	}

	return russian ? [vercel, trace, thirdParty] : [trace, vercel, thirdParty]
}

async function askCountry(ip, signal, russian = false) {
	for (const probe of countryProbes(ip, { russian })) {
		const answer = await askSource(probe, signal)
		if (answer?.country) return answer.country
	}

	return ""
}

/**
 * The source that answered last, tried first next time.
 *
 * In memory only, and holding an identifier rather than an address. This is
 * what makes the VPN case work without the page being able to detect a VPN:
 * a visitor in Russia who connects reaches Cloudflare again, Cloudflare
 * becomes the preferred source, and the next check no longer pays for the
 * Russian ordering it no longer needs.
 */
let preferredSourceId = null

/**
 * The last country this session resolved, in memory only.
 *
 * Once known it replaces the browser heuristic, so ordering follows where the
 * visitor actually appears to be rather than what their clock says.
 */
let lastKnownCountry = ""

/** Forgets the session hints. Exposed so a test can start from a clean state. */
export function resetIpCheckState() {
	preferredSourceId = null
	lastKnownCountry = ""
}

/**
 * Resolves the visitor's address and country.
 *
 * @returns `{ ip, country, source }`.
 * @throws when every source failed, so the caller can say so rather than
 *   render a blank panel.
 */
export async function resolveIpDetails({ signal } = {}) {
	const russian = lastKnownCountry ? lastKnownCountry === "RU" : looksRussian()
	const bypasses = await fetchEventBypassBases(signal)
	const chain = resolverChain({ russian, bypasses })

	const ordered = preferredSourceId
		? [
				...chain.filter((source) => source.id === preferredSourceId),
				...chain.filter((source) => source.id !== preferredSourceId),
			]
		: chain

	for (const source of ordered) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError")

		const result = await askSource(source, signal)
		if (!result) {
			if (source.id === preferredSourceId) preferredSourceId = null
			continue
		}

		preferredSourceId = source.id
		const country = result.country || (await askCountry(result.ip, signal, russian))
		if (country) lastKnownCountry = country

		return { ...result, country }
	}

	throw new Error("No IP source could be reached")
}
