// app.js — FM-1 Inspect page. Everything runs locally. Text taken from firmware files is untrusted and is only
// ever inserted with textContent (never innerHTML); styles are set through the CSSOM (the CSP forbids style attributes).
import { analyze } from "./analyze.js";
import { loadIndex, fingerprint, closest, strength } from "./match.js";
import { applyBrick, brickNote } from "./brick.js";
import { sigFromB64 } from "./fingerprint.js";

import { $, h, icon, safeUrl, ext, ghLink, short, fmtKB, fmtN, toast } from "./ui.js";
import { parseRepo, lookupRepo } from "./gh.js";

let index = null, releases = {}, brick = {}, reports = [], filter = "all";

// ---------------------------------------------------------------- data
async function loadData() {
  try {
    const [known, stop, rel] = await Promise.all(["data/known.json", "data/stoplist.json", "data/releases.json"]
      .map((u) => fetch(u, { cache: "no-cache" }).then((r) => { if (!r.ok) throw new Error(u); return r.json(); })));
    index = loadIndex(known, stop);
    releases = rel.releases || {};
    // emulated flash-chip tests (fm1-lab), optional: the page works without them
    brick = await fetch("data/lab.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : {})).then((b) => b.results || {}).catch(() => ({}));
    buildProjects();
    const repos = new Set(index.entries.map((e) => e.repo).filter(Boolean)).size;
    $("#dbinfo").textContent = `Compared against ${fmtN(index.entries.length)} known firmware files from ${repos} projects and ${fmtN(rel.count)} release files · index ${known.generated}`;
  } catch {
    $("#dbinfo").textContent = "Index unavailable: files are still checked, but can't be identified.";
  }
}

async function sha256(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const liveProv = new Map();   // provenance learned from GitHub during this session (files fetched via the GitHub tab)
function identify(sha) {
  const exact = index?.bySha.get(sha) || null;
  const rel = releases[sha] || liveProv.get(sha) || exact?.provenance || null;
  const repo = rel?.repo || exact?.repo || null;
  let title = null, sub = null;
  if (exact?.official && !rel) { title = "M-VAVE official firmware"; sub = exact.file; }
  else if (rel) { title = `${short(rel.repo)} ${rel.tag || ""}`.trim(); sub = exact?.description || null; }
  else if (exact) { title = exact.tag ? `${short(exact.repo)} ${exact.tag}` : `${short(exact.repo)}`; sub = exact.description || exact.file; }
  return { exact, rel, repo, title, sub };
}

/** Facts the static checks can't know on their own, from identifying the file. */
function adjustForIdentity(rep, id) {
  if (id.exact?.official) {
    for (const f of rep.findings) if (f.area === "flash" && f.level === "warn") {
      f.level = "info";
      f.text = "M-VAVE's own firmware: their updater installs it on every FM-1, whichever flash chip it has. (The flash-chip check is aimed at community firmware.)";
    }
    const lv = rep.findings.map((f) => f.level);
    if (rep.verdict === "caution" && !lv.includes("warn") && !lv.includes("bad")) rep.verdict = "ok";
  }
  return rep;
}

// ---------------------------------------------------------------- trust chain
function trustChain(id) {
  const { exact, rel } = id;
  const steps = [];
  const step = (state, ico, label, tag, ...body) => steps.push({ state, ico, label, tag, body });
  if (exact?.official && !rel) {
    step("ok", "check", "Source", "M-VAVE", "Official firmware from the manufacturer.");
    step("ok", "check", "Build", "official", "Built and signed off by M-VAVE.");
    step("ok", "check", "Distribution", "m-vave.com", "As distributed from M-VAVE's downloads / their fm1_open repository.");
    step("ok", "check", "Your file", "match", "Byte-for-byte identical to the official file.");
    return steps;
  }
  const repo = rel?.repo || exact?.repo;
  if (repo) step("ok", "check", "Source", "GitHub", ghLink(repo), exact?.license && exact.license !== "-" ? ` · ${exact.license}` : "");
  else step("none", "file-question", "Source", "unknown", "Not a project in the index.");

  if (rel?.attested?.verified) step("ok", "badge-check", "Build", "signed", "Signed build attestation, verified: built by ", h("code", { text: rel.attested.workflow || "a workflow" }), rel.attested.ref ? ` at ${rel.attested.ref.replace("refs/tags/", "")}` : "", rel.attested.commit ? ` (commit ${rel.attested.commit.slice(0, 7)})` : "", ".");
  else if (rel?.attested) step("ok", "badge-check", "Build", "signed", "Has a signed build attestation from ", h("code", { text: rel.attested.workflow || "a workflow" }), " (signature not checked by this index yet).");
  else if (rel?.tier === "ci") step("ok", "bot", "Build", "public CI", "Built by GitHub Actions in the project's public workflow.");
  else if (rel) step("part", "user", "Build", "by hand", "Built on the author's own machine and uploaded by hand (not reproducible from CI).");
  else step("none", "file-question", "Build", "unknown", "No record of how this file was built.");

  if (rel) step("ok", "check", "Release", rel.prerelease ? "pre-release" : "release", rel.url && safeUrl(rel.url) ? ext(safeUrl(rel.url), rel.tag) : rel.tag, rel.published ? `, published ${rel.published}` : "", rel.asset ? ` as ${rel.asset}` : "");
  else if (exact) step("part", "info", "Release", "not found", exact.vendoredCopy ? "Known only as a copy bundled inside another project." : "Known file, but not among the project's GitHub release files.");
  else step("none", "file-question", "Release", "unknown", "Not a published release in the index.");

  if (rel || exact) step("ok", "check", "Your file", "match", "Checksum identical to the file above.");
  else step("none", "x", "Your file", "no match", "No exact match. That doesn't make it bad: it may be newer than the index, a private build, or modified.");
  return steps;
}

// ---------------------------------------------------------------- rendering
const LV = { ok: ["circle-check", "ok"], info: ["info", "note"], warn: ["triangle-alert", "caution"], bad: ["octagon-x", "risk"] };
const AREA = { flash: ["microchip", "Flash chip"], network: ["globe", "Network"], usb: ["usb", "USB"], package: ["package", "Package"] };
const VERDICT = { ok: ["shield-check", "Looks fine"], caution: ["shield-alert", "Caution"], risk: ["shield-x", "Risk"], invalid: ["file-question", "Not a firmware"], other: ["layers", "Not an app"], unknown: ["file-question", "Unknown"] };

function renderChecks(findings) {
  return h("ul", { class: "checks" }, findings.map((f) => {
    const [lIco, lTxt] = LV[f.level] || LV.info, [aIco, aTxt] = AREA[f.area] || ["info", f.area];
    return h("li", { class: `check c-${f.level}` }, h("span", { class: "ci" }, icon(f.level === "ok" ? aIco : lIco)),
      h("div", { class: "ct" }, h("div", { class: "area" }, aTxt, h("span", { class: "lvl", text: lTxt })), h("p", { text: f.text })));
  }));
}

/** compact verdict badge for a release file we have analysed (from the index) */
function verdictOf(v, an, idx, sha) {
  const official = idx?.official;
  if (official && v === "caution") v = "ok";
  const b = brick[sha || idx?.sha256];
  if (b && an?.brickVerdict) v = an.brickVerdict;        // the release's verdict with the tested result in it (tools/apply-brick.mjs)
  const [ico, txt] = VERDICT[v] || VERDICT.unknown;
  const cls = v === "ok" ? "b-ok" : v === "caution" ? "b-warn" : v === "risk" ? "b-bad" : "b-none";
  const flash = an?.flash || idx?.flash;
  const why = b ? brickNote(b) : v === "caution" && flash && !flash.uc25Constant ? " · old flash chip only" : "";
  return h("span", { class: `badge ${cls}` }, icon(ico), txt + why);
}

function card(file, sha, rep, id, rels) {
  const [vIco, vTxt] = VERDICT[rep.verdict] || VERDICT.unknown;
  const head = h("div", { class: "card-head" },
    h("div", { class: "status" }, icon(vIco)),
    h("div", { class: "card-title" },
      h("h2", { text: id.title || file.name }),
      h("p", { class: "sub", text: id.title ? [file.name, id.sub && id.sub !== file.name ? id.sub : null].filter(Boolean).join(" · ") : (rep.parsed ? "Not in the index of known firmware" : "Could not be read as firmware") })),
    h("span", { class: "verdict" }, vTxt));

  const copy = h("button", { class: "copy", title: "Copy full SHA-256", "aria-label": "Copy SHA-256", onclick: () => { navigator.clipboard?.writeText(sha); toast("SHA-256 copied"); } }, icon("copy"));
  const meta = h("div", { class: "meta" },
    h("span", {}, icon("microchip"), "Device ", h("b", { text: rep.model === "none" ? "—" : rep.model })),
    h("span", { class: "mono" }, icon("package"), "Identity ", h("b", { text: rep.identity || "—" })),
    h("span", {}, icon("layers"), h("b", { text: fmtKB(rep.size) }), rep.package.appSize ? ` · code ${fmtKB(rep.package.appSize)}` : ""),
    h("span", { class: "mono", title: sha }, icon("hash"), h("b", { text: sha.slice(0, 12) + "…" }), copy));

  const checks = h("section", {}, h("h3", { class: "sec-h" }, icon("shield-check"), "Checks"), renderChecks(rep.findings));
  const lab = brick[sha];
  const emu = lab ? h("section", {}, h("h3", { class: "sec-h" }, icon("microchip"), "On an emulated FM-1"),
    h("div", { class: "emu" },
      lab.shot ? h("img", { class: "emu-shot", src: `data/shots/${sha}.png`, alt: "The screen 1.5 s after it starts, on an emulated FM-1", loading: "lazy", width: "240", height: "240" }) : null,
      h("ul", { class: "emu-facts" },
        h("li", { text: lab.boots ? `Boots: its screen is up ${lab.ms != null ? `${(lab.ms / 1000).toFixed(2)} s` : ""} after power-on.` : "The screen stayed blank in the emulator." }),
        h("li", { text: lab.sound ? "Makes sound when a key is played." : "No sound from a played key (some firmware needs a pattern or a mode first)." }),
        lab.v ? h("li", { text: lab.v === "pass" ? "Newer flash chip (UC25HQ80): works." : lab.v === "fail" ? "Newer flash chip (UC25HQ80): stops saving." : `Newer flash chip (UC25HQ80): ${lab.v}.` }) : null,
        h("li", { class: "muted", text: `Tested with fm1-lab${lab.at ? ` on ${lab.at}` : ""}: emulated, not on a real unit.` })))) : null;

  const chain = h("section", {}, h("h3", { class: "sec-h" }, icon("badge-check"), "Trust chain"),
    h("ol", { class: "chain" }, trustChain(id).map((s) => h("li", { class: `s-${s.state}` }, h("span", { class: "node" }, icon(s.ico)),
      h("div", {}, h("div", { class: "lab" }, s.label, h("small", { text: s.tag })), h("p", {}, ...s.body))))));

  let relSec = null;
  if (rep.parsed && index) {
    relSec = h("section", { class: "wide" }, h("h3", { class: "sec-h" }, icon("git-fork"), id.repo ? "Related projects" : "Closest known firmware"),
      rels.length
        ? h("ul", { class: "rels" }, rels.map((r) => {
            const e = r.entry, pct = Math.round(r.score * 100), name = short(e.repo) || e.file;
            const bar = h("i"); requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = Math.max(4, pct) + "%"; }));
            return h("li", { class: "rel" },
              h("div", {},
                h("div", { class: "rn" }, ghLink(e.repo, name), h("small", { text: e.tag || "" })),
                h("p", { class: "rd", text: e.description || e.file }),
                h("div", { class: "meter" }, h("div", { class: "bar", title: `text ${r.text.toFixed(2)} · code ${r.code.toFixed(2)}` }, bar), h("span", { text: pct + "%" })),
                h("div", { class: "rs", text: strength(r.score) })));
          }))
        : h("p", { class: "empty" }, icon("sparkles"), "No close relatives in the index: an original codebase, or one we haven't seen yet."));
  }

  const kv = [];
  const add = (k, v) => { if (v != null && v !== "" && !(Array.isArray(v) && !v.length)) kv.push(h("dt", { text: k }), h("dd", { text: Array.isArray(v) ? v.join(", ") : String(v) })); };
  add("SHA-256", sha);
  add("Chip key", rep.package.chipKey != null ? "0x" + rep.package.chipKey.toString(16).toUpperCase() : null);
  add("Package entries", rep.package.entries.map((e) => `type ${e.type} · ${fmtN(e.size)} B`));
  add("Flash files", rep.package.files);
  add("App-area files", rep.package.appFiles);
  if (rep.flash) add("Flash chip IDs in code", [rep.flash.puyaConstant && "Puya 0x856014", rep.flash.uc25Constant && "UC25HQ80 0xB36014"].filter(Boolean).join(", ") || "none");
  if (rep.network) {
    add("Network code", Object.entries(rep.network.markers).filter(([, v]) => v).map(([k]) => k));
    add("URLs in the code", rep.network.urls.slice(0, 25));
    add("Other host names", rep.network.unusualHosts.slice(0, 25));
  }
  if (rep.strings) add("Version strings", rep.strings.versions);
  add("Problems", rep.errors);
  const det = h("details", { class: "tech" }, h("summary", {}, icon("search"), "Technical details", icon("chevron-down", "i chev")), h("dl", { class: "kv" }, kv));

  return h("article", { class: `card t-${rep.verdict}`, "data-verdict": rep.verdict },
    head, meta, h("div", { class: "body" }, checks, emu, chain, relSec), det);
}

function skeleton() {
  return h("article", { class: "card skel-card" }, h("div", { class: "skel" }, h("div", { class: "ln w1" }), h("div", { class: "ln w2" }), h("div", { class: "ln w3" })));
}

function renderFilters() {
  const counts = { all: reports.length };
  for (const r of reports) counts[r.report.verdict] = (counts[r.report.verdict] || 0) + 1;
  const defs = [["all", "All", null], ["risk", "Risk", "var(--bad)"], ["caution", "Caution", "var(--warn)"], ["ok", "Looks fine", "var(--ok)"], ["other", "Not an app", "var(--ink-4)"], ["invalid", "Not firmware", "var(--ink-4)"]];
  $("#filters").replaceChildren(...defs.filter(([k]) => k === "all" || counts[k]).map(([k, label, col]) =>
    h("button", { class: "filter", "aria-pressed": String(filter === k), onclick: () => { filter = k; applyFilter(); renderFilters(); } },
      col ? h("span", { class: "sw", style: `background:${col}` }) : null, label, h("span", { class: "n", text: counts[k] || 0 }))));
}
function applyFilter() {
  document.querySelectorAll("#results .card[data-verdict]").forEach((c) => { c.hidden = !(filter === "all" || c.dataset.verdict === filter); });
}

// ---------------------------------------------------------------- flow
const seen = new Set();          // SHA-256 of every file already shown
let queue = Promise.resolve();    // selections run one after another, never interleaved
function inspectFiles(list, after = null) {
  const files = [...list].filter((f) => /\.fwsc$/i.test(f.name));
  if (!files.length) { toast("No .fwsc files in that selection"); return Promise.resolve(); }
  queue = queue.then(() => runBatch(files, after)).catch(() => {});
  return queue;
}

async function runBatch(files, after = null) {
  $("#toolbar").hidden = false;
  if (!reports.length && !after) $("#toolbar").scrollIntoView({ behavior: "smooth", block: "start" });
  const results = $("#results"), first = results.firstChild;
  const skels = files.map(() => skeleton());
  if (after) after.after(...skels); else skels.forEach((s) => results.insertBefore(s, first));
  if (after) skels[0].scrollIntoView({ behavior: "smooth", block: "start" });
  let dupes = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    progress(`Checking ${i + 1} of ${files.length}…`);
    await new Promise((r) => setTimeout(r, 0));   // let the page paint between files
    let el = null;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const sha = await sha256(bytes);
      if (seen.has(sha)) { dupes++; skels[i].remove(); continue; }
      seen.add(sha);
      const { report, app } = analyze(bytes);
      const id = identify(sha);
      adjustForIdentity(report, id);
      applyBrick(report, brick[sha]);
      const rels = app && index ? closest(fingerprint(app, index), index, { exclude: sha, excludeRepo: id.repo, limit: 6 }) : [];
      reports.push({ file: file.name, sha256: sha, identified: id.title, repo: id.repo, provenance: id.rel || null, report,
        related: rels.map((r) => ({ repo: r.entry.repo, file: r.entry.file, score: +r.score.toFixed(3) })) });
      el = card(file, sha, report, id, rels);
    } catch {
      reports.push({ file: file.name, sha256: null, report: { verdict: "invalid" } });
      el = h("article", { class: "card t-invalid", "data-verdict": "invalid" }, h("div", { class: "card-head" }, h("div", { class: "status" }, icon("file-question")),
        h("div", { class: "card-title" }, h("h2", { text: file.name }), h("p", { class: "sub", text: "Could not be read." }))));
    }
    if (reports.length && reports[reports.length - 1].sha256) el.dataset.sha = reports[reports.length - 1].sha256;
    el.hidden = !(filter === "all" || el.dataset.verdict === filter);
    skels[i].replaceWith(el);
    renderFilters();                               // counts follow every file, not just the end of the batch
  }
  progress("");
  if (dupes) toast(`${dupes} file${dupes === 1 ? " was" : "s were"} already checked`);
}

function progress(msg) { const p = $("#progress"); p.textContent = msg; p.hidden = !msg; }

// ---------------------------------------------------------------- wiring
const drop = $("#drop"), veil = $("#dragveil");
let depth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
window.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; veil.hidden = false; drop.classList.add("over"); });
window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; if (--depth <= 0) { depth = 0; veil.hidden = true; drop.classList.remove("over"); } });
window.addEventListener("drop", (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth = 0; veil.hidden = true; drop.classList.remove("over"); inspectFiles(e.dataTransfer.files); });
drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#pick").click(); } });
$("#pick").addEventListener("change", (e) => { inspectFiles(e.target.files); e.target.value = ""; });
$("#pickdir").addEventListener("change", (e) => { inspectFiles(e.target.files); e.target.value = ""; });
$("#clear").addEventListener("click", () => { reports = []; seen.clear(); filter = "all"; $("#results").replaceChildren(); $("#toolbar").hidden = true; });
$("#export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify({ tool: "fm1-inspect", date: new Date().toISOString(), reports }, null, 2)], { type: "application/json" });
  const a = h("a", { href: URL.createObjectURL(blob), download: "fm1-inspect-report.json" });
  document.body.append(a); a.click(); a.remove(); toast("Report exported");
});
loadData();

// ---------------------------------------------------------------- release drill-down (GitHub tab)
const relCache = new Map();
async function openRelease(sha, assetName, after) {
  const existing = document.querySelector(`#results .card[data-sha="${sha}"]`);
  if (existing) { existing.scrollIntoView({ behavior: "smooth", block: "start" }); return existing; }
  let rec = relCache.get(sha);
  if (!rec) {
    const r = await fetch(`data/rel/${sha}.json`);
    if (!r.ok) throw new Error("no stored report");
    rec = await r.json(); relCache.set(sha, rec);
  }
  const report = structuredClone(rec.report);
  const id = identify(sha);
  adjustForIdentity(report, id);
  applyBrick(report, brick[sha]);
  let rels = [];
  if (rec.fp && index) {
    const fp = { sig: sigFromB64(rec.fp.sig), ownCode: rec.fp.ownCode, ssig: sigFromB64(rec.fp.ssig), ownStrings: rec.fp.ownStrings };
    rels = closest(fp, index, { exclude: sha, excludeRepo: id.repo, limit: 6 });
  }
  const el = card({ name: assetName }, sha, report, id, rels);
  el.dataset.sha = sha;
  after.after(el);
  if (!seen.has(sha)) {
    seen.add(sha);
    reports.push({ file: assetName, sha256: sha, identified: id.title, repo: id.repo, provenance: id.rel || null, report,
      related: rels.map((r) => ({ repo: r.entry.repo, file: r.entry.file, score: +r.score.toFixed(3) })) });
    renderFilters();
  }
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  return el;
}

// ---------------------------------------------------------------- tabs + GitHub
function setTab(name) {
  document.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  document.querySelectorAll("[data-panel]").forEach((p) => { p.hidden = p.dataset.panel !== name; });
  if (name === "github") $("#repo").focus();
}
document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));

let ghBusy = false;
async function runRepo(input) {
  const repo = parseRepo(input);
  const msg = $("#gh-msg");
  if (!repo) { msg.textContent = "Pick a project from the list, or paste a GitHub repository (owner/name or a github.com link)."; msg.className = "gh-msg err"; return; }
  if (ghBusy) return;
  ghBusy = true; $("#gh-go").disabled = true;
  msg.className = "gh-msg"; msg.textContent = "";
  const skel = skeleton(); $("#results").prepend(skel);
  try {
    const el = await lookupRepo(repo, {
      index, releases, renderChecks, verdictOf, openRelease, hasReport: (sha) => !!releases[sha]?.a,
      onFile: (f, after, prov) => { if (prov?.sha) liveProv.set(prov.sha, prov); return inspectFiles([f], after); },
      status: (m) => progress(m),
    });
    skel.replaceWith(el);
    $("#toolbar").hidden = false;
  } catch (e) {
    skel.remove();
    msg.className = "gh-msg err";
    msg.textContent = e instanceof TypeError ? "Couldn't reach GitHub (offline, or blocked by a network filter)." : (e.message || "Couldn't reach GitHub.");
    progress("");
  } finally { ghBusy = false; $("#gh-go").disabled = false; }
}
$("#gh-form").addEventListener("submit", (e) => {
  e.preventDefault(); closeList();
  const v = $("#repo").value; if (parseRepo(v)) return runRepo(v);
  const best = matches(v)[0]; if (best) { $("#repo").value = best.repo; runRepo(best.repo); } else runRepo(v);
});

// ---- project search (combobox over the projects in the index)
let projects = [];
function buildProjects() {
  const m = new Map();
  const get = (repo) => { if (!m.has(repo)) m.set(repo, { repo, desc: "", stars: 0, files: 0, category: "" }); return m.get(repo); };
  for (const e of index.entries) if (e.repo && !e.vendoredCopy) { const p = get(e.repo); p.desc ||= e.description || ""; p.stars = Math.max(p.stars, e.stars || 0); p.category ||= e.category || ""; }
  for (const r of Object.values(releases)) if (r.repo && r.a) get(r.repo).files++;
  projects = [...m.values()].filter((p) => /^[\w.-]+\/[\w.-]+$/.test(p.repo)).sort((a, b) => b.stars - a.stars || a.repo.localeCompare(b.repo));
  $("#repo").placeholder = `Search ${projects.length} firmware projects, or paste any GitHub repo`;
}
const list = $("#repo-list"), input = $("#repo");
let active = -1, shown = [];
function matches(q) {
  q = q.trim().toLowerCase();
  if (!q) return projects.slice(0, 8);
  const words = q.split(/\s+/);
  return projects.map((p) => {
    const hay = `${p.repo} ${p.desc} ${p.category}`.toLowerCase();
    if (!words.every((w) => hay.includes(w))) return null;
    const name = p.repo.split("/")[1].toLowerCase();
    return { p, rank: (name.startsWith(words[0]) ? 0 : p.repo.toLowerCase().includes(words[0]) ? 1 : 2) };
  }).filter(Boolean).sort((a, b) => a.rank - b.rank || b.p.stars - a.p.stars).slice(0, 8).map((x) => x.p);
}
function openList() {
  shown = matches(input.value); active = -1;
  const custom = parseRepo(input.value) && !projects.some((p) => p.repo.toLowerCase() === parseRepo(input.value).toLowerCase());
  const items = shown.map((p, i) => h("li", { role: "option", id: `opt-${i}`, class: "opt", "aria-selected": "false", onmousedown: (e) => { e.preventDefault(); choose(p.repo); } },
    h("div", { class: "opt-top" }, h("span", { class: "opt-name" }, h("b", { text: p.repo.split("/")[1] }), h("span", { class: "muted", text: " · " + p.repo.split("/")[0] })),
      h("span", { class: "opt-meta" }, p.files ? h("span", { text: `${p.files} file${p.files === 1 ? "" : "s"} analysed` }) : null, p.stars ? h("span", {}, icon("sparkles"), String(p.stars)) : null)),
    p.desc ? h("div", { class: "opt-desc", text: p.desc }) : null));
  if (custom) items.push(h("li", { role: "option", class: "opt opt-custom", id: `opt-${shown.length}`, "aria-selected": "false", onmousedown: (e) => { e.preventDefault(); choose(parseRepo(input.value)); } },
    h("div", { class: "opt-top" }, h("span", { class: "opt-name" }, icon("github"), " Look up ", h("b", { text: parseRepo(input.value) }), " on GitHub")),
    h("div", { class: "opt-desc", text: "Not in our index: releases, provenance and source are checked; release files you'd download and drop in." })));
  if (!items.length) items.push(h("li", { class: "opt opt-empty", text: "No matching project in the index. Paste a GitHub link to look one up." }));
  list.replaceChildren(...items); list.hidden = false; input.setAttribute("aria-expanded", "true");
}
function closeList() { list.hidden = true; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); }
function move(d) {
  const opts = [...list.querySelectorAll(".opt[role=option]")]; if (!opts.length) return;
  active = (active + d + opts.length) % opts.length;
  opts.forEach((o, i) => o.setAttribute("aria-selected", String(i === active)));
  input.setAttribute("aria-activedescendant", opts[active].id); opts[active].scrollIntoView({ block: "nearest" });
}
function choose(repo) { input.value = repo; closeList(); runRepo(repo); }
input.addEventListener("focus", openList);
input.addEventListener("input", openList);
input.addEventListener("blur", () => setTimeout(closeList, 120));
input.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); if (list.hidden) openList(); move(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
  else if (e.key === "Escape") closeList();
  else if (e.key === "Enter" && !list.hidden && active >= 0) {
    e.preventDefault(); const opts = [...list.querySelectorAll(".opt[role=option]")]; opts[active].dispatchEvent(new MouseEvent("mousedown"));
  }
});
