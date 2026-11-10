#!/usr/bin/env node
// Collect build provenance for every firmware file published on GitHub releases of the corpus' projects.
//   node tools/provenance.mjs <corpus-dir> [out=tools/.cache/provenance.json]
// Uses the `gh` CLI (read-only API calls + `gh attestation verify`). Nothing is built or run.
//
// Tiers, strongest first:
//   attested : a signed GitHub build attestation for this exact file, verified with `gh attestation verify`
//   ci       : the release file was uploaded by GitHub Actions (built in the project's public CI)
//   release  : the file matches a release asset the author uploaded by hand
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
const run = promisify(execFile);

const corpus = process.argv[2];
const out = process.argv[3] || join(dirname(new URL(import.meta.url).pathname), ".cache", "provenance.json");
if (!corpus) { console.error("usage: provenance.mjs <corpus-dir> [out.json]"); process.exit(2); }
mkdirSync(dirname(out), { recursive: true });

// projects = top-level downloaded repos (have _SOURCE.txt); local .fwsc files by sha for attestation verify
const projects = new Set(), localBySha = new Map();
(function walk(d, depth) {
  for (const n of readdirSync(d)) {
    if (n === "node_modules" || n === ".git" || n === "fm1-inspect") continue;
    const p = join(d, n); let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, depth + 1);
    else if (n === "_SOURCE.txt" && depth <= 3) projects.add(readFileSync(p, "utf8").split("\n")[0].replace("https://github.com/", "").trim());
    else if (/\.fwsc$/i.test(n) && st.size < 20e6) {
      const sha = createHash("sha256").update(readFileSync(p)).digest("hex");
      if (!localBySha.has(sha)) localBySha.set(sha, p);
    }
  }
})(corpus, 0);
console.log(`${projects.size} projects, ${localBySha.size} distinct local .fwsc files`);

async function gh(args) {
  try { const { stdout } = await run("gh", args, { maxBuffer: 64 << 20 }); return JSON.parse(stdout); }
  catch (e) { return null; }
}
async function pool(items, n, fn) {
  const res = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; res[k] = await fn(items[k]); } }));
  return res;
}

// 1. every .fwsc asset of every release (up to 100 per project)
const prov = {};
let nAssets = 0;
await pool([...projects], 6, async (repo) => {
  const rels = await gh(["api", `repos/${repo}/releases?per_page=100`]);
  if (!Array.isArray(rels)) return;
  for (const r of rels) for (const a of r.assets || []) {
    if (!/\.fwsc$/i.test(a.name) || !a.digest?.startsWith("sha256:")) continue;
    const sha = a.digest.slice(7); nAssets++;
    if (prov[sha] && prov[sha].tier !== "release") continue;
    const ci = a.uploader?.type === "Bot" && /github-actions/.test(a.uploader?.login || "");
    prov[sha] = { tier: ci ? "ci" : "release", repo, tag: r.tag_name, asset: a.name, published: (r.published_at || "").slice(0, 10),
                  prerelease: !!r.prerelease, url: r.html_url, uploader: a.uploader?.login || null };
  }
});
console.log(`${nAssets} release .fwsc assets found, ${Object.keys(prov).length} distinct`);

// 2. attestations for those files; cryptographically verify the ones we have locally
const shas = Object.keys(prov);
let nAtt = 0, nVer = 0;
await pool(shas, 6, async (sha) => {
  const p = prov[sha];
  const a = await gh(["api", `repos/${p.repo}/attestations/sha256:${sha}`]);
  if (!a?.attestations?.length) return;
  nAtt++;
  let wf = null;
  try { wf = JSON.parse(Buffer.from(a.attestations[0].bundle.dsseEnvelope.payload, "base64").toString()).predicate?.buildDefinition?.externalParameters?.workflow; } catch {}
  p.attestation = { count: a.attestations.length, workflow: wf?.path || null, ref: wf?.ref || null, verified: false };
  const local = localBySha.get(sha);
  if (local) {
    const v = await gh(["attestation", "verify", local, "--repo", p.repo, "--format", "json"]);
    if (Array.isArray(v) && v.length) {
      const st = v[0]?.verificationResult?.statement;
      const commit = st?.predicate?.buildDefinition?.resolvedDependencies?.[0]?.digest?.gitCommit || null;
      p.attestation.verified = true; p.attestation.commit = commit; p.tier = "attested"; nVer++;
    }
  }
});
console.log(`${nAtt} files have attestations, ${nVer} verified cryptographically against local copies`);

const counts = {}; for (const p of Object.values(prov)) counts[p.tier] = (counts[p.tier] || 0) + 1;
console.log("tiers:", counts);
writeFileSync(out, JSON.stringify(prov, null, 1));
console.log("wrote", out);
