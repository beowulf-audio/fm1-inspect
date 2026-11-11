// gh.js — "GitHub repo" tab: look a project up on GitHub and check what can be checked without downloading it.
//   * releases and their .fwsc files: GitHub's published SHA-256, who uploaded them, build attestations; verdicts for
//     files already in the index (GitHub's release CDN does not allow browser downloads, so new files get a link)
//   * .fwsc files committed in the repo: fetched (raw.githubusercontent.com allows it) and fully analysed
//   * the source: C/C++ files scanned for the same signals as the binary checks
import { h, icon, ext, ghLink, short, fmtKB, fmtN, safeUrl } from "./ui.js";
import { RELAY_URL } from "./config.js";
import { previewBlock } from "./preview.js";

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
let rateLeft = null;

export function parseRepo(input) {
  const s = (input || "").trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)/i) || s.match(/^([\w.-]+)\/([\w.-]+)$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

async function api(path) {
  const r = await fetch(API + path, { headers: { Accept: "application/vnd.github+json" }, credentials: "omit", referrerPolicy: "no-referrer" });
  const left = r.headers.get("x-ratelimit-remaining"); if (left != null) rateLeft = +left;
  if (r.status === 404) return null;
  if (r.status === 403 || r.status === 429) throw new Error(`GitHub's hourly limit for anonymous lookups is used up${r.headers.get("x-ratelimit-reset") ? ` (resets ${new Date(r.headers.get("x-ratelimit-reset") * 1000).toLocaleTimeString()})` : ""}. Try again later.`);
  if (!r.ok) throw new Error(`GitHub answered ${r.status}.`);
  return r.json();
}
async function raw(repo, ref, path, asText = true) {
  const r = await fetch(`${RAW}/${repo}/${encodeURIComponent(ref)}/${path.split("/").map(encodeURIComponent).join("/")}`, { credentials: "omit", referrerPolicy: "no-referrer" });
  if (!r.ok) throw new Error(r.status);
  return asText ? r.text() : new Uint8Array(await r.arrayBuffer());
}

// ---------------------------------------------------------------- source scan
const SKIP = /(^|\/)(third_party|thirdparty|vendor|external|extern|deps|node_modules|sdk|SDK|lib\/(lwip|mbedtls|tinyusb|nimble)|lwip|mbedtls|tinyusb|nimble|cordio|JUCE|tests?|docs?|examples?)\//;
const SRC = /\.(c|h|cc|cpp|hpp|s|S)$/;
const SIG = {
  uc25: /0x0*B36014|0xB3\s*,\s*0x60\s*,\s*0x14/i,
  puya: /0x0*856014|0x85\s*,\s*0x60\s*,\s*0x14/i,
  hidKbd: /0x05\s*,\s*0x01\s*,\s*0x09\s*,\s*0x06\s*,\s*0xA1/i,
  hidMouse: /0x05\s*,\s*0x01\s*,\s*0x09\s*,\s*0x02\s*,\s*0xA1/i,
  msc: /USB_CLASS_MASS_STORAGE|MSC_SUBCLASS_SCSI|bInterfaceClass\s*=\s*0x08/i,
  net: /\blwip\b|lwip_|\bsocket\s*\(|getaddrinfo|dns_gethostbyname|http_client|httpc_|"GET %s|wpa_supplicant|wifi_connect|wifi_sta/i,
};
const URL_LIT = /"((?:https?|wss?|mqtt):\/\/[^"\s]{4,200})"/gi;
const IP_LIT = /"((?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3})(?::\d+)?"/g;

async function scanSource(repo, ref, tree, onProgress) {
  let files = tree.filter((t) => t.type === "blob" && SRC.test(t.path) && (t.size || 0) < 400000);
  const own = files.filter((t) => !SKIP.test(t.path));
  const vendored = files.length - own.length;
  files = (own.length ? own : files).sort((a, b) => (/(^|\/)(src|app|firmware|main)\//.test(b.path) - /(^|\/)(src|app|firmware|main)\//.test(a.path)) || (a.size - b.size));
  const MAX_FILES = 250, MAX_BYTES = 6e6;
  const pick = []; let bytes = 0;
  for (const f of files) { if (pick.length >= MAX_FILES || bytes + (f.size || 0) > MAX_BYTES) break; pick.push(f); bytes += f.size || 0; }
  const hits = Object.fromEntries(Object.keys(SIG).map((k) => [k, []]));
  const urls = new Map(), ips = new Map();
  let done = 0;
  const queue = [...pick];
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const f = queue.shift();
      let text; try { text = await raw(repo, ref, f.path); } catch { continue; }
      for (const [k, rx] of Object.entries(SIG)) if (rx.test(text)) hits[k].push(f.path);
      for (const m of text.matchAll(URL_LIT)) if (!urls.has(m[1])) urls.set(m[1], f.path);
      for (const m of text.matchAll(IP_LIT)) if (!/^(0|127|255)\./.test(m[1]) && m[1] !== "1.0.0.0" && !ips.has(m[1])) ips.set(m[1], f.path);
      onProgress(++done, pick.length);
    }
  }));
  return { scanned: done, total: files.length, vendored, truncated: pick.length < files.length, hits, urls: [...urls], ips: [...ips] };
}

function sourceFindings(s) {
  const F = [];
  const where = (list) => list.slice(0, 3).join(", ") + (list.length > 3 ? ` and ${list.length - 3} more` : "");
  if (!s.scanned) { F.push({ level: "info", area: "package", text: "No C/C++ source found in this repository." }); return F; }
  if (s.hits.uc25.length) F.push({ level: "ok", area: "flash", text: `Source recognises the UC25HQ80 flash in newer FM-1 units (${where(s.hits.uc25)}).` });
  else if (s.hits.puya.length) F.push({ level: "warn", area: "flash", text: `Source checks for the original Puya flash chip (${where(s.hits.puya)}) but never mentions the UC25HQ80 in newer FM-1 units. Firmware built from it may lose saves and refuse later installs on those units.` });
  else F.push({ level: "info", area: "flash", text: "No flash-chip ID found in the scanned source (it may come from a library or SDK that wasn't scanned)." });
  if (s.hits.net.length) F.push({ level: "info", area: "network", text: `Networking code in ${where(s.hits.net)}.${s.urls.length ? ` Addresses in the code: ${s.urls.slice(0, 5).map(([u]) => u.replace(/^https?:\/\//, "").split("/")[0]).filter((v, i, a) => a.indexOf(v) === i).join(", ")}.` : ""}` });
  else F.push({ level: "ok", area: "network", text: "No networking code in the scanned source." });
  if (s.ips.length) F.push({ level: "warn", area: "network", text: `Hard-coded IP addresses: ${s.ips.slice(0, 4).map(([ip, f]) => `${ip} (${f.split("/").pop()})`).join(", ")}.` });
  if (s.hits.hidKbd.length) F.push({ level: "bad", area: "usb", text: `Contains a USB keyboard descriptor (${where(s.hits.hidKbd)}): firmware built from it can type into your computer. Fine for a macro-pad project; suspicious otherwise.` });
  if (s.hits.hidMouse.length) F.push({ level: "warn", area: "usb", text: `Contains a USB mouse descriptor (${where(s.hits.hidMouse)}).` });
  if (s.hits.msc.length) F.push({ level: "info", area: "usb", text: `USB mass-storage code (${where(s.hits.msc)}): may present itself as a drive, or read one plugged into it.` });
  if (!s.hits.hidKbd.length && !s.hits.hidMouse.length) F.push({ level: "ok", area: "usb", text: "No USB keyboard or mouse descriptors in the scanned source." });
  return F;
}

// ---------------------------------------------------------------- relay (release files of any repo)
/** Fetch a release file through the relay and verify it against the SHA-256 GitHub publishes for it. */
async function viaRelay(repo, a) {
  const tag = a.url.split("/releases/download/")[1]?.split("/")[0];
  if (!tag) throw new Error("Unexpected release URL");
  const r = await fetch(`${RELAY_URL}/gh/${repo}/releases/download/${tag}/${encodeURIComponent(a.name)}`, { credentials: "omit", referrerPolicy: "no-referrer" });
  if (!r.ok) throw new Error(`Relay: ${r.status}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  const d = await crypto.subtle.digest("SHA-256", bytes);
  const sha = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (sha !== a.sha) throw new Error("Checksum mismatch: not the file GitHub published");
  return bytes;
}

// ---------------------------------------------------------------- the lookup
/**
 * @param {string} repo  owner/name
 * @param {{index, releases, renderChecks:Function, verdictOf:Function, onFile:(File)=>void, status:(msg:string)=>void, preview?:(repo:string)=>{p, lab}|null}} ctx
 */
export async function lookupRepo(repo, ctx) {
  ctx.status("Looking up the repository…");
  const meta = await api(`/repos/${repo}`);
  if (!meta) throw new Error(`No public repository "${repo}" on GitHub.`);
  repo = meta.full_name;
  const ref = meta.default_branch;
  const [rels, treeRes] = await Promise.all([api(`/repos/${repo}/releases?per_page=15`), api(`/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`)]);
  const tree = treeRes?.tree || [];

  // releases: .fwsc assets with GitHub's own digests
  const releases = (rels || []).map((r) => ({
    tag: r.tag_name, name: r.name, date: (r.published_at || "").slice(0, 10), pre: r.prerelease, url: r.html_url,
    assets: (r.assets || []).filter((a) => /\.fwsc$/i.test(a.name)).map((a) => ({
      name: a.name, size: a.size, sha: a.digest?.startsWith("sha256:") ? a.digest.slice(7) : null, url: a.browser_download_url,
      ci: a.uploader?.type === "Bot" && /github-actions/.test(a.uploader?.login || ""),
    })),
  })).filter((r) => r.assets.length);
  // attestations for the newest release's files (one API call each; anonymous limit is 60/hour)
  const newest = releases[0]?.assets || [];
  await Promise.all(newest.slice(0, 6).map(async (a) => {
    if (!a.sha) return;
    const known = ctx.releases[a.sha];
    if (known?.attested) { a.attested = known.attested; return; }
    try { const at = await api(`/repos/${repo}/attestations/sha256:${a.sha}`); if (at?.attestations?.length) a.attested = { verified: false, count: at.attestations.length }; } catch {}
  }));

  // committed firmware files
  const committed = tree.filter((t) => t.type === "blob" && /\.fwsc$/i.test(t.path) && (t.size || 0) < 20e6);

  // source
  const srcEl = h("p", { class: "muted", text: "Scanning source…" });
  const report = repoCard(meta, releases, committed, srcEl, ctx, repo, ref);
  ctx.status("Scanning source…");
  scanSource(repo, ref, tree, (d, n) => { srcEl.textContent = `Scanning source: ${d} of ${n} files…`; })
    .then((s) => {
      const findings = sourceFindings(s);
      const note = `Scanned ${fmtN(s.scanned)} of ${fmtN(s.total)} C/C++ files${s.vendored ? `, skipping ${fmtN(s.vendored)} in SDK and third-party folders` : ""}${s.truncated ? " (largest left out)" : ""}.`;
      srcEl.replaceWith(ctx.renderChecks(findings), h("p", { class: "src-note", text: note }));
      ctx.status("");
    })
    .catch(() => { srcEl.textContent = "Couldn't read the source."; ctx.status(""); });
  return report;
}

function badge(cls, ico, text) { return h("span", { class: `badge ${cls}` }, icon(ico), text); }

const VERDICT_ICON = { ok: "shield-check", caution: "shield-alert", risk: "shield-x" };
const VERDICT_TEXT = { ok: "Looks fine", caution: "Caution", risk: "Risk" };

function repoCard(meta, releases, committed, srcEl, ctx, repo, ref) {
  // the repo's verdict = its latest release's FM-1 file, when we have analysed it
  const latest = releases[0]?.assets || [];
  const pickFm1 = latest.find((a) => ctx.releases[a.sha]?.a?.model === "FM-1") || latest.find((a) => ctx.releases[a.sha]?.a);
  let v = pickFm1 ? ctx.releases[pickFm1.sha].a.verdict : null;
  if (v === "other") v = null;
  const tone = v || "repo";

  const head = h("div", { class: "card-head" },
    h("div", { class: "status" }, icon(v ? VERDICT_ICON[v] : "github")),
    h("div", { class: "card-title" }, h("h2", {}, ghLink(repo)), h("p", { class: "sub", text: meta.description || "No description" })),
    h("span", { class: "verdict", title: v ? `Latest release: ${releases[0].tag}` : "" }, v ? `${VERDICT_TEXT[v]} · ${releases[0].tag}` : "GitHub repo"));
  const meta2 = h("div", { class: "meta" },
    h("span", {}, icon("github"), "GitHub"),
    h("span", {}, icon("sparkles"), h("b", { text: fmtN(meta.stargazers_count) }), " stars"),
    h("span", {}, icon("badge-check"), h("b", { text: meta.license?.spdx_id && meta.license.spdx_id !== "NOASSERTION" ? meta.license.spdx_id : "no licence" })),
    h("span", {}, icon("history"), "updated ", h("b", { text: (meta.pushed_at || "").slice(0, 10) })),
    meta.fork ? h("span", {}, icon("git-fork"), "fork") : null,
    meta.archived ? h("span", {}, icon("package"), "archived") : null);

  let cardEl;
  const assetRow = (a) => {
    const known = a.sha ? (ctx.releases[a.sha] || null) : null, idx = a.sha ? ctx.index?.bySha.get(a.sha) : null;
    const an = known?.a || null, v = an?.verdict || idx?.verdict || null;
    const prov = a.attested?.verified || known?.attested?.verified ? badge("b-ok", "badge-check", "signed build ✓")
      : a.attested || known?.attested ? badge("b-ok", "badge-check", "signed build")
      : a.ci ? badge("b-ok", "bot", "built in CI") : badge("b-info", "user", "uploaded by hand");
    const top = h("div", { class: "aname" }, h("code", { text: a.name }), h("span", { class: "muted", text: fmtKB(a.size) }));
    if (v && a.sha && ctx.hasReport(a.sha)) {
      const row = h("button", { class: "asset clickable", type: "button", title: "Open the full report" },
        top, h("div", { class: "abadges" }, prov, ctx.verdictOf(v, an, idx, a.sha), h("span", { class: "open" }, "Report", icon("chevron-down", "i rot"))));
      row.addEventListener("click", async () => {
        cardEl.querySelectorAll(".asset.active").forEach((x) => x.classList.remove("active"));
        row.classList.add("active");
        try { await ctx.openRelease(a.sha, a.name, cardEl); } catch { row.classList.remove("active"); }
      });
      return h("li", {}, row);
    }
    let action = null;
    if (!v && RELAY_URL && a.sha) {
      const btn = h("button", { class: "btn small", type: "button" }, icon("search"), " Check it");
      btn.addEventListener("click", async () => {
        btn.disabled = true; btn.lastChild.textContent = " Fetching…";
        try {
          const bytes = await viaRelay(repo, a);
          const rel = releases.find((r) => r.assets.includes(a));
          await ctx.onFile(new File([bytes], a.name), cardEl, { sha: a.sha, repo, tag: rel?.tag, asset: a.name, published: rel?.date, prerelease: rel?.pre, url: rel?.url,
            tier: a.ci ? "ci" : "release", attested: a.attested ? { verified: false, workflow: null } : null });
          btn.lastChild.textContent = " Checked below";
        } catch (e) { btn.lastChild.textContent = " " + (e.message || "Couldn't fetch"); btn.disabled = false; }
      });
      action = btn;
    } else if (!v) action = ext(a.url, h("span", { class: "dl" }, icon("download"), "download, then drop it in the Files tab"));
    return h("li", {}, h("div", { class: "asset" }, top, h("div", { class: "abadges" }, prov,
      v ? ctx.verdictOf(v, an, idx, a.sha) : badge("b-none", "file-question", "not in our index"), action)));
  };
  const relRow = (r, i) => h("li", { class: "relrow" },
    h("div", { class: "relhead" }, ext(safeUrl(r.url), r.tag), r.pre ? h("span", { class: "tagpill", text: "pre-release" }) : null, i === 0 ? h("span", { class: "tagpill new", text: "latest" }) : null, h("span", { class: "muted", text: r.date })),
    h("ul", { class: "assets" }, r.assets.map(assetRow)));
  let relList;
  if (!releases.length) relList = h("p", { class: "empty" }, icon("package"), "No releases with .fwsc firmware files.");
  else {
    const SHOW = 2, rest = releases.slice(SHOW, 15);
    const older = h("ol", { class: "rels-list", hidden: true }, rest.map((r, i) => relRow(r, i + SHOW)));
    const more = rest.length ? h("button", { class: "btn small ghost more", type: "button", onclick: () => { older.hidden = !older.hidden; more.lastChild.textContent = older.hidden ? ` Show ${rest.length} older release${rest.length === 1 ? "" : "s"}` : " Hide older releases"; } },
      icon("history"), ` Show ${rest.length} older release${rest.length === 1 ? "" : "s"}`) : null;
    relList = h("div", {}, h("ol", { class: "rels-list" }, releases.slice(0, SHOW).map(relRow)), more, older);
  }

  const committedSec = committed.length ? h("section", { class: "wide" }, h("h3", { class: "sec-h" }, icon("package"), `Firmware files in the repo (${committed.length})`),
    h("ul", { class: "assets" }, committed.slice(0, 20).map((t) => {
      const btn = h("button", { class: "btn small", type: "button", onclick: async () => {
        btn.disabled = true; btn.lastChild.textContent = " Fetching…";
        try { const bytes = await raw(repo, ref, t.path, false); await ctx.onFile(new File([bytes], t.path.split("/").pop()), cardEl); btn.lastChild.textContent = " Checked below"; }
        catch { btn.lastChild.textContent = " Couldn't fetch"; btn.disabled = false; }
      } }, icon("search"), " Check it");
      return h("li", { class: "asset" }, h("div", { class: "aname" }, h("code", { text: t.path }), h("span", { class: "muted", text: fmtKB(t.size || 0) })), h("div", { class: "abadges" }, btn));
    }))) : null;

  // the project's preview: its tour on one release file, with the version it is of
  const pv = ctx.preview?.(repo), pvEl = pv ? previewBlock(pv.p, pv.lab) : null;
  cardEl = h("article", { class: `card t-${tone}`, "data-verdict": "repo" }, head, meta2,
    h("div", { class: "body" },
      pvEl ? h("section", { class: "wide" }, h("h3", { class: "sec-h" }, icon("microchip"), "Preview on an emulated FM-1"), pvEl) : null,
      h("section", {}, h("h3", { class: "sec-h" }, icon("history"), "Releases"), relList),
      h("section", {}, h("h3", { class: "sec-h" }, icon("search"), "Source check"), srcEl),
      committedSec));
  return cardEl;
}

export const rateRemaining = () => rateLeft;
