import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { createMirrorServer } from "../server.js"

async function listen(server) {
	await new Promise((resolve, reject) => {
		server.once("error", reject)
		server.listen(0, "127.0.0.1", resolve)
	})
	const address = server.address()
	if (!address || typeof address === "string") throw new Error("Test server has no TCP address")
	return `http://127.0.0.1:${address.port}`
}

test("the Node deployment serves the mirror and shared Proton routes", async (context) => {
	const root = await mkdtemp(join(tmpdir(), "pvpn-next-wasmer-"))
	await writeFile(join(root, "index.html"), "<!doctype html><title>mirror</title><main>ready</main>")
	await writeFile(join(root, "app.js"), "console.log('mirror')")

	const server = createMirrorServer({
		staticRoot: root,
		env: { PVPN_QUOTA_SECRET: "test-secret" },
	})
	const base = await listen(server)
	context.after(async () => {
		await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
		await rm(root, { recursive: true, force: true })
	})

	const home = await fetch(`${base}/`)
	assert.equal(home.status, 200)
	assert.match(await home.text(), /<main>ready<\/main>/)

	const navigation = await fetch(`${base}/generator/new`, {
		headers: { accept: "text/html" },
	})
	assert.equal(navigation.status, 200)
	assert.match(await navigation.text(), /<title>mirror<\/title>/)

	const missingAsset = await fetch(`${base}/missing.js`)
	assert.equal(missingAsset.status, 404)

	const health = await fetch(`${base}/api/__proxy/health`, {
		headers: { origin: "https://protonvpn-next-web.wasmer.app" },
	})
	assert.equal(health.status, 200)
	assert.equal(health.headers.get("access-control-allow-origin"), "https://protonvpn-next-web.wasmer.app")
	assert.deepEqual(await health.json(), {
		build: "2026-09-02-wasmer-node",
		origin: "https://protonvpn-next-web.wasmer.app",
		originAllowed: true,
		relayConfigured: false,
		relayFallback: false,
	})
})
