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

/**
 * IP and country panel.
 *
 * Shows the address the outside world sees, which country it is attributed to
 * and which source answered. The source is named on purpose: the fallbacks are
 * third-party services, and a visitor checking their address deserves to know
 * who they just asked.
 *
 * State lives in this closure and nowhere else — see `lib/ip-check.js` for why.
 */

import { t, onLanguageChange } from "../i18n/index.js"
import { resolveIpDetails } from "../lib/ip-check.js"

function field(labelKey, value, mono = false) {
	const term = document.createElement("dt")
	term.className = "text-xs uppercase tracking-wide text-slate-500"
	term.textContent = t(labelKey)

	const detail = document.createElement("dd")
	detail.className = mono
		? "mt-1 font-mono text-sm break-all text-white"
		: "mt-1 text-sm text-white"
	detail.textContent = value

	const cell = document.createElement("div")
	cell.append(term, detail)
	return cell
}

/**
 * Renders the panel into `root` and runs the first check straight away, the
 * way a "what is my IP" page is expected to behave.
 */
export function mountIpCheck(root) {
	const state = {
		status: "loading", // loading | ready | error
		result: null,
	}

	// Only one check may be in flight; a second click cancels the first rather
	// than racing it, so the panel cannot settle on the older answer.
	let controller = null

	function check() {
		controller?.abort()
		controller = new AbortController()
		const own = controller

		state.status = "loading"
		render()

		resolveIpDetails({ signal: own.signal })
			.then((result) => {
				if (own.signal.aborted) return
				state.result = result
				state.status = "ready"
				render()
			})
			.catch((error) => {
				if (own.signal.aborted || error?.name === "AbortError") return
				state.status = "error"
				render()
			})
	}

	function renderBody() {
		if (state.status === "loading") {
			const text = document.createElement("p")
			text.className = "text-sm text-slate-400"
			text.textContent = t("ip_checking")
			return text
		}

		if (state.status === "error") {
			const text = document.createElement("p")
			text.className = "text-sm text-slate-400"
			text.textContent = t("ip_error")
			return text
		}

		const grid = document.createElement("dl")
		grid.className = "grid gap-4 sm:grid-cols-3"
		grid.append(
			field("ip_address", state.result.ip, true),
			field("ip_country", state.result.country || t("ip_unknown")),
			field("ip_source", state.result.source),
		)
		return grid
	}

	function render() {
		root.replaceChildren()

		const card = document.createElement("div")
		card.className = "card"
		card.append(renderBody())

		const actions = document.createElement("div")
		actions.className = "mt-6 flex flex-wrap items-center gap-3"

		const refresh = document.createElement("button")
		refresh.type = "button"
		refresh.className = "btn-primary"
		refresh.disabled = state.status === "loading"
		refresh.textContent = t("ip_refresh")
		refresh.addEventListener("click", check)
		actions.append(refresh)
		card.append(actions)

		const privacy = document.createElement("p")
		privacy.className = "mt-6 text-xs text-slate-500"
		privacy.textContent = t("ip_privacy")

		root.append(card, privacy)
	}

	onLanguageChange(render)
	check()
}
