// editor/commands.js — the AI-Editor command table the relay exposes to
// jg-console (via jg-api). Same command names + shapes as jg-sandbox-runner's
// commands.js, executed against a LOCAL project workspace under
// ~/Documents/Jaagaa-ai/<project>. The user's own tools (git, wrangler, claude)
// run here; nothing leaves the machine except through the user's own pushes.
//
// M1 implements: local.setup, term.* (multi), fs.list/read/write, proc.*,
// git.changes/repo.status/repo.push. preview.*, site.*, agent.* are stubbed
// with explicit "not wired yet" errors (M3/M4) so the surface is discoverable.

import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Terminal } from './terminal.js';

const LOCAL_ROOT = process.env.JG_LOCAL_ROOT || path.join(os.homedir(), 'Documents', 'Jaagaa-ai');

// This relay's stable id — same value sent in the dial-home hello frame, so
// jg-api can correlate a resource-mint REST call to the live bridged session and
// refuse minting another account's project (account-isolation backstop).
const RELAY_ID = process.env.JG_RELAY_ID || os.hostname();

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
    if (err) { err.stderr = stderr; reject(err); } else resolve({ stdout: String(stdout), stderr: String(stderr) });
  });
});

// A STABLE, project+app-unique local port (8800–9799). Two different projects'
// `web` pods must never share a port, or their dev servers collide on 8787 (and
// a port-probe for one would falsely detect the other → wrong preview, false
// "running" dots). Deterministic so the port survives restarts.
function stablePort(project, app) {
  const s = `${project || 'app'}:${app || 'web'}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return 8800 + (h % 1000);
}

// SIGKILL whatever process is bound to a local TCP port. We call this before
// (re)starting a dev server so a LEFTOVER process — orphaned by a relay restart
// (launchd SIGKILLs us, so our children outlive us and keep holding the port) or
// a double-start — can't cause EADDRINUSE (`Address already in use`, exit 1).
async function freePort(port, tries = 10) {
  // Poll-and-kill until the port is actually free. A single pass isn't enough:
  // wrangler RESPAWNS its workerd child when it dies, so killing only the
  // port-holder lets the still-alive wrangler immediately rebind. We retry (and
  // killGroup below kills the wrangler parent) until lsof reports the port free.
  let killed = 0;
  for (let i = 0; i < tries; i++) {
    let pids = [];
    try {
      const { stdout } = await run('lsof', ['-ti', `tcp:${port}`], { timeout: 5000 });
      pids = [...new Set(stdout.split('\n').map((s) => s.trim()).filter(Boolean))];
    } catch { /* lsof exits non-zero when nothing is on the port → free */ }
    if (pids.length === 0) return killed; // free
    for (const pid of pids) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* gone */ } killed++; }
    await new Promise((r) => setTimeout(r, 150));
  }
  return killed;
}

// Kill an entire dev-server process tree. We spawn `bash -lc "wrangler dev"`
// DETACHED (its own process group), so SIGKILL to the negative pid takes down
// bash + wrangler + workerd together — otherwise killing bash orphans wrangler,
// which keeps respawning workerd on the port (→ EADDRINUSE on restart).
function killGroup(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
}

// Which coding CLI drives a chat turn + its argv. Mirrors jg-sandbox-runner's
// buildAgentRun, but LOCAL: the CLI runs under the user's OWN $HOME, so it uses
// their real `claude` subscription / config — no XDG sandbox overrides.
function buildAgentRun({ cli, prompt, convId, convName, resume, started, model }) {
  switch (cli) {
    case 'codex':  return { bin: 'codex', argv: ['exec', prompt] };
    case 'gemini': return { bin: 'gemini', argv: ['-p', prompt] };
    case 'opencode': {
      const a = ['run', '--dangerously-skip-permissions'];
      if (model) a.push('--model', model);
      if (started) a.push('--continue');
      a.push(prompt);
      return { bin: 'opencode', argv: a };
    }
    case 'claude':
    default: {
      const a = ['-p', '--dangerously-skip-permissions'];
      if (convId) { if (resume) a.push('--resume', convId); else { a.push('--session-id', convId); if (convName) a.push('--name', convName); } }
      else if (started) a.push('--continue');
      a.push(prompt);
      return { bin: 'claude', argv: a };
    }
  }
}

// cloudflared quick tunnel to a local port → public https URL (preview). Same
// approach as jg-sandbox-runner/src/lib/tunnel.js.
// Does the dev server actually answer on its port? (process-alive ≠ serving.)
// Mirrors jg-sandbox-runner's probePort so the console can show live vs starting.
function probePort(port) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'HEAD', path: '/', timeout: 1500 }, (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

const QUICK_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
function startTunnel(port, onLog = () => {}) {
  return new Promise((resolve, reject) => {
    const cf = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { env: process.env });
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; try { cf.kill('SIGKILL'); } catch { /* gone */ } reject(new Error('tunnel timeout')); } }, 30_000);
    const scan = (chunk) => {
      const text = chunk.toString();
      for (const line of text.split('\n')) if (line.trim()) onLog(line.trim());
      const m = text.match(QUICK_URL_RE);
      if (m && !settled) { settled = true; clearTimeout(timer); resolve({ url: m[0], proc: cf }); }
    };
    cf.stdout.on('data', scan); cf.stderr.on('data', scan);
    cf.on('exit', (code) => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`cloudflared exited ${code}`)); } });
  });
}

// Resolve jg-api's HTTPS origin (to mint repo tokens). Mirrors link.js: explicit
// JG_API_WS_URL, else derive from a prod cp host (cp.<d> → api.<d>).
function apiBase() {
  let wsUrl = process.env.JG_API_WS_URL;
  if (!wsUrl) {
    try { const cp = new URL(process.env.JG_CP_URL || ''); if (cp.hostname.startsWith('cp.')) wsUrl = `wss://${cp.hostname.replace(/^cp\./, 'api.')}/api/local/relay`; } catch { /* malformed */ }
  }
  if (!wsUrl) return null;
  try { const u = new URL(wsUrl.replace(/^ws/, 'http')); return `${u.protocol}//${u.host}`; } catch { return null; }
}

// Ask jg-api for a SHORT-LIVED, single-repo-scoped clone URL (GitHub App token).
// The owner never holds a broad token; we use this transiently and never persist
// it (we reset the git remote to the token-free URL after clone).
async function mintCloneUrl(project) {
  const base = apiBase();
  if (!base) throw new Error('no jg-api endpoint to mint a repo token');
  const res = await fetch(`${base}/api/local/repo-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.JG_RELAY_TOKEN || ''}` },
    body: JSON.stringify({ project, relay: RELAY_ID }),
  });
  if (!res.ok) throw new Error(`repo-token mint failed (${res.status})`);
  const j = await res.json();
  if (!j.url) throw new Error('repo-token: no url');
  return j.url; // https://x-access-token:<tok>@github.com/<org>/jgc-<project>.git
}
const stripToken = (url) => url.replace(/\/\/[^@/]+@/, '//'); // token-free remote

// Tell jg-api the tenant's `web` marketing pod was just published so it binds
// POD_WEB on the core worker and serves marketing from the pod (not the baked
// template). Best-effort: a publish still succeeds even if this notify fails —
// the operator can re-publish. project = the tenant slug; url = the deployed
// workers.dev URL (jg-api derives the worker name from it).
async function notifyWebPodPublished(project, url) {
  const base = apiBase();
  if (!base) throw new Error('no jg-api endpoint to register web pod publish');
  const res = await fetch(`${base}/api/local/web-pod/published`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.JG_RELAY_TOKEN || ''}` },
    body: JSON.stringify({ project, url, relay: RELAY_ID }),
  });
  if (!res.ok) throw new Error(`web-pod publish register failed (${res.status})`);
  return res.json();
}

// Ask jg-api to provision a NAMED jaagaa.ai preview tunnel for ONE app. jg-api
// owns the CF API; we only receive a run token scoped to this single tunnel
// (ingress remotely-managed: this app's host → our localhost:<port>, nothing
// else). Returns { tunnelId, token, host }. Throws → caller uses a quick tunnel.
async function provisionNamedTunnel(project, app, port) {
  const base = apiBase();
  if (!base) throw new Error('no jg-api endpoint');
  const res = await fetch(`${base}/api/local/preview-tunnel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.JG_RELAY_TOKEN || ''}` },
    body: JSON.stringify({ project, app, port, relay: RELAY_ID }),
  });
  if (!res.ok) throw new Error(`preview-tunnel ${res.status}`);
  const j = await res.json();
  if (!j.token || !j.host) throw new Error('preview-tunnel: missing token/host');
  return { tunnelId: j.tunnelId || null, token: j.token, host: j.host };
}
// The tenant Core origin a pod authenticates against (Identity Phase 2). Cached
// per project; injected as CORE_URL into the dev server so lib/coreAuth.ts can
// verify Core tokens against the Core JWKS.
const coreUrlCache = new Map();
async function fetchCoreUrl(project) {
  if (coreUrlCache.has(project)) return coreUrlCache.get(project);
  const base = apiBase();
  if (!base) return null;
  try {
    const res = await fetch(`${base}/api/local/core-url?project=${encodeURIComponent(project)}&relay=${encodeURIComponent(RELAY_ID)}`, {
      headers: { authorization: `Bearer ${process.env.JG_RELAY_TOKEN || ''}` },
    });
    if (!res.ok) return null;
    const j = await res.json();
    const url = j.coreUrl || null;
    coreUrlCache.set(project, url);
    return url;
  } catch { return null; }
}
// Tear the named tunnel + its DNS down (also invalidates the run token).
async function teardownNamedTunnel(tunnelId, host) {
  const base = apiBase();
  if (!base || !tunnelId) return;
  await fetch(`${base}/api/local/preview-tunnel/teardown`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.JG_RELAY_TOKEN || ''}` },
    body: JSON.stringify({ tunnelId, host }),
  }).catch(() => {});
}

// Where the relay's stdout log lives (launchd StandardOutPath on macOS).
const RELAY_LOG = process.env.JG_RELAY_LOG
  || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Logs/jg-local-relay/out.log') : null);

export function makeEditorCommands({ ws, version }) {
  let workspace = null;            // absolute path of the active project dir
  const terms = new Map();         // termId -> Terminal
  const procs = new Map();         // name -> { child, logs:[] }
  const previews = new Map();      // app -> { proc, tunnel, url, port }
  // Ring buffer of recent preview log lines per app, so the console can REPLAY
  // them (a browser reload clears its own buffer, and a re-start of an already-
  // running server emits nothing) → `preview.logs` returns these.
  const previewLog = new Map();    // app -> [{ channel, line }] (capped)
  const pushPreviewLog = (app, channel, line) => {
    const buf = previewLog.get(app) || (previewLog.set(app, []).get(app));
    buf.push({ channel, line });
    if (buf.length > 800) buf.shift();
  };
  const chatStarted = new Set();   // conv/app keys with an ongoing thread (for --continue)
  const pickTerm = (id) => (id && terms.get(id)) || (terms.size === 1 ? [...terms.values()][0] : null);

  // Resolve a path under the workspace; refuse traversal outside it.
  const resolveIn = (rel = '') => {
    if (!workspace) throw new Error('no workspace — call local.setup first');
    const abs = path.resolve(workspace, rel.replace(/^\/+/, ''));
    if (abs !== workspace && !abs.startsWith(workspace + path.sep)) throw new Error('path escapes workspace');
    return abs;
  };

  const table = {
    // --- session / workspace ----------------------------------------------
    // Clone (or reuse) the project mono-repo locally + install deps, then make
    // it the active workspace. dest defaults to ~/Documents/Jaagaa-ai/<project>.
    'local.setup': async (args, ctx) => {
      const project = String(args.project || args.slug || '').trim();
      if (!project) throw new Error('local.setup requires { project }');
      const dest = args.path ? path.resolve(args.path) : path.join(LOCAL_ROOT, project);
      const branch = args.branch || 'main';
      await mkdir(path.dirname(dest), { recursive: true });
      // Repo auth = a short-lived, single-repo-scoped token minted by jg-api
      // (NOT the owner's personal git creds). Used inline; never persisted.
      const scopedUrl = await mintCloneUrl(project);
      const cleanUrl = stripToken(scopedUrl);
      let action;
      if (existsSync(path.join(dest, '.git'))) {
        await run('git', ['-C', dest, 'fetch', '--quiet', scopedUrl], { timeout: 300_000 }).catch(() => {});
        action = 'updated';
      } else {
        ctx.logLine('setup', `cloning ${project} → ${dest}`);
        await run('git', ['clone', '--quiet', '--branch', branch, scopedUrl, dest], { timeout: 300_000 });
        // Reset the remote to the token-free URL so the ephemeral token never
        // lands in .git/config. Push/fetch re-mint a fresh scoped URL inline.
        await run('git', ['-C', dest, 'remote', 'set-url', 'origin', cleanUrl]).catch(() => {});
        action = 'cloned';
      }
      workspace = dest;
      if (args.install !== false && existsSync(path.join(dest, 'package.json'))) {
        ctx.logLine('setup', 'installing dependencies (npm install)…');
        await run('npm', ['install'], { cwd: dest, timeout: 600_000 }).catch((e) => ctx.logLine('setup', `npm install warning: ${e.message}`));
      }
      return { ok: true, project, workspace, action };
    },
    'session.info': async () => ({ workspace, root: LOCAL_ROOT, terms: terms.size, procs: [...procs.keys()], version: version ?? null, platform: process.platform, host: os.hostname(), logPath: RELAY_LOG }),

    // --- local host actions (Local mode only) -----------------------------
    // Reveal a folder/file in the OS file manager (Finder / Explorer / xdg).
    'local.reveal': async (args) => {
      const abs = resolveIn(args?.path || '');
      const bin = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
      try { spawn(bin, [abs], { detached: true, stdio: 'ignore' }).unref(); } catch (e) { throw new Error(`reveal failed: ${e.message}`); }
      return { ok: true, path: abs };
    },
    // Open a native terminal at a folder.
    'local.openTerminal': async (args) => {
      const abs = resolveIn(args?.path || '');
      try {
        if (process.platform === 'darwin') spawn('open', ['-a', 'Terminal', abs], { detached: true, stdio: 'ignore' }).unref();
        else if (process.platform === 'win32') spawn('cmd', ['/c', 'start', 'cmd', '/k', `cd /d ${abs}`], { detached: true, stdio: 'ignore' }).unref();
        else spawn('x-terminal-emulator', ['--working-directory', abs], { detached: true, stdio: 'ignore' }).unref();
      } catch (e) { throw new Error(`open terminal failed: ${e.message}`); }
      return { ok: true, path: abs };
    },
    // Tail the relay's own log so the user can see what the relay is doing.
    'local.relayLog': async (args) => {
      if (!RELAY_LOG || !existsSync(RELAY_LOG)) return { lines: [], path: RELAY_LOG, note: 'log file not found' };
      const n = Math.min(Math.max(Number(args?.tail) || 200, 1), 1000);
      const txt = await readFile(RELAY_LOG, 'utf8').catch(() => '');
      const lines = txt.split('\n').filter(Boolean);
      return { path: RELAY_LOG, version: version ?? null, lines: lines.slice(-n) };
    },

    // --- terminal (multi-PTY, addressed by termId) ------------------------
    'term.open': async (args, ctx) => {
      const t = new Terminal({ ws, id: ctx.id, cwd: workspace });
      t.open({ cols: args.cols, rows: args.rows });
      terms.set(ctx.id, t);
      return { opened: true, termId: ctx.id };
    },
    'term.input': async (args) => { pickTerm(args.termId)?.input(args.data); return {}; },
    'term.resize': async (args) => { pickTerm(args.termId)?.resize(args.cols, args.rows); return {}; },
    'term.close': async (args) => { const t = pickTerm(args.termId); if (t) { t.close(); terms.delete(t.id); } return { closed: true }; },

    // --- files -------------------------------------------------------------
    'fs.list': async (args) => {
      const rel = args?.path || '';
      const abs = resolveIn(rel);
      const ents = await readdir(abs, { withFileTypes: true });
      // Shape MUST match jg-sandbox-runner's fs.list (the console's FsEntry):
      // { name, type:'dir'|'file', path } — missing path/type crashes the tree.
      return {
        path: rel,
        entries: ents
          .filter((e) => e.name !== '.git' && e.name !== 'node_modules')
          .map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file', path: rel ? `${rel}/${e.name}` : e.name }))
          .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1)),
      };
    },
    'fs.read': async (args) => {
      const abs = resolveIn(args?.path);
      const s = await stat(abs);
      if (s.size > 2 * 1024 * 1024) throw new Error('file too large (>2MB)');
      return { path: args.path, content: await readFile(abs, 'utf8') };
    },
    'fs.write': async (args) => {
      const abs = resolveIn(args?.path);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, String(args?.content ?? ''), 'utf8');
      return { ok: true, path: args.path };
    },

    // --- processes (dev servers; logs stream as log frames) ---------------
    'proc.start': async (args, ctx) => {
      const name = String(args.name || 'dev');
      if (procs.get(name)?.child) return { name, already: true };
      const child = spawn(args.cmd || 'npm', args.args || ['run', 'dev'], {
        cwd: args.cwd ? resolveIn(args.cwd) : workspace, env: { ...process.env, ...(args.env || {}) },
      });
      const rec = { child, logs: [] };
      procs.set(name, rec);
      // Without an 'error' handler a failed spawn (ENOENT etc.) crashes the relay.
      child.on('error', (err) => { ctx.logLine(`${name}:err`, `failed to start: ${err.message}`); rec.child = null; });
      const pipe = (stream) => (buf) => { for (const line of String(buf).split('\n')) if (line) ctx.logLine(`${name}:${stream}`, line); };
      child.stdout.on('data', pipe('out'));
      child.stderr.on('data', pipe('err'));
      child.on('exit', (code) => { ctx.logLine(`${name}:out`, `[exited ${code}]`); rec.child = null; });
      return { name, pid: child.pid };
    },
    'proc.stop': async (args) => { const r = procs.get(String(args.name)); try { r?.child?.kill(); } catch { /* gone */ } return { stopped: args.name }; },
    'proc.list': async () => ({ procs: [...procs.entries()].map(([name, r]) => ({ name, running: !!r.child, pid: r.child?.pid ?? null })) }),

    // --- git ---------------------------------------------------------------
    'git.changes': async () => {
      // Shape MUST match jg-sandbox-runner + the console: { files: [{status, path}] }.
      // The console reads `files`/`path` (NOT `changes`/`file`) and attributes
      // each change to its pod by path prefix (e.g. `vault/…` → vault gets the
      // dirty `*`). Paths are relative to the repo root.
      const { stdout } = await run('git', ['-C', workspace, 'status', '--porcelain']);
      return { files: stdout.split('\n').filter(Boolean).map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3) })) };
    },
    'repo.status': async () => {
      // Full shape the console's repo bar expects (matches jg-sandbox-runner):
      // { hasRepo, branch, head, fileCount, dirty, remote }.
      if (!workspace || !existsSync(path.join(workspace, '.git'))) return { hasRepo: false };
      const [branch, head, porcelain, remote, files] = await Promise.all([
        run('git', ['-C', workspace, 'rev-parse', '--abbrev-ref', 'HEAD']).then((r) => r.stdout.trim()).catch(() => null),
        run('git', ['-C', workspace, 'rev-parse', '--short', 'HEAD']).then((r) => r.stdout.trim()).catch(() => null),
        run('git', ['-C', workspace, 'status', '--porcelain']).then((r) => r.stdout).catch(() => ''),
        run('git', ['-C', workspace, 'remote', 'get-url', 'origin']).then((r) => r.stdout.trim()).catch(() => null),
        run('git', ['-C', workspace, 'ls-files']).then((r) => r.stdout.split('\n').filter(Boolean).length).catch(() => 0),
      ]);
      return { hasRepo: true, branch, head, fileCount: files, dirty: porcelain.split('\n').filter(Boolean).length, remote };
    },
    'repo.push': async (args, ctx) => {
      const msg = args.message || 'Update from Jaagaa Local Editor';
      await run('git', ['-C', workspace, 'add', '-A']);
      await run('git', ['-C', workspace, 'commit', '-m', msg]).catch((e) => ctx.logLine('git', e.stderr || 'nothing to commit'));
      const branch = (await run('git', ['-C', workspace, 'rev-parse', '--abbrev-ref', 'HEAD']).then((r) => r.stdout.trim()).catch(() => 'main')) || 'main';
      const project = path.basename(workspace);
      // Push ONLY with a per-project, repo-scoped token minted by jg-api — the
      // SAME source the sandbox uses (jg-api getCloneUrl → JG_REPO_TOKEN). No
      // owner credentials, ever: local and sandbox behave identically. The token
      // is used transiently via http.extraheader so it's never persisted to
      // .git/config; `origin` on disk stays a tokenless URL. If jg-api can't mint
      // the token, the push fails with a clear error (don't silently fall back to
      // the owner's git credential — that would mask a real auth/config gap).
      const scopedUrl = await mintCloneUrl(project); // throws → surfaced to console
      const tok = (scopedUrl.match(/\/\/x-access-token:([^@]+)@/) || [])[1] || '';
      const authArgs = tok ? ['-c', `http.extraheader=Authorization: Basic ${Buffer.from(`x-access-token:${tok}`).toString('base64')}`] : [];
      let stdout = '', stderr = '';
      try {
        ({ stdout, stderr } = await run('git', ['-C', workspace, ...authArgs, 'push', 'origin', `HEAD:${branch}`], { timeout: 180_000 }));
      } catch (e) {
        throw new Error(`push failed: ${String((e && (e.stderr || e.message)) || e).replace(/x-access-token:[^@]+@/g, 'x-access-token:***@').slice(0, 400)}`);
      }
      const head = await run('git', ['-C', workspace, 'rev-parse', '--short', 'HEAD']).then((r) => r.stdout.trim()).catch(() => null);
      // Return the fields the console reads (pushed/head/branch) so it reports success.
      return { ok: true, pushed: true, head, branch, via: 'scoped-token', output: (stdout + stderr).trim().slice(0, 1000) };
    },

    // --- preview (local dev server + cloudflared tunnel) ------------------
    'preview.start': async (args, ctx) => {
      const app = String(args.app || '');
      const project = String(args.project || path.basename(workspace || '') || 'app');
      // Unique port per (project, app) — NOT a shared 8787 — so concurrent
      // projects' dev servers never collide or cross-detect each other.
      const port = stablePort(project, app);
      const cwd = app ? resolveIn(app) : workspace;
      let pv = previews.get(app);
      // Start command from the pod's jaagaa.app.json (mirrors the cloud runner);
      // default `wrangler dev` for workers. $PORT templated. Run via bash -lc
      // with the pod's node_modules/.bin on PATH so a locally-installed wrangler
      // (or other dev tool) resolves without a global install.
      let cmd = `wrangler dev --port ${port}`;
      try {
        const m = JSON.parse(await readFile(path.join(cwd, 'jaagaa.app.json'), 'utf8'));
        if (m?.commands?.start) cmd = String(m.commands.start).replace(/\$PORT/g, String(port));
      } catch { /* no manifest → default */ }
      // Data environment: 'development' (default) = local miniflare data, fully
      // isolated + mutable. 'production' = the pod's REAL prod D1/R2 via
      // `--remote`, with JG_ENV=prod (read-only, enforced in the pod's envGuard)
      // unless prodWrite unlocked it (JG_ENV=prod-rw). Omitted → development, so
      // existing callers are unchanged.
      const dataEnv = args.env === 'production' ? 'production' : 'development';
      const prodWrite = dataEnv === 'production' && !!args.prodWrite;
      // Force the unique per-project port — OVERRIDE any port the manifest
      // hardcoded, so two projects whose manifests both say `--port 8787` still
      // get distinct ports and never collide / cross-detect.
      if (/\bwrangler\s+dev\b/.test(cmd)) {
        cmd = /--port[=\s]+\d+/.test(cmd) ? cmd.replace(/--port[=\s]+\d+/, `--port ${port}`) : `${cmd} --port ${port}`;
        // Production data → bind the real CF resources with --remote (default
        // wrangler dev is LOCAL miniflare = isolated dev data).
        if (dataEnv === 'production' && !/--remote\b/.test(cmd)) cmd += ' --remote';
      }
      const tunnelPort = port;
      // emit = stream live AND buffer (so `preview.logs` can replay after a
      // console reload / when the server was already running).
      const logKey = app || 'preview';
      const emit = (channel, line) => { pushPreviewLog(logKey, channel, line); ctx.logLine(`preview:${logKey}:${channel}`, line); };
      // ALWAYS (re)start cleanly: tear down any process/tunnel we're tracking for
      // this app, then free the port — a leftover dev server (orphaned by a relay
      // restart, or a double-start) otherwise causes EADDRINUSE (exit 1). Net:
      // exactly one running dev server per app, never two. (Per owner request:
      // Start = restart.)
      if (pv) {
        try { pv.tunnel?.kill(); } catch { /* gone */ }
        killGroup(pv.proc);
        if (pv.tunnelId) void teardownNamedTunnel(pv.tunnelId, pv.tunnelHost);
        previews.delete(app);
        pv = undefined;
      }
      const freed = await freePort(tunnelPort);
      if (freed) emit('out', `freed port ${tunnelPort} (killed ${freed} leftover process${freed > 1 ? 'es' : ''}) before restart`);
      // Fresh run → reset this app's buffer so stale lines don't pile up.
      previewLog.set(logKey, []);
      // Ensure THIS pod's deps are installed (local.setup only installs the repo
      // root; each pod has its own node_modules — without it `wrangler` etc. are
      // missing and the dev server can't start).
      if (existsSync(path.join(cwd, 'package.json')) && !existsSync(path.join(cwd, 'node_modules'))) {
        emit('out', 'installing pod dependencies (npm install)…');
        await run('npm', ['install', '--no-audit', '--no-fund'], { cwd, timeout: 600_000 }).catch((e) => emit('err', `npm install failed: ${e.message}`));
      }
      emit('out', `starting: ${cmd}`);
      // Identity Phase 2: inject CORE_URL (tenant Core origin) + APP_ID so a
      // `core` pod can verify Core tokens locally exactly as it would in prod.
      const coreUrl = await fetchCoreUrl(path.basename(workspace)).catch(() => null);
      const binDir = path.join(cwd, 'node_modules/.bin');
      // Resolve the dev command's leading binary. If it's a bare CLI (e.g.
      // `wrangler`) that the pod did NOT install as a dependency — and isn't a
      // shell wrapper — run it via `npx --yes` so it's fetched/resolved on demand.
      // Without this, a scaffolded pod whose package.json declares `wrangler dev`
      // but not wrangler-as-a-dep fails with exit 127 (`command not found`).
      // Generic: works for any pod + any CLI, and npx prefers a pod-local/global
      // install when present.
      const lead = cmd.trim().split(/\s+/)[0];
      const wrapped = /^(npm|npx|node|bash|sh|pnpm|yarn|bun|\.|\/)/.test(lead);
      if (!wrapped && !existsSync(path.join(binDir, lead))) {
        emit('out', `'${lead}' is not installed in this pod — running it via npx`);
        cmd = `npx --yes ${cmd}`;
      }
      const env = {
        ...process.env, PORT: String(port),
        ...(coreUrl ? { CORE_URL: coreUrl } : {}), APP_ID: app || 'web',
        // JG_ENV drives the pod's read-only guard: 'prod' = production data,
        // read-only; 'prod-rw' = production with writes unlocked; 'dev' = local
        // isolated data, mutable. App code never reads this — only envGuard does.
        JG_ENV: dataEnv === 'production' ? (prodWrite ? 'prod-rw' : 'prod') : 'dev',
        PATH: `${binDir}:${process.env.PATH || ''}`,
      };
      if (dataEnv === 'production') emit('out', `⚠ PRODUCTION data (${prodWrite ? 'READ-WRITE' : 'read-only'}) — --remote bindings`);
      // We pass PATH in env AND re-export it inside the command. The env prefix
      // alone is not enough: `bash -lc` is a LOGIN shell, and on macOS /etc/profile
      // runs path_helper which RESETS PATH to the system default — wiping our
      // node_modules/.bin prefix before `cmd` ever runs (→ `wrangler: command not
      // found`, exit 127). Re-exporting inside the command runs AFTER profile init,
      // so the pod's local bins (wrangler, vite, etc.) resolve without a global install.
      const shellCmd = `export PATH="${binDir}:$PATH"; ${cmd}`;
      // detached → own process group, so killGroup() can take down bash +
      // wrangler + workerd together on stop/restart (prevents wrangler from
      // respawning workerd and re-grabbing the port → EADDRINUSE).
      const child = spawn('bash', ['-lc', shellCmd], { cwd, env, detached: true });
      // A spawn 'error' (e.g. bash missing) with no handler crashes the WHOLE
      // relay process — surface it as a log line instead.
      child.on('error', (e) => emit('err', `failed to start dev server: ${e.message}`));
      child.stdout.on('data', (b) => { for (const l of String(b).split('\n')) if (l) emit('out', l); });
      child.stderr.on('data', (b) => { for (const l of String(b).split('\n')) if (l) emit('err', l); });
      child.on('exit', (code) => emit('out', `[dev server exited ${code}]`));
      pv = { proc: child, tunnel: null, url: null, port: tunnelPort, tunnelId: null, tunnelHost: null, dataEnv, prodWrite };
      previews.set(app, pv);
      // Prefer a NAMED jaagaa.ai tunnel (jgc-<app>-<slug>-local.jaagaa.ai),
      // provisioned by jg-api + scoped to this one app. Fall back to a zero-
      // config quick tunnel (*.trycloudflare.com) if jg-api/CF is unavailable.
      // Tunnel logs stream on the :tunnel channel for the side-by-side view.
      try {
        const prov = await provisionNamedTunnel(path.basename(workspace), logKey, tunnelPort);
        const cf = spawn('cloudflared', ['tunnel', '--no-autoupdate', 'run', '--token', prov.token], { env: process.env });
        cf.stdout.on('data', (b) => { for (const l of String(b).split('\n')) if (l.trim()) emit('tunnel', l.trim()); });
        cf.stderr.on('data', (b) => { for (const l of String(b).split('\n')) if (l.trim()) emit('tunnel', l.trim()); });
        pv.tunnel = cf; pv.url = prov.host; pv.tunnelId = prov.tunnelId; pv.tunnelHost = prov.host;
        emit('tunnel', `named preview tunnel: ${prov.host} (a few seconds to route)`);
      } catch (e) {
        emit('tunnel', `named tunnel unavailable (${e.message}); using a quick tunnel`);
        const { url, proc } = await startTunnel(tunnelPort, (l) => emit('tunnel', l));
        pv.tunnel = proc; pv.url = url;
      }
      return { url };
    },
    'preview.restart': async (args, ctx) => { await table['preview.stop'](args); return table['preview.start'](args, ctx); },
    'preview.stop': async (args) => {
      const pv = previews.get(String(args.app || ''));
      if (pv) {
        try { pv.tunnel?.kill(); } catch { /* gone */ }
        killGroup(pv.proc);
        // Delete the named tunnel + DNS server-side (invalidates the run token).
        if (pv.tunnelId) void teardownNamedTunnel(pv.tunnelId, pv.tunnelHost);
        previews.delete(String(args.app || ''));
      }
      return { stopped: true };
    },
    // Replay the buffered log lines for an app (survives console reloads + the
    // already-running case). Shape: { app, lines:[{channel,line}] }.
    'preview.logs': async (args) => {
      const app = String(args?.app || '');
      return { app, lines: previewLog.get(app) ?? previewLog.get(app || 'preview') ?? [] };
    },
    'preview.status': async (args) => {
      // Same shape as jg-sandbox-runner: { app, running, ready, url, port }.
      // `ready` = the server answers on its port. We probe the port DIRECTLY
      // (off the tracked child OR the port the console passes) so a dev server
      // that's actually serving shows as running even when we're not tracking
      // its child object — e.g. after a relay restart orphaned it, or after a
      // browser refresh. That's what lets the console keep showing live
      // processes across reloads instead of resetting to idle.
      const app = String(args.app || '');
      const project = String(args.project || path.basename(workspace || '') || 'app');
      const pv = previews.get(app);
      // Probe THIS project's unique port (never a shared 8787), so a server from
      // another project can't make this pod look running.
      const port = pv?.port ?? stablePort(project, app);
      const ready = port ? await probePort(port) : false;
      const running = !!pv?.proc || ready;
      // Report the live data environment so the console can show the env badge
      // (Development / Production) + the read-only/write state.
      return { app, running, ready, url: pv?.url ?? null, port, dataEnv: pv?.dataEnv ?? null, prodWrite: pv?.prodWrite ?? false };
    },

    // --- publish (local wrangler) -----------------------------------------
    'site.build': async (args, ctx) => {
      const cwd = args.app ? resolveIn(args.app) : workspace;
      ctx.logLine('build', 'npm run build…');
      const { stdout, stderr } = await run('npm', ['run', 'build'], { cwd, timeout: 600_000 });
      return { ok: true, output: (stdout + stderr).slice(-2000) };
    },
    'site.deploy': async (args, ctx) => {
      const cwd = args.app ? resolveIn(args.app) : workspace;
      ctx.logLine('deploy', 'wrangler deploy…');
      const { stdout, stderr } = await run('npx', ['wrangler', 'deploy'], { cwd, timeout: 600_000 });
      const out = stdout + stderr;
      const url = (out.match(/https:\/\/[^\s]+\.workers\.dev[^\s]*/i) || [])[0] || null;
      // If this is the tenant's `web` MARKETING pod, tell jg-api so the core
      // worker binds POD_WEB and serves the homepage from the pod (not the baked
      // template). Detected from the pod's jaagaa.app.json tech, so it's generic
      // — no hardcoded app names. Best-effort: never fails the publish.
      let marketing = false;
      try {
        const m = JSON.parse(await readFile(path.join(cwd, 'jaagaa.app.json'), 'utf8'));
        marketing = String(m?.tech || '').toLowerCase() === 'marketing';
      } catch { /* no manifest / not marketing */ }
      if (marketing && url) {
        try {
          await notifyWebPodPublished(path.basename(workspace), url);
          ctx.logLine('deploy', 'homepage now served from this pod (POD_WEB bound)');
        } catch (e) {
          ctx.logLine('deploy', `published, but registering as live homepage failed: ${(e && e.message) || e}`);
        }
      }
      return { ok: true, url, output: out.slice(-2000) };
    },

    // --- agent chat (the user's OWN local CLI: claude / opencode / …) ------
    'agent.chat': async (args, ctx) => {
      const prompt = String(args.prompt || '').slice(0, 16000);
      if (!prompt) return { skipped: 'empty' };
      const app = /^[a-z][a-z0-9-]{0,30}$/.test(String(args.app || '')) ? String(args.app) : null;
      const cwd = app ? resolveIn(app) : workspace;
      const convId = /^[0-9a-f-]{8,40}$/i.test(String(args.conversationId || '')) ? String(args.conversationId) : null;
      const convName = typeof args.name === 'string' ? args.name.slice(0, 80) : null;
      const cli = /^(opencode|claude|codex|gemini)$/.test(String(args.cli || '')) ? String(args.cli) : 'claude';
      const model = /^[a-z0-9][a-z0-9._/-]{0,60}$/i.test(String(args.model || '')) ? String(args.model) : null;
      const key = convId || app || '__root__';
      const started = chatStarted.has(key);
      const { bin, argv } = buildAgentRun({ cli, prompt, convId, convName, resume: started, started, model });
      return await new Promise((resolve) => {
        let child;
        try { child = spawn(bin, argv, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }); }
        catch (e) { ctx.send({ type: 'agent-data', id: ctx.id, stream: 'stderr', data: Buffer.from(`failed to start ${bin}: ${e.message}`, 'utf8').toString('base64') }); return resolve({ ok: false }); }
        let sawOut = false;
        const stream = (s) => (d) => { if (s === 'stdout') sawOut = true; ctx.send({ type: 'agent-data', id: ctx.id, stream: s, data: Buffer.from(d).toString('base64') }); };
        child.stdout.on('data', stream('stdout'));
        child.stderr.on('data', stream('stderr'));
        child.on('error', (e) => { ctx.send({ type: 'agent-data', id: ctx.id, stream: 'stderr', data: Buffer.from(String(e.message), 'utf8').toString('base64') }); resolve({ ok: false }); });
        child.on('close', (code) => { if (code === 0 && sawOut) chatStarted.add(key); resolve({ exitCode: code }); });
      });
    },
  };

  function dispose() {
    for (const t of terms.values()) { try { t.close(); } catch { /* gone */ } }
    terms.clear();
    for (const r of procs.values()) { try { r.child?.kill(); } catch { /* gone */ } }
    procs.clear();
    for (const pv of previews.values()) {
      try { pv.tunnel?.kill(); } catch { /* gone */ }
      killGroup(pv.proc);
      if (pv.tunnelId) void teardownNamedTunnel(pv.tunnelId, pv.tunnelHost);
    }
    previews.clear();
  }

  return { table, dispose };
}
