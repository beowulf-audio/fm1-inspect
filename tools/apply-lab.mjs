#!/usr/bin/env node
// fm1-lab's results (an fm1-lab sweep: results.json and shots/) into the site's data:
//   site/data/lab.json        SHA-256 -> what the emulated FM-1 showed: v/r (the UC25HQ80 flash test's verdict and
//                             reason), boots, sound, ms (first screen), shot / gif / audio (files exist), tour; FM-1
//                             packages only (fm1-lab emulates an FM-1)
//   site/data/shots/SHA.png   the boot screenshot; SHA.gif and SHA.m4a the screen and sound through a preview tour
//                             (fm1-lab sweep --preview), for each project's latest 3 releases
//   site/data/rel/SHA.json    the stored report, with the tested flash result in it (site/js/brick.js applyBrick)
//   site/data/releases.json   each release's verdict with it (a.brickVerdict), and known.json's entries likewise
// Earlier results stay; a file tested again is replaced.
//   node tools/apply-lab.mjs SWEEP_OUT_DIR [--lab-commit SHA]
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyBrick } from "../site/js/brick.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "site", "data");
const args = process.argv.slice(2);
const sweepDir = args.find((a) => !a.startsWith("--"));
const commitIdx = args.indexOf("--lab-commit"), labCommit = commitIdx >= 0 ? args[commitIdx + 1] : null;
if (!sweepDir) { console.error("usage: node tools/apply-lab.mjs SWEEP_OUT_DIR [--lab-commit SHA]"); process.exit(64); }

const sweep = JSON.parse(readFileSync(join(sweepDir, "results.json"), "utf8")).results;
const labFile = join(DATA, "lab.json");
const lab = existsSync(labFile) ? JSON.parse(readFileSync(labFile, "utf8")) : { results: {} };
mkdirSync(join(DATA, "shots"), { recursive: true });

let added = 0, shots = 0;
for (const r of sweep) {
  // FM-1 packages only: fm1-lab emulates an FM-1, so an SMK-37 or MKE-P37 package boots there but doesn't behave as on its
  // own hardware (no sound from its keys, the flash test not known to apply)
  if (!r.check?.ok || !r.smoke || r.check.model !== "FM-1") continue;
  // merged over what was there: a preview-only run keeps the earlier flash test, and so on
  const e = { ...(lab.results[r.sha] || {}), boots: !!r.smoke.boots, sound: !!r.smoke.sound, ms: r.smoke.firstScreenMs ?? null, at: (r.at || "").slice(0, 10) };
  if (r.brick) { e.v = r.brick.verdict; e.r = r.brick.reason; }
  const png = join(sweepDir, "shots", `${r.sha}-boot.png`);
  if (existsSync(png)) { copyFileSync(png, join(DATA, "shots", `${r.sha}.png`)); e.shot = true; shots++; }
  // the preview: a GIF of the screen through fm1-lab's tour (a chord, a melody, PLAY, a few presets)
  const anim = join(sweepDir, "anim", `${r.sha}.gif`), m4a = join(sweepDir, "audio", `${r.sha}.m4a`);
  if (r.preview) {
    if (existsSync(anim)) { copyFileSync(anim, join(DATA, "shots", `${r.sha}.gif`)); e.gif = true; }
    if (existsSync(m4a)) { copyFileSync(m4a, join(DATA, "shots", `${r.sha}.m4a`)); e.audio = true; }
    e.tour = r.preview.tour;                         // {source: generic | tailored | author, hash}
  }
  lab.results[r.sha] = e; added++;
}
// previews (GIF, audio) only for each project's latest releases, so the site doesn't grow without end; older versions
// keep their screenshot and test results
const KEEP = 3;
{
  const rels = JSON.parse(readFileSync(join(DATA, "releases.json"), "utf8")).releases;
  const byRepo = new Map();
  for (const [sha, x] of Object.entries(rels)) { if (!byRepo.has(x.repo)) byRepo.set(x.repo, []); byRepo.get(x.repo).push([sha, x.published || "", x.tag || ""]); }
  const keep = new Set();
  for (const list of byRepo.values()) {
    const tags = [...new Set(list.sort((a, b) => b[1].localeCompare(a[1])).map((x) => x[2]))].slice(0, KEEP);
    for (const [sha, , tag] of list) if (tags.includes(tag)) keep.add(sha);
  }
  let pruned = 0;
  for (const [sha, e] of Object.entries(lab.results)) {
    if (keep.has(sha) || !rels[sha] || (!e.gif && !e.audio)) continue;
    for (const ext of ["gif", "m4a"]) rmSync(join(DATA, "shots", `${sha}.${ext}`), { force: true });
    delete e.gif; delete e.audio; delete e.tour; pruned++;
  }
  if (pruned) console.log(`previews of older releases removed: ${pruned}`);
}
lab.generated = new Date().toISOString().slice(0, 10);
lab.lab = { repo: "beowulf-audio/fm1-lab", commit: labCommit || lab.lab?.commit || null };
lab.count = Object.keys(lab.results).length;
writeFileSync(labFile, JSON.stringify(lab));

// the stored reports, the releases' verdicts and the index entries
const relFile = join(DATA, "releases.json"), knownFile = join(DATA, "known.json");
const releases = JSON.parse(readFileSync(relFile, "utf8")), known = JSON.parse(readFileSync(knownFile, "utf8"));
const bySha = new Map(known.entries.map((k) => [k.sha256, k]));
let reports = 0, changed = { ok: 0, caution: 0, risk: 0 };
for (const [sha, e] of Object.entries(lab.results)) {
  if (!e.v) continue;
  const rp = join(DATA, "rel", `${sha}.json`);
  let verdict = null;
  if (existsSync(rp)) {
    const rec = JSON.parse(readFileSync(rp, "utf8"));
    const before = rec.report.verdict;
    applyBrick(rec.report, e);
    verdict = rec.report.verdict;
    if (before !== verdict) changed[verdict] = (changed[verdict] || 0) + 1;
    writeFileSync(rp, JSON.stringify(rec)); reports++;
  }
  const rel = releases.releases[sha];
  if (rel?.a) { rel.a.brickVerdict = verdict || rel.a.verdict; rel.a.brick = e.v; }
  const k = bySha.get(sha);
  if (k && verdict) { k.verdict = verdict; k.brick = e.v; }
}
writeFileSync(relFile, JSON.stringify(releases));
writeFileSync(knownFile, JSON.stringify(known));
const v = Object.values(lab.results).reduce((m, e) => (e.v ? ((m[e.v] = (m[e.v] || 0) + 1), m) : m), {});
console.log(`lab.json: ${lab.count} files (${added} from this sweep, ${shots} screenshots) · flash test: ${Object.entries(v).map(([k, n]) => `${n} ${k}`).join(", ")}`);
console.log(`stored reports updated: ${reports} · verdicts that changed: ${Object.entries(changed).filter(([, n]) => n).map(([k, n]) => `${n} now ${k}`).join(", ") || "none"}`);
