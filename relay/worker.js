// FM-1 Inspect release relay — a Cloudflare Worker.
//
// GitHub's release-download servers don't send CORS headers, so a web page can't read a release file. This worker
// fetches ONE public GitHub release file and returns it with the header the browser needs. That is all it does:
//   GET /gh/<owner>/<repo>/releases/download/<tag>/<file>.fwsc
// * only github.com release downloads of .fwsc files, built from validated parts (no arbitrary URLs: not an open proxy)
// * only GET, only from the allowed page origins, at most 20 MB
// * no logging, no storage beyond Cloudflare's shared cache of the public file
// The page also checks every file against the SHA-256 GitHub publishes before using it, so the relay need not be trusted.

const PART = /^[A-Za-z0-9._-]{1,100}$/;
const TAG = /^[A-Za-z0-9._+@-]{1,128}$/;
const FILE = /^[A-Za-z0-9._+-]{1,160}\.fwsc$/i;
const MAX = 20 * 1024 * 1024;

export default {
  async fetch(req, env) {
    const origins = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const origin = req.headers.get("Origin") || "";
    const allowed = origins.includes(origin);
    const cors = { "Access-Control-Allow-Origin": allowed ? origin : "null", "Vary": "Origin" };
    if (req.method === "OPTIONS") return new Response(null, { status: allowed ? 204 : 403, headers: { ...cors, "Access-Control-Allow-Methods": "GET" } });
    if (req.method !== "GET") return new Response("method not allowed", { status: 405, headers: cors });
    if (!allowed) return new Response("origin not allowed", { status: 403, headers: cors });

    const p = new URL(req.url).pathname.split("/").slice(1).map(decodeURIComponent);
    // gh / owner / repo / releases / download / tag / file
    if (p.length !== 7 || p[0] !== "gh" || p[3] !== "releases" || p[4] !== "download" ||
        !PART.test(p[1]) || !PART.test(p[2]) || !TAG.test(p[5]) || !FILE.test(p[6]))
      return new Response("not a GitHub release .fwsc path", { status: 400, headers: cors });
    const upstream = `https://github.com/${p[1]}/${p[2]}/releases/download/${encodeURIComponent(p[5])}/${encodeURIComponent(p[6])}`;

    const r = await fetch(upstream, { redirect: "follow", cf: { cacheEverything: true, cacheTtl: 86400 } });
    const finalHost = new URL(r.url).hostname;
    if (!["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"].includes(finalHost))
      return new Response("unexpected upstream", { status: 502, headers: cors });
    if (!r.ok) return new Response(`GitHub answered ${r.status}`, { status: r.status === 404 ? 404 : 502, headers: cors });
    const len = Number(r.headers.get("content-length") || 0);
    if (len > MAX) return new Response("file too large", { status: 413, headers: cors });
    const body = await r.arrayBuffer();
    if (body.byteLength > MAX) return new Response("file too large", { status: 413, headers: cors });
    return new Response(body, { status: 200, headers: { ...cors, "Content-Type": "application/octet-stream", "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" } });
  },
};
