# Choreo deployment

The site and the Proton API proxy running as one container on
[Choreo](https://console.choreo.dev) (WSO2 Developer Platform) — a fourth host
beside Deno Deploy, Cloudflare and Northflank.

Choreo runs the same image as Northflank, `proxy/northflank/Dockerfile`; its
header explains why there is no per-host adapter. This file only covers the
Choreo console wiring. The quota behaviour, the one-replica rule and the
per-user cost ceiling math in `../northflank/README.md` apply here unchanged.

## Why the Node.js build fails

Do not let Choreo pick a buildpack. The repository carries a `package.json`
(Vite and the test runner), so the default Node.js buildpack builds an image
that boots `node index.js` — which does not exist, because the server is Deno
(`server.ts`). That deployment dies at start-up with:

```
Error: Cannot find module '/workspace/index.js'
```

The **Dockerfile** build preset is the only supported path.

## Deploying

1. Create a **Web Application** component from this repository.
2. Build preset: **Dockerfile**.
3. Dockerfile path `proxy/northflank/Dockerfile`, **build context `.`** (the
   repository root). The image copies `proxy/`, `server.ts` and `dist/`, so a
   narrower context cannot see them.
4. Port `8080`, protocol HTTP, public. The image defaults to 8080 and
   `server.ts` honours `PORT` when the platform sets one.
5. Configs & secrets: set `PVPN_QUOTA_SECRET` (`openssl rand -base64 32`).
   Without it the proxy falls back to the secret compiled into the repository,
   which lets anyone mint their own quota cookie.
6. **Keep one replica.** The quota counters live in the container's local Deno
   KV: two replicas silently double every limit, and a redeploy starts every
   window empty — a fresh round for everyone, not an outage.

Verify exactly as with any other deployment:

```sh
curl -s -H 'Origin: https://protonnext.qzz.io' https://<your-app>.choreoapps.dev/__proxy/health
curl -i -X OPTIONS \
  -H 'Origin: https://protonnext.qzz.io' \
  -H 'Access-Control-Request-Method: POST' \
  https://<your-app>.choreoapps.dev/api/vpn/v2/logicals
```

The `*.choreoapps.dev` hostnames Choreo assigns are already in the origin
allowlist (`proxy/core.js`), matched by shape, so a rename of the component or
a custom short URL does not break CORS.
