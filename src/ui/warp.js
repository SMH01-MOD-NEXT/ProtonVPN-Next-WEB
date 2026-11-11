import { t, onLanguageChange } from "../i18n/index.js"
import { element, button } from "./generator-view.js"
import { generateWarp } from "../lib/warp.js"
import { WARP_ENDPOINTS, WARP_PORTS, WARP_OFFICIAL_PORTS } from "../lib/warp-endpoints.js"
export function mountWarp(root) {
 let busy = false
 const title = element("h3", "text-xl font-bold"), note = element("p", "mt-3 text-slate-400")
 const check = element("input", "mr-3"); check.type = "checkbox"; check.checked = true
 const label = element("label", "mt-6 flex items-center"); const labelText = element("span"); label.append(check, labelText)
 const endpointLabel = element("label", "field-label mt-4"), endpointText = element("span")
 const endpoint = element("input", "field mt-2 w-full"); endpoint.setAttribute("list", "warp-endpoint-candidates"); endpoint.autocomplete = "off"
 const candidates = element("datalist"); candidates.id = "warp-endpoint-candidates"
 WARP_ENDPOINTS.forEach(ip => { const option = element("option"); option.value = ip; candidates.append(option) })
 endpointLabel.append(endpointText, endpoint)
 const portLabel = element("label", "field-label mt-4"), portText = element("span"), port = element("select", "field mt-2 w-full")
 for (const n of [...WARP_OFFICIAL_PORTS, ...WARP_PORTS.filter(n => !WARP_OFFICIAL_PORTS.includes(n))]) {
  const option = element("option"); option.value = String(n); option.textContent = String(n); port.append(option)
 }
 portLabel.append(portText, port)
 const awg = element("input", "mr-3"); awg.type = "checkbox"
 const awgLabel = element("label", "mt-4 flex items-center"), awgText = element("span"); awgLabel.append(awg, awgText)
 const warning = element("p", "mt-3 text-sm text-slate-400")
 const output = element("textarea", "field field-mono mt-6 w-full"); output.readOnly = true; output.rows = 12; output.hidden = true
 const status = element("p", "mt-4 text-slate-400"); status.setAttribute("role", "status")
 const action = button("btn-primary mt-6", "", async () => {
  if (busy) return
  busy = true; action.disabled = true; output.value = ""; output.hidden = true; status.textContent = t("warp_busy")
  try { output.value = await generateWarp({ bypass: check.checked, endpoint: endpoint.value.trim(), port: Number(port.value), awg2: awg.checked }); output.hidden = false; status.textContent = t("warp_ready") }
  catch { status.textContent = t(check.checked ? "warp_error" : "warp_direct_error") }
  finally { busy = false; action.disabled = false; download.hidden = !output.value }
 })
 const download = button("btn-ghost mt-4", "", () => {
  const url = URL.createObjectURL(new Blob([output.value], { type: "text/plain" }))
  const a = element("a"); a.href = url; a.download = "warp.conf"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
 }); download.hidden = true
 function translate() { title.textContent = t("warp_title"); note.textContent = t("warp_note"); labelText.textContent = t("warp_bypass"); action.textContent = t("warp_generate"); download.textContent = t("warp_download"); output.setAttribute("aria-label", t("warp_title")); endpointText.textContent = t("warp_endpoint"); endpoint.placeholder = t("warp_api_endpoint"); portText.textContent = t("warp_port"); awgText.textContent = t("warp_awg2"); warning.textContent = t("warp_candidates_notice") }
 root.append(title, note, endpointLabel, candidates, portLabel, awgLabel, warning, label, action, status, output, download); translate(); onLanguageChange(translate)
}
