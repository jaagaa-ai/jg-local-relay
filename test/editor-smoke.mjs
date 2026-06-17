// Throwaway smoke test for the AI-Editor relay surface (src/editor/*).
// Acts as jg-api: stands up a WS server, lets the relay's editor link dial in,
// then drives a command sequence and asserts. Run: node test/editor-smoke.mjs
import { WebSocketServer } from 'ws';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PORT = 7799;
const wss = new WebSocketServer({ port: PORT });
const results = [];
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { (ok ? pass++ : fail++); results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

// A temp git repo so local.setup (reuse path, no clone) sets the workspace.
const ws = await mkdtemp(path.join(tmpdir(), 'jglr-'));
execFileSync('git', ['init', '-q', ws]);

wss.on('connection', (sock) => {
  let nextId = 1;
  const waiters = new Map();      // id -> resolve
  const termData = new Map();     // id -> accumulated decoded text
  sock.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'term-data' && m.id != null) termData.set(m.id, (termData.get(m.id) || '') + Buffer.from(m.data, 'base64').toString('utf8'));
    if (m.type === 'result' && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  });
  const cmd = (cmd, args = {}) => new Promise((res) => { const id = nextId++; waiters.set(id, res); sock.send(JSON.stringify({ type: 'command', id, cmd, args })); return id; });
  // term needs the id we sent; expose a variant that returns both.
  const cmdId = (cmd, args = {}) => { const id = nextId++; const p = new Promise((res) => waiters.set(id, res)); sock.send(JSON.stringify({ type: 'command', id, cmd, args })); return { id, done: p }; };

  sock.on('message', function once(raw) { /* hello handled below */ });

  (async () => {
    // The relay sends { type:'hello', ... } first.
    await new Promise((r) => setTimeout(r, 300));

    let res = await cmd('session.info');
    check('session.info responds', res.ok && res.data, JSON.stringify(res.data));

    res = await cmd('local.setup', { project: 'smoke', path: ws, install: false });
    check('local.setup sets workspace', res.ok && res.data?.workspace === ws, res.error || res.data?.action);

    res = await cmd('fs.write', { path: 'hello.txt', content: 'hi-from-relay' });
    check('fs.write', res.ok, res.error);

    res = await cmd('fs.read', { path: 'hello.txt' });
    check('fs.read round-trips', res.ok && res.data?.content === 'hi-from-relay', res.error || res.data?.content);

    res = await cmd('fs.list', { path: '' });
    check('fs.list shows file', res.ok && res.data?.entries?.some((e) => e.name === 'hello.txt'), res.error);

    res = await cmd('proc.start', { name: 'echo', cmd: 'bash', args: ['-c', 'echo proc-ok'] });
    check('proc.start returns pid', res.ok && res.data?.pid, res.error);

    // term: open, type a command, expect its echo back in term-data.
    const t = cmdId('term.open', { cols: 80, rows: 24 });
    const opened = await t.done;
    const termId = opened.data?.termId ?? t.id;
    check('term.open', opened.ok && termId, opened.error);
    await new Promise((r) => setTimeout(r, 300));
    sock.send(JSON.stringify({ type: 'command', id: nextId++, cmd: 'term.input', args: { termId, data: Buffer.from('echo TERM-OK\n').toString('base64') } }));
    await new Promise((r) => setTimeout(r, 800));
    check('term PTY echoes input', (termData.get(termId) || '').includes('TERM-OK'), JSON.stringify((termData.get(termId) || '').slice(-60)));

    res = await cmd('repo.status');
    check('repo.status', res.ok && 'branch' in (res.data || {}), res.error);

    console.log('\n' + results.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    wss.close();
    process.exit(fail ? 1 : 0);
  })();
});

// Bring up the relay editor link pointed at us.
process.env.JG_API_WS_URL = `ws://127.0.0.1:${PORT}`;
process.env.JG_RELAY_TOKEN = 'smoke';
const { startEditorLink } = await import('../src/editor/link.js');
startEditorLink({ version: 'smoke-test' });

setTimeout(() => { console.log('TIMEOUT — no completion'); process.exit(2); }, 15_000);
