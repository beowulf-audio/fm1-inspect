// config.js — deployment settings.
// RELAY_URL: the release relay (relay/worker.js). Leave "" to disable: release files outside the index then get a
// download link instead. Locally, tools/serve.py provides the same relay at /relay on the page's own origin.
// When you set a production URL, also add its origin to connect-src in index.html's Content-Security-Policy.
const PRODUCTION_RELAY_URL = "";

const local = ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);
export const RELAY_URL = local ? `${location.origin}/relay` : PRODUCTION_RELAY_URL;
