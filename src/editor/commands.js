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
import { spawn, execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Terminal } from './terminal.js';

const LOCAL_ROOT = process.env.JG_LOCAL_ROOT || path.join(os.homedir(), 'Documents', 'Jaagaa-ai');

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
    if (err) { err.stderr = stderr; reject(err); } else resolve({ stdout: String(stdout), stderr: String(stderr) });
  });
});

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
    body: JSON.stringify({ project }),
  });
  if (!res.ok) throw new Error(`repo-token mint failed (${res.status})`);
  const j = await res.json();
  if (!j.url) throw new Error('repo-token: no url');
  return j.url; // https://x-access-token:<tok>@github.com/<org>/jgc-<project>.git
}
const stripToken = (url) => url.replace(/\/\/[^@/]+@/, '//'); // token-free remote

// Where the relay's stdout log lives (launchd StandardOutPath on macOS).
const RELAY_LOG = process.env.JG_RELAY_LOG
  || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Logs/jg-local-relay/out.log') : null);

export function makeEditorCommands({ ws, version }) {
  let workspace = null;            // absolute path of the active project dir
  const terms = new Map();         // termId -> Terminal
  const procs = new Map();         // name -> { child, logs:[] }
  const previews = new Map();      // app -> { proc, tunnel, url, port }
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
      const { stdout } = await run('git', ['-C', workspace, 'status', '--porcelain']);
      return { changes: stdout.split('\n').filter(Boolean).map((l) => ({ status: l.slice(0, 2).trim(), file: l.slice(3) })) };
    },
    'repo.status': async () => {
      const [branch, porcelain] = await Promise.all([
        run('git', ['-C', workspace, 'rev-parse', '--abbrev-ref', 'HEAD']).then((r) => r.stdout.trim()).catch(() => null),
        run('git', ['-C', workspace, 'status', '--porcelain']).then((r) => r.stdout).catch(() => ''),
      ]);
      return { branch, dirty: porcelain.split('\n').filter(Boolean).length };
    },
    'repo.push': async (args, ctx) => {
      const msg = args.message || 'Update from Jaagaa Local Editor';
      await run('git', ['-C', workspace, 'add', '-A']);
      await run('git', ['-C', workspace, 'commit', '-m', msg]).catch((e) => ctx.logLine('git', e.stderr || 'nothing to commit'));
      const branch = (await run('git', ['-C', workspace, 'rev-parse', '--abbrev-ref', 'HEAD']).then((r) => r.stdout.trim()).catch(() => 'main')) || 'main';
      // Push via a fresh scoped token URL inline — never persisted in git config.
      const project = path.basename(workspace);
      const scopedUrl = await mintCloneUrl(project);
      const { stdout, stderr } = await run('git', ['-C', workspace, 'push', scopedUrl, `HEAD:${branch}`], { timeout: 180_000 });
      return { ok: true, output: (stdout + stderr).trim().slice(0, 1000) };
    },

    // --- preview (local dev server + cloudflared tunnel) ------------------
    'preview.start': async (args, ctx) => {
      const app = String(args.app || '');
      const port = Number(args.port) || 8787;
      const cwd = app ? resolveIn(app) : workspace;
      let pv = previews.get(app);
      if (pv?.url) return { url: pv.url, already: true };
      // dev server
      const child = spawn(args.cmd || 'npm', args.devArgs || ['run', 'dev'], { cwd, env: { ...process.env, PORT: String(port) } });
      child.stdout.on('data', (b) => { for (const l of String(b).split('\n')) if (l) ctx.logLine(`${app || 'preview'}:out`, l); });
      child.stderr.on('data', (b) => { for (const l of String(b).split('\n')) if (l) ctx.logLine(`${app || 'preview'}:err`, l); });
      pv = { proc: child, tunnel: null, url: null, port };
      previews.set(app, pv);
      const { url, proc } = await startTunnel(port, (l) => ctx.logLine(`${app || 'preview'}:tunnel`, l));
      pv.tunnel = proc; pv.url = url;
      return { url };
    },
    'preview.restart': async (args, ctx) => { await table['preview.stop'](args); return table['preview.start'](args, ctx); },
    'preview.stop': async (args) => {
      const pv = previews.get(String(args.app || ''));
      if (pv) { try { pv.tunnel?.kill(); } catch { /* gone */ } try { pv.proc?.kill(); } catch { /* gone */ } previews.delete(String(args.app || '')); }
      return { stopped: true };
    },
    'preview.status': async (args) => { const pv = previews.get(String(args.app || '')); return { running: !!pv?.proc, url: pv?.url ?? null }; },

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
    for (const pv of previews.values()) { try { pv.tunnel?.kill(); } catch { /* gone */ } try { pv.proc?.kill(); } catch { /* gone */ } }
    previews.clear();
  }

  return { table, dispose };
}
