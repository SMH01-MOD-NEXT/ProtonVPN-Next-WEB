import en from "./en.json"
import ru from "./ru.json"
import uk from "./uk.json"
import be from "./be.json"
import kk from "./kk.json"
import fa from "./fa.json"
import zh from "./zh.json"

const STORAGE_KEY = "preferredLang"
const FALLBACK = "en"

export const LANGUAGES = [
	{ code: "en", label: "English", dir: "ltr" },
	{ code: "ru", label: "\u0420\u0443\u0441\u0441\u043a\u0438\u0439", dir: "ltr" },
	{ code: "uk", label: "\u0423\u043a\u0440\u0430\u0457\u043d\u0441\u044c\u043a\u0430", dir: "ltr" },
	{ code: "be", label: "\u0411\u0435\u043b\u0430\u0440\u0443\u0441\u043a\u0430\u044f", dir: "ltr" },
	{ code: "kk", label: "\u049a\u0430\u0437\u0430\u049b\u0448\u0430", dir: "ltr" },
	{ code: "fa", label: "\u0641\u0627\u0631\u0633\u06cc", dir: "rtl" },
	{ code: "zh", label: "\u4e2d\u6587", dir: "ltr" },
]

const BUNDLES = { en, ru, uk, be, kk, fa, zh }

let currentLang = FALLBACK
const listeners = new Set()

/** Returns the language descriptor for a code, or the fallback descriptor. */
export function languageOf(code) {
	return LANGUAGES.find((lang) => lang.code === code) ?? LANGUAGES[0]
}

/** Picks the best supported language from storage, then navigator, then fallback. */
export function detectLanguage() {
	let stored = null
	try {
		stored = localStorage.getItem(STORAGE_KEY)
	} catch {
		stored = null
	}
	if (stored && BUNDLES[stored]) return stored

	const candidates =
		typeof navigator !== "undefined" && Array.isArray(navigator.languages)
			? navigator.languages
			: [typeof navigator !== "undefined" ? navigator.language : FALLBACK]

	for (const candidate of candidates) {
		if (!candidate) continue
		const base = String(candidate).toLowerCase().split("-")[0]
		if (BUNDLES[base]) return base
	}
	return FALLBACK
}

/** Current active language code. */
export function getLanguage() {
	return currentLang
}

/** Translates a key, falling back to English and finally to the key itself. */
export function t(key) {
	const bundle = BUNDLES[currentLang] ?? BUNDLES[FALLBACK]
	return bundle[key] ?? BUNDLES[FALLBACK][key] ?? key
}

/** Subscribes to language changes. Returns an unsubscribe function. */
export function onLanguageChange(listener) {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

/**
 * Applies translations to every element carrying a `data-t*` attribute.
 *  - data-t            → textContent
 *  - data-t-placeholder → placeholder
 *  - data-t-title       → title
 *  - data-t-aria-label  → aria-label
 *  - data-t-content     → content (meta tags)
 */
export function applyTranslations(root = document) {
	for (const el of root.querySelectorAll("[data-t]")) {
		el.textContent = t(el.dataset.t)
	}
	for (const el of root.querySelectorAll("[data-t-placeholder]")) {
		el.setAttribute("placeholder", t(el.dataset.tPlaceholder))
	}
	for (const el of root.querySelectorAll("[data-t-title]")) {
		el.setAttribute("title", t(el.dataset.tTitle))
	}
	for (const el of root.querySelectorAll("[data-t-aria-label]")) {
		el.setAttribute("aria-label", t(el.dataset.tAriaLabel))
	}
	for (const el of root.querySelectorAll("[data-t-content]")) {
		el.setAttribute("content", t(el.dataset.tContent))
	}
}

/**
 * Switches the active language: updates <html lang/dir>, the body language
 * class, the document title, every translated node, and notifies listeners.
 */
export function setLanguage(code) {
	const lang = BUNDLES[code] ? code : FALLBACK
	const previous = currentLang
	currentLang = lang

	try {
		localStorage.setItem(STORAGE_KEY, lang)
	} catch {
		/* storage may be unavailable in private mode; translation still applies */
	}

	if (typeof document !== "undefined") {
		const { dir } = languageOf(lang)
		document.documentElement.lang = lang
		document.documentElement.dir = dir
		if (document.body) {
			document.body.classList.remove(`lang-${previous}`)
			document.body.classList.add(`lang-${lang}`)
		}
		document.title = t("meta_title")
		applyTranslations()
	}

	for (const listener of listeners) listener(lang)
	return lang
}

/** Initialises i18n on first paint. */
export function initI18n() {
	return setLanguage(detectLanguage())
}
