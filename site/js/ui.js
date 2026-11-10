// ui.js — small DOM helpers shared by the Files and GitHub tabs. Untrusted text only ever goes in via textContent;
// styles go through the CSSOM (the page's CSP forbids style attributes).
const SVGNS = "http://www.w3.org/2000/svg";
export const $ = (s) => document.querySelector(s);
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
export function icon(name, cls = "i") {
  const s = document.createElementNS(SVGNS, "svg"); s.setAttribute("class", cls); s.setAttribute("aria-hidden", "true");
  const u = document.createElementNS(SVGNS, "use"); u.setAttribute("href", `img/icons.svg#${name}`); s.append(u); return s;
}
export const isRepo = (r) => /^[\w.-]+\/[\w.-]+$/.test(r || "");
export const safeUrl = (u) => (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\/[\w./%@+-]*)?$/.test(u || "") ? u : null);
export const ext = (href, text) => href ? h("a", { href, rel: "noreferrer", target: "_blank" }, text) : text;
export const ghLink = (repo, text) => isRepo(repo) ? ext(`https://github.com/${repo}`, text || repo) : (text || repo || "");
export const short = (repo) => (repo || "").split("/").pop();
export const fmtKB = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.round(n / 1024) + " KB";
export const fmtN = (n) => Number(n || 0).toLocaleString("en-US");

let toastT = 0;
export function toast(msg) {
  const t = $("#toast"); t.replaceChildren(icon("check"), document.createTextNode(msg)); t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2800);
}
