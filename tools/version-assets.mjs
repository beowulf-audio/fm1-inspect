#!/usr/bin/env node
// At deploy: every local script, stylesheet and module import gets ?v=VERSION, so a browser that cached the previous
// deploy's files fetches the new ones (GitHub Pages lets browsers keep files for 10 minutes; the modules import each
// other, so tagging only the page's own script tags would not be enough). Rewrites SITE_DIR in place: run it on the
// deploy's checkout, not on the repository you work in.
//   node tools/version-assets.mjs SITE_DIR VERSION
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const [dir, version] = process.argv.slice(2);
if (!dir || !/^[0-9a-zA-Z._-]{4,40}$/.test(version || "")) { console.error("usage: node tools/version-assets.mjs SITE_DIR VERSION"); process.exit(64); }
const v = `?v=${version}`;
let n = 0;
const tag = (s, re) => s.replace(re, (m, a, path, b) => { n++; return `${a}${path}${v}${b}`; });

// the page: <link href="css/…"> <script src="js/…"> (local, relative paths only)
for (const f of readdirSync(dir).filter((x) => x.endsWith(".html"))) {
  let s = readFileSync(join(dir, f), "utf8");
  s = tag(s, /(<link[^>]+href=")((?:css|vendor)\/[^"?#]+\.css)(")/g);
  s = tag(s, /(<script[^>]+src=")(js\/[^"?#]+\.js)(")/g);
  writeFileSync(join(dir, f), s);
}
// the modules: import … from "./x.js", import("./x.js")
for (const f of readdirSync(join(dir, "js")).filter((x) => x.endsWith(".js"))) {
  let s = readFileSync(join(dir, "js", f), "utf8");
  s = tag(s, /(from\s+")(\.\/[^"?#]+\.js)(")/g);
  s = tag(s, /(import\(\s*")(\.\/[^"?#]+\.js)(")/g);
  writeFileSync(join(dir, "js", f), s);
}
console.log(`versioned ${n} references with ${v}`);
