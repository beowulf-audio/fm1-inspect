// readme.js — a project's README on its card: fetched from GitHub when it is opened (always the current one, on the
// default branch, so it can describe changes not released yet), Markdown made into HTML (marked) and cleaned
// (DOMPurify: document markup only, no scripts, styles, forms or frames). Links open in a new tab; images load only from
// GitHub's own hosts (the page's Content-Security-Policy allows no others), the rest become links.
import { Marked } from "../vendor/marked/marked.esm.js";
import DOMPurify from "../vendor/dompurify/purify.es.mjs";
import { h, icon } from "./ui.js";

const MAX = 400_000;   // a README larger than this is linked, not shown
const IMG_HOSTS = new Set(["raw.githubusercontent.com", "user-images.githubusercontent.com", "private-user-images.githubusercontent.com",
  "objects.githubusercontent.com", "avatars.githubusercontent.com", "github.com"]);
const TAGS = ["h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "hr", "a", "img", "ul", "ol", "li", "blockquote", "pre", "code", "em", "strong",
  "b", "i", "del", "s", "table", "thead", "tbody", "tr", "th", "td", "details", "summary", "kbd", "sup", "sub", "span", "div", "input"];
const ATTRS = ["href", "src", "alt", "title", "colspan", "rowspan", "open", "type", "checked", "disabled"];

/** The README's file in the repository's tree (at its root), or null. */
export function findReadme(tree) {
  const top = (tree || []).filter((t) => t.type === "blob" && !t.path.includes("/") && /^readme(\.(md|markdown|txt|rst))?$/i.test(t.path));
  return top.sort((a, b) => (/\.md$/i.test(b.path) ? 1 : 0) - (/\.md$/i.test(a.path) ? 1 : 0))[0] || null;
}

/** README text as safe HTML (a string), its links and images made absolute. Exported for the tests. */
export function renderReadme(text, repo, ref, path, purify = DOMPurify) {
  const md = /\.(md|markdown)$/i.test(path) || !/\./.test(path);
  const html = md ? new Marked({ gfm: true, breaks: false }).parse(text) : `<pre>${text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</pre>`;
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
  const blob = `https://github.com/${repo}/blob/${encodeURIComponent(ref)}/${dir}`, raw = `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${dir}`;
  const abs = (u, base) => { try { return new URL(u, base); } catch { return null; } };
  purify.addHook("afterSanitizeAttributes", (n) => {
    if (n.tagName === "A") {
      const href = n.getAttribute("href") || "";
      if (!href || href.startsWith("#")) { n.removeAttribute("href"); return; }        // in-page anchors: the card isn't the page
      const u = abs(href, blob);
      if (!u || !/^https?:$/.test(u.protocol)) { n.removeAttribute("href"); return; }
      n.setAttribute("href", u.href); n.setAttribute("target", "_blank"); n.setAttribute("rel", "noreferrer noopener");
    }
    if (n.tagName === "IMG") {
      let u = abs(n.getAttribute("src") || "", raw);
      // a picture linked to its page on GitHub (github.com/OWNER/REPO/blob/REF/x.png): the file itself
      if (u?.hostname === "github.com" && /^\/[^/]+\/[^/]+\/blob\//.test(u.pathname)) u = new URL(`https://raw.githubusercontent.com${u.pathname.replace("/blob/", "/")}`);
      if (u && u.protocol === "https:" && IMG_HOSTS.has(u.hostname)) { n.setAttribute("src", u.href); n.setAttribute("loading", "lazy"); n.setAttribute("referrerpolicy", "no-referrer"); return; }
      // anywhere else: a link to it (loading it would tell that site who is reading)
      n.setAttribute("data-offsite", u && /^https?:$/.test(u.protocol) ? u.href : "");
      n.removeAttribute("src");
    }
    if (n.tagName === "INPUT" && n.getAttribute("type") !== "checkbox") n.remove();
    if (n.tagName === "INPUT") n.setAttribute("disabled", "");
  });
  try { return purify.sanitize(html, { ALLOWED_TAGS: TAGS, ALLOWED_ATTR: ATTRS, ALLOW_DATA_ATTR: false, ADD_ATTR: ["target", "rel", "loading", "referrerpolicy", "data-offsite"] }); }
  finally { purify.removeHook("afterSanitizeAttributes"); }
}

/** The card's README section: closed, fetched the first time it is opened. */
export function readmeSection(repo, ref, tree) {
  const f = findReadme(tree);
  if (!f) return null;
  const page = `https://github.com/${repo}/blob/${encodeURIComponent(ref)}/${f.path}`;
  const body = h("div", { class: "readme" }, h("p", { class: "muted", text: "Loading…" }));
  const det = h("details", { class: "tech readme-box" },
    h("summary", {}, icon("file-search"), "README", h("span", { class: "muted", text: " · the current one on GitHub, which can describe changes not released yet" }), icon("chevron-down", "i chev")),
    body);
  let loaded = false;
  det.addEventListener("toggle", async () => {
    if (!det.open || loaded) return;
    loaded = true;
    try {
      if ((f.size || 0) > MAX) throw new Error("large");
      const r = await fetch(`https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${f.path.split("/").map(encodeURIComponent).join("/")}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      if (text.length > MAX) throw new Error("large");
      body.innerHTML = renderReadme(text, repo, ref, f.path);
      for (const img of body.querySelectorAll("img[data-offsite]")) {
        const u = img.getAttribute("data-offsite");
        img.replaceWith(u ? h("a", { href: u, target: "_blank", rel: "noreferrer noopener", class: "offsite" }, icon("download"), ` image${img.alt ? `: ${img.alt}` : ""} (${new URL(u).hostname})`) : document.createTextNode(img.alt || ""));
      }
      body.append(h("p", { class: "muted readme-src" }, h("a", { href: page, target: "_blank", rel: "noreferrer noopener", text: "Open it on GitHub" })));
    } catch (e) {
      body.replaceChildren(h("p", { class: "muted" }, e.message === "large" ? "Too long to show here: " : "Couldn't load it: ", h("a", { href: page, target: "_blank", rel: "noreferrer noopener", text: "open it on GitHub" })));
    }
  });
  return h("section", { class: "wide" }, det);
}
