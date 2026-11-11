#!/usr/bin/env node
// Tests: robustness on garbage input, deterministic fingerprints, and (if a corpus is given) known verdicts.
//   node tests/run.mjs [corpus-dir]
import { readFileSync, existsSync } from "node:fs";
import { analyze } from "../site/js/analyze.js";
import { parsePackage, identityOf } from "../site/js/fwsc.js";
import { shingleHashes, signature, similarity } from "../site/js/fingerprint.js";
import { applyBrick, brickNote } from "../site/js/brick.js";

let fail = 0, pass = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log("FAIL:", msg); } };

// 1. never throws on hostile/garbage input
for (const n of [0, 10, 960, 4096, 200000]) {
  const junk = new Uint8Array(n); for (let i = 0; i < n; i++) junk[i] = (i * 2654435761) >>> 24;
  let r; try { r = analyze(junk).report; } catch (e) { r = null; }
  ok(r && (r.verdict === "invalid" || r.verdict === "other"), `garbage input of ${n} bytes handled`);
}
ok(identityOf(new Uint8Array(0)) === "", "identity of empty input");
ok(parsePackage(new Uint8Array(100)).ok === false, "short input rejected");

// 2. fingerprints are deterministic and self-similar
const code = new Uint8Array(50000); for (let i = 0; i < code.length; i++) code[i] = (i * 40503 ^ (i >> 3)) & 0xff;
const a = signature(shingleHashes(code)).sig, b = signature(shingleHashes(code)).sig;
ok(similarity(a, b) === 1, "same code -> similarity 1");
const other = code.slice(); for (let i = 0; i < other.length; i += 2) other[i] ^= 0x5a;
ok(similarity(a, signature(shingleHashes(other)).sig) < 0.2, "different code -> low similarity");

// 2b. an emulated flash-chip test over what the code alone says (site/js/brick.js)
{
  const rep = () => ({ verdict: "caution", findings: [{ level: "warn", area: "flash", text: "Checks for the original Puya flash chip only." }, { level: "ok", area: "usb", text: "No HID." }] });
  const pass = applyBrick(rep(), { v: "pass", r: "same use" });
  ok(pass.verdict === "ok", "brick pass clears a flash-only caution");
  ok(pass.findings[0].tested && pass.findings[0].level === "ok", "the tested finding comes first");
  ok(pass.findings[1].level === "info" && pass.findings[1].text.startsWith("From the code alone:"), "the code-only finding stays, as a note");
  const fail = applyBrick(rep(), { v: "fail", r: "never saves" });
  ok(fail.verdict === "caution" && fail.findings[0].level === "warn", "brick fail is a caution (not yet confirmed on a real unit)");
  ok(/Not yet confirmed on a real unit/.test(fail.findings[0].text), "a fail says what is not confirmed");
  const twice = applyBrick(applyBrick(rep(), { v: "pass" }), { v: "fail" });
  ok(twice.findings.filter((f) => f.tested).length === 1 && twice.verdict === "caution", "applied again: the newer result replaces the earlier");
  ok(twice.findings.filter((f) => /^From the code alone: From/.test(f.text)).length === 0, "the code-only note isn't prefixed twice");
  const inc = applyBrick(rep(), { v: "inconclusive" });
  ok(inc.verdict === "caution" && inc.findings[1].level === "warn", "inconclusive keeps the code-only warning");
  const other = applyBrick({ verdict: "invalid", findings: [] }, { v: "fail" });
  ok(other.verdict === "invalid", "an invalid file stays invalid");
  ok(applyBrick(rep(), null).verdict === "caution" && brickNote(null) === "", "no result: nothing changes");
  ok(/works with the newer/.test(brickNote({ v: "pass" })) && /didn't save with the newer flash chip \(emulated test\)/.test(brickNote({ v: "fail" })), "badge notes");
  ok(/Units with the original chip aren't affected/.test(applyBrick(rep(), { v: "fail" }).findings[0].text), "a fail says who is affected");
}

// 3. real files (optional corpus)
const corpus = process.argv[2];
if (corpus && existsSync(corpus)) {
  const E = (p) => `${corpus}/examples/${p}`;
  const cases = [
    ["02_grooveboxes/sloop-fm1/_release_assets/sloop-2.8.5.fwsc", "ok", true],
    ["01_platforms_templates/Felucca/_release_assets/felucca-1.7.0.fwsc", "caution", false],
    ["01_platforms_templates/dinghy/_release_assets/dinghy-0.5.fwsc", "ok", true],
    ["11_games_emulators_onboard/fm1-boardwalk/base/web/m-bootloader/fm1-uboot-1.2.fwsc", "other", null],
  ];
  for (const [p, verdict, uc25] of cases) {
    if (!existsSync(E(p))) { console.log("skip (missing):", p); continue; }
    const r = analyze(new Uint8Array(readFileSync(E(p)))).report;
    ok(r.verdict === verdict, `${p.split("/").pop()}: verdict ${r.verdict}, expected ${verdict}`);
    if (uc25 !== null) ok(r.flash.uc25Constant === uc25, `${p.split("/").pop()}: UC25HQ80 support ${r.flash.uc25Constant}, expected ${uc25}`);
    if (r.usb) ok(!r.usb.hidKeyboard, `${p.split("/").pop()}: no keyboard descriptor`);
  }
} else console.log("(no corpus given: skipping real-file tests)");

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
