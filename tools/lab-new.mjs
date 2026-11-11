#!/usr/bin/env node
// The daily job's fm1-lab step: release files with no emulated result yet (site/data/lab.json), newest first, are
// downloaded (anonymously, checked against their SHA-256), run through `fm1-lab sweep --brick --gif` (a preview GIF,
// a boot screenshot, sound, the UC25HQ80 flash test; sandboxed with bubblewrap) and merged into the site's data (tools/apply-lab.mjs).
//   node tools/lab-new.mjs --lab PATH_TO_FM1_LAB [--max 150]
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const LAB = arg("--lab"), MAX = +arg("--max", 150);
if (!LAB || !existsSync(join(LAB, "bin", "fm1-lab.mjs"))) { console.error("usage: node tools/lab-new.mjs --lab PATH_TO_FM1_LAB [--max N]"); process.exit(64); }

const releases = JSON.parse(readFileSync(join(ROOT, "site", "data", "releases.json"), "utf8")).releases;
const labFile = join(ROOT, "site", "data", "lab.json");
const done = existsSync(labFile) ? JSON.parse(readFileSync(labFile, "utf8")).results : {};
const todo = Object.entries(releases).filter(([sha]) => !done[sha])
  .sort((a, b) => (b[1].published || "").localeCompare(a[1].published || "")).slice(0, MAX);
console.log(`${Object.keys(releases).length} release files; ${Object.keys(done).length} tested; ${todo.length} to test now`);
if (!todo.length) process.exit(0);

const dir = mkdtempSync(join(tmpdir(), "fm1-inspect-lab-")), files = join(dir, "files"), out = join(dir, "sweep");
mkdirSync(files);
let got = 0;
for (const [sha, r] of todo) {
  const url = `https://github.com/${r.repo}/releases/download/${encodeURIComponent(r.tag)}/${encodeURIComponent(r.asset)}`;
  try {
    const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "fm1-inspect" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const b = Buffer.from(await res.arrayBuffer());
    if (createHash("sha256").update(b).digest("hex") !== sha) throw new Error("SHA-256 differs");
    writeFileSync(join(files, `${sha}.fwsc`), b); got++;
  } catch (e) { console.log(`  skipped ${r.repo} ${r.tag} ${r.asset}: ${e.message}`); }
}
console.log(`downloaded ${got}`);
if (!got) process.exit(0);
execFileSync(process.execPath, [join(LAB, "bin", "fm1-lab.mjs"), "sweep", files, "--out", out, "--brick", "--gif", "--no-audio"], { stdio: "inherit" });
const commit = execFileSync("git", ["-C", LAB, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
execFileSync(process.execPath, [join(ROOT, "tools", "apply-lab.mjs"), out, "--lab-commit", commit], { stdio: "inherit" });
