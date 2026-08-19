import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"

/** Minimal localStorage stand-in; the module only needs these three methods. */
function memoryStorage() {
	const entries = new Map()
	return {
		getItem: (key) => (entries.has(key) ? entries.get(key) : null),
		setItem: (key, value) => entries.set(key, String(value)),
		removeItem: (key) => entries.delete(key),
		clear: () => entries.clear(),
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

const { CITIES_TTL_MS, __testing, cityLabel, loadCachedCities, localeFor, saveCachedCities } = await import(
	"../src/lib/cities.js"
)

const SAMPLE_CITIES = {
	NL: { Amsterdam: "Амстердам", Rotterdam: "Роттердам" },
	JP: { Tokyo: "Токио" },
}

test("saved translations come back for the same locale", () => {
	saveCachedCities("ru-RU", SAMPLE_CITIES, 1_000)

	assert.deepEqual(loadCachedCities("ru-RU", 1_000), SAMPLE_CITIES)
})

test("one locale's cache is never served for another", () => {
	saveCachedCities("ru-RU", SAMPLE_CITIES, 1_000)

	assert.equal(loadCachedCities("fa-IR", 1_000), null)
})

test("translations older than a day are fetched again", () => {
	saveCachedCities("ru-RU", SAMPLE_CITIES, 0)

	assert.ok(loadCachedCities("ru-RU", CITIES_TTL_MS - 1_000), "still fresh just before the mark")
	assert.equal(loadCachedCities("ru-RU", CITIES_TTL_MS + 1_000), null, "stale right after it")
})

test("a corrupted store reads as no translations at all", () => {
	storage.setItem(__testing.STORAGE_KEY, "{not json")
	assert.equal(loadCachedCities("ru-RU", 1_000), null)

	storage.setItem(__testing.STORAGE_KEY, JSON.stringify({ "ru-RU": { cities: null } }))
	assert.equal(loadCachedCities("ru-RU", 1_000), null)
})

test("the localized name wins when the map has one", () => {
	assert.equal(cityLabel(SAMPLE_CITIES, "NL", "Amsterdam"), "Амстердам")
})

test("anything missing falls back to the English name", () => {
	assert.equal(cityLabel(SAMPLE_CITIES, "NL", "Utrecht"), "Utrecht", "unknown city")
	assert.equal(cityLabel(SAMPLE_CITIES, "US", "New York"), "New York", "unknown country")
	assert.equal(cityLabel(null, "NL", "Amsterdam"), "Amsterdam", "no map at all")
	assert.equal(cityLabel({ NL: { Amsterdam: "" } }, "NL", "Amsterdam"), "Amsterdam", "empty translation")
})

test("an empty city name passes through untouched", () => {
	assert.equal(cityLabel(SAMPLE_CITIES, "NL", null), null)
	assert.equal(cityLabel(SAMPLE_CITIES, "NL", ""), "")
})

test("every site language maps to a Proton locale tag", () => {
	assert.equal(localeFor("ru"), "ru-RU")
	assert.equal(localeFor("uk"), "uk-UA")
	assert.equal(localeFor("be"), "be-BY")
	assert.equal(localeFor("fa"), "fa-IR")
	assert.equal(localeFor("zh"), "zh-CN")
	assert.equal(localeFor("en"), "en-US")
	assert.equal(localeFor("klingon"), "en-US", "unknown languages read as English")
})
