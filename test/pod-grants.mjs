// test/pod-grants.mjs — a member granted one pod cannot reach the others.
//
// project_members.grants has been per-pod since it shipped:
//
//   scandeer | ramarao.satti@… | active | [{"pod": "storefront", …}]
//
// and NOTHING downstream had ever been told. A project is one repo with pods as
// folders, so the relay cloned all of it and served every folder — a grant on
// storefront handed over whatsapp-store too, with a terminal and an agent on
// top. jg-api's own comment claimed "runner enforces"; the runner has no
// reference to grants at all.
//
// This drives the REAL command table against a temp workspace. A source check
// would not do: the interesting cases are `../` traversal and the wrapper that
// adopts the grant, neither of which is visible in a grep.
//
//   node test/pod-grants.mjs
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';

// local.setup always mints a repo token, so stand in for jg-api. The workspace
// must also live under LOCAL_ROOT — the relay refuses anything outside it.
const home = await mkdtemp(path.join(tmpdir(), 'jg-grants-home-'));
process.env.JG_LOCAL_ROOT = home;
process.env.JG_RELAY_TOKEN = 'test';
const api = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ url: 'https://x-access-token:t@github.com/o/r.git' }));
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));
process.env.JG_API_WS_URL = `ws://127.0.0.1:${api.address().port}/api/local/relay`;

const { makeEditorCommands } = await import('../src/editor/commands.js');

let pass = 0, fail = 0;
const ok = (n, c, note = '') => { if (c) pass++; else { fail++; console.log(`  FAIL  ${n}${note ? ` — ${note}` : ''}`); } };
console.log('pod-grants');

const ws = { readyState: 1, OPEN: 1, send() {} };
const ctx = { ws, id: 'x', send() {}, logLine() {} };

// dest is <LOCAL_ROOT>/<account>/<project>, so the fixture goes there.
const root = path.join(home, 'a@b.c', 'proj');
await mkdir(root, { recursive: true });
// An existing .git takes local.setup's "already cloned" path, so no network.
execFileSync('git', ['init', '-q', root]);
for (const pod of ['storefront', 'whatsapp-store']) {
  await mkdir(path.join(root, pod, 'src'), { recursive: true });
  await writeFile(path.join(root, pod, 'src', 'index.ts'), `// ${pod}\n`);
}
await writeFile(path.join(root, 'README.md'), '# project\n');

const { table } = makeEditorCommands({ ws, version: 'test' });
await table['local.setup']({ project: 'proj', account: 'a@b.c' }, ctx);

const read = (p, pods) => table['fs.read']({ path: p, ...(pods ? { pods } : {}) }, ctx);
const GRANT = ['storefront'];

// ── the bug ────────────────────────────────────────────────────────────────
{
  await read('storefront/src/index.ts', GRANT);
  ok('a granted pod is readable', true);
  let denied = false;
  try { await read('whatsapp-store/src/index.ts', GRANT); } catch { denied = true; }
  ok('an ungranted pod is NOT readable', denied,
    'this is what handed a storefront-only member the whole repo');
}
{
  // Resolution happens before the check, so `..` cannot launder a path.
  let denied = false;
  try { await read('storefront/../whatsapp-store/src/index.ts', GRANT); } catch { denied = true; }
  ok('  and cannot be reached by traversing out of a granted one', denied,
    'checking the raw string instead of the resolved path is the classic hole here');
}

// ── what must still work ───────────────────────────────────────────────────
{
  await read('README.md', GRANT);
  ok('root files stay readable', true,
    'they belong to the project, not a pod — and Save has to see them');
}
{
  await read('whatsapp-store/src/index.ts', ['*']);
  ok("'*' grants everything", true);
  await read('whatsapp-store/src/index.ts', null);
  ok('no stamp at all is unrestricted', true,
    'an older jg-api that does not send pods must not lock everybody out');
}

// ── the grant is per COMMAND, so narrowing takes effect at once ────────────
{
  await read('whatsapp-store/src/index.ts', ['*']);
  let denied = false;
  try { await read('whatsapp-store/src/index.ts', GRANT); } catch { denied = true; }
  ok('narrowing a grant applies to the very next command', denied,
    'adopting once per session would leave a revoked member working until they reconnect');
}

// ── and it covers commands nobody thought about ───────────────────────────
{
  let denied = false;
  try { await table['fs.list']({ path: 'whatsapp-store', pods: GRANT }, ctx); } catch { denied = true; }
  ok('fs.list is covered without naming it', denied,
    'the guard sits in resolveIn, so every path-taking command inherits it');
}

api.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
