import { strict as assert } from "node:assert"
import { test } from "node:test"

import { buildBundle, bundleFileName, scopeServers } from "../src/lib/bulk.js"

const servers = [
	{ id: "nl-1", name: "NL-FREE#1", exitCountry: "NL", city: "Amsterdam", entryIp: "1.1.1.1", publicKey: "a=" },
	{ id: "nl-2", name: "NL-FREE#2", exitCountry: "NL", city: "Amsterdam", entryIp: "1.1.1.2", publicKey: "b=" },
	{ id: "nl-3", name: "NL#3", exitCountry: "NL", city: "Rotterdam", entryIp: "1.1.1.3", publicKey: "c=" },
	{ id: "de-1", name: "DE#1", exitCountry: "DE", city: "Berlin", entryIp: "2.2.2.1", publicKey: "d=" },
]

const settings = {
	privateKey: "key=",
	awgParams: { Jc: "3", Jmin: "1", Jmax: "3" },
	dnsId: "proton",
	mtu: "1420",
	port: 51820,
	allowedIps: "0.0.0.0/0, ::/0",
	ipv6: true,
	sniDomain: "apteka.ru",
}

test("a scope selects the servers it names", () => {
	assert.equal(scopeServers({ servers, scope: "all" }).length, 4)
	assert.equal(scopeServers({ servers, scope: "country", country: "NL" }).length, 3)
	assert.equal(scopeServers({ servers, scope: "city", country: "NL", city: "Amsterdam" }).length, 2)
	assert.deepEqual(
		scopeServers({ servers, scope: "server", server: servers[3] }).map((entry) => entry.id),
		["de-1"],
	)
	assert.deepEqual(scopeServers({ servers, scope: "server", server: null }), [])
})

test("a city scope stays inside its country", () => {
	const berlinInNetherlands = scopeServers({ servers, scope: "city", country: "NL", city: "Berlin" })
	assert.equal(berlinInNetherlands.length, 0)
})

test("the countries scope keeps the fastest server of each country", () => {
	const loaded = [
		{ id: "nl-fast", name: "NL#1", exitCountry: "NL", city: "Amsterdam", entryIp: "1.1.1.1", publicKey: "a=", load: 12 },
		{ id: "nl-slow", name: "NL#2", exitCountry: "NL", city: "Amsterdam", entryIp: "1.1.1.2", publicKey: "b=", load: 88 },
		{ id: "de-mid", name: "DE#1", exitCountry: "DE", city: "Berlin", entryIp: "2.2.2.1", publicKey: "c=", load: 40 },
	]

	assert.deepEqual(
		scopeServers({ servers: loaded, scope: "countries" }).map((entry) => entry.id),
		["de-mid", "nl-fast"],
	)
	assert.equal(bundleFileName({ scope: "countries", format: "wiresock" }), "pvpn-next-countries-wiresock.zip")
})

test("one server needs no archive", () => {
	const bundle = buildBundle({ servers: [servers[0]], format: "amneziawg", scope: "server", settings })

	assert.equal(bundle.kind, "text")
	assert.equal(bundle.fileName, "pvpn-next-NL-FREE-1.conf")
	assert.equal(bundle.count, 1)
	assert.match(bundle.text, /^\[Interface\]/)
})

test("several servers are packed into one archive", () => {
	const bundle = buildBundle({
		servers: scopeServers({ servers, scope: "country", country: "NL" }),
		format: "wiresock",
		scope: "country",
		country: "NL",
		settings,
	})

	assert.equal(bundle.kind, "zip")
	assert.equal(bundle.count, 3)
	assert.equal(bundle.fileName, "pvpn-next-NL-wiresock.zip")

	const text = new TextDecoder().decode(bundle.bytes)
	assert.ok(text.includes("NL-FREE-1.conf"))
	assert.ok(text.includes("NL-3.conf"))
	assert.ok(text.includes("Id = apteka.ru"))
})

test("Clash gets a single document holding every server", () => {
	const bundle = buildBundle({ servers, format: "clash", scope: "all", settings })

	assert.equal(bundle.kind, "text")
	assert.equal(bundle.fileName, "pvpn-next-all-clash.yaml")
	assert.equal(bundle.count, 4)
	assert.equal(bundle.text.match(/- name: /g).length, 5) // four proxies plus the group
	assert.ok(bundle.text.includes("proxy-groups:"))
})

test("the download is named after the scope", () => {
	assert.equal(
		bundleFileName({ scope: "city", format: "amneziawg", country: "NL", city: "Amsterdam" }),
		"pvpn-next-NL-Amsterdam-amneziawg.zip",
	)
	assert.equal(bundleFileName({ scope: "all", format: "clash" }), "pvpn-next-all-clash.yaml")
})
