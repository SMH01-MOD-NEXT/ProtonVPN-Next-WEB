/**
 * Proton API access for the browser.
 *
 * The API cannot be called directly from a page (no CORS headers on
 * vpn-api.proton.me), so every request goes through the proxy in `proxy/core.ts`.
 * Every host serves its own copy of the proxy under `/api`, so the site always
 * has a proxy on its own origin and neither deployment burns the other's quota.
 */

import { baseHeaders } from "./spoof.js"

/** True on the Vercel deployment, the only host with relay fallbacks. */
const ON_VERCEL = typeof location !== "undefined" && location.hostname.endsWith(".vercel.app")

/**
 * The query-parameter URL form, for the one deployment that needs it.
 *
 * Vercel routes `api/index.ts` only at the literal `/api` path; deeper paths
 * like `/api/vpn/v2` need the `vercel.json` rewrite to reach the function.
 * Passing the Proton path in `__path` keeps the request on the one route
 * Vercel serves without any rewrite at all, and the proxy strips the
 * parameter before forwarding. `via` asks the function to relay the call
 * through a sibling deployment instead of calling Proton itself.
 */
function queryUrl(path, via = null) {
	const url = new URL(path, "https://proxy.invalid")
	url.searchParams.set("__path", url.pathname)
	if (via) url.searchParams.set("__via", via)
	return `/api?${url.searchParams.toString()}`
}

// Tried in order until one answers with a Proton payload.
//
// Path-based same-origin first: Deno and Cloudflare route `/api/*` natively,
// so the normal path involves no extra hop. On Vercel that URL only reaches
// the function through the vercel.json rewrite; when the handoff breaks, the
// answer carries no Proton Code field (or a routing 404), and the call falls
// through to the query-parameter form, which always routes.
//
// The Vercel deployment additionally relays through its siblings when its own
// route to Proton fails: Cloudflare first, then Deno, both called by the
// Vercel function server-side. The browser never talks to another origin — in
// a heavily censored network the Vercel domain may be the only one a visitor
// can reach — and the relay swaps the egress IP Proton sees when it starts
// distrusting Vercel's.
//
// Elsewhere the absolute Deno URL stays as a last resort for the case where
// the site is served from somewhere without a proxy of its own, such as a
// local `vite preview` or a static copy; it is subject to CORS and may be
// unreachable, which the caller already handles as a proxy failure.
const DIRECT_ENDPOINTS = [
	{ id: "same-origin", sameOrigin: true, urlFor: (path) => `/api${path}` },
	{ id: "same-origin-query", sameOrigin: true, urlFor: (path) => queryUrl(path) },
]

const VERCEL_RELAY_ENDPOINTS = [
	{ id: "via-cf", sameOrigin: true, urlFor: (path) => queryUrl(path, "cf") },
	{ id: "via-deno", sameOrigin: true, urlFor: (path) => queryUrl(path, "deno") },
]

export const API_ENDPOINTS = ON_VERCEL
	? [...DIRECT_ENDPOINTS, ...VERCEL_RELAY_ENDPOINTS]
	: [
			...DIRECT_ENDPOINTS,
			{ id: "deno", sameOrigin: false, urlFor: (path) => "https:" + "//protonvpn-next-web--main.smh01-mirrors.deno.net/api" + path },
		]

/**
 * The endpoint that answered most recently, tried first on the next call.
 *
 * Without this every call on Vercel would pay for a known-dead route before
 * reaching the working form. Only a usable answer sets the preference and only
 * a transport or routing failure clears it, so a deployment whose routing
 * changes mid-visit simply re-discovers its route on the next call.
 */
let preferredEndpointId = null

/** Proton API codes that mean "prove you are human". */
export const CODE_HUMAN_VERIFICATION = 9001
export const CODE_CAPTCHA_EXPIRED = 12087
export const CODE_OK = 1000

export class ApiError extends Error {
	constructor(message, { code = null, status = null, body = null } = {}) {
		super(message)
		this.name = "ApiError"
		this.code = code
		this.status = status
		this.body = body
	}

	/** True when the API wants human verification, which triggers a profile swap. */
	get needsVerification() {
		return this.code === CODE_HUMAN_VERIFICATION || this.code === CODE_CAPTCHA_EXPIRED
	}
}

/** Raised when no proxy could be reached at all. */
export class ProxyUnreachableError extends Error {
	constructor(failures) {
		super("No API proxy could be reached")
		this.name = "ProxyUnreachableError"
		this.failures = failures
	}
}

/**
 * Performs one API call, trying each proxy in order.
 *
 * Only transport failures and responses that did not come from Proton fall
 * through to the next proxy, with two exceptions: a Proton "Path not found"
 * (Code 404), which means the route between the page and the API is broken
 * rather than the data missing — none of the endpoints used here can 404 a
 * real object — and, on the Vercel deployment, a 401/403, which there usually
 * means Proton distrusts the function's egress IP rather than the session, so
 * the relayed siblings get their chance first. Any other valid API response,
 * including an error payload, is returned as-is so the caller can react to
 * the Proton error code.
 */
export async function apiRequest(path, { method = "GET", profile, session = null, body = null, extraHeaders = {}, signal } = {}) {
	const headers = { ...baseHeaders(profile), ...extraHeaders }

	if (session?.accessToken) {
		headers.Authorization = `Bearer ${session.accessToken}`
	}
	if (session?.uid) {
		headers["x-pm-uid"] = session.uid
	}

	const failures = []
	let firstApiError = null
	const ordered = preferredEndpointId
		? [...API_ENDPOINTS.filter((endpoint) => endpoint.id === preferredEndpointId), ...API_ENDPOINTS.filter((endpoint) => endpoint.id !== preferredEndpointId)]
		: API_ENDPOINTS

	for (const endpoint of ordered) {
		let response
		try {
			response = await fetch(endpoint.urlFor(path), {
				method,
				headers,
				body: body === null ? undefined : JSON.stringify(body),
				signal,
				// The proxy counts refreshes against a cookie it signs itself, so
				// the cookie has to ride along; nothing Proton sets is ever kept,
				// because the proxy strips upstream `Set-Cookie` headers.
				credentials: endpoint.sameOrigin ? "same-origin" : "include",
				mode: "cors",
			})
		} catch (error) {
			if (error?.name === "AbortError") throw error
			// A CORS rejection is indistinguishable from a network failure here, so
			// both simply move on to the next proxy.
			if (endpoint.id === preferredEndpointId) preferredEndpointId = null
			failures.push({ endpoint: endpoint.id, reason: String(error) })
			continue
		}

		const raw = await response.text()

		let payload = null
		try {
			payload = raw ? JSON.parse(raw) : null
		} catch {
			payload = null
		}

		// Only a payload with Proton's Code field counts as an answer from the
		// API. The platform's own error page is not one: Vercel's unrouted 404
		// is valid JSON too — {"error": {"code": "404"}} — so parseable alone
		// proves nothing. HTML pages, empty bodies and platform error JSON all
		// mean this URL form is not routed to the proxy, and the next form gets
		// its turn. A Proton error Code is authoritative and never falls
		// through: the caller reacts to it, including a proxy's own 429/502
		// payloads, which carry Code 0 by convention.
		if (payload === null || typeof payload.Code !== "number") {
			if (endpoint.id === preferredEndpointId) preferredEndpointId = null
			failures.push({
				endpoint: endpoint.id,
				reason: `Non-API response (HTTP ${response.status}, ${response.headers.get("content-type") || "unknown content type"})`,
			})
			continue
		}

		if (payload.Code === 404 || (ON_VERCEL && (response.status === 401 || response.status === 403))) {
			// The other routes get their chance; when every route agrees on the
			// answer, the first one is what the caller sees.
			if (endpoint.id === preferredEndpointId) preferredEndpointId = null
			firstApiError ??= { payload, status: response.status, endpoint: endpoint.id }
			failures.push({ endpoint: endpoint.id, reason: `HTTP ${response.status}: ${payload.Error || "API error"}` })
			continue
		}

		// A Proton error payload still proves the route works, so it pins the
		// preference exactly like a Code 1000 would.
		preferredEndpointId = endpoint.id
		return { payload, status: response.status, endpoint: endpoint.id }
	}

	if (firstApiError) return firstApiError
	throw new ProxyUnreachableError(failures)
}

/** Same as `apiRequest`, but turns a non-1000 API code into an `ApiError`. */
export async function apiCall(path, options) {
	const { payload, status } = await apiRequest(path, options)

	if (payload?.Code !== CODE_OK) {
		throw new ApiError(payload?.Error || `API error (HTTP ${status})`, {
			code: payload?.Code ?? null,
			status,
			body: payload,
		})
	}

	return payload
}
