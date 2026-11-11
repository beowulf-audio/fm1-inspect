#!/usr/bin/env node
// Project descriptions (site/data/about/OWNER__REPO.json: a summary and main features, written from the project's
// README) can go out of date when the project changes. Each one keeps a fingerprint of the README it was written from
// (its SHA-256, length and section headings); this fetches each project's current README (anonymously, from GitHub)
// and lists the ones that changed a lot (sections added or removed, or about a third longer or shorter) in
// data/about-review.json, with a warning in the job's log. Small edits (a typo, a version number) aren't listed.
//   node tools/about-check.mjs           check every description
//   node tools/about-check.mjs --stamp   record the current README's fingerprint where a description has none (after
//                                        writing descriptions)
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "site", "data", "about");

/** A README's fingerprint: what a description depends on. */
export function fingerprint(text) {
  const t = String(text).replace(/\r\n/g, "\n");
  const headings = [...t.matchAll(/^#{1,3}\s+(.+?)\s*#*\s*$/gm)].map((m) => m[1].replace(/[`*_[\]()]/g, "").trim().toLowerCase()).filter(Boolean);
  return { sha: createHash("sha256").update(t).digest("hex").slice(0, 16), length: t.length, headings };
}

/** Why the README changed enough to look at the description again, or null. */
export function changed(now, then) {
  if (now.sha === then.sha) return null;
  const why = [], a = new Set(then.headings), b = new Set(now.headings);
  const added = now.headings.filter((x) => !a.has(x)), removed = then.headings.filter((x) => !b.has(x));
  if (added.length) why.push(`sections added: ${added.slice(0, 4).join(", ")}${added.length > 4 ? "…" : ""}`);
  if (removed.length) why.push(`sections removed: ${removed.slice(0, 4).join(", ")}${removed.length > 4 ? "…" : ""}`);
  const r = now.length / Math.max(1, then.length);
  if (r > 1.33 || r < 0.75) why.push(`${r > 1 ? "longer" : "shorter"} (${then.length} → ${now.length} characters)`);
  return why.length ? why.join("; ") : null;
}

async function readme(repo) {
  for (const name of ["README.md", "readme.md", "Readme.md", "README.markdown", "README"]) {
    try {
      const r = await fetch(`https://raw.githubusercontent.com/${repo}/HEAD/${name}`, { headers: { "user-agent": "fm1-inspect" } });
      if (r.ok) return await r.text();
    } catch {}
  }
  return null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const stamp = process.argv.includes("--stamp"), review = [];
  const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => /^[\w.-]+__[\w.-]+\.json$/.test(f)) : [];
  for (const f of files) {
    const p = join(DIR, f), a = JSON.parse(readFileSync(p, "utf8")), repo = f.replace(/\.json$/, "").replace("__", "/");
    if (stamp ? a.readme : !a.readme) continue;
    const text = await readme(repo);
    if (text == null) { console.log(`  ${repo}: no README found`); continue; }
    const fp = fingerprint(text);
    if (stamp) { a.readme = fp; writeFileSync(p, JSON.stringify(a, null, 1) + "\n"); continue; }
    const why = changed(fp, a.readme);
    if (why) review.push({ repo, why });
  }
  if (!stamp) {
    writeFileSync(join(ROOT, "data", "about-review.json"), JSON.stringify({ review }, null, 1) + "\n");
    for (const x of review) console.log(`${process.env.GITHUB_ACTIONS ? "::warning title=Description needs a look::" : "description needs a look: "}${x.repo}: its README changed (${x.why})`);
  }
  console.log(`descriptions: ${files.length}${stamp ? " (fingerprints recorded where missing)" : `, ${review.length} to look at (data/about-review.json)`}`);
}
