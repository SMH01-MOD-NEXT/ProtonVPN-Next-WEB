/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Vercel Edge function to proxy /api/* requests to Proton VPN API.
 *
 * Notes:
 * - This implementation intentionally focuses on safe, single-domain proxying
 *   (only Proton upstreams are allowed). It does not implement the quota gate
 *   present in the Deno/Cloudflare deployments. For production rate-limiting
 *   or replay behaviour use an external store (Redis/Upstash) and extend the
 *   logic accordingly.
 * - Deploy by placing this file at `api/[...path].ts` in the repository root.
 * - The function runs on the Edge runtime (Vercel): it uses standard Web APIs.
 */

export const config = {
  runtime: "edge",
}

const PROXY_BUILD = "vercel-edge-2026-08-17"

const ALLOWED_ORIGIN_PATTERNS: RegExp[] = [
  /^https:\/\/([a-z0-9-]+\.)*protonnext\.qzz\.io$/,
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
  // Vercel preview/production hosts if you want to allow them add here
]

function isAllowedOrigin(origin: string): boolean {
  return ALLOWED_ORIGIN_PATTERNS.some((p) => p.test(origin))
}

const UPSTREAMS: Array<{ prefix: string; host: string }> = [
  { prefix: "/verify-api", host: "https://verify-api.proton.me" },
  { prefix: "/verify", host: "https://verify.proton.me" },
]
const DEFAULT_UPSTREAM = "https://vpn-api.proton.me"

function resolveUpstream(pathname: string): string {
  for (const upstream of UPSTREAMS) {
    if (pathname === upstream.prefix || pathname.startsWith(`${upstream.prefix}/`)) {
      return `${upstream.host}${pathname.slice(upstream.prefix.length) || "/"}`
    }
  }
  return `${DEFAULT_UPSTREAM}${pathname}`
}

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
    "access-control-max-age": "600",
    vary: "Origin",
  }
  if (isAllowedOrigin(origin)) {
    headers["access-control-allow-origin"] = origin
    headers["access-control-allow-credentials"] = "true"
  }
  return headers
}

export default async function handler(req: Request) {
  const url = new URL(req.url)
  // Vercel maps /api/* to this function; the request URL contains the full
  // path including /api. We strip the leading /api to match the project's
  // routing semantics.
  const pathname = url.pathname.startsWith("/api") ? url.pathname.slice(4) || "/" : url.pathname

  const origin = req.headers.get("origin") ?? ""
  const cors = corsHeaders(origin)
  cors["access-control-expose-headers"] = EXPOSED_RESPONSE_HEADERS.join(", ")

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors })
  }

  // Health endpoint
  if (pathname === "/__proxy/health") {
    return new Response(JSON.stringify({ build: PROXY_BUILD, origin, originAllowed: isAllowedOrigin(origin) }), {
      status: 200,
      headers: { ...cors, "content-type": "application/json" },
    })
  }

  // Restrict proxying strictly to Proton upstreams only.
  // Resolve upstream and forward.
  const target = `${resolveUpstream(pathname)}${url.search}`

  // Build forwarded headers
  const forwardHeaders = new Headers()
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const v = req.headers.get(name)
    if (v) forwardHeaders.set(name, v)
  }

  // Keep a reasonable user-agent when none is provided.
  if (!forwardHeaders.get("user-agent")) forwardHeaders.set("user-agent", "pvpn-next-vercel-proxy/1.0")

  let upstreamResponse: Response
  try {
    upstreamResponse = await fetch(target, {
      method: req.method,
      headers: forwardHeaders,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : await req.text(),
      redirect: "follow",
    })
  } catch (err: any) {
    return new Response(JSON.stringify({ Code: 0, Error: `Upstream unreachable: ${err?.toString()}` }), {
      status: 502,
      headers: { ...cors, "content-type": "application/json" },
    })
  }

  const responseHeaders = new Headers(cors)
  for (const [name, value] of upstreamResponse.headers) {
    const lower = name.toLowerCase()
    if (STRIPPED_RESPONSE_HEADERS.has(lower)) continue
    if (lower.startsWith("access-control-")) continue
    responseHeaders.set(name, value)
  }

  const body = await upstreamResponse.text()

  return new Response(body, {
    status: upstreamResponse.status,
    headers: responseHeaders,
  })
}
