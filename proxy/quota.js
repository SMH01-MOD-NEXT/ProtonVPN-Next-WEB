/**
 * The quota gate the proxy runs every protected call through.
 *
 * `limits.js` holds the rules and the arithmetic, `identity.js` decides who is
 * calling and `store.js` remembers it. This file is the part that ties them
 * together and is the only one `core.ts` has to know about.
 *
 * The flow for one call:
 *
 *   1. resolve the caller's cookie and IP identities, issuing a signed cookie
 *      when there is none;
 *   2. read the counters for both scopes and decide: forward, replay or reject;
 *   3. after a forwarded call, store the counter and — when it succeeded — the
 *      body, so the next call over quota has something of the caller's own to
 *      be answered with.
 *
 * Nothing here trusts the request beyond its path: no header, cookie value or
 * body can raise a limit, and the client is never told anything it could act on
 * beyond the informational `x-pvpn-quota-*` headers. The one exception is the
 * relay signature, which proves a sibling deployment vouches for the caller's
 * address rather than the caller claiming one.
 */

import { resolveIdentity } from "./identity.js"
import {
	counterKey,
	evaluate,
	isSuccessfulPayload,
	nextRecord,
	remainingFor,
	replayKey,
	ruleFor,
} from "./limits.js"

/** Response body handed back when a caller is over quota with nothing cached. */
function exhaustedBody(resetAt) {
	const minutes = Math.max(1, Math.ceil((resetAt - Date.now()) / 60000))
	return JSON.stringify({
		Code: 0,
		Error: `Rate limit reached. Try again in about ${minutes} minute(s).`,
		RetryAfterMinutes: minutes,
	})
}

/**
 * Prepares the gate for one request.
 *
 * @returns an object describing what to do:
 *   - `rule: null` when the path is not limited; only `setCookie` applies.
 *   - `blocked` holds a ready response body when the call must not go upstream,
 *     either a replay of the caller's own last answer or a rate-limit error.
 *   - `commit(status, body)` records the outcome of a forwarded call.
 */
export async function openQuotaGate(request, pathname, { store, secret, relaySecret = "", address = "" } = {}) {
	const { scopes, setCookie } = await resolveIdentity(request, { secret, relaySecret, address })
	const rule = ruleFor(pathname)

	if (!rule || !store) {
		return { rule: null, setCookie, blocked: null, headers: {}, commit: async () => {} }
	}

	const now = Date.now()
	const records = await Promise.all(
		scopes.map(async ({ scope, identity }) => ({
			scope,
			identity,
			record: await store.get(counterKey(rule.id, scope, identity)),
		})),
	)

	const { decision, resetAt, blockedScope } = evaluate({ rule, records, now })
	const headers = {
		"x-pvpn-quota": rule.id,
		"x-pvpn-quota-limit": String(rule.limit),
		"x-pvpn-quota-remaining": String(remainingFor({ rule, records, now })),
		"x-pvpn-quota-reset": new Date(resetAt).toISOString(),
	}

	if (decision === "forward") {
		return {
			rule,
			setCookie,
			blocked: null,
			headers,
			async commit(status, body) {
				const success = isSuccessfulPayload(status, body)

				await Promise.all(
					records.flatMap(({ scope, identity, record }) => {
						const updated = nextRecord({ rule, record, now, success })
						const ttl = Math.max(1000, updated.resetAt - now)
						const writes = [store.put(counterKey(rule.id, scope, identity), updated, ttl)]

						// Only a good answer is worth replaying. Storing a captcha
						// challenge would hand it back for hours.
						if (success) {
							writes.push(store.put(replayKey(rule.id, scope, identity), { status, body }, ttl))
						}
						return writes
					}),
				)
			},
		}
	}

	if (decision === "reject") {
		return {
			rule,
			setCookie,
			headers: { ...headers, "x-pvpn-quota-state": "rejected" },
			blocked: { status: 429, body: exhaustedBody(resetAt) },
			commit: async () => {},
		}
	}

	// Over quota: answer with this caller's own last successful response. The
	// scope that ran out is tried first, then the other one, so a visitor who
	// cleared their cookies still gets the answer stored against their address
	// rather than a new guest session.
	const ordered = [
		...records.filter(({ scope }) => scope === blockedScope),
		...records.filter(({ scope }) => scope !== blockedScope),
	]

	for (const { scope, identity } of ordered) {
		const cached = await store.get(replayKey(rule.id, scope, identity))
		if (cached?.body) {
			return {
				rule,
				setCookie,
				headers: { ...headers, "x-pvpn-quota-state": "replayed" },
				blocked: { status: cached.status ?? 200, body: cached.body },
				commit: async () => {},
			}
		}
	}

	return {
		rule,
		setCookie,
		headers: { ...headers, "x-pvpn-quota-state": "exhausted" },
		blocked: { status: 429, body: exhaustedBody(resetAt) },
		commit: async () => {},
	}
}
