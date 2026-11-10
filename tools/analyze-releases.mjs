#!/usr/bin/env node
// Download every release .fwsc listed in the provenance cache and run the static checks on it, so the site can
// show a verdict for any known release file from its checksum alone (e.g. in GitHub-repo mode).
//   node tools/analyze-releases.mjs <download-dir> [provenance.json] [out.json]
// Files are only read by our own decoder; nothing downloaded is executed. Each file is verified against the
// SHA-256 digest GitHub publishes for it before it is analysed.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { analyze } from "../site/js/analyze.js";

const here = dirname(new URL(import.meta.url).pathname);
const dl = process.argv[2];
const provPath = process.argv[3] || join(here, ".cache", "provenance.json");
const outPath = process.argv[4] || join(here, ".cache", "release-analysis.json");
if (!dl) { console.error("usage: analyze-releases.mjs <download-dir> [provenance.json] [out.json]"); process.exit(2); }
mkdirSync(dl, { recursive: true });
const prov = JSON.parse(readFileSync(provPath, "utf8"));
const out = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : {};

const todo = Object.entries(prov).filter(([sha]) => !out[sha]);
console.log(`${Object.keys(prov).length} release files, ${todo.length} still to analyse`);
let done = 0, failed = 0, mismatch = 0;

async function one([sha, p]) {
  const file = join(dl, sha + ".fwsc");
  let bytes;
  if (existsSync(file)) bytes = new Uint8Array(readFileSync(file));
  else {
    const url = `https://github.com/${p.repo}/releases/download/${encodeURIComponent(p.tag)}/${encodeURIComponent(p.asset)}`;
    try {
      const r = await fetch(url, { redirect: "follow" });
      if (!r.ok) throw new Error(r.status);
      bytes = new Uint8Array(await r.arrayBuffer());
    } catch { failed++; return; }
    if (bytes.length > 20e6) { failed++; return; }
    writeFileSync(file, bytes);
  }
  if (createHash("sha256").update(bytes).digest("hex") !== sha) { mismatch++; return; }
  const { report: r } = analyze(bytes);
  out[sha] = {
    verdict: r.verdict, model: r.model, identity: r.identity, size: r.size,
    flash: r.flash, internet: r.network?.internetCapable ?? null, hosts: r.network?.unusualHosts?.slice(0, 8) ?? [],
    usb: r.usb, findings: r.findings.map((f) => ({ level: f.level, area: f.area, text: f.text })),
  };
  if (++done % 100 === 0) { console.log(`  ${done} analysed`); writeFileSync(outPath, JSON.stringify(out)); }
}

const queue = [...todo];
await Promise.all(Array.from({ length: 8 }, async () => { while (queue.length) await one(queue.shift()); }));
writeFileSync(outPath, JSON.stringify(out));
const v = {}; for (const x of Object.values(out)) v[x.verdict] = (v[x.verdict] || 0) + 1;
console.log(`done: ${done} analysed, ${failed} failed to download, ${mismatch} checksum mismatches; verdicts`, v);
