#!/usr/bin/env python3
"""Serve site/ on 127.0.0.1 only, with the same strict security headers the published page uses.
    python3 -I tools/serve.py [port]      ->  http://127.0.0.1:8737/

Also serves the release relay API locally (same rules as relay/worker.js):
    GET /relay/gh/<owner>/<repo>/releases/download/<tag>/<file>.fwsc
"""
import http.server, functools, pathlib, sys, re, urllib.request, urllib.parse

SITE = pathlib.Path(__file__).resolve().parent.parent / "site"
CSP = ("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://api.github.com https://raw.githubusercontent.com; "
       "font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
PART = re.compile(r"^[A-Za-z0-9._-]{1,100}$")
TAG = re.compile(r"^[A-Za-z0-9._+@-]{1,128}$")
FILE = re.compile(r"^[A-Za-z0-9._+-]{1,160}\.fwsc$", re.I)
HOSTS = {"github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"}
MAX = 20 * 1024 * 1024


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json"}

    def end_headers(self):
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        if self.path.startswith("/relay/"):
            return self.relay()
        return super().do_GET()

    def fail(self, code, msg):
        body = msg.encode()
        self.send_response(code); self.send_header("Content-Type", "text/plain"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def relay(self):
        p = [urllib.parse.unquote(x) for x in urllib.parse.urlsplit(self.path).path.split("/")[2:]]
        if not (len(p) == 7 and p[0] == "gh" and p[3] == "releases" and p[4] == "download"
                and PART.match(p[1]) and PART.match(p[2]) and TAG.match(p[5]) and FILE.match(p[6])):
            return self.fail(400, "not a GitHub release .fwsc path")
        url = f"https://github.com/{p[1]}/{p[2]}/releases/download/{urllib.parse.quote(p[5], safe='')}/{urllib.parse.quote(p[6], safe='')}"
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "fm1-inspect-relay"}), timeout=60) as r:
                if urllib.parse.urlsplit(r.geturl()).hostname not in HOSTS:
                    return self.fail(502, "unexpected upstream")
                data = r.read(MAX + 1)
        except urllib.error.HTTPError as e:
            return self.fail(404 if e.code == 404 else 502, f"GitHub answered {e.code}")
        except Exception:
            return self.fail(502, "couldn't reach GitHub")
        if len(data) > MAX:
            return self.fail(413, "file too large")
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream"); self.send_header("Content-Length", str(len(data)))
        self.end_headers(); self.wfile.write(data)

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8737
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Handler, directory=str(SITE)))
    print(f"FM-1 Inspect: http://127.0.0.1:{port}/  (Ctrl-C to stop)")
    srv.serve_forever()
