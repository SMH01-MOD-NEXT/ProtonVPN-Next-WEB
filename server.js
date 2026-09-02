import { readFile, stat } from "node:fs/promises"
import { createServer } from "node:http"
import { extname, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { handleProxyRequest } from "./proxy/core.js"
import { proxyPathname, wantsAppShell } from "./proxy/routing.js"
import { memoryStore } from "./proxy/store.js"

const DEFAULT_PORT = 8080
const MAX_REQUEST_BODY = 16 * 1024 * 1024
const DEFAULT_STATIC_ROOT = fileURLToPath(new URL("./dist/", import.meta.url))

const CONTENT_TYPES = new Map([
	[".css", "text/css; charset=utf-8"],
	[".gif", "image/gif"],
	[".html", "text/html; charset=utf-8"],
	[".ico", "image/x-icon"],
	[".jpeg", "image/jpeg"],
	[".jpg", "image/jpeg"],
	[".js", "text/javascript; charset=utf-8"],
	[".json", "application/json; charset=utf-8"],
	[".map", "application/json; charset=utf-8"],
	[".mjs", "text/javascript; charset=utf-8"],
	[".png", "image/png"],
	[".svg", "image/svg+xml"],
	[".txt", "text/plain; charset=utf-8"],
	[".webmanifest", "application/manifest+json"],
	[".webp", "image/webp"],
	[".woff", "font/woff"],
	[".woff2", "font/woff2"],
	[".zip", "application/zip"],
])

function externalUrl(request) {
	return new URL(request.url ?? "/", "https://wasmer-mirror.invalid")
}

function webHeaders(request) {
	const headers = new Headers()
	for (const [name, value] of Object.entries(request.headers)) {
		if (Array.isArray(value)) {
			for (const item of value) headers.append(name, item)
		} else if (value !== undefined) {
			headers.set(name, value)
		}
	}
	return headers
}

async function requestBody(request) {
	const chunks = []
	let length = 0

	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
		length += bytes.length
		if (length > MAX_REQUEST_BODY) {
			const error = new Error("Request body exceeds 16 MiB")
			error.statusCode = 413
			throw error
		}
		chunks.push(bytes)
	}

	return chunks.length === 0 ? undefined : Buffer.concat(chunks)
}

async function toWebRequest(request) {
	const method = request.method ?? "GET"
	const init = { method, headers: webHeaders(request) }
	if (method !== "GET" && method !== "HEAD") init.body = await requestBody(request)
	return new Request(externalUrl(request), init)
}

async function writeWebResponse(request, response, reply) {
	reply.statusCode = response.status

	const setCookies = response.headers.getSetCookie?.() ?? []
	for (const [name, value] of response.headers) {
		if (name.toLowerCase() !== "set-cookie") reply.setHeader(name, value)
	}
	if (setCookies.length > 0) {
		reply.setHeader("set-cookie", setCookies)
	} else {
		const setCookie = response.headers.get("set-cookie")
		if (setCookie) reply.setHeader("set-cookie", setCookie)
	}

	if (request.method === "HEAD") {
		reply.end()
		return
	}

	reply.end(Buffer.from(await response.arrayBuffer()))
}

function staticPath(root, pathname) {
	let decoded
	try {
		decoded = decodeURIComponent(pathname)
	} catch {
		return null
	}

	const relative = decoded.replace(/^\/+/, "") || "index.html"
	const candidate = resolve(root, relative)
	const resolvedRoot = resolve(root)
	if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${sep}`)) return null
	return candidate
}

async function existingFile(candidate) {
	if (!candidate) return null
	try {
		const details = await stat(candidate)
		if (details.isFile()) return candidate
		if (!details.isDirectory()) return null

		const index = resolve(candidate, "index.html")
		return (await stat(index)).isFile() ? index : null
	} catch (error) {
		if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null
		throw error
	}
}

async function sendFile(request, reply, filename) {
	const body = await readFile(filename)
	const extension = extname(filename).toLowerCase()

	reply.statusCode = 200
	reply.setHeader("content-type", CONTENT_TYPES.get(extension) ?? "application/octet-stream")
	reply.setHeader("content-length", String(body.length))
	reply.setHeader(
		"cache-control",
		extension === ".html" ? "no-cache" : "public, max-age=86400",
	)
	reply.end(request.method === "HEAD" ? undefined : body)
}

function plain(reply, status, message) {
	const body = Buffer.from(message)
	reply.statusCode = status
	reply.setHeader("content-type", "text/plain; charset=utf-8")
	reply.setHeader("content-length", String(body.length))
	reply.end(body)
}

/**
 * Creates the one process Wasmer runs: Vite mirror and Proton proxy together.
 */
export function createMirrorServer({
	staticRoot = DEFAULT_STATIC_ROOT,
	env = process.env,
	store = memoryStore(),
} = {}) {
	const proxyContext = {
		store,
		secret: env.PVPN_QUOTA_SECRET ?? "",
		relaySecret: env.PVPN_RELAY_SECRET ?? "",
		relayUrl: env.PVPN_RELAY_URL ?? env.PVPN_RELAY_DENO_URL ?? "",
	}

	const server = createServer(async (request, reply) => {
		try {
			const url = externalUrl(request)
			const proxied = proxyPathname(url.pathname)

			if (proxied !== null) {
				const response = await handleProxyRequest(await toWebRequest(request), proxied, {
					...proxyContext,
					address: request.socket.remoteAddress ?? "",
				})
				await writeWebResponse(request, response, reply)
				return
			}

			if (request.method !== "GET" && request.method !== "HEAD") {
				plain(reply, 405, "Method Not Allowed")
				return
			}

			const direct = await existingFile(staticPath(staticRoot, url.pathname))
			if (direct) {
				await sendFile(request, reply, direct)
				return
			}

			const navigation = new Request(url, {
				method: request.method,
				headers: webHeaders(request),
			})
			if (wantsAppShell(navigation, url.pathname)) {
				const shell = await existingFile(resolve(staticRoot, "index.html"))
				if (shell) {
					await sendFile(request, reply, shell)
					return
				}
			}

			plain(reply, 404, "Not Found")
		} catch (error) {
			console.error(`[mirror] request failed: ${error instanceof Error ? error.message : String(error)}`)
			if (reply.headersSent) {
				reply.destroy(error)
				return
			}
			plain(reply, error?.statusCode === 413 ? 413 : 500, "Internal Server Error")
		}
	})

	server.requestTimeout = 45_000
	server.headersTimeout = 50_000
	return server
}

export function startMirrorServer({ port = Number(process.env.PORT) || DEFAULT_PORT } = {}) {
	const server = createMirrorServer()
	server.listen(port, "0.0.0.0", () => {
		const address = server.address()
		const actualPort = typeof address === "object" && address ? address.port : port
		console.log(`Proton VPN-Next mirror listening on port ${actualPort}`)
	})
	return server
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ""
if (entrypoint === import.meta.url) startMirrorServer()
