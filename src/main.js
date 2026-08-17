import "./style.css"

import {
	LANGUAGES,
	getLanguage,
	initI18n,
	setLanguage,
} from "./i18n/index.js"
import { installDiagnostics } from "./lib/diagnostics.js"
import { mountDownloads } from "./ui/downloads.js"
import { mountGenerator } from "./ui/generator.js"

function setupLanguageSwitcher() {
	const select = document.querySelector("#lang-select")
	if (!select) return

	for (const language of LANGUAGES) {
		const option = document.createElement("option")
		option.value = language.code
		option.textContent = language.label
		option.selected = language.code === getLanguage()
		select.append(option)
	}

	select.addEventListener("change", (event) => {
		setLanguage(event.target.value)
	})
}

function start() {
	initI18n()
	installDiagnostics()
	setupLanguageSwitcher()

	const downloadsRoot = document.querySelector("#downloads-root")
	if (downloadsRoot) mountDownloads(downloadsRoot)

	const generatorRoot = document.querySelector("#generator-root")
	if (generatorRoot) mountGenerator(generatorRoot)
}

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", start, { once: true })
} else {
	start()
}
