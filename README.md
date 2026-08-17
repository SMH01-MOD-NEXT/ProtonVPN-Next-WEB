# Proton VPN-Next — website

The site for [Proton VPN-Next](https://gitlab.com/vpn-next-group/proton-vpn-next): a landing page,
the download picker for every build channel and flavour, and a config generator that produces
AmneziaWG, WireSock and Clash configuration files for Proton's free servers, in the browser.

The generator is the reason this repository is not just a static page. It opens a guest session
against the Proton API, fetches the server list, issues a WireGuard key pair and a certificate, and
writes the configuration locally. The private key never leaves the browser, and there is no account,
no database and no analytics anywhere in the stack.

**Not affiliated with Proton AG.** This is an unofficial client and an unofficial site.

## What is here

```
index.html            the landing page; the generator mounts into #generator-root
src/lib/              everything that is not the DOM: API, crypto, config writers, bulk export
src/ui/               rendering; pure functions returning detached DOM
src/i18n/             six languages, en/ru/uk/be/fa/zh, with RTL for Persian
proxy/                the Proton API proxy and its quota layer, shared by every host
api/                  the Vercel serverless proxy, which can also relay to the sibling deployments
server.ts             Deno Deploy entrypoint: static site plus the proxy on one origin
worker/index.ts       the Cloudflare mirror of the same
public/lite/          a no-CSS, no-JavaScript page for very old or very locked-down browsers
tests/                node:test suites, no browser required
```

The browser cannot call the Proton API directly — it sets no CORS headers — so every request goes
through a proxy served from the same origin as the page. `proxy/README.md` covers the standalone
deployment used by the desktop and Android clients.

## Running it

```sh
npm install
npm run dev        # vite, with the /api proxy wired up
npm test           # node --test, no browser needed
npm run build      # writes dist/
```

`dist/` is a build artifact and is not committed: every deployment runs the build itself, so no host
ever ships a stale interface. `deno task start` serves `dist/`, so build first for a local run of
the Deno entrypoint.

## Deploying

**Deno Deploy** — entrypoint `server.ts` with build command `npm run build`. It serves the freshly
built `dist/` and answers `/api` itself.

**Cloudflare Workers** — `worker/index.ts` as the entry, `dist/` as the asset directory. Deploys run
through Workers Builds with build command `npm run build` and deploy command `npx wrangler deploy`;
a manual `npm run deploy` from a checkout does the same thing. The deployment owns the custom domain
`home.protonnext.qzz.io`, so its proxy answers `https://home.protonnext.qzz.io/api/...` directly.

**Vercel** — builds on push; the functions in `api/` answer `/api`. When the direct route to Proton
fails, the function relays the same request server-side through the Cloudflare deployment first and
the Deno one second: the browser never has to reach any origin but Vercel's, which keeps the
generator usable from heavily censored networks and on days when Proton distrusts Vercel's egress
addresses.

**Container hosts** — `proxy/northflank/Dockerfile` builds the same site and proxy as one image;
`proxy/northflank/README.md` covers Northflank and `proxy/choreo/README.md` covers Choreo. Keep it
at one replica unless the quota store is made shared first, or every replica gets its own counters.

All hosts run the same proxy and are independent of each other; the page falls back from one to the
other when its own route to Proton cannot be used.

### Configuration

| Setting | Where | Purpose |
| --- | --- | --- |
| `PVPN_QUOTA_SECRET` | environment variable / `wrangler secret put` | Signs the quota cookie and hashes caller addresses. Optional but recommended; without it a built-in fallback is used. |
| `QUOTA` | Cloudflare KV binding, see `wrangler.jsonc` | Quota storage. Without it the Cache API is used, which is per-colo rather than global. Deno Deploy uses Deno KV automatically. |
| `PVPN_RELAY_SECRET` | environment variable on Vercel, Cloudflare and Deno (same value everywhere) | Signs the caller address the Vercel function relays to the sibling proxies, so relayed visitors keep their own quotas instead of sharing one bucket. Without it the relay fallback stays off. |
| `PVPN_RELAY_CF_URL`, `PVPN_RELAY_DENO_URL` | environment variables on Vercel | Optional overrides for the relay targets. The defaults are `https://home.protonnext.qzz.io/api` and the Deno deployment. |

## Rate limits

The site is a public page in front of somebody else's API, so the proxy — never the browser — counts
requests: one guest session and one session upgrade per day, one server list and three load
refreshes every two hours, three certificates per day. Callers are identified by a signed `HttpOnly`
cookie and by a hashed IP address at the same time, so clearing cookies does not reset a counter and
no raw address is stored.

Going over a limit is not an error: the proxy replays that caller's own last successful response, so
a held-down button shows the same data instead of failing. Quotas are spent on success only, because
Proton answers logins with a captcha often enough that counting attempts would lock people out of a
session they never received. The rules live in `proxy/limits.js` and are covered by `tests/`.

Calls relayed through the Vercel deployment are counted the same way: the relay forwards the
visitor's signed address and a per-relay quota cookie, so a fallback visit is indistinguishable from
a direct one.

## Contributing

Code is developed on [GitLab](https://gitlab.com/vpn-next-group/proton-vpn-next); the
[GitHub repository](https://github.com/SMH01-MOD-NEXT/ProtonVPN-Next) is a mirror. Issues and merge
requests are welcome on GitLab.

Two house rules worth knowing before a first patch: comments explain *why* something is the way it
is rather than restating the code, and translations are updated for all six languages in the same
change, so no interface ever falls back to English mid-page.

## License

GNU General Public License v3.0 or later. See [LICENSE](LICENSE).
