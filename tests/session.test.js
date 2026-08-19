import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"

/** Minimal localStorage stand-in; the module only needs these four methods. */
function memoryStorage() {
	const entries = new Map()
	return {
		getItem: (key) => (entries.has(key) ? entries.get(key) : null),
		setItem: (key, value) => entries.set(key, String(value)),
		removeItem: (key) => entries.delete(key),
		clear: () => entries.clear(),
		get size() {
			return entries.size
		},
	}
}

let storage

beforeEach(() => {
	storage = memoryStorage()
	globalThis.localStorage = storage
})

afterEach(() => {
	delete globalThis.localStorage
})

const { STORAGE_KEY } = (await import("../src/lib/session.js")).__testing
const {
	clearCachedSession,
	hoursRemaining,
	loadCachedSession,
	loadsAreStale,
	renewCachedSession,
	saveCachedSession,
	updateCachedServers,
} = await import("../src/lib/session.js")

const SAMPLE = {
	session: { accessToken: "token", uid: "uid", refreshToken: "refresh" },
	profile: { id: "pixel8", model: "Pixel 8" },
	maxTier: 0,
	servers: [{ id: "a", name: "NL-FREE#1", exitCountry: "NL", load: 12 }],
}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

test("a saved session comes back with everything needed to skip the login", () => {
	saveCachedSession(SAMPLE, 1_000)
	const cache = loadCachedSession(1_000)

	assert.equal(cache.session.accessToken, "token")
	assert.equal(cache.session.refreshToken, "refresh")
	assert.equal(cache.profile.id, "pixel8")
	assert.equal(cache.maxTier, 0)
	assert.equal(cache.servers.length, 1)
})

test("a session without a refresh token still caches, it just cannot renew", () => {
	saveCachedSession({ ...SAMPLE, session: { accessToken: "token", uid: "uid" } }, 1_000)

	const cache = loadCachedSession(1_000)
	assert.equal(cache.session.accessToken, "token")
	assert.equal(cache.session.refreshToken, null)
})

test("the cache survives right up to the day mark and not past it", () => {
	saveCachedSession(SAMPLE, 0)

	assert.ok(loadCachedSession(DAY - 1_000), "still valid just before a day")
	assert.equal(loadCachedSession(DAY + 1_000), null, "expired after a day")
})

test("an expired entry is dropped instead of being left behind", () => {
	saveCachedSession(SAMPLE, 0)
	loadCachedSession(DAY + 1_000)

	assert.equal(storage.getItem(STORAGE_KEY), null)
})

test("a corrupted or half-written entry is treated as no cache at all", () => {
	storage.setItem(STORAGE_KEY, "{not json")
	assert.equal(loadCachedSession(1_000), null)

	storage.setItem(STORAGE_KEY, JSON.stringify({ session: { accessToken: "", uid: "" }, createdAt: 1 }))
	assert.equal(loadCachedSession(1_000), null)
})

test("refreshed servers do not extend the day the session was granted", () => {
	saveCachedSession(SAMPLE, 0)

	const refreshed = [...SAMPLE.servers, { id: "b", name: "DE-FREE#2", exitCountry: "DE", load: 40 }]
	const updated = updateCachedServers(refreshed, DAY / 2)

	assert.equal(updated.servers.length, 2)
	assert.equal(loadCachedSession(DAY + 1_000), null, "still expires a day after login")
})

test("a renewal swaps the tokens and restarts the one-day clock", () => {
	saveCachedSession(SAMPLE, 0)

	const renewed = renewCachedSession({ accessToken: "token2", uid: "uid", refreshToken: "refresh2" }, DAY / 2)

	assert.equal(renewed.session.accessToken, "token2")
	assert.equal(renewed.session.refreshToken, "refresh2")
	assert.equal(hoursRemaining(renewed, DAY / 2), 24, "a full day again")

	// The day now counts from the renewal, not from the original login.
	assert.ok(loadCachedSession(DAY + HOUR), "alive past the original deadline")
	assert.equal(loadCachedSession(DAY / 2 + DAY + 1_000), null, "gone a day after the renewal")
})

test("a renewal keeps the old refresh token when Proton does not rotate it", () => {
	saveCachedSession(SAMPLE, 0)

	const renewed = renewCachedSession({ accessToken: "token2", uid: "uid", refreshToken: null }, HOUR)

	assert.equal(renewed.session.accessToken, "token2")
	assert.equal(renewed.session.refreshToken, "refresh")
})

test("a renewal keeps the servers and credentials it knows nothing about", () => {
	const credentials = {
		wireGuardPrivateKey: "private",
		publicKeyPem: "pem",
		certificate: "cert",
	}
	saveCachedSession({ ...SAMPLE, credentials }, 0)

	const renewed = renewCachedSession({ accessToken: "token2", uid: "uid", refreshToken: "refresh2" }, HOUR)

	assert.equal(renewed.servers.length, 1)
	assert.equal(renewed.credentials.certificate, "cert")
})

test("renewing without an existing cache writes nothing", () => {
	const result = renewCachedSession({ accessToken: "t", uid: "u", refreshToken: "r" }, 0)

	assert.equal(result, null)
	assert.equal(storage.getItem(STORAGE_KEY), null)
})

test("load figures go stale long before the session does", () => {
	saveCachedSession(SAMPLE, 0)
	const cache = loadCachedSession(0)

	assert.equal(loadsAreStale(cache, 60_000), false)
	assert.equal(loadsAreStale(cache, 30 * 60_000), true)
})

test("the remaining time is reported in whole hours", () => {
	saveCachedSession(SAMPLE, 0)
	const cache = loadCachedSession(0)

	assert.equal(hoursRemaining(cache, 0), 24)
	assert.equal(hoursRemaining(cache, DAY - 1), 0)
})

test("clearing removes the entry so the next visit starts clean", () => {
	saveCachedSession(SAMPLE, 0)
	clearCachedSession()

	assert.equal(loadCachedSession(1_000), null)
})

test("the certificate is kept, so a download does not order a new one", () => {
	const credentials = {
		wireGuardPrivateKey: "private",
		publicKeyPem: "-----BEGIN PUBLIC KEY-----",
		certificate: "-----BEGIN CERTIFICATE-----",
		expirationTime: 1_700_000_000,
		extended: true,
	}

	saveCachedSession({ ...SAMPLE, credentials }, 0)

	const cache = loadCachedSession(HOUR)
	assert.equal(cache.credentials.certificate, credentials.certificate)
	assert.equal(cache.credentials.wireGuardPrivateKey, "private", "the key the certificate was issued for")
	assert.equal(cache.credentials.extended, true)
})

test("refreshing the server list leaves the certificate alone", () => {
	const credentials = {
		wireGuardPrivateKey: "private",
		publicKeyPem: "pem",
		certificate: "cert",
	}
	saveCachedSession({ ...SAMPLE, credentials }, 0)

	updateCachedServers([...SAMPLE.servers], HOUR)

	assert.equal(loadCachedSession(HOUR).credentials.certificate, "cert")
})

test("a half-written certificate is dropped rather than half-used", () => {
	saveCachedSession({ ...SAMPLE, credentials: { wireGuardPrivateKey: "private", certificate: "" } }, 0)

	assert.equal(loadCachedSession(HOUR).credentials, null, "a new one will be ordered instead")
})

test("a browser that refuses storage does not break the generator", () => {
	globalThis.localStorage = {
		getItem() {
			throw new Error("denied")
		},
		setItem() {
			throw new Error("quota")
		},
		removeItem() {
			throw new Error("denied")
		},
	}

	assert.doesNotThrow(() => saveCachedSession(SAMPLE, 0))
	assert.equal(loadCachedSession(0), null)
	assert.doesNotThrow(() => clearCachedSession())
})
