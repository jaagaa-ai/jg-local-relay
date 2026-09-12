// A TERMINAL OUTLIVES THE SOCKET THAT OPENED IT.
//
// The relay's connection to the control plane drops for ordinary reasons — a
// sleeping lid, a network blip, a cp restart — and reconnects moments later.
// Before this, ws.on('close') ran disposeAll(), which killed every PTY: the
// user's shell, their running `claude`, and whatever it had not finished.
//
// This drives the real Terminal class against a fake socket, because "reads
// fine" is not the question — the question is what survives a close.
import { Terminal } from '../src/editor/terminal.js';
import assert from 'node:assert/strict';

let fails = 0;
const is = (what, got, want) => {
  let ok;
  try { assert.deepEqual(got, want); ok = true; } catch { ok = false; }
  if (!ok) fails++;
  console.log((ok ? '  ok   ' : '  FAIL ') + what + (ok ? '' : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('terminal-persist');

// A socket we can close and replace, exactly as the relay does.
const mkWs = () => ({ readyState: 1, OPEN: 1, sent: [], send(s) { this.sent.push(JSON.parse(s)); } });
let ws = mkWs();
const t = new Terminal({ getWs: () => ws, id: 'T1', cwd: process.cwd() });
t.open({ cols: 80, rows: 24 });
is('the pty is running', !!t.pty, true);

// Prove the shell is alive and reachable BEFORE the drop.
t.input(Buffer.from('echo alpha\n').toString('base64'));
await sleep(600);
const readAll = (w) => w.sent.filter((m) => m.type === 'term-data')
  .map((m) => Buffer.from(m.data, 'base64').toString('utf8')).join('');
is('output reaches the live socket', /alpha/.test(readAll(ws)), true);

// THE DROP. The old socket goes away; the relay detaches rather than disposing.
const old = ws;
old.readyState = 3;            // CLOSED
t.detach();
is('the pty survives the socket closing', !!t.pty, true);

// Work continues while nobody is watching.
t.input(Buffer.from('echo beta\n').toString('base64'));
await sleep(600);
is('  and nothing is written to the dead socket',
  /beta/.test(readAll(old)), false);
is('  the missed output is kept', t.bufBytes > 0, true);

// THE RECONNECT: a new socket, and attach replays what was missed.
ws = mkWs();
t.attach();
const back = readAll(ws);
is('reconnecting replays what was missed', /beta/.test(back), true);
is('  as one frame, not a hundred repaints',
  ws.sent.filter((m) => m.type === 'term-data').length, 1);
is('  flagged as a replay so the browser can tell',
  ws.sent.find((m) => m.type === 'term-data').replay, true);
is('  and the buffer is emptied, so it is not replayed twice', t.bufBytes, 0);

// Still live afterwards — the same shell, not a new one.
t.input(Buffer.from('echo gamma\n').toString('base64'));
await sleep(600);
is('the same shell keeps serving the new socket', /gamma/.test(readAll(ws)), true);

// The bounded buffer must not grow without limit on a machine nobody watches.
t.detach();
for (let i = 0; i < 120; i++) t.input(Buffer.from(`echo ${'x'.repeat(1500)}\n`).toString('base64'));
await sleep(2500);
is('  detached output is bounded', t.bufBytes <= 256 * 1024, true);

await sleep(1200);
t.close();
await sleep(100);
is('close really does end it', !!t.pty, false);

if (fails) { console.error(`${fails} failed`); process.exit(1); }
console.log(`  ${'-'.repeat(20)}\n  all good`);
