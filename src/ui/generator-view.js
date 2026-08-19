/**
 * Presentation for the config generator.
 *
 * Everything here is pure rendering: each function takes the values it needs
 * plus callbacks, and returns detached DOM. The wizard's state and its network
 * calls live in `generator.js`, which keeps this file readable and lets the
 * pieces be exercised without a session.
 *
 * The layout mirrors the Android client: countries and servers are chosen from
 * tappable cards with flags, the way profiles are chosen in the app, instead of
 * from dropdowns.
 */

import { t } from "../i18n/index.js"
import { ADVANCED_GROUPS, OBFUSCATION_PRESETS, presetById } from "../lib/awg.js"
import { cityLabel } from "../lib/cities.js"
import { FASTEST_FLAG, flagImage } from "../lib/flags.js"
import { ALLOWED_IPS_PRESETS, AVAILABLE_PORTS, DNS_PROFILES, allowedIpsPresetId } from "../lib/conf.js"
import { serversByCountry } from "../lib/servers.js"

/** Sentinel for "every country", kept out of the country codes themselves. */
export const ALL_COUNTRIES = "all"

export function element(tag, className, text) {
	const node = document.createElement(tag)
	if (className) node.className = className
	if (text !== undefined) node.textContent = text
	return node
}

export function button(className, text, onClick, { disabled = false, pressed = null } = {}) {
	const node = element("button", className, text)
	node.type = "button"
	node.disabled = disabled
	if (pressed !== null) node.setAttribute("aria-pressed", String(pressed))
	node.addEventListener("click", onClick)
	return node
}

export function labelledField(labelKey, control) {
	const wrapper = element("label", "block")
	wrapper.append(element("span", "field-label", t(labelKey)), control)
	return wrapper
}

/**
 * Localised country name, kept as short as the language allows.
 *
 * The short form is asked for first because the full one runs to "Соединённые
 * Штаты" in Russian and similar mouthfuls elsewhere, which overflowed the
 * country tiles and the server rows into an ellipsis. Where a language has no
 * short form the two are identical, so this costs nothing; the raw code is the
 * last resort for territories the browser does not know.
 */
export function countryName(code) {
	const lang = document.documentElement.lang

	for (const style of ["short", "long"]) {
		try {
			const name = new Intl.DisplayNames([lang], { type: "region", style }).of(code)
			if (name) return name
		} catch {
			// An unsupported style or locale simply falls through to the next one.
		}
	}

	return code
}

/** Load bar that reads at a glance, as in the app's server list. */
export function loadIndicator(load) {
	const wrapper = element("span", "load")
	const track = element("span", "load-track")
	const fill = element("span", "load-fill")

	const value = typeof load === "number" ? Math.min(100, Math.max(0, load)) : null
	fill.style.width = value === null ? "0%" : `${value}%`
	fill.dataset.level = value === null ? "unknown" : value >= 90 ? "high" : value >= 75 ? "medium" : "low"

	track.append(fill)
	wrapper.append(track, element("span", "load-value", value === null ? "\u2014" : `${value}%`))
	return wrapper
}

export function stepBar(steps, activeId) {
	const list = element("ol", "mb-8 flex flex-wrap gap-2 text-xs")
	const activeIndex = steps.findIndex((step) => step.id === activeId)

	steps.forEach((step, index) => {
		const item = element(
			"li",
			`rounded-lg px-3 py-1.5 ${index <= activeIndex ? "bg-brand/25 text-white" : "bg-white/5 text-slate-500"}`,
			`${index + 1}. ${t(step.labelKey)}`,
		)
		if (index === activeIndex) item.setAttribute("aria-current", "step")
		list.append(item)
	})

	return list
}

export function notices({ progressKey, errorKey, busy }) {
	const fragment = document.createDocumentFragment()

	if (progressKey && busy) {
		fragment.append(element("p", "mt-4 text-sm text-brand-light", t(progressKey)))
	}
	if (errorKey) {
		const alert = element(
			"p",
			"mt-4 rounded-lg border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-200",
			t(errorKey),
		)
		alert.setAttribute("role", "alert")
		fragment.append(alert)
	}

	return fragment
}

/** Country tiles, ordered by how good each country's best server is. */
export function countryPicker({ servers, selected, onSelect }) {
	const card = element("div", "card")
	card.append(element("h3", "text-sm font-semibold text-white", t("gen_country")))

	const grid = element("div", "picker-grid mt-4")

	const everywhereActive = selected === ALL_COUNTRIES
	const everywhere = button(`picker-tile ${everywhereActive ? "picker-tile-active" : ""}`, "", () => onSelect(ALL_COUNTRIES), {
		pressed: everywhereActive,
	})
	everywhere.append(
		flagImage(FASTEST_FLAG, "", "flag flag-lg"),
		element("span", "picker-title", t("gen_country_all")),
		element("span", "picker-meta", `${servers.length} \u00b7 ${t("gen_servers_count")}`),
	)
	grid.append(everywhere)

	for (const group of serversByCountry(servers)) {
		const active = selected === group.country
		const tile = button(`picker-tile ${active ? "picker-tile-active" : ""}`, "", () => onSelect(group.country), {
			pressed: active,
		})

		tile.append(
			flagImage(group.country, "", "flag flag-lg"),
			element("span", "picker-title", countryName(group.country)),
			element("span", "picker-meta", `${group.servers.length} \u00b7 ${t("gen_load")} ${group.load ?? "\u2014"}%`),
		)
		grid.append(tile)
	}

	card.append(grid)
	return card
}

/** Server rows, with "fastest" pinned on top exactly as the app pins it. */
export function serverPicker({ servers, fastest, fastestId, selectedId, cityNames = {}, onSelect }) {
	const card = element("div", "card")
	card.append(element("h3", "text-sm font-semibold text-white", t("gen_server")))

	const list = element("div", "server-list mt-4")

	const fastestActive = selectedId === fastestId
	const fastestRow = button(`server-row ${fastestActive ? "server-row-active" : ""}`, "", () => onSelect(fastestId), {
		pressed: fastestActive,
	})
	const fastestText = element("span", "server-text")
	fastestText.append(
		element("span", "server-name", t("gen_fastest")),
		element("span", "server-meta", fastest ? `${t("gen_fastest_now")}: ${fastest.name}` : t("gen_no_servers")),
	)
	fastestRow.append(flagImage(FASTEST_FLAG, "", "flag"), fastestText, loadIndicator(fastest?.load ?? null))
	list.append(fastestRow)

	for (const server of servers) {
		const active = selectedId === server.id
		const row = button(`server-row ${active ? "server-row-active" : ""}`, "", () => onSelect(server.id), {
			pressed: active,
		})

		const text = element("span", "server-text")
		text.append(
			element("span", "server-name", server.name),
			element(
				"span",
				"server-meta",
				[countryName(server.exitCountry), cityLabel(cityNames, server.exitCountry, server.city)].filter(Boolean).join(" \u00b7 "),
			),
		)

		row.append(flagImage(server.exitCountry, "", "flag"), text, loadIndicator(server.load))
		list.append(row)
	}

	card.append(list)
	return card
}

export function obfuscationCard({ advanced, presetId, params, busy, domain, handlers }) {
	const card = element("div", "card")

	const header = element("div", "flex flex-wrap items-center justify-between gap-3")
	header.append(element("h3", "text-sm font-semibold text-white", t("gen_obf_title")))

	const modes = element("div", "flex gap-2")
	modes.append(
		button(`chip ${advanced ? "" : "chip-active"}`, t("gen_obf_mode_easy"), () => handlers.setAdvanced(false), {
			pressed: !advanced,
		}),
		button(`chip ${advanced ? "chip-active" : ""}`, t("gen_obf_mode_advanced"), () => handlers.setAdvanced(true), {
			pressed: advanced,
		}),
	)
	header.append(modes)
	card.append(header)

	if (!advanced) {
		const group = element("div", "mt-4 flex flex-wrap gap-2")
		for (const preset of OBFUSCATION_PRESETS) {
			const active = preset.id === presetId
			group.append(
				button(`chip ${active ? "chip-active" : ""}`, t(preset.labelKey), () => handlers.setPreset(preset.id), {
					pressed: active,
				}),
			)
		}
		card.append(group, element("p", "mt-3 text-xs text-slate-500", t(presetById(presetId).descriptionKey)))
		return card
	}

	card.append(
		element("p", "mt-3 text-xs text-slate-500", t("gen_obf_advanced_desc")),
		advancedEditor({ params, busy, domain, handlers }),
	)
	return card
}

function advancedEditor({ params, busy, domain, handlers }) {
	const wrapper = element("div", "mt-5 space-y-6")

	for (const group of ADVANCED_GROUPS) {
		const section = element("section", "space-y-3")
		section.append(element("h4", "field-label mb-0", t(group.titleKey)))
		if (group.hintKey) section.append(element("p", "text-xs text-slate-500", t(group.hintKey)))

		const wide = group.id === "signatures" || group.id === "mimicry"
		const grid = element("div", wide ? "grid gap-4" : "grid gap-4 sm:grid-cols-4")
		for (const field of group.fields) grid.append(advancedField(field, params, handlers))
		section.append(grid)

		if (group.id === "signatures") section.append(i1Tools({ busy, domain, handlers }))
		wrapper.append(section)
	}

	wrapper.append(button("btn-ghost btn-sm", t("gen_adv_reset"), handlers.resetAdvanced))
	return wrapper
}

function advancedField(field, params, handlers) {
	const input = document.createElement(field.type === "long-text" ? "textarea" : "input")
	input.className = field.type === "long-text" ? "field field-mono" : "field"
	if (field.type === "long-text") input.rows = 3
	else input.type = field.type === "number" ? "number" : "text"
	input.value = params[field.key] ?? ""

	// Typing updates state without a re-render, so the caret never jumps.
	input.addEventListener("input", (event) => handlers.setParam(field.key, event.target.value))

	const wrapper = element("div")
	wrapper.append(labelledField(field.labelKey, input))
	if (field.hintKey) wrapper.append(element("p", "mt-1 text-xs text-slate-500", t(field.hintKey)))
	if (field.generator === "hpk") {
		wrapper.append(button("btn-ghost btn-sm mt-2", t("gen_adv_hpk_generate"), handlers.generateHeaderKey))
	}

	return wrapper
}

/** I1 controls: rotate the app's stock packets, or build one from a domain. */
function i1Tools({ busy, domain, handlers }) {
	const tools = element("div", "rounded-xl border border-white/10 bg-white/5 p-4 space-y-3")
	tools.append(element("p", "text-xs text-slate-400", t("gen_i1_tools_desc")))

	const row = element("div", "flex flex-wrap items-end gap-3")

	const domainInput = document.createElement("input")
	domainInput.className = "field"
	domainInput.type = "text"
	domainInput.value = domain
	domainInput.placeholder = t("gen_i1_domain_placeholder")
	domainInput.addEventListener("input", (event) => handlers.setDomain(event.target.value))

	const domainField = labelledField("gen_i1_domain", domainInput)
	domainField.className = "block min-w-60 flex-1"

	row.append(
		domainField,
		button("btn-ghost btn-sm", t("gen_i1_from_domain"), handlers.applyDomainI1, { disabled: busy }),
		button("btn-ghost btn-sm", t("gen_i1_rotate"), handlers.rotateI1),
	)

	tools.append(row)
	return tools
}

export function networkCard({ dnsId, customDns, port, mtu, allowedIps, ipv6, extendedCert, handlers }) {
	const card = element("div", "card space-y-5")
	card.append(element("h3", "text-sm font-semibold text-white", t("gen_network_title")))

	const dnsGroup = element("div", "flex flex-wrap gap-2")
	const choices = [...DNS_PROFILES.map((profile) => [profile.id, t(profile.labelKey)]), ["custom", t("gen_dns_custom")]]
	for (const [id, label] of choices) {
		const active = dnsId === id
		dnsGroup.append(button(`chip ${active ? "chip-active" : ""}`, label, () => handlers.setDns(id), { pressed: active }))
	}

	const dnsBlock = element("div")
	dnsBlock.append(element("span", "field-label", t("gen_dns_title")), dnsGroup)
	card.append(dnsBlock)

	if (dnsId === "custom") {
		const customInput = document.createElement("input")
		customInput.className = "field"
		customInput.type = "text"
		customInput.value = customDns
		customInput.placeholder = t("gen_dns_custom_placeholder")
		customInput.addEventListener("input", (event) => handlers.setCustomDns(event.target.value))
		card.append(labelledField("gen_dns_custom", customInput))
	}

	const portGroup = element("div", "flex flex-wrap gap-2")
	for (const candidate of AVAILABLE_PORTS) {
		const active = Number(port) === candidate
		portGroup.append(
			button(`chip ${active ? "chip-active" : ""}`, String(candidate), () => handlers.setPort(candidate), {
				pressed: active,
			}),
		)
	}
	const portBlock = element("div")
	portBlock.append(element("span", "field-label", t("gen_port")), portGroup)
	card.append(portBlock)

	const mtuInput = document.createElement("input")
	mtuInput.className = "field"
	mtuInput.type = "number"
	mtuInput.min = "1280"
	mtuInput.max = "1500"
	mtuInput.value = mtu
	mtuInput.addEventListener("input", (event) => handlers.setMtu(event.target.value))

	const allowedInput = document.createElement("textarea")
	allowedInput.className = "field field-mono"
	allowedInput.rows = 3
	allowedInput.value = allowedIps
	// No re-render on input: the LAN list is long and the caret must stay put.
	allowedInput.addEventListener("input", (event) => handlers.setAllowedIps(event.target.value))

	const grid = element("div", "grid gap-4 sm:grid-cols-2")
	grid.append(labelledField("gen_mtu", mtuInput), toggleRow("gen_ipv6", "gen_ipv6_desc", ipv6, handlers.setIpv6))
	card.append(grid)

	// The presets are the reason this field exists: routing everything is the
	// default, and skipping the local network is the option people ask for by
	// name. Anything else can still be typed in by hand.
	const presets = element("div", "flex flex-wrap gap-2")
	const activePreset = allowedIpsPresetId(allowedIps)
	for (const preset of ALLOWED_IPS_PRESETS) {
		const active = preset.id === activePreset
		presets.append(
			button(`chip ${active ? "chip-active" : ""}`, t(preset.labelKey), () => handlers.setAllowedIpsPreset(preset.id), {
				pressed: active,
			}),
		)
	}

	const allowedBlock = element("div")
	allowedBlock.append(
		element("span", "field-label", t("gen_allowed_ips")),
		presets,
		element("p", "mt-2 text-xs text-slate-500", t("gen_allowed_preset_nolan_desc")),
		allowedInput,
	)
	card.append(allowedBlock)

	card.append(toggleRow("gen_extended_cert", "gen_extended_cert_desc", extendedCert, handlers.setExtendedCert))

	return card
}

/**
 * Strips the card chrome off one of the pickers above.
 *
 * The pickers are written as standalone cards because they are also usable on
 * their own, but stacking eight bordered boxes down the settings step made the
 * page look like a form nobody wants to fill in. Inside an accordion the panel
 * already provides the frame, so the card only has to give up its border and
 * padding — not its markup, and not its behaviour.
 */
export function unwrapCard(node) {
	if (!node) return node
	node.classList.remove("card")
	node.classList.add("card-plain")
	return node
}

/**
 * One collapsible section of the settings step.
 *
 * Built on `<details>` rather than on a click handler and a state flag: it is
 * operable from the keyboard and stays usable if the styles fail to load. The
 * wizard re-renders by replacing the whole tree, which would recreate this
 * element closed, so the open flag is handed in and every fold is reported
 * back through `onToggle` for the next render to restore.
 *
 * @param summaryText Short read-out of the current choice, shown on the closed
 *   header so that nothing has to be opened just to see what is set.
 * @param onToggle Called with the new open state when the visitor folds or
 *   unfolds the section. Deliberately not a render trigger: the element has
 *   already toggled itself, the state only matters to the next render.
 */
export function accordion({ titleKey, summaryText = "", open = false, onToggle = null, children = [] }) {
	const details = element("details", "card card-accordion")
	details.open = open

	const summary = element("summary", "card-accordion-summary")
	summary.append(element("span", "card-accordion-title", t(titleKey)))
	if (summaryText) summary.append(element("span", "card-accordion-meta", summaryText))
	details.append(summary)

	const body = element("div", "card-accordion-body")
	for (const child of children) {
		if (child) body.append(child)
	}
	details.append(body)

	if (onToggle) details.addEventListener("toggle", () => onToggle(details.open))

	return details
}

/** Checkbox with a title and an explanation, as used across the settings step. */
export function toggleRow(labelKey, descKey, checked, onChange) {
	const toggle = element("label", "flex items-start gap-3")

	const checkbox = document.createElement("input")
	checkbox.type = "checkbox"
	checkbox.className = "mt-1 size-4 accent-[var(--color-brand)]"
	checkbox.checked = checked
	checkbox.addEventListener("change", (event) => onChange(event.target.checked))

	const text = element("span")
	text.append(
		element("span", "block text-sm text-white", t(labelKey)),
		element("span", "block text-xs text-slate-500", t(descKey)),
	)

	toggle.append(checkbox, text)
	return toggle
}
