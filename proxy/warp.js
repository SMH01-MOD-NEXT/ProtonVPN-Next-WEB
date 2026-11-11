import { requestMasqueRegistration } from "../src/lib/warp-masque.js"

/** Fixed WARP registration route. Never accepts a caller-supplied upstream or private key. */
export const WARP_REGISTRATION_URL = "https://api.cloudflareclient.com/v0a2158/reg"
export async function handleWarpRegistration(request, cors = {}) {
 const headers = { ...cors, "content-type": "application/json", "cache-control": "no-store" }
 if (request.method !== "POST") return new Response('{}', { status: 405, headers: { ...headers, allow: "POST" } })
 try {
  if (Number(request.headers.get("content-length")) > 2048) throw new Error()
  const raw = await request.text()
  if (raw.length > 2048) throw new Error()
  const body = JSON.parse(raw)
  if (!/^[A-Za-z0-9+/]{43}=$/.test(body.key ?? "") || atob(body.key).length !== 32) throw new Error()
  if (body.masque_key !== undefined) {
   const result = await requestMasqueRegistration(body.key, body.masque_key, { clientHeaders: true })
   return new Response(JSON.stringify(result), { status: 200, headers })
  }
  const response = await fetch(WARP_REGISTRATION_URL, {
   method: "POST", redirect: "error", signal: AbortSignal.timeout(20000),
   headers: { "content-type": "application/json", "user-agent": "okhttp/4.12.0", "CF-Client-Version": "a-6.30-3596" },
   body: JSON.stringify({ key: body.key, install_id: "", fcm_token: "", tos: new Date().toISOString(), type: "Android", locale: "en_US", warp_enabled: true })
  })
  if (!response.ok) return new Response('{}', { status: response.status, headers })
  const result = await response.json()
  // Do not return the registration token or account identifiers to unneeded callers.
  return new Response(JSON.stringify({ config: result.config }), { status: 200, headers })
 } catch { return new Response('{}', { status: 502, headers }) }
}
