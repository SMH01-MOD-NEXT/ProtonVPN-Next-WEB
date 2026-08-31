/**
 * Path routing shared by the Deno server and the Cloudflare Worker.
 *
 * Both deployments serve the static site and the proxy from one origin, and the
 * split between the two has to be identical: a path that proxies on one host
 * and returns HTML on the other would make the generator work in one place and
 * fail in the other for reasons invisible from the page.
 */

/** Everything below this path is proxied to Proton instead of being served. */
export const PROXY_PREFIX = "/api"

/**
 * Maps an incoming path to the path the proxy should forward, or `null` when
 * the request belongs to the site.
 *
 * `/__proxy/health` stays at the root on purpose: the documented verification
 * command must work the same way against every deployment, including the
 * standalone proxy that has no site in front of it.
 */
export function proxyPathname(pathname: string): string | null {
	if (pathname === "/__proxy/health") return pathname
	// Same reasoning as health: the address echo has to answer identically on
	// every deployment, including the standalone proxy with no site in front of
	// it, so it keeps its root path as well as the prefixed one.
	if (pathname === "/__proxy/whoami") return pathname
	if (pathname === PROXY_PREFIX) return "/"
	if (pathname.startsWith(`${PROXY_PREFIX}/`)) return pathname.slice(PROXY_PREFIX.length)
	return null
}

/**
 * True for navigation requests, which should fall back to the app shell.
 *
 * A missing asset (`.js`, `.png`, `update.json`) must stay a real 404: serving
 * HTML in its place turns a broken path into a confusing parse error further
 * down the line.
 */
export function wantsAppShell(request: Request, pathname: string): boolean {
	if (request.method !== "GET" && request.method !== "HEAD") return false
	if (pathname.includes(".")) return false
	return (request.headers.get("accept") ?? "").includes("text/html")
}
