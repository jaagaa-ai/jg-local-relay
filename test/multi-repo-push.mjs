// test/multi-repo-push.mjs — Save covers every repo in the workspace.
//
// A project used to be one git repo, so repo.push pushed one directory. A
// workspace is now the project clone PLUS a clone per pod that owns its repo,
// and pushing only the project would silently drop every change made inside a
// pod — which on a project like jaagaa is most of the work.
//
// Drives the real command table against real local repos, because the thing
// worth checking is which directories get walked and which are skipped.
//
//   node test/multi-repo-push.mjs
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';

let pass = 0, fail = 0;
const ok = (n, c, note = '') => { if (c) pass++; else { fail++; console.log(`  FAIL  ${n}${note ? ` — ${note}` : ''}`); } };
console.log('multi-repo-push');

const home = await mkdtemp(path.join(tmpdir(), 'jg-mrp-'));
process.env.JG_LOCAL_ROOT = home;
process.env.JG_RELAY_TOKEN = 'test';
const api = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  // No pod repos to clone; the fixtures below stand in for already-cloned ones.
  res.end(JSON.stringify(req.url.includes('pod-repos') ? { pods: [] } : { url: 'https://x-access-token:t@github.com/o/r.git' }));
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));
process.env.JG_API_WS_URL = `ws://127.0.0.1:${api.address().port}/api/local/relay`;
const { makeEditorCommands } = await import('../src/editor/commands.js');

const git = (d, ...a) => execFileSync('git', ['-C', d, ...a], { stdio: 'ignore' });
const proj = path.join(home, 'a@b.c', 'proj');
await mkdir(proj, { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'main', proj]);
await writeFile(path.join(proj, 'README.md'), '# p\n');
git(proj, 'add', '-A'); git(proj, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');

// `vault` and `sign` are their OWN repos inside the workspace; `web` is a plain
// folder of the project checkout. Each pod gets a real bare remote, because
// "committed but not pushed" is only detectable against an upstream — a fixture
// without one cannot tell that case from a clean repo.
for (const pod of ['vault', 'sign']) {
  const bare = path.join(home, `${pod}.git`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const d = path.join(proj, pod);
  await mkdir(d, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', d]);
  await writeFile(path.join(d, 'index.ts'), `// ${pod}\n`);
  git(d, 'add', '-A'); git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  git(d, 'remote', 'add', 'origin', bare);
  git(d, 'push', '-q', '-u', 'origin', 'main');
}
// vault now has a commit its remote does not: "committed, not yet pushed".
await writeFile(path.join(proj, 'vault', 'later.ts'), '// later\n');
git(path.join(proj, 'vault'), 'add', '-A');
git(path.join(proj, 'vault'), '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'later');
await mkdir(path.join(proj, 'web'), { recursive: true });
await writeFile(path.join(proj, 'web', 'index.ts'), '// web\n');

const ws = { readyState: 1, OPEN: 1, send() {} };
const ctx = { ws, id: 'x', send() {}, logLine() {} };
const { table } = makeEditorCommands({ ws, version: 'test' });
await table['local.setup']({ project: 'proj', account: 'a@b.c' }, ctx);

// ── which directories does Save consider? ─────────────────────────────────
// No remotes, so every push fails — that is fine and is the point: the RESULT
// names each repo it walked, which is what this asserts.
const res = await table['repo.push']({ message: 'x' }, ctx).catch((e) => ({ error: e.message }));
const names = (res.repos ?? []).map((r) => r.repo);
ok('the project repo is pushed', names.includes('project'));
ok('a pod with unpushed COMMITS is walked', names.includes('vault'),
  `walked: ${names.join(', ') || '(none)'} — pushing only the project silently drops pod work`);
ok('  a pod already in sync is skipped', !names.includes('sign'),
  'nothing to push means nothing to do; committing an empty change every Save is noise');
ok('a plain FOLDER of the project is NOT pushed separately', !names.includes('web'),
  'it has no .git; the project push already covers it');

// ── clean pods are skipped ────────────────────────────────────────────────
{
  // `sign` was committed and has no remote → rev-list @{u} fails → not dirty.
  // `vault` gets an uncommitted change, so it must be walked.
  await writeFile(path.join(proj, 'vault', 'new.ts'), '// changed\n');
  const r2 = await table['repo.push']({ message: 'y' }, ctx).catch(() => ({ repos: [] }));
  const n2 = (r2.repos ?? []).map((x) => x.repo);
  ok('a pod with uncommitted changes is included', n2.includes('vault'));
  ok('  a pod with nothing to push is skipped', !n2.includes('sign'),
    'committing an empty change in every pod on every Save would be noise in their history');
}

// ── one failure must not hide the others ──────────────────────────────────
ok('the project push is reported even though it failed (no remote)',
  (res.repos ?? []).some((r) => r.repo === 'project' && r.error),
  'throwing here skipped every pod, so one bad remote hid all the pod work');
ok('  and a failing project does NOT stop the pods being walked', names.includes('vault'));

api.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
