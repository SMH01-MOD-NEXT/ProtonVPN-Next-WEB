/**
 * Deno Deploy entrypoint: serves the built site and the Proton API proxy from a
 * single deployment.
 *
 * Keeping both in one origin is what makes the generator robust: the browser
 * calls `/api/...` on the page's own origin, so there is no preflight, no
 * allow-list to keep in sync, and no way for a stale proxy deployment to break
 * the site while the site itself is up to date.
 *
 * Cloudflare runs the mirror image of this file in `worker/index.ts`, sharing
 * the same proxy and routing modules, so the two hosts stay independent.
 */

import { serveDir } from "jsr:@std/http@^1.0.0/file-server"
import { handleProxyRequest } from "./proxy/core.ts"
import { proxyPathname, wantsAppShell } from "./proxy/routing.ts"
import { createDenoStore } from "./proxy/store.js"

/** Vite's build output, produced by the deployment's own build step. */
const STATIC_ROOT = "dist"

/**
 * Quota storage, opened once at start-up.
 *
 * Deno KV is consistent across isolates and regions, so the per-day guest
 * session limit means the same thing everywhere. When the runtime has no KV the
 * store falls back to memory, which still limits a single instance.
 */
const quotaStore = await createDenoStore()
const quotaSecret = Deno.env.get("PVPN_QUOTA_SECRET") ?? ""
const relaySecret = Deno.env.get("PVPN_RELAY_SECRET") ?? ""

/**
 * Listening port.
 *
 * Deno Deploy assigns one itself and ignores this, but a container host does
 * not: Northflank hands the port over in `PORT` and routes to nothing if the
 * process picks its own. Falling back to Deno's usual 8000 keeps `deno task
 * start` behaving exactly as before for local runs.
 */
const port = Number(Deno.env.get("PORT")) || 8000

Deno.serve({ port }, async (request: Request, info?: Deno.ServeHandlerInfo): Promise<Response> => {
	const url = new URL(request.url)

	const proxied = proxyPathname(url.pathname)
	if (proxied !== null) {
		return await handleProxyRequest(request, proxied, {
			store: quotaStore,
			secret: quotaSecret,
			relaySecret,
			// Behind Deno Deploy the address arrives in a header; locally it does
			// not, and the connection info is the only way to tell callers apart.
			address: (info?.remoteAddr as Deno.NetAddr | undefined)?.hostname ?? "",
		})
	}

	const response = await serveDir(request, { fsRoot: STATIC_ROOT, quiet: true })
	if (response.status !== 404 || !wantsAppShell(request, url.pathname)) {
		return response
	}

	const shellRequest = new Request(new URL("/", url), { headers: request.headers })
	return await serveDir(shellRequest, { fsRoot: STATIC_ROOT, quiet: true })
})
