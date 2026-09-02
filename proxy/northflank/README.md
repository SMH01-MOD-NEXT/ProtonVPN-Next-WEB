# Northflank deployment

The site and the Proton API proxy running as one container, as a third host
beside Deno Deploy and Cloudflare.

Northflank is not an edge platform, and that is why it was chosen: it runs an
ordinary long-lived process, so `server.ts` deploys unchanged. There is no
adapter in this directory and no second copy of the proxy to keep in step —
only a Dockerfile.

## Why a container changes the quota story

On Cloudflare and on any isolate-based host, an in-process counter is useless:
every isolate has its own, so the per-day limits mean nothing until a KV
namespace is bound. A container is a single process. With one replica, even the
plain in-memory store is exactly correct, and Deno's local key-value database
(the same `createDenoStore()` the Deploy version uses) makes the counters
survive a restart.

Two consequences worth knowing before scaling anything:

- **Keep it at one replica** unless you move the quota store to something
  shared. Two replicas mean two independent sets of counters, and the limits
  double without any sign that they have.
- **Mount a volume at `/deno-dir`** to keep counters across a redeploy. Without
  one, a deploy resets every window, which is a free round for everyone rather
  than an outage — acceptable, but not what you want during an abuse spike.

## Deploying

1. Create a **Service -> Deployment** from this repository, build type
   **Dockerfile**.
2. Dockerfile path `proxy/northflank/Dockerfile`, **build context the repository
   root** (`.`). The image copies `proxy/`, `server.ts` and `dist/`, so a
   context set to this directory cannot see them.
3. Port `8080`, protocol HTTP, public. Northflank injects `PORT`; `server.ts`
   reads it and falls back to 8000 locally.
4. Environment: set `PVPN_QUOTA_SECRET` (`openssl rand -base64 32`). Without it
   the proxy falls back to the secret compiled into the repository, which lets
   anyone mint their own quota cookie.
5. Optional: a persistent volume mounted at `/deno-dir`, 1 GB is plenty.
6. Optional: a **spend limit** on the project. See the numbers below for why
   this matters more here than on the other two hosts.

Verify exactly as with any other deployment:

```sh
curl -s -H 'Origin: https://protonnext.qzz.io' <service-url>/__proxy/health
curl -i -X OPTIONS \
  -H 'Origin: https://protonnext.qzz.io' \
  -H 'Access-Control-Request-Method: POST' \
  <service-url>/api/vpn/v2/logicals
```

The `.code.run` hostname Northflank assigns is already in the origin allowlist
(`proxy/core.js`), matched by shape, so a rename of the service or project does
not break CORS.

## What it costs, and how to size it

This is the part that differs from Deno Deploy and Cloudflare in kind, not in
degree. Those two have a free tier with a ceiling: cross it and things stop.
Northflank meters, so crossing a threshold produces a bill rather than an
outage. That is a better failure mode for users and a worse one for a wallet,
and it is the reason to set a spend limit on day one.

### The free tier

The **Sandbox** plan covers 2 services, 2 jobs and 1 addon, always on — no
sleeping. One proxy service fits inside it with room for a second. Northflank
documents the sandbox as not intended for production workloads.

### The meter, for anything past that

| Resource | Rate |
| --- | --- |
| CPU | $0.01667 / vCPU / hour |
| Memory | $0.00833 / GB / hour |
| Network egress | $0.06 / GB |
| Network ingress | free |
| SSD storage | $0.15 / GB / month |
| Log forwarding | $0.20 / GB, first 10 GB/month free |
| Requests | not billed (removed December 2025) |

Compute is charged per second for as long as the container is up, so an
always-on service has a floor regardless of traffic:

| Size | Monthly compute |
| --- | --- |
| 0.1 vCPU / 256 MB | ~$2.75 |
| 0.2 vCPU / 512 MB | ~$5.50 |
| 0.5 vCPU / 1 GB | ~$12.20 |

The proxy holds no state worth speaking of and spends its time waiting on
Proton, so the smallest size is the place to start.

### Egress, which is the part that scales with users

Requests are free; bytes are not. Measure the two payloads that dominate,
because they are the whole calculation:

```sh
curl -s -o /dev/null -w 'logicals %{size_download} bytes\n' \
  '<service-url>/api/vpn/v2/logicals?WithEntriesForProtocols=wireguard&WithState=true'
curl -s -o /dev/null -w 'loads %{size_download} bytes\n' \
  '<service-url>/api/vpn/v1/loads'
```

The per-user ceiling follows from the quota rules in `../limits.js`, since a
caller cannot exceed them:

| Endpoint | Quota | Ceiling per user per month |
| --- | --- | --- |
| `/vpn/v2/logicals` | 1 per 2 h | 360 fetches |
| `/vpn/v1/loads` | 3 per 2 h | 1080 fetches |
| `/vpn/v1/certificate` | 3 per 24 h | 90 issues |
| `/auth/v4/sessions` | 1 per 24 h | 30 sessions |
| `/auth/v4/credentialless` | 1 per 24 h | 30 upgrades |

So the worst case one determined visitor can cost, per month:

```
(360 x logicals_bytes + 1080 x loads_bytes) / 1e9 x $0.06
```

With a 3 MB logicals payload and a 40 KB loads payload that is about
**7 cents per user per month at the absolute ceiling** — and a real visitor who
opens the page a few times a month costs a fraction of a cent. A thousand real
users is single-digit dollars; a thousand users all pinned at the quota ceiling
is about $70.

Two things follow from that shape:

- **The quotas are the cost control**, not an anti-abuse nicety. They are the
  only reason the worst case is bounded at all. Turning them off here (by
  leaving `PVPN_QUOTA_SECRET` unset and losing cookie scoping, or by running
  multiple replicas) removes the ceiling from the bill as well as from Proton.
- A **shared upstream cache** would cut Proton's load and the fetches leaving
  the container, but not the bytes going out to visitors. Egress is per
  response served, so only the per-user quotas bound it.

### Comparing against the current Deno usage

Deno Deploy's free tier is counted in requests and outbound data per month; the
site has been staying under half of it. The same traffic on Northflank is not
measured the same way: requests do not count at all, so the comparison is only
about gigabytes out, plus the fixed compute floor above. Take the outbound
figure from the Deno dashboard, multiply by $0.06, and add the compute row —
that is the whole bill.
