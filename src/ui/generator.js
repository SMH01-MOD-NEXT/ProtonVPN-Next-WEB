/**
 * Config generator wizard: state and flow.
 *
 * Guest session -> server picked from the flag cards -> obfuscation and network
 * settings -> registered certificate -> downloadable configuration. Every call
 * goes through the CORS proxy served next to the site under `/api`; the private
 * key never leaves the tab.
 *
 * The session, the server list, the tier and the VPN credentials are cached for
 * a day (`lib/session.js`), so the usual flow is to log in once and then produce
 * as many configurations as wanted without another call to Proton.
 *
 * The certificate is issued once, right after the guest session is upgraded,
 * and reused by every configuration afterwards. That is not a shortcut: Proton
 * issues a certificate for a public key rather than for a server, so one
 * certificate covers every server, and asking for a new one per download only
 * burned the account's rate limit for no benefit.
 *
 * Rendering lives in `generator-view.js` and `generator-export.js`.
 */

import { t, onLanguageChange } from "../i18n/index.js"
import { ApiError, ProxyUnreachableError } from "../lib/api.js"
import { loginAsGuest, VerificationExhaustedError } from "../lib/auth.js"
import { Ed25519UnsupportedError, generateVpnKeys } from "../lib/crypto.js"
import { registerCertificate } from "../lib/cert.js"
import { advancedFromPreset, generateHeaderProtectionKey, nextI1, presetById } from "../lib/awg.js"
import { DomainI1UnsupportedError, generateI1FromDomain } from "../lib/quic.js"
import {
	ALLOWED_IPS_ALL,
	ALLOWED_IPS_PRESETS,
	DEFAULT_MTU,
	DEFAULT_PORT,
	DNS_PROFILES,
	configFileName,
	downloadBlob,
	downloadConfig,
} from "../lib/conf.js"
import { formatById, randomSni, renderConfig } from "../lib/formats.js"
import { buildBundle, scopeServers } from "../lib/bulk.js"
import {
	FASTEST_ID,
	TIER_FREE,
	fastestServer,
	fetchLoads,
	fetchMaxTier,
	fetchServers,
	prepareServers,
} from "../lib/servers.js"
import {
	clearCachedSession,
	hoursRemaining,
	loadCachedSession,
	loadsAreStale,
	saveCachedSession,
	updateCachedServers,
} from "../lib/session.js"
import {
	ALL_COUNTRIES,
	accordion,
	button,
	countryName,
	countryPicker,
	element,
	networkCard,
	notices,
	obfuscationCard,
	serverPicker,
	stepBar,
	unwrapCard,
} from "./generator-view.js"
import { ALL_CITIES, bulkCard, cityPicker, formatCard } from "./generator-export.js"

const STEPS = [
	{ id: "login", labelKey: "gen_step_login" },
	{ id: "settings", labelKey: "gen_step_settings" },
	{ id: "config", labelKey: "gen_step_config" },
]

const PROGRESS_KEYS = {
	session: "gen_progress_session",
	credentialless: "gen_progress_credentialless",
	rotating: "gen_progress_rotating",
	servers: "gen_progress_servers",
	keys: "gen_progress_keys",
	cert: "gen_progress_cert",
	i1: "gen_progress_i1",
	bundle: "gen_progress_bundle",
}

function errorKeyFor(error) {
	if (error instanceof ProxyUnreachableError) return "gen_error_proxy"
	if (error instanceof VerificationExhaustedError) return "gen_error_verification"
	if (error instanceof Ed25519UnsupportedError) return "gen_error_crypto"
	if (error instanceof DomainI1UnsupportedError) return "gen_error_domain"
	return "gen_error_generic"
}

/**
 * A cached session eventually stops being accepted, either because it expired
 * early or because Proton dropped it. That is not a real failure: the cache is
 * cleared and the visitor is sent back to the login step.
 */
function isSessionRejected(error) {
	return error instanceof ApiError && (error.status === 401 || error.code === 401)
}

export function mountGenerator(root) {
	const state = {
		step: "login",
		busy: false,
		progressKey: null,
		errorKey: null,
		session: null,
		profile: null,
		maxTier: TIER_FREE,
		servers: [],
		cache: null,
		// Key pair plus the certificate issued for it, shared by every config in
		// this session and restored from the cache on a return visit.
		credentials: null,
		country: ALL_COUNTRIES,
		city: ALL_CITIES,
		serverId: FASTEST_ID,
		format: "amneziawg",
		sniDomain: randomSni(),
		sniProtocol: "quic",
		sniBrowser: "curl",
		bulkScope: "all",
		presetId: "vpn-next-default",
		advanced: false,
		advancedParams: advancedFromPreset("vpn-next-default"),
		domain: "",
		dnsId: "cloudflare",
		customDns: "",
		mtu: DEFAULT_MTU,
		port: DEFAULT_PORT,
		allowedIps: ALLOWED_IPS_ALL,
		ipv6: true,
		extendedCert: true,
		// Which settings sections are unfolded. render() replaces the whole tree,
		// so the accordions cannot keep this in the DOM: they report every toggle
		// back here and the next render hands the flags back to them.
		accordionOpen: { location: true, export: false, advanced: false },
		configText: "",
		configServer: null,
		configFormat: "amneziawg",
		certExpiry: null,
		copied: false,
		generatedCount: 0,
	}

	/* ---------- session ---------- */

	function restoreCachedSession() {
		const cache = loadCachedSession()
		if (!cache) return

		state.cache = cache
		state.session = cache.session
		state.profile = cache.profile
		state.maxTier = cache.maxTier
		state.servers = cache.servers
		state.credentials = cache.credentials
		state.step = "settings"

		// Load figures age far faster than the session, so a returning visitor
		// quietly gets fresh numbers instead of yesterday's.
		if (loadsAreStale(cache)) refreshServers({ quiet: true })
	}

	function dropSession() {
		clearCachedSession()
		state.cache = null
		state.session = null
		state.profile = null
		state.servers = []
		state.credentials = null
		state.maxTier = TIER_FREE
		state.step = "login"
	}

	function fail(error) {
		if (error?.name === "AbortError") return

		if (isSessionRejected(error)) {
			dropSession()
			state.errorKey = "gen_error_session_expired"
		} else {
			state.errorKey = errorKeyFor(error)
		}

		state.busy = false
		state.progressKey = null
		render()
	}

	async function startSession() {
		state.busy = true
		state.errorKey = null
		render()

		try {
			const session = await loginAsGuest({
				onProgress: ({ stage }) => {
					if (!PROGRESS_KEYS[stage]) return
					state.progressKey = PROGRESS_KEYS[stage]
					render()
				},
			})

			state.session = { accessToken: session.accessToken, uid: session.uid }
			state.profile = session.profile
			state.progressKey = PROGRESS_KEYS.servers
			render()

			const context = { profile: state.profile, session: state.session }
			const [maxTier, logicals, loads] = await Promise.all([
				fetchMaxTier(context),
				fetchServers(context),
				fetchLoads(context),
			])

			state.maxTier = maxTier
			state.servers = prepareServers(logicals, loads, maxTier)

			// The certificate is part of the login, not of a download: issuing it
			// here means the whole day's worth of configurations costs Proton one
			// certificate call instead of one per file.
			state.credentials = await issueCredentials()
			state.cache = saveCachedSession({
				session: state.session,
				profile: state.profile,
				maxTier: state.maxTier,
				servers: state.servers,
				credentials: state.credentials,
			})

			state.step = "settings"
			state.busy = false
			state.progressKey = null
			render()
		} catch (error) {
			fail(error)
		}
	}

	async function refreshServers({ quiet = false } = {}) {
		if (!state.session) return

		if (!quiet) {
			state.busy = true
			state.progressKey = PROGRESS_KEYS.servers
			render()
		}

		try {
			const context = { profile: state.profile, session: state.session }
			const [logicals, loads] = await Promise.all([fetchServers(context), fetchLoads(context)])

			state.servers = prepareServers(logicals, loads, state.maxTier)
			state.cache = updateCachedServers(state.servers) ?? state.cache
			state.busy = false
			state.progressKey = null
			render()
		} catch (error) {
			// A background refresh must never throw away a usable cached list.
			if (quiet && !isSessionRejected(error)) return
			fail(error)
		}
	}

	/* ---------- selection ---------- */

	/** Servers matching the country filter, before the city narrows it down. */
	function countryServers() {
		return state.country === ALL_COUNTRIES
			? state.servers
			: state.servers.filter((server) => server.exitCountry === state.country)
	}

	function visibleServers() {
		const candidates = countryServers()
		if (state.city === ALL_CITIES) return candidates
		return candidates.filter((server) => server.city === state.city)
	}

	/** Resolves the picker selection, including the "fastest" pseudo-entry. */
	function selectedServer() {
		const candidates = visibleServers()
		if (state.serverId === FASTEST_ID) return fastestServer(candidates)
		return candidates.find((server) => server.id === state.serverId) ?? fastestServer(candidates)
	}

	function obfuscationParams() {
		return state.advanced ? { ...state.advancedParams } : presetById(state.presetId).params()
	}

	/** Everything a configuration needs except the server and the private key. */
	function configSettings() {
		return {
			awgParams: obfuscationParams(),
			dnsId: state.dnsId,
			customDns: state.customDns,
			mtu: state.mtu,
			port: state.port,
			allowedIps: state.allowedIps,
			ipv6: state.ipv6,
			sniDomain: state.sniDomain,
			sniProtocol: state.sniProtocol,
			sniBrowser: state.sniBrowser,
		}
	}

	/** The servers the bulk export currently covers. */
	function bulkServers() {
		return scopeServers({
			servers: state.servers,
			scope: state.bulkScope,
			server: selectedServer(),
			country: state.country,
			city: state.city,
		})
	}

	const handlers = {
		setAdvanced(value) {
			// Opening the editor should show what the preset was doing, not a
			// blank form.
			if (value && !state.advanced) state.advancedParams = advancedFromPreset(state.presetId)
			state.advanced = value
			render()
		},
		setPreset(id) {
			state.presetId = id
			render()
		},
		setParam(key, value) {
			// Deliberately no re-render: the caret must stay where it is.
			state.advancedParams = { ...state.advancedParams, [key]: value }
		},
		resetAdvanced() {
			state.advancedParams = advancedFromPreset(state.presetId)
			render()
		},
		generateHeaderKey() {
			state.advancedParams = { ...state.advancedParams, HeaderProtectionKey: generateHeaderProtectionKey() }
			render()
		},
		rotateI1() {
			state.advancedParams = { ...state.advancedParams, I1: nextI1(state.advancedParams.I1) }
			render()
		},
		setDomain(value) {
			state.domain = value
		},
		async applyDomainI1() {
			const domain = state.domain.trim()
			if (!domain) return

			state.busy = true
			state.errorKey = null
			state.progressKey = PROGRESS_KEYS.i1
			render()

			try {
				const i1 = await generateI1FromDomain(domain)
				state.advancedParams = { ...state.advancedParams, I1: i1 }
				state.busy = false
				state.progressKey = null
				render()
			} catch (error) {
				fail(error)
			}
		},
		setFormat(id) {
			state.format = id
			render()
		},
		setSniDomain(value) {
			state.sniDomain = value
		},
		randomiseSni() {
			state.sniDomain = randomSni()
			render()
		},
		setSniProtocol(id) {
			state.sniProtocol = id
			render()
		},
		setSniBrowser(id) {
			state.sniBrowser = id
			render()
		},
		setDns(id) {
			state.dnsId = id
			render()
		},
		setCustomDns(value) {
			state.customDns = value
		},
		setPort(value) {
			state.port = value
			render()
		},
		setMtu(value) {
			state.mtu = value
		},
		setAllowedIps(value) {
			state.allowedIps = value
		},
		setAllowedIpsPreset(id) {
			const preset = ALLOWED_IPS_PRESETS.find((entry) => entry.id === id)
			if (!preset) return
			state.allowedIps = preset.value
			render()
		},
		setIpv6(value) {
			state.ipv6 = value
			render()
		},
		setExtendedCert(value) {
			state.extendedCert = value
		},
		setBulkScope(id) {
			state.bulkScope = id
			render()
		},
		downloadBundle() {
			return downloadBundle()
		},
	}

	/* ---------- generation ---------- */

	/**
	 * Issues one key pair and the certificate that authorises it.
	 *
	 * Called once per session, from the login flow, and kept in the day-long
	 * cache afterwards. The certificate is bound to the public key rather than
	 * to a server, so the same pair serves every configuration the visitor
	 * generates.
	 */
	async function issueCredentials() {
		state.progressKey = PROGRESS_KEYS.keys
		render()

		const keys = await generateVpnKeys()

		state.progressKey = PROGRESS_KEYS.cert
		render()

		const certificate = await registerCertificate({
			profile: state.profile,
			session: state.session,
			publicKeyPem: keys.publicKeyPem,
			extended: state.extendedCert,
		})

		return {
			wireGuardPrivateKey: keys.wireGuardPrivateKey,
			publicKeyPem: keys.publicKeyPem,
			certificate: certificate.certificate ?? certificate.Certificate ?? "",
			expirationTime: certificate.expirationTime ?? null,
			extended: state.extendedCert,
		}
	}

	/**
	 * The credentials for this session, issuing them only when there are none.
	 *
	 * A cached pair is reused as-is. The one case that forces a new certificate
	 * is the visitor flipping the extended-lifetime switch after the fact, since
	 * that property is baked into the certificate and cannot be changed locally.
	 */
	async function ensureCredentials() {
		if (state.credentials && state.credentials.extended === state.extendedCert) {
			return state.credentials
		}

		const credentials = await issueCredentials()
		state.credentials = credentials
		state.cache = saveCachedSession({
			session: state.session,
			profile: state.profile,
			maxTier: state.maxTier,
			servers: state.servers,
			credentials,
		}) ?? state.cache
		return credentials
	}

	async function generate() {
		const server = selectedServer()
		if (!server) return

		state.busy = true
		state.errorKey = null
		render()

		try {
			const credentials = await ensureCredentials()

			state.configText = renderConfig({
				...configSettings(),
				format: state.format,
				server,
				privateKey: credentials.wireGuardPrivateKey,
			})
			state.certExpiry = credentials.expirationTime
			state.configServer = server
			state.configFormat = state.format
			state.generatedCount += 1
			state.copied = false
			state.step = "config"
			state.busy = false
			state.progressKey = null
			render()
		} catch (error) {
			fail(error)
		}
	}

	/**
	 * Builds every configuration in the chosen scope and hands over one file:
	 * an archive for the per-server formats, a single document for Clash.
	 */
	async function downloadBundle() {
		const servers = bulkServers()
		if (servers.length === 0) return

		state.busy = true
		state.errorKey = null
		render()

		try {
			const credentials = await ensureCredentials()

			state.progressKey = PROGRESS_KEYS.bundle
			render()

			const bundle = buildBundle({
				servers,
				format: state.format,
				scope: state.bulkScope,
				country: state.country === ALL_COUNTRIES ? null : state.country,
				city: state.city === ALL_CITIES ? null : state.city,
				settings: { ...configSettings(), privateKey: credentials.wireGuardPrivateKey },
			})

			const payload = bundle.kind === "zip" ? bundle.bytes : bundle.text
			downloadBlob(new Blob([payload], { type: bundle.mime }), bundle.fileName)

			state.generatedCount += bundle.count
			state.busy = false
			state.progressKey = null
			render()
		} catch (error) {
			fail(error)
		}
	}

	/** Back to the settings step with the session intact, for the next config. */
	function generateAnother() {
		state.step = "settings"
		state.configText = ""
		state.certExpiry = null
		state.configServer = null
		state.copied = false
		state.errorKey = null
		render()
	}

	// There is deliberately no "start over" action. Dropping a working guest
	// session only meant asking Proton for a new one, and the server-side quota
	// allows one of those per day: a visitor who pressed it twice locked
	// themselves out of a session they already had. The session is dropped
	// automatically when Proton stops accepting it, which is the only case that
	// ever needed it.

	/* ---------- steps ---------- */

	function renderLogin() {
		const card = element("div", "card")

		const warning = element("div", "rounded-xl border border-brand-light/30 bg-brand/10 p-4")
		warning.append(
			element("p", "text-sm font-semibold text-brand-light", t("gen_warning_title")),
			element("p", "mt-2 text-sm text-slate-300", t("gen_warning_text")),
		)

		card.append(
			warning,
			element("p", "mt-4 text-xs text-slate-500", t("gen_cache_explainer")),
			button("btn-primary mt-6", t("gen_start"), startSession, { disabled: state.busy }),
			notices(state),
		)
		return card
	}

	/**
	 * The session read-out, as one strip rather than a card.
	 *
	 * It carries the same figures as before — tier, server count, configurations
	 * generated, device profile — but inline, because none of them is something
	 * the visitor acts on; they are there to confirm the session is alive. The
	 * only action left is the server refresh.
	 */
	function renderSessionSummary() {
		const strip = element("div", "summary-strip")

		const facts = element("div", "summary-facts")
		facts.append(element("span", "summary-status", t("gen_session_ready")))
		if (state.cache) {
			facts.append(
				element("span", "badge", `${t("gen_cached")} \u00b7 ${hoursRemaining(state.cache)} ${t("gen_cache_hours")}`),
			)
		}

		const figures = [
			[t("gen_tier"), state.maxTier === TIER_FREE ? t("gen_tier_free") : String(state.maxTier)],
			[t("gen_servers_count"), String(state.servers.length)],
			[t("gen_generated_count"), String(state.generatedCount)],
			[t("gen_device_profile"), state.profile?.model ?? state.profile?.id ?? "\u2014"],
		]
		for (const [term, value] of figures) {
			const fact = element("span", "summary-fact")
			fact.append(element("span", "summary-term", term), element("span", "summary-value", value))
			facts.append(fact)
		}

		strip.append(facts, button("btn-ghost btn-sm", t("gen_refresh"), () => refreshServers(), { disabled: state.busy }))
		return strip
	}

	/** Reads back the chosen server, for the closed "server" section header. */
	function locationSummary() {
		const server = selectedServer()
		if (!server) return t("gen_no_servers")

		const place = [countryName(server.exitCountry), server.city].filter(Boolean).join(" \u00b7 ")
		const prefix = state.serverId === FASTEST_ID ? `${t("gen_fastest")}: ` : ""
		return `${prefix}${server.name} \u00b7 ${place}`
	}

	/** Reads back the export choice, for the closed "export" section header. */
	function exportSummary() {
		const format = t(formatById(state.format).labelKey)
		return `${format} \u00b7 ${bulkServers().length} ${t("gen_bulk_count")}`
	}

	/** Reads back the tunnel tweaks, for the closed "advanced" section header. */
	function advancedSummary() {
		const obfuscation = state.advanced ? t("gen_obf_mode_advanced") : t(presetById(state.presetId).labelKey)
		const dns = DNS_PROFILES.find((profile) => profile.id === state.dnsId)
		const dnsLabel = dns ? t(dns.labelKey) : t("gen_dns_custom")
		return `${obfuscation} \u00b7 ${dnsLabel} \u00b7 ${t("gen_port")} ${state.port}`
	}

	/**
	 * The settings step, as three collapsible sections instead of eight cards.
	 *
	 * Everything that was on the page is still on it; what changed is that only
	 * the part being worked on is unfolded, and each closed header reads back
	 * the current choice, so the page can be taken in at a glance. Picking a
	 * server is open by default because it is the one choice nobody skips, while
	 * obfuscation and network settings have working defaults and are opened by
	 * the people who came for them.
	 */
	function renderSettings() {
		const wrapper = element("div", "space-y-4")
		const candidates = visibleServers()

		const cities = cityPicker({
			servers: countryServers(),
			city: state.city,
			onSelect: (city) => {
				state.city = city
				state.serverId = FASTEST_ID
				render()
			},
		})

		wrapper.append(
			renderSessionSummary(),
			accordion({
				titleKey: "gen_section_location",
				summaryText: locationSummary(),
				open: state.accordionOpen.location,
				onToggle: (open) => {
					state.accordionOpen.location = open
				},
				children: [
					unwrapCard(
						countryPicker({
							servers: state.servers,
							selected: state.country,
							onSelect: (country) => {
								state.country = country
								state.city = ALL_CITIES
								state.serverId = FASTEST_ID
								render()
							},
						}),
					),
					unwrapCard(cities),
					unwrapCard(
						serverPicker({
							servers: candidates,
							fastest: fastestServer(candidates),
							fastestId: FASTEST_ID,
							selectedId: state.serverId,
							onSelect: (id) => {
								state.serverId = id
								render()
							},
						}),
					),
				],
			}),
			accordion({
				titleKey: "gen_section_export",
				summaryText: exportSummary(),
				open: state.accordionOpen.export,
				onToggle: (open) => {
					state.accordionOpen.export = open
				},
				children: [
					unwrapCard(
						formatCard({
							format: state.format,
							sniDomain: state.sniDomain,
							sniProtocol: state.sniProtocol,
							sniBrowser: state.sniBrowser,
							handlers,
						}),
					),
					unwrapCard(
						bulkCard({
							scope: state.bulkScope,
							count: bulkServers().length,
							busy: state.busy,
							disabledScopes: [
								...(state.country === ALL_COUNTRIES ? ["country"] : []),
								...(state.city === ALL_CITIES ? ["city"] : []),
							],
							handlers,
						}),
					),
				],
			}),
			accordion({
				titleKey: "gen_section_advanced",
				summaryText: advancedSummary(),
				open: state.accordionOpen.advanced,
				onToggle: (open) => {
					state.accordionOpen.advanced = open
				},
				children: [
					unwrapCard(
						obfuscationCard({
							advanced: state.advanced,
							presetId: state.presetId,
							params: state.advancedParams,
							busy: state.busy,
							domain: state.domain,
							handlers,
						}),
					),
					unwrapCard(
						networkCard({
							dnsId: state.dnsId,
							customDns: state.customDns,
							port: state.port,
							mtu: state.mtu,
							allowedIps: state.allowedIps,
							ipv6: state.ipv6,
							extendedCert: state.extendedCert,
							handlers,
						}),
					),
				],
			}),
		)

		const footer = element("div")
		footer.append(
			button("btn-primary", state.busy ? t("gen_generating") : t("gen_generate"), generate, {
				disabled: state.busy || candidates.length === 0,
			}),
			notices(state),
		)
		wrapper.append(footer)

		return wrapper
	}

	function renderConfigStep() {
		const card = element("div", "card")
		card.append(element("h3", "text-sm font-semibold text-white", t("gen_result_title")))

		if (state.configServer) {
			card.append(element("p", "mt-1 text-xs text-slate-500", state.configServer.name))
		}
		if (state.certExpiry) {
			const expires = new Date(state.certExpiry * 1000).toLocaleString(document.documentElement.lang)
			card.append(element("p", "mt-1 text-xs text-slate-500", `${t("gen_cert_expires")}: ${expires}`))
		}

		const code = element("pre", "code-block mt-4")
		code.append(element("code", "", state.configText))
		card.append(code)

		const extension = formatById(state.configFormat).extension
		const actions = element("div", "mt-5 flex flex-wrap gap-3")
		actions.append(
			button("btn-primary", t("gen_download_conf"), () => {
				downloadConfig(state.configText, configFileName(state.configServer, extension))
			}),
			button("btn-ghost", state.copied ? t("gen_copied") : t("gen_copy"), async () => {
				await navigator.clipboard.writeText(state.configText)
				state.copied = true
				render()
			}),
			// The session is still good, so another config is one click away.
			button("btn-ghost", t("gen_another"), generateAnother),
		)
		card.append(actions, notices(state))

		return card
	}

	/**
	 * Panes that scroll inside the page, remembered across a re-render.
	 *
	 * The wizard redraws itself completely on every choice, which threw away the
	 * scroll position of the server list: picking a server from further down the
	 * list jumped it back to the top, right after the row that was clicked
	 * disappeared from view. The panes are identified by class rather than by a
	 * key, so a new scrollable section is covered by adding it to this list.
	 */
	const SCROLLABLE_PANES = [".server-list"]

	function render() {
		const scrollPositions = SCROLLABLE_PANES.map((selector) => root.querySelector(selector)?.scrollTop ?? 0)

		root.replaceChildren()

		const section = element("div", "container-page")
		section.append(
			element("h2", "section-title", t("gen_title")),
			element("p", "section-subtitle", t("gen_subtitle")),
			stepBar(STEPS, state.step),
		)

		if (state.step === "login") section.append(renderLogin())
		else if (state.step === "settings") section.append(renderSettings())
		else section.append(renderConfigStep())

		root.append(section)

		// After the append, so the pane has its height and the position sticks.
		SCROLLABLE_PANES.forEach((selector, index) => {
			const pane = root.querySelector(selector)
			if (pane && scrollPositions[index]) pane.scrollTop = scrollPositions[index]
		})
	}

	restoreCachedSession()
	render()
	onLanguageChange(render)
}
