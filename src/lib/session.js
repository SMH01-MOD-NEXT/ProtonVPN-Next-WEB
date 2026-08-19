/**
 * Keeps a guest session, its server list, the account tier and the VPN
 * credentials in the browser for a day, so that generating a second
 * configuration does not mean another anonymous login, another server fetch or
 * another certificate.
 *
 * The credentials are the reason this cache holds anything sensitive. Proton
 * issues a certificate for a public key rather than for a server, so reusing
 * one means reusing the key pair it was issued for; the pair is generated in
 * the tab, stored here and never sent anywhere. That is the same exposure as
 * the `.conf` file the visitor downloads, and it is what keeps the site from
 * asking Proton for a fresh certificate on every single download.
 *
 * The refresh token rides along since v3: it is what lets the session renew
 * itself instead of dying at the one-day mark. It stays scoped to this origin
 * like the access token, and it rotates on every renewal — Proton hands out a
 * new one with each fresh access token, so a stolen copy ages out quickly.
 *
 * Everything lives in `localStorage` under one key and is rewritten as a whole,
 * so a partially written or hand-edited entry is discarded rather than merged.
 * The stored access token is a throwaway guest credential, but it is still a
 * credential: it is scoped to this origin, expires with the cache, and is wiped
 * as soon as Proton rejects it and the refresh token cannot revive it.
 */

// Bumped from v2: entries now carry the refresh token. An older entry has no
// way to renew itself, so it is simply left to be replaced at the next login.
const STORAGE_KEY = "pvpn-next.generator.session.v3"

/** Proton guest sessions outlive this comfortably; a day is the product choice. */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000

/** Server load is the part that goes stale fastest, so it is refreshed sooner. */
export const LOADS_TTL_MS = 15 * 60 * 1000

function storage() {
	try {
		// Private windows and blocked-cookie setups throw on access rather than
		// returning null, and a generator that cannot cache is still usable.
		return globalThis.localStorage ?? null
	} catch {
		return null
	}
}

function isSession(value) {
	return (
		typeof value?.accessToken === "string" &&
		value.accessToken.length > 0 &&
		typeof value?.uid === "string" &&
		value.uid.length > 0
	)
}

/**
 * The refresh token is optional: Proton has not always returned one for a
 * credential-less session, and a cache without it still works — it just
 * cannot renew itself when the access token dies.
 */
function normalizeSession(value) {
	if (!isSession(value)) return null
	return {
		accessToken: value.accessToken,
		uid: value.uid,
		refreshToken: typeof value.refreshToken === "string" && value.refreshToken.length > 0 ? value.refreshToken : null,
	}
}

/**
 * The VPN credentials are only usable as a set: the private key belongs to the
 * public key the certificate was issued for. A half-written entry has to be
 * treated as no credentials at all, or generation would emit a `.conf` whose
 * key and certificate do not match.
 */
function isCredentials(value) {
	return (
		typeof value?.wireGuardPrivateKey === "string" &&
		value.wireGuardPrivateKey.length > 0 &&
		typeof value?.publicKeyPem === "string" &&
		value.publicKeyPem.length > 0 &&
		typeof value?.certificate === "string" &&
		value.certificate.length > 0
	)
}

/**
 * Reads the cache, returning null when it is missing, unreadable, written by an
 * older shape, or older than a day.
 */
export function loadCachedSession(now = Date.now()) {
	const store = storage()
	if (!store) return null

	let parsed
	try {
		const raw = store.getItem(STORAGE_KEY)
		if (!raw) return null
		parsed = JSON.parse(raw)
	} catch {
		return null
	}

	if (!parsed || typeof parsed !== "object") return null
	if (typeof parsed.createdAt !== "number") return null
	if (!Array.isArray(parsed.servers)) return null

	const session = normalizeSession(parsed.session)
	if (!session) return null

	if (now - parsed.createdAt >= CACHE_TTL_MS) {
		clearCachedSession()
		return null
	}

	return {
		session,
		profile: parsed.profile ?? null,
		maxTier: typeof parsed.maxTier === "number" ? parsed.maxTier : 0,
		servers: parsed.servers,
		credentials: isCredentials(parsed.credentials) ? parsed.credentials : null,
		createdAt: parsed.createdAt,
		loadsUpdatedAt: typeof parsed.loadsUpdatedAt === "number" ? parsed.loadsUpdatedAt : parsed.createdAt,
		expiresAt: parsed.createdAt + CACHE_TTL_MS,
	}
}

/** Writes a freshly established session; resets the one-day clock. */
export function saveCachedSession({ session, profile, maxTier, servers, credentials }, now = Date.now()) {
	const store = storage()
	const normalized = normalizeSession(session)
	if (!store || !normalized) return null

	const entry = {
		session: normalized,
		profile: profile ?? null,
		maxTier: maxTier ?? 0,
		servers: servers ?? [],
		credentials: isCredentials(credentials) ? credentials : null,
		createdAt: now,
		loadsUpdatedAt: now,
	}

	try {
		store.setItem(STORAGE_KEY, JSON.stringify(entry))
	} catch {
		// A full or restricted quota should not break generation, only caching.
		return null
	}

	return { ...entry, expiresAt: now + CACHE_TTL_MS, loadsUpdatedAt: now }
}

/**
 * Rewrites the entry with fresh tokens and restarts the one-day clock.
 *
 * Unlike `updateCachedServers`, renewing extends the cache on purpose: Proton
 * accepted the refresh token, so the session is provably alive right now and
 * the visitor has just earned another day of it. The server list, the
 * credentials and the profile carry over untouched — a renewal changes the
 * tokens, nothing else. When the answer carries no new refresh token, the old
 * one is kept: Proton does not rotate it on every call.
 */
export function renewCachedSession(session, now = Date.now()) {
	const store = storage()
	const existing = loadCachedSession(now)
	const normalized = normalizeSession(session)
	if (!store || !existing || !normalized) return null

	const entry = {
		session: { ...normalized, refreshToken: normalized.refreshToken ?? existing.session.refreshToken },
		profile: existing.profile,
		maxTier: existing.maxTier,
		servers: existing.servers,
		credentials: existing.credentials,
		createdAt: now,
		loadsUpdatedAt: existing.loadsUpdatedAt,
	}

	try {
		store.setItem(STORAGE_KEY, JSON.stringify(entry))
	} catch {
		return null
	}

	return { ...entry, expiresAt: now + CACHE_TTL_MS }
}

/**
 * Replaces the server list without touching the session's expiry, so refreshing
 * load figures does not extend or shorten the cached day.
 */
export function updateCachedServers(servers, now = Date.now()) {
	const store = storage()
	const existing = loadCachedSession(now)
	if (!store || !existing) return null

	const entry = {
		session: existing.session,
		profile: existing.profile,
		maxTier: existing.maxTier,
		servers,
		credentials: existing.credentials,
		createdAt: existing.createdAt,
		loadsUpdatedAt: now,
	}

	try {
		store.setItem(STORAGE_KEY, JSON.stringify(entry))
	} catch {
		return null
	}

	return { ...entry, expiresAt: existing.expiresAt }
}

export function clearCachedSession() {
	try {
		storage()?.removeItem(STORAGE_KEY)
	} catch {
		/* nothing to clean up if storage is unavailable */
	}
}

/** True when the cached load figures are old enough to be worth refetching. */
export function loadsAreStale(cache, now = Date.now()) {
	if (!cache) return true
	return now - cache.loadsUpdatedAt >= LOADS_TTL_MS
}

/** Whole hours left before the cached session is dropped, for the UI. */
export function hoursRemaining(cache, now = Date.now()) {
	if (!cache) return 0
	return Math.max(0, Math.round((cache.expiresAt - now) / (60 * 60 * 1000)))
}

export const __testing = { STORAGE_KEY }
