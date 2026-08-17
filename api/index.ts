/* eslint-disable @typescript-eslint/no-explicit-any */
/** Vercel serverless function proxying requests to the Proton VPN API. */

const PROXY_BUILD = "vercel-node-2026-08-17-4"

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

export default async function handler(req: any, res: any) {
  const url = new URL(req.url ?? "/", "http://localhost")
  const pathname = requestedPath(url)

  // __path is private routing metadata, not part of Proton's query string.
  url.searchParams.delete("__path")
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
    })
    return
  }

  const target = `${resolveUpstream(pathname)}${search ? `?${search}` : ""}`

  const forwardHeaders: Record<string, string> = {}
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers?.[name]
    if (typeof value === "string") forwardHeaders[name] = value
  }
  if (!forwardHeaders["user-agent"]) forwardHeaders["user-agent"] = "pvpn-next-vercel-proxy/1.0"

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

  const upstreamBody = Buffer.from(await upstreamResponse.arrayBuffer())
  res.statusCode = upstreamResponse.status
  res.end(upstreamBody)
}
