/**
 * Proton API access for the browser.
 *
 * The API cannot be called directly from a page (no CORS headers on
 * vpn-api.proton.me), so every request goes through the proxy in `proxy/core.ts`.
 */

import { baseHeaders } from "./spoof.js"

function vercelUrl(path) {
	const url = new URL(path, "https://proxy.invalid")
	url.searchParams.set("__path", url.pathname)
	return `/api?${url.searchParams.toString()}`
}

// Vercel only routes api/index.ts at the literal /api path. Passing the Proton
// path in a query parameter keeps every same-origin request on that function;
// the proxy removes the private parameter before forwarding the real query.
// Deno still accepts the original catch-all URL and remains the fallback.
export const API_ENDPOINTS = [
	{ id: "same-origin", urlFor: vercelUrl },
	{ id: "deno", urlFor: (path) => "https:" + "//protonvpn-next-web--main.smh01-mirrors.deno.net/api" + path },
]

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

	get needsVerification() {
		return this.code === CODE_HUMAN_VERIFICATION || this.code === CODE_CAPTCHA_EXPIRED
	}
}

export class ProxyUnreachableError extends Error {
	constructor(failures) {
		super("No API proxy could be reached")
		this.name = "ProxyUnreachableError"
		this.failures = failures
	}
}

export async function apiRequest(path, { method = "GET", profile, session = null, body = null, extraHeaders = {}, signal } = {}) {
	const headers = { ...baseHeaders(profile), ...extraHeaders }

	if (session?.accessToken) headers.Authorization = `Bearer ${session.accessToken}`
	if (session?.uid) headers["x-pm-uid"] = session.uid

	const failures = []

	for (const endpoint of API_ENDPOINTS) {
		let response
		try {
			response = await fetch(endpoint.urlFor(path), {
				method,
				headers,
				body: body === null ? undefined : JSON.stringify(body),
				signal,
				credentials: endpoint.id === "same-origin" ? "same-origin" : "include",
				mode: "cors",
			})
		} catch (error) {
			if (error?.name === "AbortError") throw error
			failures.push({ endpoint: endpoint.id, reason: String(error) })
			continue
		}

		let payload = null
		const raw = await response.text()
		try {
			payload = raw ? JSON.parse(raw) : {}
		} catch {
			failures.push({
				endpoint: endpoint.id,
				reason: `Malformed response (HTTP ${response.status}, ${response.headers.get("content-type") || "unknown content type"})`,
			})
			continue
		}

		return { payload, status: response.status, endpoint: endpoint.id }
	}

	throw new ProxyUnreachableError(failures)
}

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
