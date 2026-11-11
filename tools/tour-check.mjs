#!/usr/bin/env node
// Which projects' tours need a look. A tour is written for one version of a firmware, and a newer version that moved
// its controls can leave it pressing the wrong things (ending on a menu, stuck on a notice). For each project with its
// own tour (tailored or the author's), data/tours/baseline.json holds the release the tour is known to work on (the one
// it was written for, then each newer one that showed as much) and what its preview showed (fm1-lab's preview stats:
// distinct screens, the share of the time with sound, sounds started). The latest release's preview through the same
// tour is compared with it:
//   - as much: the latest release becomes the baseline
//   - clearly less: it goes on data/tours/review.json, and the job's log gets a warning; the baseline stays
//   - a changed tour (rewritten): its latest release becomes the baseline
// Nothing else is changed: the preview stays; a person (or a new tour) decides.
//   node tools/tour-check.mjs [--quiet]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p, d) => (existsSync(join(ROOT, p)) ? JSON.parse(readFileSync(join(ROOT, p), "utf8")) : d);

/** Why `now` shows clearly less than `before` (preview stats), or null. */
export function worse(now, before) {
  const why = [];
  if (before.looks >= 3 && now.looks < Math.max(2, before.looks * 0.5)) why.push(`screens ${before.looks} → ${now.looks}`);
  if (before.soundShare >= 0.3 && now.soundShare < before.soundShare - 0.25) why.push(`sound ${Math.round(before.soundShare * 100)}% → ${Math.round(now.soundShare * 100)}% of the time`);
  if (before.onsets >= 8 && now.onsets < before.onsets * 0.4) why.push(`sounds started ${before.onsets} → ${now.onsets}`);
  return why.length ? why.join(", ") : null;
}

/** A release file's name without its version or build: "Araminta-e86b396.fwsc" and "Araminta-1f0c2aa.fwsc" are the same
 *  firmware in two releases, as are "sloop-2.8.5.fwsc" and "sloop-2.9.0.fwsc". */
export const stem = (asset) => String(asset).toLowerCase().replace(/\.fwsc$/, "")
  .replace(/[-_.]?v?\d+(\.\d+)+([-.]?(beta|rc|alpha)\.?\d*)?/g, "").replace(/[-_.][0-9a-f]{7,40}\b/g, "").replace(/[-_.]+$/, "");

/** {baseline, review}: the new baselines and the review list [{repo, tag, asset, baseline, source, why, now, before}]. */
export function check(releases, lab, baseline = {}) {
  const byRepo = new Map();
  for (const [sha, r] of Object.entries(releases)) {
    const t = lab[sha]?.tour;
    if (!t?.stats || t.source === "generic" || (r.a?.model || "FM-1") !== "FM-1") continue;
    if (!byRepo.has(r.repo)) byRepo.set(r.repo, []);
    byRepo.get(r.repo).push({ sha, tag: r.tag, asset: r.asset, published: r.published || "", hash: t.hash, source: t.source, stats: t.stats });
  }
  const next = {}, review = [];
  for (const [repo, list] of byRepo) {
    list.sort((a, b) => b.published.localeCompare(a.published));
    const latest = list.filter((x) => x.tag === list[0].tag), base = baseline[repo];
    const keep = (x) => ({ tag: x.tag, asset: x.asset, sha: x.sha, hash: x.hash, stats: x.stats });
    if (!base || base.hash !== latest[0].hash) { next[repo] = keep(latest[0]); continue; }   // new, or the tour changed
    if (base.tag === latest[0].tag) { next[repo] = base; continue; }
    // the same firmware: the file with the same name (less its version), or the only one; a collection's other files aren't compared
    const n = latest.find((x) => x.asset === base.asset) || latest.find((x) => stem(x.asset) === stem(base.asset)) || (latest.length === 1 ? latest[0] : null);
    if (!n) { next[repo] = base; continue; }
    const why = worse(n.stats, base.stats);
    if (why) { next[repo] = base; review.push({ repo, tag: n.tag, asset: n.asset, baseline: base.tag, source: n.source, why, now: n.stats, before: base.stats }); }
    else next[repo] = keep(n);
  }
  return { baseline: next, review: review.sort((a, b) => a.repo.localeCompare(b.repo)) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { baseline, review } = check(read("site/data/releases.json").releases, read("site/data/lab.json").results, read("data/tours/baseline.json", {}));
  writeFileSync(join(ROOT, "data", "tours", "baseline.json"), JSON.stringify(Object.fromEntries(Object.entries(baseline).sort()), null, 1) + "\n");
  writeFileSync(join(ROOT, "data", "tours", "review.json"), JSON.stringify({ review }, null, 1) + "\n");
  for (const x of review) console.log(`${process.env.GITHUB_ACTIONS ? "::warning title=Tour needs a look::" : "tour needs a look: "}${x.repo} ${x.tag} (${x.source} tour): ${x.why}, compared with ${x.baseline}`);
  if (!process.argv.includes("--quiet")) console.log(`tour check: ${Object.keys(baseline).length} projects with their own tour, ${review.length} to look at (data/tours/review.json)`);
}
