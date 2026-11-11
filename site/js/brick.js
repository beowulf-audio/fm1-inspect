// brick.js — what an emulated FM-1 showed about a firmware and the newer UC25HQ80 flash chip (fm1-lab brick-test:
// the same firmware booted twice, with the original Puya chip and with the UC25HQ80, its flash use compared), over
// what the code alone suggests (analyze.js: which chip IDs are in it). data/brick.json: SHA-256 -> {v, r} (verdict,
// reason) and the fm1-lab commit that tested them.

const TESTED = "Tested on an emulated FM-1 with the newer UC25HQ80 flash chip";
const TEXT = {
  pass: { level: "ok", text: `${TESTED}: it uses its flash the same way as on the original chip, so settings save and later installs work on newer FM-1 units.` },
  fail: { level: "bad", text: `${TESTED}: it stops using its flash there (on the original chip it saves). On newer FM-1 units its settings would be lost at power-off and later installs refused, which then needs a USB download-mode rescue. Check the project for a newer release.` },
  warn: { level: "warn", text: `${TESTED}: it uses its flash much less there than on the original chip. It may not save everything on newer FM-1 units; check the project's notes.` },
  inconclusive: { level: "info", text: `${TESTED}: no conclusion (it did not use its flash during the test).` },
  error: { level: "info", text: `${TESTED}: the emulator could not run it, so no conclusion.` },
};

/** Put a brick-test result into a report (once): the tested finding first, the code-only flash findings as notes. */
export function applyBrick(rep, b) {
  if (!rep || !b || !TEXT[b.v] || !Array.isArray(rep.findings) || rep.findings.some((f) => f.tested)) return rep;
  const t = TEXT[b.v];
  const rest = rep.findings.map((f) => (f.area === "flash" && b.v !== "inconclusive" && b.v !== "error"
    ? { ...f, level: "info", text: `From the code alone: ${f.text}` } : f));
  rep.findings = [{ level: t.level, area: "flash", text: t.text, tested: true }, ...rest];
  rep.brick = { verdict: b.v, reason: b.r || "" };
  if (["ok", "caution", "risk"].includes(rep.verdict)) {
    const lv = rep.findings.map((f) => f.level);
    rep.verdict = lv.includes("bad") ? "risk" : lv.includes("warn") ? "caution" : "ok";
  }
  return rep;
}

/** A short note for a verdict badge. */
export function brickNote(b) {
  return !b ? "" : b.v === "pass" ? " · works on newer FM-1s (tested)" : b.v === "fail" ? " · breaks on newer FM-1s (tested)" : b.v === "warn" ? " · may not save on newer FM-1s" : "";
}
