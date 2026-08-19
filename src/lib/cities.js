/**
 * Localized city names for the server picker, fetched the way the Android
 * client does it: Proton serves a country → English name → localized name map
 * at `/vpn/v1/cities/names` for the locale passed in `x-pm-locale`
 * (`ProtonVpnApi.getServerCities`, cached by `CityRepository` there).
 *
 * Translations are cached per locale for a day — the same duration the app's
 * CITY_CACHE_DURATION_MILLIS uses. Every lookup falls back to the English
 * name the server list already carries, so a missing or failed fetch never
 * breaks the picker; it just stays in English.
 */

import { apiCall } from "./api.js"

const STORAGE_KEY = "pvpn-next.generator.cities.v1"

/** Matches the app's city translation cache duration. */
export const CITIES_TTL_MS = 24 * 60 * 60 * 1000

/** The site's language codes as the BCP-47 tags Proton expects. */
const LOCALES = {
	en: "en-US",
	ru: "ru-RU",
	uk: "uk-UA",
	be: "be-BY",
	fa: "fa-IR",
	zh: "zh-CN",
}

/** The Proton locale tag for a site language, English when unknown. */
export function localeFor(language) {
	return LOCALES[language] ?? LOCALES.en
}

function storage() {
	try {
		return globalThis.localStorage ?? null
	} catch {
		return null
	}
}

function readStore() {
	const store = storage()
	if (!store) return {}
	try {
		const parsed = JSON.parse(store.getItem(STORAGE_KEY) ?? "{}")
		return parsed && typeof parsed === "object" ? parsed : {}
	} catch {
		return {}
	}
}

/** Cached country map for a locale, or null when missing or older than a day. */
export function loadCachedCities(locale, now = Date.now()) {
	const entry = readStore()[locale]
	if (!entry || typeof entry !== "object") return null
	if (typeof entry.fetchedAt !== "number" || now - entry.fetchedAt >= CITIES_TTL_MS) return null
	if (!entry.cities || typeof entry.cities !== "object") return null
	return entry.cities
}

export function saveCachedCities(locale, cities, now = Date.now()) {
	const store = storage()
	if (!store || !cities || typeof cities !== "object") return

	const all = readStore()
	all[locale] = { fetchedAt: now, cities }

	try {
		store.setItem(STORAGE_KEY, JSON.stringify(all))
	} catch {
		/* the picker works in English without the cache too */
	}
}

/**
 * Fetches the translation map for one locale.
 *
 * The response's `Cities` is keyed by exit country code, then by the English
 * city name exactly as the logical server list spells it — the same keys
 * `cityLabel` looks up later.
 */
export async function fetchCityNames({ profile, session, locale, signal }) {
	const payload = await apiCall("/vpn/v1/cities/names", {
		profile,
		session,
		extraHeaders: { "x-pm-locale": locale },
		signal,
	})
	return payload.Cities ?? {}
}

/**
 * The localized name of one city. Anything missing — the country, the city,
 * the translation itself — falls back to the English name from the server
 * list, which is always a correct label.
 */
export function cityLabel(cities, countryCode, englishName) {
	if (!englishName) return englishName
	const translated = cities?.[countryCode]?.[englishName]
	return typeof translated === "string" && translated.length > 0 ? translated : englishName
}

export const __testing = { STORAGE_KEY }
