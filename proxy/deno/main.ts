/**
 * Standalone Deno Deploy proxy: the shared handler with nothing in front of it.
 *
 * Kept as its own entrypoint because the Android client and the CLI call an
 * absolute proxy URL rather than a path on the site. The site's own deployments
 * mount the same handler under `/api` (`server.ts` on Deno, `worker/index.ts`
 * on Cloudflare).
 */

import { handleProxyRequest } from "../core.js"

export { handleProxyRequest }

// Guarded so importing this file does not start a second listener.
if (import.meta.main) {
	Deno.serve(handleProxyRequest)
}
