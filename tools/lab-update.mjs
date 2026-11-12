#!/usr/bin/env node
// The daily job's fm1-lab step: keeps site/data/lab.json (and its screenshots, previews and the reports) current.
//   1. release files with no result yet (new releases, new projects): downloaded (anonymously, checked against their
//      SHA-256) and run through fm1-lab: the UC25HQ80 flash test and a boot screenshot
//   2. each project's preview (one per project, tools/previews.mjs): its tour played on its latest release's file when
//      that isn't the one previewed, or the tour has changed, or the preview is missing; then tools/previews.mjs decides
//      whether it replaces the current preview
// A project's tour, the first that exists: the author's .fm1-preview.yaml in their repository (the default branch),
// a tour written for it here (data/tours/OWNER__REPO.yaml), fm1-lab's generic one (scenarios/preview.yaml).
// A release file with a resource region beside it (NAME-res.bin, the index's res) whose address is in
// data/resources.json: the region is downloaded (checked against its SHA-256) and put in the emulated flash for the
// preview; a preview made without it, or with another, is made again. A region in the package itself (entry: its type,
// an entry beside flash.bin that only the firmware's own installer writes) needs no download: fm1-lab takes it from the
// file (entry:TYPE@ADDR); a release whose package has no such entry is previewed without it, and not again for that.
//   node tools/lab-update.mjs --lab PATH_TO_FM1_LAB [--max-new 150] [--max-previews 300] [--dry-run]
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { byProject, candidate } from "./previews.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const LAB = arg("--lab"), MAX_NEW = +arg("--max-new", 150), MAX_PREV = +arg("--max-previews", 300);
if (!LAB || !existsSync(join(LAB, "bin", "fm1-lab.mjs"))) { console.error("usage: node tools/lab-update.mjs --lab PATH_TO_FM1_LAB [--max-new N] [--max-previews N]"); process.exit(64); }
const { normalize } = await import(pathToFileURL(join(LAB, "lib", "scenario.mjs")).href);
const yaml = await import(pathToFileURL(join(LAB, "lib", "vendor", "js-yaml.mjs")).href);
// a tour's identity is what it plays, not its text (fm1-lab's tourHash), so a comment or formatting change makes no previews again
const { tourHash: hashOf } = await import(pathToFileURL(join(LAB, "lib", "preview.mjs")).href);
const tourHash = (text, where) => hashOf(normalize(yaml.load(text), where));

// FM-1 packages only (fm1-lab emulates an FM-1; an SMK-37 or MKE-P37 package wouldn't behave as on its own hardware)
const releases = Object.fromEntries(Object.entries(JSON.parse(readFileSync(join(ROOT, "site", "data", "releases.json"), "utf8")).releases)
  .filter(([, r]) => (r.a?.model || "FM-1") === "FM-1"));
const labFile = join(ROOT, "site", "data", "lab.json");
const lab = existsSync(labFile) ? JSON.parse(readFileSync(labFile, "utf8")).results : {};
const work = mkdtempSync(join(tmpdir(), "fm1-inspect-lab-")), tourDir = join(work, "tours");
mkdirSync(tourDir);

const previews = existsSync(join(ROOT, "site", "data", "previews.json")) ? JSON.parse(readFileSync(join(ROOT, "site", "data", "previews.json"), "utf8")).previews : {};
// a newer release already found to show clearly less through the same tour isn't played again until the tour changes
const judged = new Set((existsSync(join(ROOT, "data", "tours", "review.json")) ? JSON.parse(readFileSync(join(ROOT, "data", "tours", "review.json"), "utf8")).review : []).map((x) => `${x.sha} ${x.hash} ${x.resources || ""}`));
const generic = join(LAB, "scenarios", "preview.yaml");
const regions = existsSync(join(ROOT, "data", "resources.json")) ? JSON.parse(readFileSync(join(ROOT, "data", "resources.json"), "utf8")).regions : {};
/** A release file's resource region for its preview: {asset, sha, base, id} (id: fm1-lab's tour.resources), or null */
const resourcesOf = (sha) => {
  const r = releases[sha], g = r && regions[r.repo], base = g && parseInt(g.base, 16);
  if (!g || !Number.isInteger(base)) return null;
  if (Number.isInteger(g.entry)) return { entry: g.entry, base, id: `0x${base.toString(16)}:entry${g.entry}` };
  return r.res ? { asset: r.res.asset, sha: r.res.sha, base, id: `0x${base.toString(16)}:${r.res.sha.slice(0, 16)}` } : null;
};
// the preview has what it should: the region, or (one in the package) fm1-lab found the package has no such entry
const sameResources = (tour, res) => (tour.resources || null) === (res?.id || null)
  || (res?.entry != null && !tour.resources && /no entry of type/.test(tour.resourcesError || ""));
const ok = (text, where) => {   // a tour must be a valid fm1-lab scenario, and short
  try { const sc = normalize(yaml.load(text), where); if (sc.ms > 20000 || sc.steps.length > 200) throw new Error("longer than 20 s or 200 steps"); return true; }
  catch (e) { console.log(`  tour ${where} not used: ${e.message}`); return false; }
};
async function tourFor(repo) {
  const safe = repo.replace("/", "__");
  try {   // the author's, from their repository (data only: parsed as a scenario, never run as code)
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/HEAD/.fm1-preview.yaml`, { headers: { "user-agent": "fm1-inspect" } });
    if (res.ok) { const t = await res.text(); if (t.length < 20000 && ok(t, `${repo}/.fm1-preview.yaml`)) { const p = join(tourDir, `${safe}.author.yaml`); writeFileSync(p, t); return { scenario: p, source: "author", hash: tourHash(t, p) }; } }
  } catch {}
  const ours = join(ROOT, "data", "tours", `${safe}.yaml`);
  if (existsSync(ours)) { const t = readFileSync(ours, "utf8"); if (ok(t, ours)) return { scenario: ours, source: "tailored", hash: tourHash(t, ours) }; }
  return { scenario: generic, source: "generic", hash: tourHash(readFileSync(generic, "utf8"), generic) };
}

// 1. new files, and 2. each project's preview: its latest release's file, through its tour
const fresh = Object.entries(releases).filter(([sha]) => !lab[sha]).sort((a, b) => (b[1].published || "").localeCompare(a[1].published || "")).slice(0, MAX_NEW).map(([sha]) => sha);
const freshSet = new Set(fresh);
const tours = {}, redo = [];
for (const [repo, list] of byProject(releases)) {
  const cur = previews[repo], c = candidate(list, cur), e = lab[c.sha];
  if (!e && !freshSet.has(c.sha)) continue;           // not tested yet, and not today: another day
  if (e && e.boots === false) continue;
  const t = await tourFor(repo), res = resourcesOf(c.sha);
  const has = e?.gif && e.tour?.hash === t.hash && e.tour?.stats && sameResources(e.tour, res);
  if (!has && !(cur && cur.hash === t.hash && judged.has(`${c.sha} ${t.hash} ${res?.id || ""}`)) && redo.length < MAX_PREV) { tours[c.sha] = { scenario: t.scenario, source: t.source, ...(res ? { res } : {}) }; redo.push(c.sha); }
}
const newRepos = new Set(fresh.map((s) => releases[s].repo));
console.log(`${Object.keys(releases).length} release files · ${fresh.length} new to test (${newRepos.size} projects) · ${redo.length} previews to make`);
if (process.argv.includes("--dry-run")) {   // what it would do, nothing more
  const src = {}; for (const t of Object.values(tours)) src[t.source] = (src[t.source] || 0) + 1;
  const withRes = Object.entries(tours).filter(([, t]) => t.res).map(([s]) => `${releases[s].repo} ${releases[s].tag}`);
  console.log(`dry run: tours by source for the latest releases: ${JSON.stringify(src)}${withRes.length ? ` · with their resource region: ${withRes.join(", ")}` : ""}`); process.exit(0);
}

async function download(shas, dir) {
  mkdirSync(dir, { recursive: true }); let got = 0;
  for (const sha of shas) {
    const r = releases[sha], url = `https://github.com/${r.repo}/releases/download/${encodeURIComponent(r.tag)}/${encodeURIComponent(r.asset)}`;
    try {
      const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "fm1-inspect" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const b = Buffer.from(await res.arrayBuffer());
      if (createHash("sha256").update(b).digest("hex") !== sha) throw new Error("SHA-256 differs");
      writeFileSync(join(dir, `${sha}.fwsc`), b); got++;
    } catch (e) { console.log(`  skipped ${r.repo} ${r.tag} ${r.asset}: ${e.message}`); }
  }
  return got;
}
// the resource regions (anonymously, checked against their SHA-256); one that can't be had: the preview without it, and
// again another day
const resDir = join(work, "res"); mkdirSync(resDir);
for (const [sha, t] of Object.entries(tours)) {
  if (!t.res) continue;
  if (t.res.entry != null) { t.resources = `entry:${t.res.entry}@0x${t.res.base.toString(16)}`; delete t.res; continue; }
  const r = releases[sha], p = join(resDir, `${t.res.sha}.bin`);
  try {
    if (!existsSync(p)) {
      const res = await fetch(`https://github.com/${r.repo}/releases/download/${encodeURIComponent(r.tag)}/${encodeURIComponent(t.res.asset)}`, { redirect: "follow", headers: { "user-agent": "fm1-inspect" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const b = Buffer.from(await res.arrayBuffer());
      if (createHash("sha256").update(b).digest("hex") !== t.res.sha) throw new Error("SHA-256 differs");
      writeFileSync(p, b);
    }
    t.resources = `${p}@0x${t.res.base.toString(16)}`;
  } catch (e) { console.log(`  resources for ${r.repo} ${r.tag} (${t.res.asset}) not used: ${e.message}`); }
  delete t.res;
}
writeFileSync(join(work, "tours.json"), JSON.stringify(tours));
const commit = execFileSync("git", ["-C", LAB, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const sweep = (dir, out, extra, preview) => {
  execFileSync(process.execPath, [join(LAB, "bin", "fm1-lab.mjs"), "sweep", dir, "--out", out, ...(preview ? ["--preview", "--tours", join(work, "tours.json")] : []), "--no-audio", ...extra], { stdio: "inherit" });
  execFileSync(process.execPath, [join(ROOT, "tools", "apply-lab.mjs"), out, "--lab-commit", commit], { stdio: "inherit" });
};
if (fresh.length && await download(fresh, join(work, "new"))) sweep(join(work, "new"), join(work, "sweep-new"), ["--brick"], false);
if (redo.length) {   // the files to preview: today's new ones are on disk already, the rest downloaded
  const dir = join(work, "redo"); mkdirSync(dir, { recursive: true });
  const get = redo.filter((s) => !existsSync(join(work, "new", `${s}.fwsc`)));
  for (const s of redo.filter((s) => existsSync(join(work, "new", `${s}.fwsc`)))) copyFileSync(join(work, "new", `${s}.fwsc`), join(dir, `${s}.fwsc`));
  await download(get, dir);
  if (readdirSync(dir).length) sweep(dir, join(work, "sweep-redo"), [], true);
}
// which preview each project shows, and the rest of the preview files removed
execFileSync(process.execPath, [join(ROOT, "tools", "previews.mjs")], { stdio: "inherit" });
