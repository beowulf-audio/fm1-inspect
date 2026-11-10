#!/usr/bin/env node
// Build site/data/known.json: every known firmware image with its identity, checks, source repo and fingerprint.
//   node tools/build-data.mjs <corpus-dir> [--provenance tools/.cache/provenance.json]
// <corpus-dir> holds downloaded repos, each with _SOURCE.txt (repo URL) and optionally _release_assets/.
// Reads files only; runs nothing from the corpus.
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, relative, dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import { analyze, strings } from "../site/js/analyze.js";
import { shingleHashes, signature, sigToB64, stopToB64, stringTokens, bloomBuild, bloomFrom, bytesToB64 } from "../site/js/fingerprint.js";

const args = process.argv.slice(2);
const corpus = args.find((a) => !a.startsWith("--"));
if (!corpus) { console.error("usage: build-data.mjs <corpus-dir> [--provenance file]"); process.exit(2); }
const provPath = args.includes("--provenance") ? args[args.indexOf("--provenance") + 1] : null;
// folder of downloaded release files (<sha256>.fwsc, from tools/analyze-releases.mjs): full per-file reports for drill-down
const relDir = args.includes("--releases-dir") ? args[args.indexOf("--releases-dir") + 1] : null;
const here = dirname(new URL(import.meta.url).pathname);
const outDir = join(here, "..", "site", "data");
mkdirSync(outDir, { recursive: true });

// ---- walk the corpus for .fwsc files
const files = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    if (n === "node_modules" || n === ".git" || n === "fm1-inspect") continue;
    const p = join(d, n);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p);
    else if (/\.fwsc$/i.test(n) && st.size < 20e6) files.push(p);
  }
})(corpus);

// ---- project metadata: nearest _SOURCE.txt (top-level downloaded repo), category from the path, catalog.csv
const catalog = new Map();
const csvPath = join(corpus, "catalog.csv");
if (existsSync(csvPath)) {
  const lines = readFileSync(csvPath, "utf8").split("\n"), head = lines[0].split(",");
  for (const l of lines.slice(1)) {
    if (!l.trim()) continue;
    const cells = []; let cur = "", q = false;
    for (const ch of l) { if (ch === '"') q = !q; else if (ch === "," && !q) { cells.push(cur); cur = ""; } else cur += ch; }
    cells.push(cur);
    const row = Object.fromEntries(head.map((h, i) => [h, cells[i]]));
    catalog.set(row.repo, row);
  }
}
function projectOf(p) {
  let d = dirname(p);
  while (d.startsWith(corpus) && d !== corpus) {
    const s = join(d, "_SOURCE.txt");
    if (existsSync(s)) {
      const repo = readFileSync(s, "utf8").split("\n")[0].replace("https://github.com/", "").trim();
      const rel = relative(corpus, d).split("/");
      return { repo, dir: d, category: rel.length >= 2 ? rel[1] : rel[0] };
    }
    d = dirname(d);
  }
  return null;
}

// ---- pass 1: decode, dedupe by file hash
const bySha = new Map();
let bad = 0;
for (const p of files) {
  const bytes = new Uint8Array(readFileSync(p));
  const sha = createHash("sha256").update(bytes).digest("hex");
  const proj = projectOf(p);
  const isRelease = p.includes("/_release_assets/") || p.includes("/stock_firmware/");
  const prev = bySha.get(sha);
  if (prev) { // keep the most canonical path: a project's own release asset beats a vendored copy
    if (isRelease && !prev.isRelease) Object.assign(prev, { path: p, proj, isRelease });
    prev.copies++;
    continue;
  }
  const { report, app } = analyze(bytes);
  if (!app) { bad++; continue; }
  bySha.set(sha, { sha, path: p, proj, isRelease, report, app, copies: 1 });
}
const images = [...bySha.values()];
console.log(`${files.length} .fwsc files, ${images.length} distinct decodable images, ${bad} not firmware (bootloaders/stages)`);

// ---- stop-lists. Code shingles: those in M-VAVE's own images (the SDK) or in >= 60% of projects.
// Strings: only M-VAVE's own (SDK text); common platform strings (Felucca's, SLOOP's) are kept: they ARE lineage.
const isMvave = (im) => im.path.includes("/stock_firmware/") || /^m-vave\//i.test(im.proj?.repo || "");
for (const im of images) im.tokens = stringTokens(strings(im.app, 6));
const stockShingles = new Set(), stockStrings = new Set();
for (const im of images) if (isMvave(im)) { for (const h of shingleHashes(im.app)) stockShingles.add(h); for (const t of im.tokens) stockStrings.add(t); }
const perProject = new Map(); // one representative FM-1 image per project
for (const im of images) {
  const key = im.proj?.repo || im.path;
  if (!perProject.has(key) || (im.isRelease && im.report.model === "FM-1" && perProject.get(key).report.model !== "FM-1")) perProject.set(key, im);
}
const df = new Map();
for (const im of perProject.values()) for (const h of new Set(shingleHashes(im.app))) df.set(h, (df.get(h) || 0) + 1);
const nProj = perProject.size, stopB = new Set(stockShingles);
for (const [h, c] of df) if (c / nProj >= 0.6) stopB.add(h);
const BLOOM_M = Math.ceil(stopB.size * 9.6);           // ~1% false positives at k=5
const bloomBits = bloomBuild(stopB, BLOOM_M), isStop = bloomFrom(bloomBits, BLOOM_M);
const stopS = Uint32Array.from(stockStrings).sort(), isStopS = (h) => stockStrings.has(h);
console.log(`stop-lists: ${stopB.size} code shingles -> ${(bloomBits.length / 1024).toFixed(0)} KB bloom; ${stopS.length} SDK strings; ${nProj} projects`);

// ---- provenance (optional, built by tools/provenance.mjs)
const prov = provPath && existsSync(provPath) ? JSON.parse(readFileSync(provPath, "utf8")) : {};

// ---- pass 2: entries
const entries = images.map((im) => {
  const { sig, used } = signature(shingleHashes(im.app), isStop);
  const { sig: ssig, used: ownStrings } = signature(im.tokens, isStopS);
  const repo = im.proj?.repo || null, meta = repo ? catalog.get(repo) : null;
  const tagFile = join(dirname(im.path), "TAG.txt");
  const r = im.report;
  return {
    sha256: im.sha, file: basename(im.path), repo, category: im.proj?.category || null, official: isMvave(im),
    vendoredCopy: !im.isRelease, tag: im.isRelease && existsSync(tagFile) ? readFileSync(tagFile, "utf8").trim() : null,
    description: meta?.desc || null, stars: meta ? Number(meta.stars) : null, license: meta?.license || null,
    identity: r.identity, model: r.model, verdict: r.verdict,
    flash: r.flash, internet: r.network.internetCapable, hosts: r.network.unusualHosts.slice(0, 12),
    usb: r.usb, appSize: r.package.appSize, ownCode: used, sig: sigToB64(sig), ownStrings, ssig: sigToB64(ssig),
    provenance: prov[im.sha] || null,
  };
}).sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1) || a.file.localeCompare(b.file));

const known = { generated: new Date().toISOString().slice(0, 10), count: entries.length, entries };
// every firmware file published on the projects' GitHub releases, by checksum (identifies versions we hold no copy of)
const releases = {};
const anaPath = join(here, ".cache", "release-analysis.json");
const ana = existsSync(anaPath) ? JSON.parse(readFileSync(anaPath, "utf8")) : {};
for (const [sha, p] of Object.entries(prov)) {
  const { repo, tag, asset, published, prerelease, url, tier, attestation } = p;
  const a = ana[sha] ? { verdict: ana[sha].verdict, model: ana[sha].model, flash: ana[sha].flash, internet: ana[sha].internet, usb: ana[sha].usb } : null;
  releases[sha] = { repo, tag, asset, published, prerelease, url, tier, a, attested: attestation ? { verified: attestation.verified, workflow: attestation.workflow, ref: attestation.ref, commit: attestation.commit || null } : null };
}
writeFileSync(join(outDir, "releases.json"), JSON.stringify({ generated: known.generated, count: Object.keys(releases).length, releases }));
writeFileSync(join(outDir, "known.json"), JSON.stringify(known));
writeFileSync(join(outDir, "stoplist.json"), JSON.stringify({ bloomM: BLOOM_M, bloom: bytesToB64(bloomBits), strings: stopToB64(stopS) }));
console.log(`wrote site/data/known.json (${entries.length} entries) and site/data/stoplist.json`);

// ---- per-file reports (site/data/rel/<sha>.json), fetched when a release file is opened in the GitHub tab
if (relDir && existsSync(relDir)) {
  const out = join(outDir, "rel");
  rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
  const slim = (r) => ({
    verdict: r.verdict, parsed: r.parsed, model: r.model, identity: r.identity, size: r.size, errors: r.errors, findings: r.findings,
    package: r.package, flash: r.flash, usb: r.usb, strings: r.strings ? { versions: r.strings.versions } : null,
    network: r.network ? { markers: r.network.markers, urls: r.network.urls.slice(0, 25), unusualHosts: r.network.unusualHosts.slice(0, 25), internetCapable: r.network.internetCapable } : null,
  });
  let n = 0;
  for (const sha of Object.keys(releases)) {
    const f = join(relDir, sha + ".fwsc");
    if (!existsSync(f)) continue;
    const bytes = new Uint8Array(readFileSync(f));
    if (createHash("sha256").update(bytes).digest("hex") !== sha) continue;
    const { report, app } = analyze(bytes);
    const rec = { report: slim(report) };
    if (app) {
      const b = signature(shingleHashes(app), isStop), t = signature(stringTokens(strings(app, 6)), isStopS);
      rec.fp = { sig: sigToB64(b.sig), ownCode: b.used, ssig: sigToB64(t.sig), ownStrings: t.used };
    }
    writeFileSync(join(out, sha + ".json"), JSON.stringify(rec)); n++;
  }
  console.log(`wrote ${n} per-file release reports to site/data/rel/`);
}
