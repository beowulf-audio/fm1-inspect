# Release relay (Cloudflare Worker)

GitHub's release-download servers don't allow web pages to read release files (no CORS header). This worker fetches one public `.fwsc` release file from GitHub and returns it with that header, so the GitHub tab can check release files of **any** repo, not just the ones in the index.

- Only `GET /gh/<owner>/<repo>/releases/download/<tag>/<file>.fwsc`, built from validated parts: it is not an open proxy.
- Only for the page origins in `ALLOWED_ORIGINS`, at most 20 MB, no logging, no storage (Cloudflare caches the public file for a day).
- The page verifies every file against the SHA-256 GitHub publishes for it, so a broken or tampered relay can't substitute a different file.
- The relay sees which public release file was requested and the visitor's IP; it never sees anyone's own files.

## Deploy (free tier: 100,000 requests/day)

```sh
cd relay
# set ALLOWED_ORIGINS in wrangler.toml to your Pages origin, https://beowulf-audio.github.io
npx wrangler login
npx wrangler deploy        # prints https://fm1-inspect-relay.<your-subdomain>.workers.dev
```

Then put that URL in `site/js/config.js` (`RELAY_URL`) and add it to `connect-src` in `site/index.html`'s Content-Security-Policy.

Locally, `tools/serve.py` serves the same API at `/relay/gh/...`, so no deploy is needed to develop.
