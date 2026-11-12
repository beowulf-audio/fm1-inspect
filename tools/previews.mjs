#!/usr/bin/env node
// One preview per project: its tour (the author's, one written here, or fm1-lab's generic one) on one release file,
// the screen as a GIF and the sound, shown on the project's card with the version it is of. site/data/previews.json
// says which file that is; every other release keeps its flash test and screenshot, without a preview.
//
// When a project has a newer release, the daily job (tools/lab-update.mjs) plays the same tour on it, and this decides:
//   - it shows as much as the current preview: it becomes the preview, and the old one's files are removed
//   - it shows clearly less (fewer screens, much less sound; a version that moved its controls can leave a tour pressing
//     the wrong things): the current preview stays, the project goes on data/tours/review.json, and the job's log gets
//     a warning; a fixed tour makes it again
//   - the tour changed (rewritten), or the project uses the generic tour, or it was made with another resource region
//     (data/resources.json): the newer release becomes the preview
//   node tools/previews.mjs [--quiet]
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "site", "data");

/** Why `now` shows clearly less than `before` (fm1-lab's preview stats), or null. */
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

/** Newer first. Releases carry only the day they came out, so on the same day: a release before a pre-release, then the
 *  higher version ("v1.12.3" before "v1.12.2", "v1.4.0" before "v1.4.0-rc1"). */
const NUM = new Intl.Collator("en", { numeric: true });
export const newer = (a, b) => b.published.localeCompare(a.published) || (a.pre ? 1 : 0) - (b.pre ? 1 : 0) || NUM.compare(b.tag, a.tag);

/** Each project's FM-1 release files, newest release first: Map repo -> [{sha, tag, asset, published, pre}] */
export function byProject(releases) {
  const m = new Map();
  for (const [sha, r] of Object.entries(releases)) {
    if ((r.a?.model || "FM-1") !== "FM-1") continue;
    if (!m.has(r.repo)) m.set(r.repo, []);
    m.get(r.repo).push({ sha, tag: r.tag, asset: r.asset, published: r.published || "", pre: !!r.prerelease });
  }
  for (const list of m.values()) list.sort((a, b) => newer(a, b) || a.asset.localeCompare(b.asset));
  return m;
}

/** The file of a project's latest release to preview: the same firmware as the current preview (by name, less its
 *  version), else the release's only file, else its first by name. A collection's other firmwares aren't previewed. */
export function candidate(list, current) {
  const latest = list.filter((x) => x.tag === list[0].tag);
  if (current) {
    const same = latest.find((x) => x.asset === current.asset) || latest.find((x) => stem(x.asset) === stem(current.asset));
    if (same) return same;
  }
  return latest.length === 1 ? latest[0] : [...latest].sort((a, b) => a.asset.localeCompare(b.asset))[0];
}

/** The decision. lab: SHA -> lab.json entry (tour: {source, hash, stats}, gif, audio); previews: repo -> current preview.
 *  Returns {previews, review}. */
export function decide(releases, lab, previews = {}) {
  const next = {}, review = [];
  for (const [repo, list] of byProject(releases)) {
    const cur = previews[repo] && lab[previews[repo].sha]?.gif ? previews[repo] : null;
    const c = candidate(list, cur), e = lab[c.sha], t = e?.tour;
    const entry = () => ({ sha: c.sha, tag: c.tag, asset: c.asset, source: t.source, hash: t.hash, ...(t.resources ? { resources: t.resources } : {}), stats: t.stats, at: e.at || null });
    if (!(e?.gif && t?.stats)) { if (cur) next[repo] = cur; continue; }          // the latest has no preview (yet): keep the current one
    // compared only with the same firmware through the same tour: a renamed file, or a collection's other firmware, just
    // becomes the preview
    if (!cur || cur.sha === c.sha || cur.hash !== t.hash || (cur.resources || null) !== (t.resources || null) || t.source === "generic" || stem(c.asset) !== stem(cur.asset)) { next[repo] = entry(); continue; }
    const why = worse(t.stats, cur.stats);
    if (why) { next[repo] = cur; review.push({ repo, tag: c.tag, asset: c.asset, sha: c.sha, hash: t.hash, ...(t.resources ? { resources: t.resources } : {}), previewing: cur.tag, source: t.source, why, now: t.stats, before: cur.stats }); }
    else next[repo] = entry();
  }
  return { previews: next, review: review.sort((a, b) => a.repo.localeCompare(b.repo)) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const read = (p, d) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : d);
  const labFile = join(DATA, "lab.json"), prevFile = join(DATA, "previews.json");
  const lab = read(labFile, { results: {} });
  const { previews, review } = decide(read(join(DATA, "releases.json"), { releases: {} }).releases, lab.results, read(prevFile, {}).previews || {});
  // the rest of the preview files go: one preview per project
  const keep = new Set(Object.values(previews).map((p) => p.sha));
  let removed = 0;
  for (const [sha, e] of Object.entries(lab.results)) {
    if (keep.has(sha) || (!e.gif && !e.audio && !e.tour)) continue;
    for (const ext of ["gif", "m4a"]) rmSync(join(DATA, "shots", `${sha}.${ext}`), { force: true });
    delete e.gif; delete e.audio; delete e.tour; removed++;
  }
  writeFileSync(labFile, JSON.stringify(lab));
  writeFileSync(prevFile, JSON.stringify({ generated: new Date().toISOString().slice(0, 10), count: keep.size,
    previews: Object.fromEntries(Object.entries(previews).sort()) }));
  writeFileSync(join(ROOT, "data", "tours", "review.json"), JSON.stringify({ review }, null, 1) + "\n");
  for (const x of review) console.log(`${process.env.GITHUB_ACTIONS ? "::warning title=Tour needs a look::" : "tour needs a look: "}${x.repo} ${x.tag} (${x.source} tour): ${x.why}; still previewing ${x.previewing}`);
  if (!process.argv.includes("--quiet")) console.log(`previews: ${keep.size} projects · ${removed} older previews removed · ${review.length} tours to look at (data/tours/review.json)`);
}
