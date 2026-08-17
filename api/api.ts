/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Vercel serverless function proxying /api/* requests to the Proton VPN API.
 *
 * Runs on the Node.js runtime on purpose: the Edge Runtime is unavailable to
 * recently created Vercel projects, and an edge function in this repository
 * built without any error yet never routed — every /api/* request fell
 * through to the static 404 while the site itself deployed fine. The Node
 * runtime is the one runtime every Vercel project can still create.
 *
 * Notes:
 * - This implementation intentionally focuses on safe, single-domain proxying
 *   (only Proton upstreams are allowed). It does not implement the quota gate
 *   present in the Deno/Cloudflare deployments. For production rate-limiting
 *   or replay behaviour use an external store (Redis/Upstash) and extend the
 *   logic accordingly.
 * - CORS is intentionally open: no origin allowlist. The custom domain is
 *   served by the Cloudflare deployment; Vercel mirrors accept any origin.
 * - Deploy by placing this file at `api/[...path].ts` in the repository root.
 */

const PROXY_BUILD = "vercel-node-2026-08-17-3"

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
  // No allowlist: reflect the caller's Origin (credentials-compatible),
  // fall back to "*" for non-browser clients that send no Origin header.
  const headers: Record<string, string> = {
    "access-control-allow-origin": origin || "*",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": FORWARDED_REQUEST_HEADERS.join(", "),
    "access-control-max-age": "600",
    vary: "Origin",
  }
  if (origin) headers["access-control-allow-credentials"] = "true"
  return headers
}

function applyHeaders(res: any, headers: Record<string, string>) {
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
}

function sendJson(res: any, status: number, headers: Record<string, string>, payload: unknown) {
  applyHeaders(res, { ...headers, "content-type": "application/json" })
  res.statusCode = status
  res.end(JSON.stringify(payload))
}

/**
 * Reads the request body whichever way the runtime exposes it: @vercel/node
 * pre-parses JSON bodies into `req.body`, anything else stays on the raw
 * stream. Proton only accepts JSON on the write endpoints, so re-serializing
 * an already parsed body loses nothing.
 */
async function readRequestBody(req: any): Promise<Buffer | undefined> {
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) return req.body
    if (typeof req.body === "string") return Buffer.from(req.body)
    return Buffer.from(JSON.stringify(req.body))
  }
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  return chunks.length ? Buffer.concat(chunks) : undefined
}

export default async function handler(req: any, res: any) {
  const url = new URL(req.url ?? "/", "http://localhost")
  // Vercel maps /api/* to this function; the request URL contains the full
  // path including /api. We strip the leading /api to match the project's
  // routing semantics.
  const pathname = url.pathname.startsWith("/api") ? url.pathname.slice(4) || "/" : url.pathname

  const origin = typeof req.headers?.origin === "string" ? req.headers.origin : ""
  const cors = corsHeaders(origin)
  cors["access-control-expose-headers"] = EXPOSED_RESPONSE_HEADERS.join(", ")

  if (req.method === "OPTIONS") {
    applyHeaders(res, cors)
    res.statusCode = 204
    res.end()
    return
  }

  // Health endpoint: tells a live deploy from a stale one by its build tag.
  if (pathname === "/__proxy/health") {
    sendJson(res, 200, cors, {
      build: PROXY_BUILD,
      runtime: "node",
      node: process.version,
      origin,
    })
    return
  }

  // Restrict proxying strictly to Proton upstreams only.
  // Resolve upstream and forward.
  const target = `${resolveUpstream(pathname)}${url.search}`

  // Build forwarded headers (Node lowercases request header names).
  const forwardHeaders: Record<string, string> = {}
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const v = req.headers?.[name]
    if (typeof v === "string") forwardHeaders[name] = v
  }

  // Keep a reasonable user-agent when none is provided.
  if (!forwardHeaders["user-agent"]) forwardHeaders["user-agent"] = "pvpn-next-vercel-proxy/1.0"

  const body = ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : await readRequestBody(req)

  let upstreamResponse: Response
  try {
    upstreamResponse = await fetch(target, {
      method: req.method,
      headers: forwardHeaders,
      // Node's Buffer is a valid runtime payload but is not part of the
      // fetch BodyInit type from undici-types; cast at the call site.
      body: body as unknown as BodyInit | undefined,
      redirect: "follow",
    })
  } catch (err: any) {
    sendJson(res, 502, cors, { Code: 0, Error: `Upstream unreachable: ${err?.toString()}` })
    return
  }

  applyHeaders(res, cors)
  upstreamResponse.headers.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (STRIPPED_RESPONSE_HEADERS.has(lower)) return
    if (lower.startsWith("access-control-")) return
    res.setHeader(name, value)
  })

  const upstreamBody = Buffer.from(await upstreamResponse.arrayBuffer())

  res.statusCode = upstreamResponse.status
  res.end(upstreamBody)
}
