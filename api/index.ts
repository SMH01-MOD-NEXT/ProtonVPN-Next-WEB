/* eslint-disable @typescript-eslint/no-explicit-any */
/** Vercel serverless function proxying requests to the Proton VPN API. */

import { createHmac } from "node:crypto"

const PROXY_BUILD = "vercel-node-2026-08-17-5"

const UPSTREAMS: Array<{ prefix: string; host: string }> = [
  { prefix: "/verify-api", host: "https://verify-api.proton.me" },
  { prefix: "/verify", host: "https://verify.proton.me" },
]
const DEFAULT_UPSTREAM = "https://vpn-api.proton.me"

/**
 * Sibling deployments the browser can fall back to, relayed through this
 * function. The page never talks to another origin: in a censored network the
 * Vercel domain may be the only one a visitor can reach, and relaying
 * server-side also swaps the egress IP Proton sees when it starts distrusting
 * Vercel's. The client tries them in the order listed here: Cloudflare first,
 * then Deno. The values are a fixed allowlist on purpose — taking the relay
 * target from the request would turn this function into an open proxy.
 */
const RELAYS: Record<string, string> = {
  cf: process.env.PVPN_RELAY_CF_URL || "https://home.protonnext.qzz.io/api",
  deno: process.env.PVPN_RELAY_DENO_URL || "https://protonvpn-next-web--main.smh01-mirrors.deno.net/api",
}

/**
 * Secret shared by every deployment, signing the caller address this function
 * relays. Without it the sibling proxy would see this function's IP for every
 * visitor, collapsing all relayed traffic into one shared quota bucket whose
 * replayed answers would leak across visitors — so relaying is refused rather
 * than degraded when no secret is configured here.
 */
const RELAY_SECRET = process.env.PVPN_RELAY_SECRET || ""

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

function requestedPath(url: URL): string {
  const queryPath = url.searchParams.get("__path")
  if (queryPath) return queryPath.startsWith("/") ? queryPath : `/${queryPath}`
  return url.pathname.startsWith("/api") ? url.pathname.slice(4) || "/" : url.pathname
}

/** The visitor's address as Vercel reports it to the function. */
function callerAddress(req: any): string {
  const realIp = req.headers?.["x-real-ip"]
  if (typeof realIp === "string" && realIp.trim()) return realIp.trim()
  const forwarded = req.headers?.["x-forwarded-for"]
  if (typeof forwarded === "string" && forwarded) return forwarded.split(",")[0].trim()
  return ""
}

function relayProof(address: string): string {
  return createHmac("sha256", RELAY_SECRET).update(address).digest("base64url")
}

/** Reads this relay's quota cookie out of the browser's cookie header. */
function relayCookie(cookieHeader: unknown, via: string): string | null {
  if (typeof cookieHeader !== "string") return null
  const prefix = `pvpn_quota_${via}=`
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim()
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length)
  }
  return null
}

export default async function handler(req: any, res: any) {
  const url = new URL(req.url ?? "/", "http://localhost")
  const pathname = requestedPath(url)

  // Private routing metadata, never part of the forwarded query string.
  url.searchParams.delete("__path")
  const via = url.searchParams.get("__via") ?? ""
  url.searchParams.delete("__via")
  const search = url.searchParams.toString()

  const origin = typeof req.headers?.origin === "string" ? req.headers.origin : ""
  const cors = corsHeaders(origin)
  cors["access-control-expose-headers"] = EXPOSED_RESPONSE_HEADERS.join(", ")

  if (req.method === "OPTIONS") {
    applyHeaders(res, cors)
    res.statusCode = 204
    res.end()
    return
  }

  if (pathname === "/__proxy/health") {
    sendJson(res, 200, cors, {
      build: PROXY_BUILD,
      runtime: "node",
      node: process.version,
      origin,
      relays: Object.keys(RELAYS),
      relayConfigured: Boolean(RELAY_SECRET),
    })
    return
  }

  const relayBase = via ? RELAYS[via] : undefined
  if (via && (!relayBase || !RELAY_SECRET)) {
    // Deliberately not a Proton-shaped payload: the client treats responses
    // without a Code field as a dead route and moves on to the next fallback.
    sendJson(res, 502, cors, { Error: "Relay is not configured on this deployment" })
    return
  }

  const target = relayBase
    ? `${relayBase}${pathname}${search ? `?${search}` : ""}`
    : `${resolveUpstream(pathname)}${search ? `?${search}` : ""}`

  const forwardHeaders: Record<string, string> = {}
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers?.[name]
    if (typeof value === "string") forwardHeaders[name] = value
  }
  if (!forwardHeaders["user-agent"]) forwardHeaders["user-agent"] = "pvpn-next-vercel-proxy/1.0"

  if (relayBase) {
    const address = callerAddress(req)
    if (!address) {
      sendJson(res, 502, cors, { Error: "Cannot identify the relayed caller" })
      return
    }
    forwardHeaders["x-pvpn-relay"] = `${address}.${relayProof(address)}`
    // The sibling proxy's quota cookie rides the Vercel domain under a
    // per-relay name, so every visitor keeps their own quota there instead of
    // sharing this function's identity.
    const quota = relayCookie(req.headers?.["cookie"], via)
    if (quota) forwardHeaders["cookie"] = `pvpn_quota=${quota}`
  }

  const body = ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : await readRequestBody(req)

  let upstreamResponse: Response
  try {
    upstreamResponse = await fetch(target, {
      method: req.method,
      headers: forwardHeaders,
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

  // The set-cookie strip above stays, with one exception: the relay's own
  // quota cookie, renamed per relay so the Cloudflare and Deno ones never
  // overwrite each other in the Vercel-domain cookie jar.
  if (relayBase) {
    const setCookies: string[] = (upstreamResponse.headers as any).getSetCookie?.() ?? []
    for (const cookie of setCookies) {
      if (!cookie.startsWith("pvpn_quota=")) continue
      res.setHeader("set-cookie", `pvpn_quota_${via}=${cookie.slice("pvpn_quota=".length)}`)
    }
  }

  const upstreamBody = Buffer.from(await upstreamResponse.arrayBuffer())
  res.statusCode = upstreamResponse.status
  res.end(upstreamBody)
}
