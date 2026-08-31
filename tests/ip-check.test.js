/*
 * Copyright (C) 2026 SMH01
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import {
	PUBLIC_RESOLVERS,
	countryProbes,
	echoUrls,
	isBypassUsable,
	parseTrace,
	resolverChain,
} from "../src/lib/ip-check.js"

const LANGUAGES = ["be", "en", "fa", "ru", "uk", "zh"]

/** Every string the panel and its section ask `t()` for. */
const IP_KEYS = [
	"nav_ipcheck",
	"ip_title",
	"ip_subtitle",
	"ip_checking",
	"ip_error",
	"ip_address",
	"ip_country",
	"ip_source",
	"ip_unknown",
	"ip_refresh",
	"ip_privacy",
]

const publicIds = new Set(PUBLIC_RESOLVERS.map((resolver) => resolver.id))

/** The project's own deployments a chain tries, in order, ignoring duplicates. */
function deploymentOrder(chain) {
	const order = []
	for (const source of chain) {
		if (publicIds.has(source.id)) continue
		if (!order.includes(source.id)) order.push(source.id)
	}
	return order
}

test("the visitor's own origin is asked before anyone else", () => {
	// The whole point of running an echo is that the address does not have to
	// leave the deployment the visitor already loaded the page from.
	for (const russian of [false, true]) {
		const chain = resolverChain({ russian })

		assert.equal(chain[0].id, "same-origin", `russian=${russian}: own origin must be first`)
		assert.equal(chain[0].url, "/__proxy/whoami")
	}
})

test("Cloudflare is stepped over in Russia and preferred everywhere else", () => {
	assert.deepEqual(deploymentOrder(resolverChain({ russian: false })), [
		"same-origin",
		"cloudflare",
		"vercel",
		"deno",
	])
	// Cloudflare is the endpoint currently being blocked there, so it goes last.
	assert.deepEqual(deploymentOrder(resolverChain({ russian: true })), [
		"same-origin",
		"deno",
		"vercel",
		"cloudflare",
	])
})

test("an Event Bypass is tried ahead of Cloudflare in Russia", () => {
	const bypasses = [{ id: "bypass:mts", base: "https://bypass.invalid" }]

	assert.deepEqual(deploymentOrder(resolverChain({ russian: true, bypasses })), [
		"same-origin",
		"deno",
		"bypass:mts",
		"vercel",
		"cloudflare",
	])
	assert.deepEqual(deploymentOrder(resolverChain({ russian: false, bypasses })), [
		"same-origin",
		"cloudflare",
		"vercel",
		"deno",
		"bypass:mts",
	])
})

test("a third party is never asked before the project's own copies", () => {
	const chain = resolverChain({ russian: true })
	const firstPublic = chain.findIndex((source) => publicIds.has(source.id))
	const lastOwn = chain.reduce(
		(last, source, index) => (publicIds.has(source.id) ? last : index),
		-1,
	)

	assert.ok(firstPublic > lastOwn, "a public API answered before one of our own deployments")
	assert.deepEqual(
		chain.slice(firstPublic).map((source) => source.id),
		PUBLIC_RESOLVERS.map((resolver) => resolver.id),
	)
})

test("each deployment is asked on both URL shapes it may serve", () => {
	// Vercel routes to the proxy only through /api, so the Proton path has to
	// ride in __path on that exact path; every other copy serves the plain path.
	const expected = [
		"https://example.invalid/__proxy/whoami",
		"https://example.invalid/api?__path=/__proxy/whoami",
	]

	assert.deepEqual(echoUrls("https://example.invalid"), expected)
	assert.deepEqual(echoUrls("https://example.invalid/"), expected, "a trailing slash is not a new host")
	assert.deepEqual(echoUrls(""), [])
	assert.deepEqual(echoUrls(undefined), [])
})

test("the country is asked of our own deployments before a third party", () => {
	const ids = (options) => countryProbes("203.0.113.7", options).map((probe) => probe.id)

	assert.deepEqual(ids({ russian: false }), ["cloudflare-trace", "vercel-whoami", "country.is"])
	// Cloudflare is the endpoint being blocked there, so asking it first means
	// waiting out a timeout while the panel has an address and no country.
	assert.deepEqual(ids({ russian: true }), ["vercel-whoami", "cloudflare-trace", "country.is"])
	assert.deepEqual(ids(undefined), ids({ russian: false }), "not in Russia is the default")

	const [vercel] = countryProbes("203.0.113.7", { russian: true })
	assert.ok(vercel.url.includes("/api?__path="), "Vercel reaches the proxy only through /api")

	const thirdParty = countryProbes("203.0.113.7").at(-1)
	assert.ok(thirdParty.url.endsWith("203.0.113.7"), "a third party needs the address to answer")
})

test("Cloudflare's trace body is read as key=value lines", () => {
	const fields = parseTrace("fl=1f2\nip=203.0.113.7\nloc=NL\nwarp=off\nnonsense\n")

	assert.equal(fields.ip, "203.0.113.7")
	assert.equal(fields.loc, "NL")
	assert.equal(fields.nonsense, undefined, "a line without = is not a field")
	assert.deepEqual(parseTrace(undefined), {})
})

test("a bypass stays usable until the day it names has passed", () => {
	const entry = (extra) => ({ enabled: true, url: "https://bypass.invalid", ...extra })
	const noon = new Date(Date.UTC(2026, 7, 31, 12, 0, 0))

	assert.equal(isBypassUsable(entry({ expiresAt: "forever" }), noon), true)
	assert.equal(isBypassUsable(entry({ expiresAt: "" }), noon), true, "blank means nobody knows yet")
	// Still the stated day, so it must not vanish at midnight UTC.
	assert.equal(isBypassUsable(entry({ expiresAt: "31-08-2026" }), noon), true)
	assert.equal(isBypassUsable(entry({ expiresAt: "30-08-2026" }), noon), false)
	assert.equal(isBypassUsable(entry({ enabled: false, expiresAt: "forever" }), noon), false)
	assert.equal(isBypassUsable({ enabled: true }, noon), false, "an entry without a URL is unusable")
	assert.equal(isBypassUsable(undefined, noon), false)
})

test("the panel's strings are translated in every bundle", () => {
	for (const language of LANGUAGES) {
		const bundle = JSON.parse(
			readFileSync(new URL(`../src/i18n/${language}.json`, import.meta.url), "utf8"),
		)

		for (const key of IP_KEYS) {
			assert.equal(typeof bundle[key], "string", `${language}.json is missing ${key}`)
			assert.ok(bundle[key].trim().length > 0, `${language}.json leaves ${key} empty`)
		}
	}
})

test("every string the section references is defined", () => {
	// A missing key renders as a blank label rather than an error, so nothing but
	// a test catches it.
	const html = readFileSync(new URL("../index.html", import.meta.url), "utf8")
	const en = JSON.parse(readFileSync(new URL("../src/i18n/en.json", import.meta.url), "utf8"))

	const referenced = [...html.matchAll(/data-t="(nav_ipcheck|ip_[a-z_]+)"/g)].map((match) => match[1])

	assert.ok(referenced.length > 0, "the section should reference its strings")
	for (const key of referenced) {
		assert.ok(key in en, `index.html asks for ${key}, which en.json does not define`)
	}
})
