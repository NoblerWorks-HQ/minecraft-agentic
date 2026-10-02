// The web panel's POST guard (src/http-guard.js). No server, no browser, no API key.
import { isAllowedRequest, isJsonContentType, isLoopbackBind } from '../src/http-guard.js';

let failed = 0;
function check(name, got, want) {
  if (got === want) console.log(`  ok   ${name}`);
  else { failed++; console.log(`  FAIL ${name}: got ${got}, want ${want}`); }
}

console.log('http-guard');
check('own page (localhost)', isAllowedRequest({ origin: 'http://localhost:8080', host: 'localhost:8080' }), true);
check('own page (127.0.0.1)', isAllowedRequest({ origin: 'http://127.0.0.1:8080', host: '127.0.0.1:8080' }), true);
check('no Origin (curl)', isAllowedRequest({ host: 'localhost:8080' }), true);
check('cross-site form POST', isAllowedRequest({ origin: 'https://evil.example', host: 'localhost:8080' }), false);
check('other local port', isAllowedRequest({ origin: 'http://localhost:3000', host: 'localhost:8080' }), false);
check('null origin', isAllowedRequest({ origin: 'null', host: 'localhost:8080' }), false);
check('DNS rebinding Host on loopback bind', isAllowedRequest({ origin: 'http://evil.example:8080', host: 'evil.example:8080' }), false);
check('LAN host when BIND=0.0.0.0', isAllowedRequest({ origin: 'http://192.168.1.5:8080', host: '192.168.1.5:8080', bind: '0.0.0.0' }), true);
check('missing Host', isAllowedRequest({ origin: 'http://localhost:8080' }), false);
check('json content-type', isJsonContentType('application/json; charset=utf-8'), true);
check('text/plain rejected', isJsonContentType('text/plain'), false);
check('missing content-type rejected', isJsonContentType(undefined), false);
check('127.0.0.1 is loopback', isLoopbackBind('127.0.0.1'), true);
check('0.0.0.0 is not loopback', isLoopbackBind('0.0.0.0'), false);

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
