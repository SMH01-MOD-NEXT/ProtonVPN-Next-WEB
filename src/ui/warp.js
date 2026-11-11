import { t, onLanguageChange } from "../i18n/index.js"
import { element, button, labelledField, stepBar, accordion, notices, toggleRow } from "./generator-view.js"
import { generateWarpClient, WARP_FORMATS, warpFormat } from "../lib/warp-formats.js"
import { WARP_ENDPOINTS, WARP_PORTS, WARP_OFFICIAL_PORTS, validateWarpOptions } from "../lib/warp-endpoints.js"
import { MASQUE_ENDPOINTS, MASQUE_PORTS } from "../lib/warp-masque.js"
import { downloadConfig } from "../lib/conf.js"

const STEPS = [{ id: "settings", labelKey: "gen_step_settings" }, { id: "config", labelKey: "gen_step_config" }]

/** Same settings accordions, chips, step bar and result card as the Proton wizard. */
export function mountWarp(root) {
 const state = { step: "settings", format: "amneziawg", variant: 2, endpoint: "", customHost: "", port: 2408, bypass: true, busy: false, errorKey: null, config: "", copied: false, open: { network: true, format: false, registration: false } }
 root.classList.remove("card", "p-6")
 const isMasque = () => state.format === "clash-masque"
 function select(id, values, value, change) {
  const control = element("select", "field")
  control.id = id
  for (const [key, label] of values) { const option = element("option", "", label); option.value = String(key); control.append(option) }
  control.value = String(value)
  control.disabled = state.busy
  control.addEventListener("change", () => change(control.value))
  return control
 }
 function network() {
  const panel = element("div", "space-y-5")
  const endpoints = isMasque() ? MASQUE_ENDPOINTS : WARP_ENDPOINTS
  const endpoint = select("warp-endpoint", [["", t("warp_api_endpoint")], ...endpoints.map(ip => [ip, ip]), ["custom", t("warp_custom_endpoint")]], state.endpoint, value => { state.endpoint = value; render() })
  panel.append(labelledField("warp_endpoint", endpoint))
  if (state.endpoint === "custom") {
   const input = element("input", "field field-mono")
   input.id = "warp-custom-endpoint"; input.type = "text"; input.value = state.customHost; input.autocomplete = "off"; input.spellcheck = false; input.maxLength = 253; input.disabled = state.busy
   input.placeholder = t("warp_custom_placeholder")
   input.addEventListener("input", () => { state.customHost = input.value })
   panel.append(labelledField("warp_custom_endpoint", input), element("p", "text-xs text-slate-500", t("warp_custom_hint")))
  }
  const ports = isMasque() ? MASQUE_PORTS : [...WARP_OFFICIAL_PORTS, ...WARP_PORTS.filter(p => !WARP_OFFICIAL_PORTS.includes(p))]
  panel.append(labelledField("warp_port", select("warp-port", ports.map(p => [p, String(p)]), state.port, value => { state.port = Number(value) })))
  panel.append(element("p", "text-xs text-slate-500", t(isMasque() ? "warp_masque_notice" : "warp_candidates_notice")))
  return panel
 }
 function formats() {
  const panel = element("div", "space-y-4"), chips = element("div", "flex flex-wrap gap-2")
  for (const format of WARP_FORMATS) {
   const active = state.format === format.id
   chips.append(button(`chip ${active ? "chip-active" : ""}`, t(format.labelKey), () => {
    const previousMasque = isMasque(); state.format = format.id
    if (previousMasque !== isMasque()) { state.endpoint = ""; state.port = isMasque() ? 443 : 2408 }
    render()
   }, { pressed: active, disabled: state.busy }))
  }
  panel.append(chips, element("p", "text-xs text-slate-500", t(`warp_desc_${state.format}`)))
  if (["amneziawg", "clash"].includes(state.format)) {
   const profiles = element("div", "flex flex-wrap gap-2")
   for (const variant of [1,2,3]) profiles.append(button(`chip ${state.variant === variant ? "chip-active" : ""}`, t(`warp_variant_${variant}`), () => { state.variant = variant; render() }, { pressed: state.variant === variant, disabled: state.busy }))
   panel.append(element("span", "field-label", t("warp_variant")), profiles, element("p", "text-xs text-slate-500", t(`warp_variant_${state.variant}_desc`)))
  }
  return panel
 }
 async function generate() {
  if (state.busy) return
  const customEndpoint = state.endpoint === "custom"
  const endpoint = customEndpoint ? state.customHost.trim() : state.endpoint
  try {
   if (customEndpoint && !endpoint) throw new RangeError()
   // Reject invalid custom data before creating keys or contacting any registration API.
   validateWarpOptions({ endpoint, customEndpoint, port: isMasque() ? null : state.port })
  } catch { state.errorKey = "warp_invalid_endpoint"; render(); return }
  const options = { format: state.format, variant: state.variant, endpoint, customEndpoint, port: state.port, bypass: state.bypass }
  state.busy = true; state.errorKey = null; state.config = ""; render()
  try { state.config = await generateWarpClient(options); state.step = "config"; state.copied = false }
  catch { state.errorKey = state.bypass ? "warp_error" : "warp_direct_error" }
  finally { state.busy = false; render() }
 }
 function settings() {
  const wrapper = element("div", "space-y-4")
  for (const [id, titleKey, content, summaryText] of [
   ["network", "gen_network_title", network(), state.endpoint === "custom" ? t("warp_custom_endpoint") : (state.endpoint || t("warp_api_endpoint"))],
   ["format", "gen_format_title", formats(), t(warpFormat(state.format).labelKey)],
   ["registration", "warp_registration_title", toggleRow("warp_bypass", "warp_bypass_desc", state.bypass, value => { state.bypass = value }), ""],
  ]) wrapper.append(accordion({ titleKey, summaryText, open: state.open[id], onToggle: open => { state.open[id] = open }, children: [content] }))
  // Freeze all settings while a registration is in flight, including the shared toggle.
  wrapper.querySelectorAll("input").forEach(input => { input.disabled = state.busy })
  const footer = element("div")
  footer.append(button("btn-primary", t(state.busy ? "warp_busy" : "warp_generate"), generate, { disabled: state.busy }), notices(state))
  const status = element("p", "sr-only", state.busy ? t("warp_busy") : ""); status.setAttribute("role", "status"); footer.append(status)
  wrapper.append(footer)
  return wrapper
 }
 function result() {
  const card = element("div", "card")
  card.append(element("h3", "text-sm font-semibold text-white", t("gen_result_title")), element("p", "mt-1 text-xs text-slate-500", t(warpFormat(state.format).labelKey)))
  const code = element("pre", "code-block mt-4"); code.append(element("code", "", state.config)); card.append(code)
  const actions = element("div", "mt-5 flex flex-wrap gap-3")
  actions.append(
   button("btn-primary", t("warp_download"), () => downloadConfig(state.config, `warp-${state.format}.${warpFormat(state.format).extension}`)),
   button("btn-ghost", t(state.copied ? "gen_copied" : "gen_copy"), async () => {
    try { await navigator.clipboard.writeText(state.config); state.copied = true; state.errorKey = null }
    catch { state.errorKey = "warp_copy_error" }
    render()
   }),
   button("btn-ghost", t("gen_another"), () => { state.step = "settings"; state.errorKey = null; render() }),
  )
  card.append(actions, notices(state)); return card
 }
 function render() {
  const section = element("div", "container-page")
  section.append(element("h2", "section-title", t("warp_title")), element("p", "section-subtitle", t("warp_note")), stepBar(STEPS, state.step), state.step === "config" ? result() : settings())
  root.replaceChildren(section)
 }
 render(); onLanguageChange(render)
}
