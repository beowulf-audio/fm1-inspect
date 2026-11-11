#!/usr/bin/env node
// The daily job's fm1-lab step: keeps site/data/lab.json (and its screenshots, previews and the reports) current.
//   1. release files with no result yet (new releases, new projects): downloaded (anonymously, checked against their
//      SHA-256) and run through fm1-lab: the UC25HQ80 flash test, a boot screenshot, and the preview
//   2. each project's latest 3 releases: the preview (an animated GIF of the screen, the sound as .m4a) made again when
//      the project's tour has changed since it was made, or is missing; the flash test is kept
// A project's tour, the first that exists: the author's .fm1-preview.yaml in their repository (the default branch),
// a tour written for it here (data/tours/OWNER__REPO.yaml), fm1-lab's generic one (scenarios/preview.yaml).
//   node tools/lab-update.mjs --lab PATH_TO_FM1_LAB [--max-new 150] [--max-previews 300] [--dry-run]
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const LAB = arg("--lab"), MAX_NEW = +arg("--max-new", 150), MAX_PREV = +arg("--max-previews", 300), KEEP = 3;
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

// each project's latest releases (by tag) and its tour
const byRepo = new Map();
for (const [sha, r] of Object.entries(releases)) { if (!byRepo.has(r.repo)) byRepo.set(r.repo, []); byRepo.get(r.repo).push({ sha, ...r }); }
const latest = new Map();
for (const [repo, list] of byRepo) {
  const tags = [...new Set(list.sort((a, b) => (b.published || "").localeCompare(a.published || "")).map((x) => x.tag))].slice(0, KEEP);
  latest.set(repo, list.filter((x) => tags.includes(x.tag)));
}
const generic = join(LAB, "scenarios", "preview.yaml");
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

// 1. new files, and 2. previews whose tour changed
const fresh = Object.entries(releases).filter(([sha]) => !lab[sha]).sort((a, b) => (b[1].published || "").localeCompare(a[1].published || "")).slice(0, MAX_NEW).map(([sha]) => sha);
const tours = {}, redo = [];
for (const [repo, list] of latest) {
  const t = await tourFor(repo);
  for (const x of list) {
    tours[x.sha] = { scenario: t.scenario, source: t.source };
    const e = lab[x.sha];
    if (e && (e.tour?.hash !== t.hash || !e.gif || !e.tour?.stats) && e.boots !== false && redo.length < MAX_PREV) redo.push(x.sha);
  }
}
const freshSet = new Set(fresh);
const newRepos = new Set(fresh.map((s) => releases[s].repo));
for (const s of fresh) if (!tours[s]) tours[s] = { scenario: generic, source: "generic" };
console.log(`${Object.keys(releases).length} release files · ${fresh.length} new to test (${newRepos.size} projects) · ${redo.length} previews to make again`);
writeFileSync(join(work, "tours.json"), JSON.stringify(tours));
if (process.argv.includes("--dry-run")) {   // what it would do, nothing more
  const src = {}; for (const t of Object.values(tours)) src[t.source] = (src[t.source] || 0) + 1;
  console.log(`dry run: tours by source for the latest releases: ${JSON.stringify(src)}`); process.exit(0);
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
const commit = execFileSync("git", ["-C", LAB, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const sweep = (dir, out, extra) => {
  execFileSync(process.execPath, [join(LAB, "bin", "fm1-lab.mjs"), "sweep", dir, "--out", out, "--preview", "--no-audio", "--tours", join(work, "tours.json"), ...extra], { stdio: "inherit" });
  execFileSync(process.execPath, [join(ROOT, "tools", "apply-lab.mjs"), out, "--lab-commit", commit], { stdio: "inherit" });
};
if (fresh.length && await download(fresh, join(work, "new"))) sweep(join(work, "new"), join(work, "sweep-new"), ["--brick"]);
const prev = redo.filter((s) => !freshSet.has(s));
if (prev.length && await download(prev, join(work, "redo"))) sweep(join(work, "redo"), join(work, "sweep-redo"), []);
