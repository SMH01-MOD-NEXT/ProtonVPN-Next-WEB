/**
 * Routing probe: a plain-named function to test whether Vercel routes
 * /api/* at all. If /api/ping answers but /api/[...path] does not, the
 * bracket catch-all filename is the routing problem.
 */
export default async function handler(req: any, res: any) {
  res.statusCode = 200
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify({ ok: true, route: "/api/ping", url: req.url ?? null }))
}
