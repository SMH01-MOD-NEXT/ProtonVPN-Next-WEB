# WARP registration

The WARP card generates X25519 keys with WebCrypto, registers only the public key, and offers the resulting `.conf` for download. Keys/configs are kept in page memory only. Users must keep downloaded private keys secret and accept Cloudflare terms before generation.

Use API bypass (default): same-origin fixed `/api/warp/reg` or query routing `/api?__path=%2Fwarp%2Freg`. The shared handler is used by Node/Worker/Deno, Netlify and Vercel adapters. Deploy the updated mirror code before using these routes from Android. This change does not deploy or push anything automatically.

Bypass disabled: the browser calls `api.cloudflareclient.com` directly. CORS or network blocking can prevent registration; no mirror fallback is attempted in this mode. A clear localized error explains this. X25519 WebCrypto requires a modern browser and a secure context (HTTPS or localhost).

The server accepts only a bounded public-key registration payload to one fixed HTTPS URL. It does not accept arbitrary target URLs or forward Proton auth headers. Device tokens/account metadata are removed from the response; registration responses are `no-store`. Existing provider-level abuse controls should also cover this endpoint before public deployment.

Tests use synthetic responses and do not create real WARP accounts. Run `npm test` and `npm run build` using the existing dependencies.
