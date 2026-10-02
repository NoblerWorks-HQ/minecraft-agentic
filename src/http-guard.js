// Request guard for the web panel (scripts/web.js). The panel spends the user's model key,
// so a POST must come from the panel's own page:
//   - Origin, when the browser sends one, must be the same host:port the request was sent to
//     (blocks a cross-site text/plain form POST - a CORS "simple request" needs no preflight);
//   - the Host must be loopback unless the operator deliberately bound the panel elsewhere
//     (blocks DNS rebinding against the default 127.0.0.1 bind).
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLoopbackBind(bind) {
  return LOOPBACK.has(String(bind || '').toLowerCase());
}

export function isAllowedRequest({ origin, host, bind = '127.0.0.1' }) {
  if (!host) return false;
  let hostname;
  try { hostname = new URL(`http://${host}`).hostname.toLowerCase(); } catch { return false; }
  if (isLoopbackBind(bind) && !LOOPBACK.has(hostname)) return false;
  if (!origin) return true;
  try {
    const o = new URL(origin);
    return (o.protocol === 'http:' || o.protocol === 'https:') && o.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;   // includes the literal "null" origin (sandboxed iframes, file://)
  }
}

export function isJsonContentType(contentType) {
  return /^application\/json\b/i.test(String(contentType || '').trim());
}
