// test/tunnel-ledger.mjs — a preview tunnel is never left registered.
//
// preview.start registers a named tunnel + DNS record with jg-api and holds the
// cloudflared child in memory; preview.stop releases both. A relay RESTART
// never calls preview.stop — and the hourly self-update restarts routinely:
//
//   2026-09-01T15:15:34.506Z [update] updated to bf4ec46 — restarting
//
// after which the hostname still resolved and Cloudflare answered 1033, because
// the tunnel was registered with no connector left alive. Every restart also
// leaked one DNS record — the subdomain exhaustion this platform worries about,
// caused by leakage rather than use.
//
// So registrations go to a ledger on disk and boot hands back whatever the last
// process left. This RUNS that reclaim against a fake jg-api and asserts the
// teardown call actually goes out.
//
//   node test/tunnel-ledger.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (n, c, note = '') => { if (c) pass++; else { fail++; console.log(`  FAIL  ${n}${note ? ` — ${note}` : ''}`); } };
console.log('tunnel-ledger');

// Stand in for jg-api and record what gets torn down.
const tornDown = [];
const api = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; });
  req.on('end', () => { if (req.url.includes('teardown')) tornDown.push(JSON.parse(b || '{}')); res.writeHead(200); res.end('{}'); });
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));
// apiBase() derives the http origin from the relay's WS url — set what it reads.
process.env.JG_API_WS_URL = `ws://127.0.0.1:${api.address().port}/api/local/relay`;
process.env.JG_RELAY_TOKEN = 'test';

// Point the ledger at a scratch HOME so the real one is never touched.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jglr-home-'));
process.env.HOME = home;
process.env.XDG_STATE_HOME = path.join(home, 'state');
process.env.LOCALAPPDATA = path.join(home, 'local');

const { reclaimLeakedPreviewTunnels } = await import('../src/editor/commands.js');

const ledgerPath = process.platform === 'darwin'
  ? path.join(home, 'Library/Application Support/jg-local-relay/preview-tunnels.json')
  : path.join(process.env.XDG_STATE_HOME, 'jg-local-relay', 'preview-tunnels.json');

// ── nothing recorded → nothing to do, and no crash on a missing file ────────
{
  const r = await reclaimLeakedPreviewTunnels();
  ok('an absent ledger reclaims nothing and does not throw', r.reclaimed === 0);
  ok('  and calls no teardown', tornDown.length === 0);
}

// ── the bug: two tunnels left behind by a restart ───────────────────────────
{
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, JSON.stringify({
    'jaagaa-apps-demo:web': { tunnelId: 't-1', host: 'jgc-jaagaa-apps-demo-web-local.jaagaa.ai', at: Date.now() },
    'jaagaa-apps-demo:vault': { tunnelId: 't-2', host: 'jgc-jaagaa-apps-demo-vault-local.jaagaa.ai', at: Date.now() },
  }));
  const r = await reclaimLeakedPreviewTunnels();
  ok('every leaked tunnel is handed back', r.reclaimed === 2, `reclaimed ${r.reclaimed}`);
  ok('  and jg-api really was asked to tear each one down', tornDown.length === 2,
    `teardown calls: ${JSON.stringify(tornDown)}`);
  ok('  by id AND host, which is what deletes the DNS record too',
    tornDown.every((t) => t.tunnelId && t.host));
  ok('  the exact hostname that was answering 1033 is among them',
    tornDown.some((t) => t.host === 'jgc-jaagaa-apps-demo-web-local.jaagaa.ai'));
}

// ── and the ledger is emptied, so a second boot is a no-op ──────────────────
{
  const before = tornDown.length;
  const r = await reclaimLeakedPreviewTunnels();
  ok('a second boot reclaims nothing', r.reclaimed === 0);
  ok('  and does not tear the same tunnels down again', tornDown.length === before,
    'a stale ledger would re-issue deletes for hostnames someone has since re-created');
  ok('  because the file was cleared', JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) && Object.keys(JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))).length === 0);
}

// ── jg-api unreachable: the record must SURVIVE ────────────────────────────
{
  fs.writeFileSync(ledgerPath, JSON.stringify({
    'p:web': { tunnelId: 't-9', host: 'jgc-p-web-local.jaagaa.ai', at: Date.now() },
  }));
  api.close();
  await new Promise((r) => setTimeout(r, 100));
  const r = await reclaimLeakedPreviewTunnels();
  ok('an unreachable jg-api reclaims nothing', r.reclaimed === 0);
  ok('  and the record is KEPT for the next boot', r.pending === 1,
    'clearing a registration we failed to release is how a leak becomes permanent');
  ok('  so the hostname is still on disk',
    JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))['p:web']?.tunnelId === 't-9');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
