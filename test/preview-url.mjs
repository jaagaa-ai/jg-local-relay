// test/preview-url.mjs — what preview.start hands the browser is a URL.
//
// Two defects, one line apart, and together they made a perfectly healthy
// preview look dead:
//
//   pv.url = prov.host;   // jg-api returns a bare HOSTNAME
//   …
//   return { url };       // `url` only existed inside the catch block
//
// 1. A bare host in <iframe src> is a RELATIVE url. The browser resolved
//    `jgc-jaagaa-apps-demo-web-local.jaagaa.ai` against the console page and
//    fetched
//      console.jaagaa.ai/projects/jaagaa-apps-demo/jgc-…-web-local.jaagaa.ai
//    which 404s. The dev server was answering `HEAD / 200 OK` and cloudflared
//    had registered four connections; the pane showed a broken page.
//
// 2. On the named-tunnel path — the normal one — `return { url }` threw
//    ReferenceError, so preview.start reported failure over a dev server and
//    tunnel that were both already up.
//
// The quick-tunnel fallback had neither problem, because startTunnel() parses a
// full https:// url out of cloudflared's output. So the BETTER path was the
// broken one, and it only broke when jg-api was reachable enough to provision a
// named tunnel — which is to say, in production.
//
//   node test/preview-url.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { absUrl } from '../src/editor/commands.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, cond, note = '') => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL  ${name}${note ? ` — ${note}` : ''}`); }
};
console.log('preview-url');

// ── the bug ──────────────────────────────────────────────────────────────────
{
  const host = 'jgc-jaagaa-apps-demo-web-local.jaagaa.ai';
  const u = absUrl(host);
  ok('a bare hostname becomes an absolute url', u === `https://${host}`);
  // The assertion that actually matters: resolved against the console page it
  // must point at the tunnel, not back into the console.
  const resolved = new URL(u, 'https://console.jaagaa.ai/projects/jaagaa-apps-demo/ai-edit');
  ok('  and resolves to the tunnel, not the console',
    resolved.host === host,
    `resolved to ${resolved.href} — a bare host lands under the console's own path`);
}
{
  // Guard the inverse: prove the OLD value really was broken, so this test
  // cannot pass for the wrong reason.
  const bad = new URL('jgc-jaagaa-apps-demo-web-local.jaagaa.ai',
    'https://console.jaagaa.ai/projects/jaagaa-apps-demo/ai-edit');
  ok('  (the un-prefixed host really did land on the console)',
    bad.host === 'console.jaagaa.ai');
}

// ── shapes it must tolerate ──────────────────────────────────────────────────
ok('an https url is left alone', absUrl('https://x.trycloudflare.com') === 'https://x.trycloudflare.com');
ok('an http url is left alone', absUrl('http://localhost:8787') === 'http://localhost:8787');
ok('  case-insensitively', absUrl('HTTPS://X.IO') === 'HTTPS://X.IO');
ok('whitespace is trimmed', absUrl('  host.io  ') === 'https://host.io');
ok('nothing is null, not "https://"', absUrl('') === null && absUrl(null) === null && absUrl(undefined) === null);

// ── and the call sites use it ────────────────────────────────────────────────
{
  const src = fs.readFileSync(path.join(ROOT, 'src/editor/commands.js'), 'utf8');
  ok('the named tunnel stores an absolute url', /pv\.url = absUrl\(prov\.host\)/.test(src),
    'storing prov.host raw is the whole bug');
  ok('preview.start returns the url it stored', /return \{ url: pv\.url \}/.test(src),
    '`return { url }` read a binding that only exists in the catch block');
  ok('  and no longer returns a bare `url`', !/^\s*return \{ url \};$/m.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
