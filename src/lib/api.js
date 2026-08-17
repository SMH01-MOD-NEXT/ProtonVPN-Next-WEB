/**
 * Proton API access for the browser.
 *
 * The API cannot be called directly from a page (no CORS headers on
 * vpn-api.proton.me), so every request goes through the proxy in `proxy/core.ts`.
 * Every host serves its own copy of the proxy under `/api`, so the site always
 * has a proxy on its own origin and neither deployment burns the other's quota.
 */

import { baseHeaders } from "./spoof.js"

/**
 * The query-parameter URL form, for the one deployment that needs it.
 *
 * Vercel routes `api/index.ts` only at the literal `/api` path; deeper paths
 * like `/api/vpn/v2` fall through to the static 404 without invoking the
 * function. Passing the Proton path in `__path` keeps the request on the one
 * route Vercel serves, and the proxy strips the parameter before forwarding.
 */
function queryUrl(path) {
	const url = new URL(path, "https://proxy.invalid")
	url.searchParams.set("__path", url.pathname)
	return `/api?${url.searchParams.toString()}`
}

// Tried in order until one answers with a parseable response.
//
// Path-based same-origin first: Deno and Cloudflare route `/api/*` natively,
// so the normal path involves no extra hop. On Vercel that URL returns the
// static 404 page, and HTML never parses as JSON, so the call falls through to
// the query-parameter form, which the Vercel function does serve. The absolute
// Deno URL stays as a last resort for the case where the site is served from
// somewhere without a proxy of its own, such as a local `vite preview` or a
// static copy; it is subject to CORS and may be unreachable, which the caller
// already handles as a proxy failure.
export const API_ENDPOINTS = [
	{ id: "same-origin", urlFor: (path) => `/api${path}` },
	{ id: "same-origin-query", urlFor: queryUrl },
	{ id: "deno", urlFor: (path) => "https:" + "//protonvpn-next-web--main.smh01-mirrors.deno.net/api" + path },
]

/**
 * The endpoint that answered most recently, tried first on the next call.
 *
 * Without this every call on Vercel would pay for a known-dead 404 before
 * reaching the working form. Only a usable answer sets the preference and only
 * a transport or parse failure clears it, so a deployment whose routing
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
 * Only transport failures and unparseable responses fall through to the next
 * proxy. A valid API response, including an error payload, is returned as-is
 * so the caller can react to the Proton error code.
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
				credentials: endpoint.id.startsWith("same-origin") ? "same-origin" : "include",
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
		// An empty error page is a dead route, not an answer from Proton.
		if (!raw && !response.ok) {
			if (endpoint.id === preferredEndpointId) preferredEndpointId = null
			failures.push({ endpoint: endpoint.id, reason: `Empty response (HTTP ${response.status})` })
			continue
		}

		let payload = null
		try {
			payload = raw ? JSON.parse(raw) : {}
		} catch {
			if (endpoint.id === preferredEndpointId) preferredEndpointId = null
			failures.push({
				endpoint: endpoint.id,
				reason: `Malformed response (HTTP ${response.status}, ${response.headers.get("content-type") || "unknown content type"})`,
			})
			continue
		}

		// A Proton error payload still proves the route works, so it pins the
		// preference exactly like a Code 1000 would.
		preferredEndpointId = endpoint.id
		return { payload, status: response.status, endpoint: endpoint.id }
	}

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
