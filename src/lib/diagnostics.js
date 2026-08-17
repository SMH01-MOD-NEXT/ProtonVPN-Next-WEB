const MAX_ENTRIES = 12
const MAX_BODY_LENGTH = 1800
const entries = []
let installed = false

const SUMMARY_LABELS = {
	ru: "Технические подробности",
	en: "Technical details",
	uk: "Технічні подробиці",
	be: "Тэхнічныя падрабязнасці",
	fa: "جزئیات فنی",
	zh: "技术详情",
}

function record(entry) {
	entries.push({ time: new Date().toISOString(), ...entry })
	if (entries.length > MAX_ENTRIES) entries.shift()
}

function safeUrl(input) {
	try {
		const url = new URL(typeof input === "string" ? input : input.url, location.href)
		url.searchParams.delete("token")
		url.searchParams.delete("access_token")
		return `${url.pathname}${url.search}`
	} catch {
		return String(input)
	}
}

function sanitisePayload(payload) {
	if (!payload || typeof payload !== "object") return payload
	const copy = Array.isArray(payload) ? [...payload] : { ...payload }
	for (const key of ["AccessToken", "RefreshToken", "Token", "Password", "PrivateKey"]) {
		if (key in copy) copy[key] = "<redacted>"
	}
	return copy
}

function responsePreview(text, contentType) {
	if (!text) return "<empty body>"
	if (contentType.includes("json")) {
		try {
			return JSON.stringify(sanitisePayload(JSON.parse(text)), null, 2).slice(0, MAX_BODY_LENGTH)
		} catch {
			// Fall through to the raw preview when an upstream sent broken JSON.
		}
	}
	return text.slice(0, MAX_BODY_LENGTH)
}

function shouldRecord(response, text, contentType) {
	if (!response.ok || contentType.includes("text/html")) return true
	if (!contentType.includes("json") || !text) return false
	try {
		const payload = JSON.parse(text)
		return payload?.Code !== undefined && payload.Code !== 1000
	} catch {
		return true
	}
}

function formatEntries() {
	if (entries.length === 0) return "No network diagnostics were captured. Open the browser console for the original error."
	return entries
		.map((entry) => {
			const lines = [`[${entry.time}] ${entry.method} ${entry.url}`]
			if (entry.status !== undefined) lines.push(`HTTP ${entry.status}${entry.contentType ? ` · ${entry.contentType}` : ""}`)
			if (entry.error) lines.push(entry.error)
			if (entry.body) lines.push(entry.body)
			return lines.join("\n")
		})
		.join("\n\n")
}

function attachDiagnostics(alert) {
	if (alert.dataset.diagnosticsAttached === "true") return
	alert.dataset.diagnosticsAttached = "true"

	const details = document.createElement("details")
	details.className = "mt-3 border-t border-red-300/20 pt-3"

	const summary = document.createElement("summary")
	summary.className = "cursor-pointer select-none font-medium"
	const language = document.documentElement.lang?.split("-")[0] || "en"
	summary.textContent = SUMMARY_LABELS[language] || SUMMARY_LABELS.en

	const pre = document.createElement("pre")
	pre.className = "mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/30 p-3 font-mono text-xs text-red-100"
	pre.textContent = formatEntries()

	details.append(summary, pre)
	alert.append(details)
}

function observeGeneratorErrors() {
	const root = document.querySelector("#generator-root")
	if (!root) return

	const attachVisible = () => root.querySelectorAll('[role="alert"]').forEach(attachDiagnostics)
	new MutationObserver(attachVisible).observe(root, { childList: true, subtree: true })
	attachVisible()
}

export function installDiagnostics() {
	if (installed) return
	installed = true

	const originalFetch = window.fetch.bind(window)
	window.fetch = async (input, init = {}) => {
		const method = String(init.method || (typeof input !== "string" && input.method) || "GET").toUpperCase()
		const url = safeUrl(input)
		try {
			const response = await originalFetch(input, init)
			const contentType = response.headers.get("content-type") || "unknown content type"
			let text = ""
			try {
				text = await response.clone().text()
			} catch {
				// Diagnostics must never interfere with the original response.
			}
			if (shouldRecord(response, text, contentType)) {
				record({ method, url, status: response.status, contentType, body: responsePreview(text, contentType) })
			}
			return response
		} catch (error) {
			record({ method, url, error: `${error?.name || "Error"}: ${error?.message || String(error)}` })
			throw error
		}
	}

	observeGeneratorErrors()
}
