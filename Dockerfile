# Root container image for JustRunMy.App.
#
# JustRunMy.App builds from a Dockerfile in the repository root (zip upload or
# git) and maps one container port to a managed HTTPS URL. This is the same
# site + Proton API proxy the Deno Deploy project serves and that the
# Northflank/Choreo image in `proxy/northflank/Dockerfile` runs: `server.ts`
# runs unchanged, so a change to the proxy reaches this deployment by
# rebuilding, not by being ported to a second implementation.
#
# The build context is the repository root, which is what JustRunMy.App uses:
#   docker build -t pvpn-jrma .

# Left unpinned to match the rest of the project: the entrypoint uses only
# stable Deno APIs plus `--unstable-kv`. Pin a patch release here if a build
# ever breaks.
FROM denoland/deno:alpine

# Deno's module cache *and* the local key-value database that backs the guest
# quotas live here. Without a mounted volume the counters simply start empty on
# each redeploy, which is a fresh window for everyone rather than a broken run.
ENV DENO_DIR=/deno-dir

WORKDIR /app

# Copied before the sources so a change to the site does not invalidate the
# cached dependency layer.
COPY deno.json ./
COPY server.ts ./
COPY proxy ./proxy
RUN deno cache server.ts

# The built site is committed to the repository, so the image never depends on a
# Vite build succeeding a second time in a different place.
COPY dist ./dist

# Run as a non-root user (security default). DENO_DIR holds the module cache and
# the local KV database, so the runtime user has to own it.
RUN adduser -D -u 10014 app && chown -R 10014:10014 /deno-dir
USER 10014

# JustRunMy.App maps a container port to HTTPS: expose 8080 and set the same
# port in the panel. server.ts reads PORT, so the platform may also override it
# through an environment variable without editing this file.
ENV PORT=8080
EXPOSE 8080

# A container that cannot answer is worth restarting. The health endpoint runs
# the real routing code (`/__proxy/health`), so it fails when the proxy is
# genuinely broken and not merely busy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD wget --quiet --tries=1 --spider "http://127.0.0.1:${PORT}/__proxy/health" || exit 1

CMD ["deno", "task", "start:container"]
