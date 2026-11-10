# FM-1 Inspect

Check an M-VAVE FM-1 (or SMK-37) firmware file **before** you install it. Drop a `.fwsc` on the page and it tells you:

- **What it is:** matched against an index of known community and official firmware, by exact checksum and by code fingerprint, so renamed files and forks are still placed. It also lists the closest related projects.
- **Where it came from:** whether this exact file is on the project's GitHub release, was built by its public CI, or carries a **signed build attestation** (verified with `gh attestation verify` when the index is built).
- **Brick risk:** whether it recognises the UC25HQ80 flash chip in newer FM-1 units. Firmware that only knows the original Puya chip has kept saves in RAM only and refused later installs on those units.
- **Safety:** networking code and the servers it names, hard-coded IP addresses, and whether it can pose to a computer as a USB keyboard, mouse or drive.

Everything runs in the browser and files are never uploaded. The page's Content-Security-Policy allows it to contact only its own host, plus GitHub (`api.github.com`, `raw.githubusercontent.com`) when you use the GitHub tab.

### GitHub repo tab

Enter `owner/repo` (or a github.com link) to check a project without downloading anything yourself:

- **Releases:** every `.fwsc` file with GitHub's published SHA-256, who uploaded it (CI or by hand), and signed build attestations. Files already in the index get their verdict. GitHub's release CDN doesn't allow browser downloads, so new files get a download link to drop into the Files tab.
- **Firmware committed in the repo:** fetched and fully checked.
- **Source check:** the project's own C/C++ (SDK and third-party folders skipped) scanned for flash-chip support, networking code and servers, hard-coded IPs, and USB keyboard/mouse descriptors.

It uses GitHub's anonymous API (60 requests per hour per visitor; a lookup takes about 3 to 9).

## Layout

```
site/                 the static site (GitHub Pages serves this folder)
  index.html, css/, js/
    js/fwsc.js         .fwsc decoder (UFW header, JLFS directory, chip-key descrambling)
    js/analyze.js      static checks on the decrypted code
    js/fingerprint.js  MinHash fingerprints of code bytes and strings, Bloom stop-list
    js/match.js        identification and closest-relative search
    js/app.js          the page (all firmware-derived text goes through textContent)
    js/gh.js           GitHub repo tab
    js/ui.js           shared DOM helpers
  data/                generated index (known.json, releases.json, stoplist.json)
  vendor/              self-hosted UI assets, no CDN: Inter + JetBrains Mono (OFL), Open Props easings (MIT)
  img/icons.svg        Lucide icon sprite (ISC)
tools/
  build-data.mjs       builds site/data from a folder of downloaded firmware repos
  provenance.mjs       collects release checksums, uploaders and attestations via `gh`
  analyze-releases.mjs downloads every known release file once and records its checks (for GitHub-tab verdicts)
  serve.py             local server on 127.0.0.1 with the same security headers
tests/run.mjs          robustness + known-verdict tests
```

## Run locally

```sh
python3 -I tools/serve.py          # http://127.0.0.1:8737/
node tests/run.mjs [corpus-dir]    # tests
```

## Rebuild the index

The index is built from a corpus of downloaded firmware repos (each with `_SOURCE.txt` naming its GitHub repo, and `_release_assets/` holding release files):

```sh
node tools/provenance.mjs <corpus>              # ~5 min, read-only GitHub API calls + attestation checks
node tools/analyze-releases.mjs <download-dir>   # ~1 GB, verified against GitHub's digests
node tools/build-data.mjs <corpus> --provenance tools/.cache/provenance.json
```

Neither script builds or runs anything from the corpus; they only read files.

## Limits

These are static checks. They catch the common, known problems, not every possible one. "Not a release we know of" doesn't make a file bad: it may be newer than the index or a private build. When in doubt, read the project's source and notes, and back up your FM-1 first.

## Credits

The package format follows the notes in [fm1-emu](https://github.com/joakimeriksson/fm1-emu) (Joakim Eriksson, MIT) and Felucca's installer documentation. Not affiliated with M-VAVE.

## Licence

MIT
