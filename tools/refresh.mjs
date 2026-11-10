#!/usr/bin/env node
// Daily index refresh (runs in GitHub Actions, or locally with GH_TOKEN set).
//   1. discover FM-1 firmware repos: GitHub search, the Firmware Hub catalogue, fm1-emu's firmware list, plus data/repos.json
//   2. list each repo's releases; every .fwsc file not yet in site/data/releases.json is downloaded, checked against the
//      SHA-256 GitHub publishes, analysed, fingerprinted, and written to site/data/rel/<sha>.json
//   3. attestations are looked up for new files and verified with `gh attestation verify` when gh is available
//   4. each new firmware file also gets a record in site/data/known.json (with the project's description, stars and
//      licence), so new projects are identified, listed in search and found as relatives like the rest
// Downloaded files are only read by our own decoder; nothing from them is executed.
//   GH_TOKEN=... node tools/refresh.mjs [--max-new N]
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { analyze, strings } from "../site/js/analyze.js";
import { shingleHashes, signature, sigToB64, stringTokens, bloomFrom, b64ToBytes, stopFromB64 } from "../site/js/fingerprint.js";

const run = promisify(execFile);
const root = join(dirname(new URL(import.meta.url).pathname), "..");
const data = join(root, "site", "data"), relDir = join(data, "rel");
const reposPath = join(root, "data", "repos.json");
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
const maxNew = process.argv.includes("--max-new") ? +process.argv[process.argv.indexOf("--max-new") + 1] : 400;
mkdirSync(relDir, { recursive: true }); mkdirSync(dirname(reposPath), { recursive: true });

const H = { Accept: "application/vnd.github+json", "User-Agent": "fm1-inspect-refresh", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
async function api(path) {
  const r = await fetch(`https://api.github.com${path}`, { headers: H });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}
async function json(url) { try { const r = await fetch(url, { headers: { "User-Agent": "fm1-inspect-refresh" } }); return r.ok ? r.json() : null; } catch { return null; } }
async function pool(items, n, fn) { const q = [...items]; await Promise.all(Array.from({ length: n }, async () => { while (q.length) await fn(q.shift()); })); }
const repoRe = /^[\w.-]+\/[\w.-]+$/;

// ---- 1. discovery
const repos = new Set(existsSync(reposPath) ? JSON.parse(readFileSync(reposPath, "utf8")) : []);
const before = repos.size;
for (const q of ["M-VAVE FM-1 firmware", "fm1 firmware fwsc", "mvave fm1", "fm-1 m-vave", "fm1 felucca", "smk-37 firmware m-vave"]) {
  try {
    const r = await api(`/search/repositories?q=${encodeURIComponent(q)}&per_page=100&sort=updated`);
    for (const it of r?.items || []) repos.add(it.full_name);
  } catch (e) { console.log("search failed:", q, e.message); }
}
const hub = await json("https://thefirmwarehub.com/catalog.json");
for (const f of hub?.firmwares || []) if (repoRe.test(f.repo || "")) repos.add(f.repo);
const emu = await json("https://raw.githubusercontent.com/joakimeriksson/fm1-emu/master/web/firmwares.json");
for (const f of (emu?.firmwares || emu || [])) {
  const m = JSON.stringify(f).match(/github\.com\/([\w.-]+\/[\w.-]+)/); if (m) repos.add(m[1].replace(/\.git$/, ""));
}
console.log(`repos: ${repos.size} (${repos.size - before} new)`);

// ---- 2. releases
const relPath = join(data, "releases.json");
const relDoc = existsSync(relPath) ? JSON.parse(readFileSync(relPath, "utf8")) : { releases: {} };
const releases = relDoc.releases;
const stop = JSON.parse(readFileSync(join(data, "stoplist.json"), "utf8"));
const isStop = bloomFrom(b64ToBytes(stop.bloom), stop.bloomM), isStopS = stopFromB64(stop.strings);
const fresh = [];
await pool([...repos], 6, async (repo) => {
  let rels; try { rels = await api(`/repos/${repo}/releases?per_page=30`); } catch { return; }
  for (const r of rels || []) for (const a of r.assets || []) {
    if (!/\.fwsc$/i.test(a.name) || !a.digest?.startsWith("sha256:")) continue;
    const sha = a.digest.slice(7);
    if (releases[sha]?.a || fresh.some((f) => f.sha === sha)) continue;
    fresh.push({ sha, repo, tag: r.tag_name, asset: a.name, published: (r.published_at || "").slice(0, 10), prerelease: !!r.prerelease,
      url: r.html_url, size: a.size, ci: a.uploader?.type === "Bot" && /github-actions/.test(a.uploader?.login || "") });
  }
});
console.log(`${fresh.length} new release files${fresh.length > maxNew ? `, analysing the first ${maxNew}` : ""}`);

const slim = (r) => ({
  verdict: r.verdict, parsed: r.parsed, model: r.model, identity: r.identity, size: r.size, errors: r.errors, findings: r.findings,
  package: r.package, flash: r.flash, usb: r.usb, strings: r.strings ? { versions: r.strings.versions } : null,
  network: r.network ? { markers: r.network.markers, urls: r.network.urls.slice(0, 25), unusualHosts: r.network.unusualHosts.slice(0, 25), internetCapable: r.network.internetCapable } : null,
});
const knownPath = join(data, "known.json");
const known = JSON.parse(readFileSync(knownPath, "utf8"));
const knownSha = new Set(known.entries.map((e) => e.sha256));
const repoMeta = new Map();
await pool([...new Set(fresh.slice(0, maxNew).map((f) => f.repo))], 6, async (repo) => {
  try { const m = await api(`/repos/${repo}`); if (m) repoMeta.set(repo, { description: m.description || null, stars: m.stargazers_count ?? null, license: m.license?.spdx_id || "-" }); } catch {}
});
let added = 0;
const tmp = mkdtempSync(join(tmpdir(), "fm1-refresh-"));
let ok = 0, bad = 0, attested = 0;
await pool(fresh.slice(0, maxNew), 6, async (f) => {
  if (f.size > 20e6) { bad++; return; }
  let bytes;
  try {
    const r = await fetch(`https://github.com/${f.repo}/releases/download/${encodeURIComponent(f.tag)}/${encodeURIComponent(f.asset)}`, { redirect: "follow" });
    if (!r.ok) throw new Error(r.status);
    bytes = new Uint8Array(await r.arrayBuffer());
  } catch { bad++; return; }
  if (createHash("sha256").update(bytes).digest("hex") !== f.sha) { bad++; return; }
  const { report, app } = analyze(bytes);
  const rec = { report: slim(report) };
  if (app) {
    const b = signature(shingleHashes(app), isStop), t = signature(stringTokens(strings(app, 6)), isStopS);
    rec.fp = { sig: sigToB64(b.sig), ownCode: b.used, ssig: sigToB64(t.sig), ownStrings: t.used };
  }
  // attestation: look it up, verify cryptographically if gh is available
  let att = null;
  try {
    const at = await api(`/repos/${f.repo}/attestations/sha256:${f.sha}`);
    if (at?.attestations?.length) {
      att = { verified: false, workflow: null, ref: null, commit: null };
      try { const wf = JSON.parse(Buffer.from(at.attestations[0].bundle.dsseEnvelope.payload, "base64").toString()).predicate?.buildDefinition?.externalParameters?.workflow; att.workflow = wf?.path || null; att.ref = wf?.ref || null; } catch {}
      const file = join(tmp, f.sha + ".fwsc"); writeFileSync(file, bytes);
      try {
        const { stdout } = await run("gh", ["attestation", "verify", file, "--repo", f.repo, "--format", "json"], { maxBuffer: 32 << 20 });
        const v = JSON.parse(stdout);
        if (Array.isArray(v) && v.length) { att.verified = true; att.commit = v[0]?.verificationResult?.statement?.predicate?.buildDefinition?.resolvedDependencies?.[0]?.digest?.gitCommit || null; attested++; }
      } catch {}
    }
  } catch {}
  writeFileSync(join(relDir, f.sha + ".json"), JSON.stringify(rec));
  if (rec.fp && !knownSha.has(f.sha)) {
    const m = repoMeta.get(f.repo) || {};
    known.entries.push({
      sha256: f.sha, file: f.asset, repo: f.repo, category: "discovered", official: false, vendoredCopy: false, tag: f.tag,
      description: m.description ?? null, stars: m.stars ?? null, license: m.license ?? null,
      identity: report.identity, model: report.model, verdict: report.verdict, flash: report.flash,
      internet: report.network?.internetCapable ?? null, hosts: (report.network?.unusualHosts || []).slice(0, 12), usb: report.usb,
      appSize: report.package.appSize, ownCode: rec.fp.ownCode, sig: rec.fp.sig, ownStrings: rec.fp.ownStrings, ssig: rec.fp.ssig,
      provenance: null,
    });
    knownSha.add(f.sha); added++;
  }
  releases[f.sha] = { repo: f.repo, tag: f.tag, asset: f.asset, published: f.published, prerelease: f.prerelease, url: f.url,
    tier: att?.verified ? "attested" : f.ci ? "ci" : "release",
    a: { verdict: report.verdict, model: report.model, flash: report.flash, internet: report.network?.internetCapable ?? null, usb: report.usb },
    attested: att };
  ok++;
});
rmSync(tmp, { recursive: true, force: true });

relDoc.generated = new Date().toISOString().slice(0, 10);
relDoc.count = Object.keys(releases).length;
writeFileSync(relPath, JSON.stringify(relDoc));
writeFileSync(reposPath, JSON.stringify([...repos].sort((a, b) => a.localeCompare(b)), null, 1));
if (added) {
  known.entries.sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1) || a.file.localeCompare(b.file));
  known.count = known.entries.length; known.generated = relDoc.generated;
  writeFileSync(knownPath, JSON.stringify(known));
}
console.log(`analysed ${ok} new files (${attested} attestations verified), ${bad} skipped; ${added} added to known.json; index now ${relDoc.count} release files, ${known.entries.length} known firmware records`);
