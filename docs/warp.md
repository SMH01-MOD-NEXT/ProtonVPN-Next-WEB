# WARP registration

The WARP card generates X25519 keys with WebCrypto, registers only the public key, and offers the resulting `.conf` for download. Keys/configs are kept in page memory only. Users must keep downloaded private keys secret and accept Cloudflare terms before generation.

Use API bypass (default): same-origin fixed `/api/warp/reg` or query routing `/api?__path=%2Fwarp%2Freg`. The shared handler is used by Node/Worker/Deno, Netlify and Vercel adapters. Deploy the updated mirror code before using these routes from Android. This change does not deploy or push anything automatically.

Bypass disabled: the browser calls `api.cloudflareclient.com` directly. CORS or network blocking can prevent registration; no mirror fallback is attempted in this mode. A clear localized error explains this. X25519 WebCrypto requires a modern browser and a secure context (HTTPS or localhost).

The server accepts only a bounded public-key registration payload to one fixed HTTPS URL. It does not accept arbitrary target URLs or forward Proton auth headers. Device tokens/account metadata are removed from the response; registration responses are `no-store`. Existing provider-level abuse controls should also cover this endpoint before public deployment.

Tests use synthetic responses and do not create real WARP accounts. Run `npm test` and `npm run build` using the existing dependencies.

## Endpoint and AWG2 catalog (2026-11-11)

`docs/warp-endpoints.json` records source URLs and the source script SHA-256. Cloudflare officially documents WireGuard IPv4 `162.159.193.0/24`, IPv6 `2606:4700:100::/48` and UDP 2408 / 500 / 1701 / 4500. Before login, `162.159.192.0/24` can also appear. The public reference generator lists 54 ports and 14 IPv4 prefixes, but picks only last octets 1–10, not every address in each /24. This yields 140 community candidates plus the 256-address official range (396 IPv4 suggestions). None is labelled handshake-tested. The Android app remains IPv4-only.

Generation now accepts an IPv4 candidate, any of the 54 published ports, and an optional experimental AWG2/QUIC profile. A blank IP preserves the endpoint returned by registration. Unknown candidate IPs/ports fail before registration; arbitrary custom endpoints can still be imported in a custom config. MASQUE ports and bot-gated/nonstandard service endpoints are not treated as public WireGuard endpoints.

AWG2 profile: Jc=4, Jmin=40, Jmax=70, S1=S2=S3=S4=0, H1=1/H2=2/H3=3/H4=4. I1 is generated locally with the existing QUIC Initial generator and SNI `www.cloudflare.com`, with fresh randomness per generation. This is not MASQUE. Like the reference AWG2 export, this format omits Reserved (the embedded AWG schema does not support it). Standard WG mode preserves Reserved. This difference is disclosed in the generation UI and needs a real registered handshake on the target network; no compatibility guarantee is made. Do not arbitrarily enable RandomTrailers or change WireGuard header numbers against a standard Cloudflare peer.

A UDP send, TCP connect or ICMP response does not prove a working WARP tunnel. No live account/registered handshake was created during these tests.
