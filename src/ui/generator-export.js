/**
 * Presentation for the export controls: client format, city filter and bulk
 * download.
 *
 * Kept apart from `generator-view.js` so the wizard's original cards stay
 * readable; both files are pure rendering and hold no state.
 */

import { t } from "../i18n/index.js"
import { BULK_SCOPES } from "../lib/bulk.js"
import { cityLabel } from "../lib/cities.js"
import { CLIENT_FORMATS, SNI_DOMAINS, WIRESOCK_BROWSERS, WIRESOCK_PROTOCOLS } from "../lib/formats.js"
import { citiesOf } from "../lib/servers.js"
import { button, element, labelledField } from "./generator-view.js"

/** Sentinel for "every city", kept out of the city names themselves. */
export const ALL_CITIES = "all"

function chipRow(items, activeId, onSelect) {
	const row = element("div", "flex flex-wrap gap-2")
	for (const item of items) {
		const active = item.id === activeId
		row.append(
			button(`chip ${active ? "chip-active" : ""}`, item.label, () => onSelect(item.id), { pressed: active }),
		)
	}
	return row
}

/**
 * Client format picker.
 *
 * WireSock cannot be handed a ready-made I1 packet, so when it is selected the
 * card asks for the three fields it builds one from instead: the domain to
 * imitate, the protocol and the client fingerprint.
 */
export function formatCard({ format, sniDomain, sniProtocol, sniBrowser, handlers }) {
	const card = element("div", "card space-y-4")
	card.append(element("h3", "text-sm font-semibold text-white", t("gen_format_title")))

	card.append(
		chipRow(
			CLIENT_FORMATS.map((entry) => ({ id: entry.id, label: t(entry.labelKey) })),
			format,
			handlers.setFormat,
		),
	)

	const descriptor = CLIENT_FORMATS.find((entry) => entry.id === format) ?? CLIENT_FORMATS[0]
	card.append(element("p", "text-xs text-slate-500", t(descriptor.descKey)))

	if (format !== "wiresock") return card

	const domainInput = document.createElement("input")
	domainInput.className = "field"
	domainInput.type = "text"
	domainInput.value = sniDomain
	domainInput.setAttribute("list", "sni-domains")
	domainInput.addEventListener("input", (event) => handlers.setSniDomain(event.target.value))

	const datalist = element("datalist")
	datalist.id = "sni-domains"
	for (const domain of SNI_DOMAINS) {
		const option = element("option")
		option.value = domain
		datalist.append(option)
	}

	const domainBlock = element("div")
	domainBlock.append(labelledField("gen_sni_id", domainInput), datalist)
	domainBlock.append(
		element("p", "mt-1 text-xs text-slate-500", t("gen_sni_id_desc")),
		button("btn-ghost btn-sm mt-2", t("gen_sni_random"), handlers.randomiseSni),
	)

	const protocolBlock = element("div")
	protocolBlock.append(
		element("span", "field-label", t("gen_sni_ip")),
		chipRow(
			WIRESOCK_PROTOCOLS.map((entry) => ({ id: entry.id, label: t(entry.labelKey) })),
			sniProtocol,
			handlers.setSniProtocol,
		),
	)

	const browserBlock = element("div")
	browserBlock.append(
		element("span", "field-label", t("gen_sni_ib")),
		chipRow(
			WIRESOCK_BROWSERS.map((entry) => ({ id: entry.id, label: t(entry.labelKey) })),
			sniBrowser,
			handlers.setSniBrowser,
		),
	)

	card.append(domainBlock, protocolBlock, browserBlock)
	return card
}

/**
 * City chips for the servers currently in view.
 *
 * Proton runs several servers per city, so this is the filter that turns "the
 * Netherlands" into "Amsterdam". It renders nothing when the selection holds a
 * single city, where the choice would be meaningless.
 *
 * The chip values stay English — they are what the server list is filtered by —
 * but the labels follow the interface language through `cityNames`, and the
 * chips are sorted by those labels so the order reads alphabetically in the
 * visitor's language rather than in English.
 */
export function cityPicker({ servers, city, cityNames = {}, onSelect }) {
	const cities = citiesOf(servers)
	if (cities.length < 2) return null

	// A city's translation is keyed by its country, which the bare name loses;
	// the first server carrying the name lends it. The same English name in two
	// countries translates the same in practice, so a first match is enough.
	const countryByCity = new Map()
	for (const server of servers) {
		if (server.city && !countryByCity.has(server.city)) countryByCity.set(server.city, server.exitCountry)
	}

	const card = element("div", "card")
	card.append(element("h3", "text-sm font-semibold text-white", t("gen_city")))

	const localized = cities
		.map((name) => ({ id: name, label: cityLabel(cityNames, countryByCity.get(name), name) }))
		.sort((first, second) => first.label.localeCompare(second.label, document.documentElement.lang))

	const items = [{ id: ALL_CITIES, label: t("gen_city_all") }, ...localized]
	const row = chipRow(items, city, onSelect)
	row.classList.add("mt-4")
	card.append(row)

	return card
}

/**
 * Bulk export card.
 *
 * The scope decides how many servers end up in the download; the count is shown
 * before the click because "all servers" can mean a hundred files.
 */
export function bulkCard({ scope, count, busy, disabledScopes = [], handlers }) {
	const card = element("div", "card space-y-4")
	card.append(
		element("h3", "text-sm font-semibold text-white", t("gen_bulk_title")),
		element("p", "text-xs text-slate-500", t("gen_bulk_desc")),
	)

	const row = element("div", "flex flex-wrap gap-2")
	for (const entry of BULK_SCOPES) {
		const active = entry.id === scope
		row.append(
			button(`chip ${active ? "chip-active" : ""}`, t(entry.labelKey), () => handlers.setBulkScope(entry.id), {
				pressed: active,
				disabled: disabledScopes.includes(entry.id),
			}),
		)
	}
	card.append(row)

	card.append(
		element("p", "text-xs text-slate-400", `${count} \u00b7 ${t("gen_bulk_count")}`),
		element("p", "text-xs text-slate-500", t("gen_bulk_note")),
		button("btn-primary", busy ? t("gen_bulk_downloading") : t("gen_bulk_download"), handlers.downloadBundle, {
			disabled: busy || count === 0,
		}),
	)

	return card
}
