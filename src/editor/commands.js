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

export function makeEditorCommands({ ws }) {
  let workspace = null;            // absolute path of the active project dir
  const terms = new Map();         // termId -> Terminal
  const procs = new Map();         // name -> { child, logs:[] }
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
      let action;
      if (existsSync(path.join(dest, '.git'))) {
        await run('git', ['-C', dest, 'fetch', '--quiet']).catch(() => {});
        action = 'updated';
      } else {
        if (!args.repoUrl) throw new Error('local.setup needs { repoUrl } for a first clone');
        ctx.logLine('setup', `cloning ${project} → ${dest}`);
        await run('git', ['clone', '--quiet', '--branch', branch, args.repoUrl, dest], { timeout: 300_000 });
        action = 'cloned';
      }
      workspace = dest;
      if (args.install !== false && existsSync(path.join(dest, 'package.json'))) {
        ctx.logLine('setup', 'installing dependencies (npm install)…');
        await run('npm', ['install'], { cwd: dest, timeout: 600_000 }).catch((e) => ctx.logLine('setup', `npm install warning: ${e.message}`));
      }
      return { ok: true, project, workspace, action };
    },
    'session.info': async () => ({ workspace, root: LOCAL_ROOT, terms: terms.size, procs: [...procs.keys()] }),

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
      const abs = resolveIn(args?.path || '');
      const ents = await readdir(abs, { withFileTypes: true });
      return {
        path: args?.path || '',
        entries: ents
          .filter((e) => e.name !== '.git' && e.name !== 'node_modules')
          .map((e) => ({ name: e.name, dir: e.isDirectory() }))
          .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1)),
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
      const { stdout, stderr } = await run('git', ['-C', workspace, 'push'], { timeout: 180_000 });
      return { ok: true, output: (stdout + stderr).trim().slice(0, 1000) };
    },

    // --- not wired yet (M3/M4) — explicit so the surface is discoverable ---
    'preview.start': async () => { throw new Error('preview not wired in local mode yet (M3 — reuse relay tunnel.*)'); },
    'preview.stop': async () => { throw new Error('preview not wired in local mode yet (M3)'); },
    'preview.status': async () => ({ running: false, note: 'local preview wiring is M3' }),
    'site.build': async () => { throw new Error('site.build not wired in local mode yet (M4 — local wrangler)'); },
    'site.deploy': async () => { throw new Error('site.deploy not wired in local mode yet (M4 — local wrangler)'); },
    'agent.chat': async () => { throw new Error('agent.chat not wired in local mode yet (M4 — drives your local `claude`)'); },
  };

  function dispose() {
    for (const t of terms.values()) { try { t.close(); } catch { /* gone */ } }
    terms.clear();
    for (const r of procs.values()) { try { r.child?.kill(); } catch { /* gone */ } }
    procs.clear();
  }

  return { table, dispose };
}
