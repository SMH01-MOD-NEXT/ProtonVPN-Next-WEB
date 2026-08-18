/**
 * Proton API proxy, written against Web APIs only so the same code runs on both
 * platforms the site is deployed to.
 *
 * Deno and Cloudflare each serve the site together with their own copy of this
 * proxy, so neither deployment depends on the other being up or on the other's
 * free-plan quota. `proxy/deno/main.ts` additionally runs it standalone for the
 * Android client and the CLI, which call an absolute URL.
 */

/**
 * Bumped by hand whenever the routing or CORS behaviour changes, and reported
 * by `/__proxy/health`. Deno Deploy silently keeps serving an older build when
 * a deployment does not run, and without a marker the only symptom is a CORS
 * error that looks identical to a code bug.
 */
const PROXY_BUILD = "2026-08-18-relay-fallback"

import { openQuotaGate } from "./quota.js"
import { clientAddress, relayProof } from "./identity.js"

/** Best-effort JSON store; see `store.js` for the backends behind it. */
export interface QuotaStore {
	id: string
	get: (key: string) => Promise<unknown>
	put: (key: string, value: unknown, ttlMs: number) => Promise<void>
	delete: (key: string) => Promise<void>
}

/** Per-deployment wiring for the quota gate. */
export interface ProxyContext {
	store?: QuotaStore | null
	secret?: string
	/** Shared secret verifying the caller address a relaying sibling claims. */
	relaySecret?: string
	/** Caller address for runtimes that do not put it in a header. */
	address?: string
	/**
	 * Sibling proxy retried once when the direct upstream answers with a
	 * Cloudflare edge error (521/522/523/525/526) — the shape Proton's egress
	 * blackholing takes. Fires only together with relaySecret, which signs the
	 * caller's address so the sibling's quotas stay per visitor.
	 */
	relayUrl?: string
}

/**
 * Fallback signing secret.
 *
 * The secret only has to be unguessable and stable for one deployment: it signs
 * the quota cookie and hashes addresses, and rotating it costs nothing worse
 * than a fresh set of counters. Setting `PVPN_QUOTA_SECRET` is still the right
 * thing to do, because a secret compiled into a public repository lets someone
 * mint their own cookie — which only ever buys them a new cookie-scoped
 * counter, since the address-scoped one applies regardless.
 */
const FALLBACK_SECRET = "pvpn-next-quota-fallback-secret"

/**
 * Origins allowed to read proxied responses.
 *
 * Patterns rather than a fixed list: the site is reachable through the apex
 * domain, subdomains, Cloudflare preview deployments and local dev servers on
 * arbitrary ports, and an origin missing from a hardcoded list fails in a way
 * that looks exactly like a broken proxy.
 */
const ALLOWED_ORIGIN_PATTERNS: RegExp[] = [
	/^https:\/\/([a-z0-9-]+\.)*protonnext\.qzz\.io$/,
	/^https:\/\/[a-z0-9-]+\.workers\.dev$/,
	/^https:\/\/[a-z0-9-]+\.pages\.dev$/,
	// Northflank names a service `<service>--<project>--<team>.code.run`, so the
	// mirror there is matched by shape rather than by a name that changes with
	// the project it lives in.
	/^https:\/\/[a-z0-9-]+(--[a-z0-9-]+)+\.code\.run$/,
	// Choreo serves every deployment from a `choreoapps.dev` subdomain whose
	// labels vary with the organization, project and environment, so the mirror
	// there is matched by shape like the others.
	/^https:\/\/([a-z0-9-]+\.)+choreoapps\.dev$/,
	/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
]

function isAllowedOrigin(origin: string): boolean {
	return ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin))
}

const UPSTREAMS: Array<{ prefix: string; host: string }> = [
	{ prefix: "/verify-api", host: "https://verify-api.proton.me" },
	{ prefix: "/verify", host: "https://verify.proton.me" },
]
const DEFAULT_UPSTREAM = "https://vpn-api.proton.me"

/**
 * Cloudflare edge error statuses. Proton blackholes egress it distrusts by
 * answering with one of these — currently a fake 525 carrying Cloudflare's
 * compact "error code" body, served only to requests whose CF-Worker header
 * names this deployment's zone — so anything in this range means "this
 * network is being blocked", not "the API is down".
 */
const EDGE_ERROR_STATUSES = new Set([521, 522, 523, 525, 526])

/**
 * Headers the browser must be allowed to read, on top of the safelisted ones.
 *
 * The quota headers are informational — the page shows how many refreshes are
 * left rather than guessing — and are never trusted as input on the way back in.
 */
const EXPOSED_RESPONSE_HEADERS = [
	"x-pvpn-quota",
	"x-pvpn-quota-limit",
	"x-pvpn-quota-remaining",
	"x-pvpn-quota-reset",
	"x-pvpn-quota-state",
]

const STRIPPED_RESPONSE_HEADERS = new Set([
	"content-security-policy",
	"content-security-policy-report-only",
	"x-frame-options",
	"content-encoding",
	"content-length",
	"transfer-encoding",
	"connection",
	"set-cookie",
])

const FORWARDED_REQUEST_HEADERS = [
	"accept",
	"authorization",
	"content-type",
	"x-pm-appversion",
	"x-pm-apiversion",
	"x-pm-uid",
	"x-pm-locale",
	"x-pm-human-verification-token",
	"x-pm-human-verification-token-type",
	"user-agent",
]

function corsHeaders(origin: string): Record<string, string> {
	const headers: Record<string, string> = {
		"access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
		"access-control-allow-headers": FORWARDED_REQUEST_HEADERS.join(", "),
		// Short on purpose: a browser caches a failed preflight too, and a whole
		// day of poisoned cache outlives any fix deployed here.
		"access-control-max-age": "600",
		vary: "Origin",
	}
	// Echo the caller's origin, never a substitute. Answering an unknown origin
	// with an allowed one produced the confusing "does not match" browser error
	// instead of a plain "origin not allowed".
	if (isAllowedOrigin(origin)) {
		headers["access-control-allow-origin"] = origin
	}
	return headers
}

function resolveUpstream(pathname: string): string {
	for (const upstream of UPSTREAMS) {
		if (pathname === upstream.prefix || pathname.startsWith(`${upstream.prefix}/`)) {
			return `${upstream.host}${pathname.slice(upstream.prefix.length) || "/"}`
		}
	}
	return `${DEFAULT_UPSTREAM}${pathname}`
}

/**
 * Handles one proxied request.
 *
 * @param pathnameOverride Path to forward upstream, used when the proxy is
 *   mounted under a prefix by `server.ts`. Without it the request path is taken
 *   as-is, which is what the standalone deployment needs.
 * @param context Quota storage and the signing secret for this deployment.
 *   Omitting it disables the quotas, which is what the standalone proxy used by
 *   the desktop and Android clients wants: those hold their own session and are
 *   not the button-spamming case this guards against.
 */
export async function handleProxyRequest(
	request: Request,
	pathnameOverride?: string,
	context?: ProxyContext,
): Promise<Response> {
	const origin = request.headers.get("origin") ?? ""
	const cors = corsHeaders(origin)
	cors["access-control-expose-headers"] = EXPOSED_RESPONSE_HEADERS.join(", ")
	// The quota cookie only travels on same-origin calls, where credentials are
	// sent by default; the header lets the cross-origin fallback work too.
	if (cors["access-control-allow-origin"]) {
		cors["access-control-allow-credentials"] = "true"
	}

	if (request.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: cors })
	}

	const incoming = new URL(request.url)
	// The Vercel deployment cannot route beyond the literal `/api` path, so its
	// client sends the real Proton path in this query parameter instead.
	// Accepting it here as well keeps every copy of the proxy interchangeable: a
	// caller holding the other URL form gets an answer instead of Proton's
	// "path not found" for the proxy root. The parameter is private routing
	// metadata and is never forwarded upstream.
	const queryPath = incoming.searchParams.get("__path")
	const pathname = queryPath
		? queryPath.startsWith("/")
			? queryPath
			: `/${queryPath}`
		: (pathnameOverride ?? incoming.pathname)
	if (queryPath) incoming.searchParams.delete("__path")

	// Tells which build is actually live and whether this caller's origin would
	// be accepted, without having to trigger a real CORS failure to find out.
	if (pathname === "/__proxy/health") {
		return new Response(
			JSON.stringify({
				build: PROXY_BUILD,
				origin,
				originAllowed: isAllowedOrigin(origin),
				relayConfigured: Boolean(context?.relaySecret),
				relayFallback: Boolean(context?.relayUrl && context?.relaySecret),
			}),
			{ status: 200, headers: { ...cors, "content-type": "application/json" } },
		)
	}
	// Everything below this point may be rate limited. The gate decides before
	// the call goes anywhere, so a caller over quota never touches Proton.
	const gate = await openQuotaGate(request, pathname, {
		store: context?.store ?? null,
		secret: context?.secret || FALLBACK_SECRET,
		relaySecret: context?.relaySecret ?? "",
		address: context?.address ?? "",
	})

	const withGateHeaders = (headers: Headers): Headers => {
		for (const [name, value] of Object.entries(gate.headers)) headers.set(name, value)
		if (gate.setCookie) headers.append("set-cookie", gate.setCookie)
		return headers
	}

	if (gate.blocked) {
		return new Response(gate.blocked.body, {
			status: gate.blocked.status,
			headers: withGateHeaders(new Headers({ ...cors, "content-type": "application/json" })),
		})
	}

	const target = `${resolveUpstream(pathname)}${incoming.search}`

	const headers = new Headers()
	for (const name of FORWARDED_REQUEST_HEADERS) {
		const value = request.headers.get(name)
		if (value) headers.set(name, value)
	}

	// Read once: the relay retry below needs the same body, and a request body
	// cannot be consumed twice.
	const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.text()

	let upstreamResponse: Response
	try {
		upstreamResponse = await fetch(target, {
			method: request.method,
			headers,
			body,
			redirect: "follow",
		})
	} catch (error) {
		// A failed call still counts as an attempt, so an unreachable upstream
		// cannot be used as an unmetered retry loop.
		await gate.commit(502, "")
		return new Response(JSON.stringify({ Code: 0, Error: `Upstream unreachable: ${error}` }), {
			status: 502,
			headers: withGateHeaders(new Headers({ ...cors, "content-type": "application/json" })),
		})
	}

	// An edge error means this deployment's egress is being blocked, not that
	// the API is down: a configured sibling gets one retry from its own
	// network. The signed relay header proves the caller's address, so the
	// sibling counts the visitor rather than this deployment's address. The
	// client cannot inject the header itself — it is not on the forwarded
	// allowlist — and without the shared secret the honest edge error stands.
	if (
		context?.relayUrl &&
		context.relaySecret &&
		EDGE_ERROR_STATUSES.has(upstreamResponse.status)
	) {
		const address = clientAddress(request, context.address ?? "")
		if (address) {
			const relayHeaders = new Headers(headers)
			relayHeaders.set(
				"x-pvpn-relay",
				`${address}.${await relayProof(address, context.relaySecret)}`,
			)
			try {
				upstreamResponse = await fetch(`${context.relayUrl}${pathname}${incoming.search}`, {
					method: request.method,
					headers: relayHeaders,
					body,
					redirect: "follow",
				})
			} catch {
				// An unreachable relay is no worse than the block that triggered it:
				// the original edge error is the answer either way.
			}
		}
	}

	const responseHeaders = new Headers(cors)
	for (const [name, value] of upstreamResponse.headers) {
		const lower = name.toLowerCase()
		if (STRIPPED_RESPONSE_HEADERS.has(lower)) continue
		// Proton sets its own CORS headers on some endpoints; copying them would
		// overwrite ours and reject the page.
		if (lower.startsWith("access-control-")) continue
		responseHeaders.set(name, value)
	}

	// Read as text rather than bytes: the quota gate has to look inside the
	// payload to tell a real answer from a captcha challenge, and Proton always
	// speaks JSON here.
	const responseBody = await upstreamResponse.text()
	await gate.commit(upstreamResponse.status, responseBody)

	return new Response(responseBody, {
		status: upstreamResponse.status,
		headers: withGateHeaders(responseHeaders),
	})
}
