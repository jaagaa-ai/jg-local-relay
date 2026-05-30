// commands.js — local executors the relay runs on behalf of the control-plane.
// Each command is `async (args, ctx) => data`. ctx.send(msg) lets long-running
// commands stream {type:'log', id, line} frames before the final result.
//
// Start small + safe; grow this to full parity with the manager's local actions
// (pm2 start/stop/restart, logs.tail, tunnel.start/stop, git.*, env.read/write).

import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, watch as fsWatch, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

// Per-cwd fs.watch state for git.status push notifications. Keyed by
// cwd. Each entry: { watchers:FSWatcher[], debounce:Timeout|null, ctx,
// last:{branch,dirty,ahead,behind} }. Only one watcher per cwd no
// matter how many cp clients ask for git.status — re-issuing on the
// same cwd just refreshes the ctx so cp's latest connection wins.
const _gitWatchers = new Map();

async function _probeGitStatus(cwd) {
  const out = { branch: null, dirty: false, ahead: 0, behind: 0 };
  try {
    const br = await run('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 4000 });
    out.branch = br.stdout.trim() || null;
  } catch (_) { /* non-git cwd is fine */ }
  try {
    const pc = await run('git', ['-C', cwd, 'status', '--porcelain'], { timeout: 4000 });
    out.dirty = pc.stdout.trim().length > 0;
  } catch (_) {}
  try {
    const rl = await run('git', ['-C', cwd, 'rev-list', '--left-right', '--count', '@{u}...HEAD'], { timeout: 4000 });
    const [behind, ahead] = rl.stdout.trim().split(/\s+/).map((n) => parseInt(n, 10) || 0);
    out.behind = behind || 0;
    out.ahead = ahead || 0;
  } catch (_) {}
  return out;
}

function _startGitWatcher(cwd, ctx, initial) {
  const existing = _gitWatchers.get(cwd);
  if (existing) {
    existing.ctx = ctx;
    existing.last = initial;
    return;
  }
  const watchers = [];
  // Watch points: .git/HEAD (branch switches), .git/index (staged/unstaged
  // changes), .git/refs (commits/fetches). fs.watch on macOS uses FSEvents
  // — cheap and silent until something changes.
  const gitDir = path.join(cwd, '.git');
  if (!existsSync(gitDir)) return; // non-git cwd
  const targets = [
    path.join(gitDir, 'HEAD'),
    path.join(gitDir, 'index'),
    path.join(gitDir, 'refs'),
  ];
  const state = { watchers, debounce: null, ctx, last: initial };
  _gitWatchers.set(cwd, state);
  const fire = () => {
    if (state.debounce) clearTimeout(state.debounce);
    // 400ms debounce — git operations touch multiple files in quick
    // succession (HEAD + index + refs/heads/main can flip all at once
    // on a `git pull`). Without this we'd fire 3-5 redundant probes
    // per single user action.
    state.debounce = setTimeout(async () => {
      state.debounce = null;
      try {
        const next = await _probeGitStatus(cwd);
        // Only push if something actually changed — avoids waking cp
        // for fs.watch noise like .git/index lock file flickering.
        const prev = state.last;
        if (next.branch !== prev.branch || next.dirty !== prev.dirty ||
            next.ahead !== prev.ahead || next.behind !== prev.behind) {
          state.last = next;
          try { state.ctx?.send?.({ type: 'git-status', cwd, ...next }); } catch (_) {}
        }
      } catch (_) {}
    }, 400);
  };
  for (const t of targets) {
    try {
      // recursive:true so .git/refs/heads/* changes also bubble up.
      const w = fsWatch(t, { persistent: false, recursive: t.endsWith('refs') }, fire);
      w.on('error', () => {});
      watchers.push(w);
    } catch (_) {}
  }
}

// Same package.json read as src/index.js — keeps a single source of
// truth so `agent.version` matches what cp displays in the relay pill.
const _pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const VERSION = (() => {
  try { return JSON.parse(readFileSync(_pkgPath, 'utf8'))?.version || '0.0.0'; }
  catch { return '0.0.0'; }
})();

// Track long-running background processes (tunnels, log tails) so we
// can `pgrep`-list them, stop them by name, and clean up on disconnect.
const _backgroundProcs = new Map(); // key → child_process

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stdout, stderr }));
      resolve({ stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '' });
    });
  });
}

export const commands = {
  // Liveness probe — the cp uses this to confirm a relay is responsive.
  async ping() {
    return { pong: true, ts: Date.now() };
  },

  // Machine facts so the cp can show which host/user a relay represents.
  async 'sys.info'() {
    return {
      hostname: os.hostname(),
      user: os.userInfo().username,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      uptimeSec: Math.round(process.uptime()),
      loadavg: os.loadavg(),
      totalmem: os.totalmem(),
      freemem: os.freemem(),
    };
  },

  // Local PM2 process list (parity with the manager's local cards). Returns
  // the raw `pm2 jlist` JSON so the cp can feed it through its existing
  // mapPm2Process() without a parallel mapper. Resolve the pm2 binary via
  // JG_PM2_BIN, else PATH `pm2`.
  // Clone (or update) a repo onto the user's local disk. Called by cp
  // when an admin grants this user access to a new repository. Idempotent:
  // if `dest` already has a .git dir we fetch + (optional) checkout
  // instead of cloning, so re-granting an existing repo is harmless.
  //
  // Cross-platform: uses node:fs.mkdirSync ({ recursive: true }) for the
  // parent dir, git CLI for clone/fetch. Works on Mac, Linux, Windows
  // (git is the only external requirement; if cloudflared is installed
  // for tunnels then git almost certainly is too).
  async 'repo.clone'({ slug, url, dest, branch } = {}) {
    if (!url || typeof url !== 'string')  throw new Error('repo.clone requires `url`');
    if (!dest || typeof dest !== 'string') throw new Error('repo.clone requires `dest`');
    if (existsSync(path.join(dest, '.git'))) {
      try { await run('git', ['-C', dest, 'fetch', '--quiet'], { timeout: 60_000 }); } catch (_) {}
      if (branch) {
        try { await run('git', ['-C', dest, 'checkout', branch], { timeout: 10_000 }); } catch (_) {}
      }
      return { ok: true, slug: slug || null, dest, action: 'updated' };
    }
    const parent = path.dirname(dest);
    try { mkdirSync(parent, { recursive: true }); } catch (_) {}
    const args = ['clone', '--quiet'];
    if (branch) args.push('--branch', branch);
    args.push(url, dest);
    await run('git', args, { timeout: 180_000 });
    return { ok: true, slug: slug || null, dest, action: 'cloned' };
  },

  // Remove a local repo from disk. Called by cp when an admin revokes
  // this user's access. Safety checks: refuse obviously-wrong paths
  // (root, homedir, short paths), refuse dirs with uncommitted changes
  // unless `force=true`, refuse dirs that are the cwd of a running pm2
  // process unless `force=true`. fs.rmSync is cross-platform.
  async 'repo.wipe'({ dest, force } = {}) {
    if (!dest || typeof dest !== 'string') throw new Error('repo.wipe requires `dest`');
    const abs = path.resolve(dest);
    const unsafe = ['/', '/Users', '/home', '/root', os.homedir(), path.dirname(os.homedir())];
    if (abs.length < 10 || unsafe.includes(abs)) {
      throw new Error(`repo.wipe refused: ${abs} looks unsafe`);
    }
    if (!existsSync(abs)) return { ok: true, dest: abs, action: 'not_present' };

    // Uncommitted-changes guard.
    if (!force && existsSync(path.join(abs, '.git'))) {
      try {
        const { stdout } = await run('git', ['-C', abs, 'status', '--porcelain'], { timeout: 4_000 });
        if (stdout.trim().length > 0) {
          return {
            ok: false, dest: abs, action: 'has_uncommitted',
            error: 'Uncommitted changes present — re-run with force=true to override.',
          };
        }
      } catch (_) { /* not git or git missing — fall through */ }
    }

    // Running-process guard. If a pm2 process is currently online with
    // this dir as its cwd, refuse unless forced.
    if (!force) {
      try {
        const bin = process.env.JG_PM2_BIN || 'pm2';
        const { stdout } = await run(bin, ['jlist'], { timeout: 4_000 });
        const procs = JSON.parse(stdout || '[]');
        const running = procs.find((p) =>
          p?.pm2_env?.pm_cwd === abs && p?.pm2_env?.status === 'online');
        if (running) {
          return {
            ok: false, dest: abs, action: 'process_running',
            error: `${running.name} is running from this dir — stop it first or re-run with force=true.`,
          };
        }
      } catch (_) { /* tolerate missing pm2 */ }
    }

    // Also stop any active git.status watcher for this cwd before wipe.
    const w = _gitWatchers.get(abs);
    if (w) {
      for (const wt of w.watchers) { try { wt.close(); } catch (_) {} }
      _gitWatchers.delete(abs);
    }

    try {
      rmSync(abs, { recursive: true, force: true });
    } catch (e) {
      throw new Error(`repo.wipe failed: ${e.message}`);
    }
    return { ok: true, dest: abs, action: 'wiped' };
  },

  async 'pm2.list'() {
    const bin = process.env.JG_PM2_BIN || 'pm2';
    const { stdout } = await run(bin, ['jlist']);
    return JSON.parse(stdout || '[]');
  },

  // Start a process by name. If pm2 already knows the app (it has been
  // registered previously by some ecosystem), `pm2 start <name>` is enough.
  // For a cold start of a brand-new app, cp must pass `ecosystem` (absolute
  // path on this host) so we can `pm2 start <ecosystem> --only <name>`.
  async 'pm2.start'({ name, ecosystem } = {}) {
    if (!name || typeof name !== 'string') throw new Error('pm2.start requires `name`');
    const bin = process.env.JG_PM2_BIN || 'pm2';
    const args = ecosystem
      ? ['start', ecosystem, '--only', name, '--update-env']
      : ['start', name, '--update-env'];
    const { stdout, stderr } = await run(bin, args);
    return { ok: true, name, stdout: stdout.slice(-400), stderr: stderr.slice(-400) };
  },

  async 'pm2.stop'({ name } = {}) {
    if (!name || typeof name !== 'string') throw new Error('pm2.stop requires `name`');
    const bin = process.env.JG_PM2_BIN || 'pm2';
    const { stdout, stderr } = await run(bin, ['stop', name]);
    return { ok: true, name, stdout: stdout.slice(-400), stderr: stderr.slice(-400) };
  },

  async 'pm2.restart'({ name } = {}) {
    if (!name || typeof name !== 'string') throw new Error('pm2.restart requires `name`');
    const bin = process.env.JG_PM2_BIN || 'pm2';
    const { stdout, stderr } = await run(bin, ['restart', name, '--update-env']);
    return { ok: true, name, stdout: stdout.slice(-400), stderr: stderr.slice(-400) };
  },

  // Git branch + dirty flag for a working tree. cp enriches LocalCard
  // entries with these so the hosted dashboard shows the same branch
  // chip the localhost manager does. Tolerates non-git or missing cwds
  // by returning a soft `null` instead of throwing.
  async 'git.branch'({ cwd } = {}) {
    if (!cwd || typeof cwd !== 'string') throw new Error('git.branch requires `cwd`');
    try {
      const { stdout } = await run('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 4000 });
      return { branch: stdout.trim() || null };
    } catch { return { branch: null }; }
  },

  async 'git.dirty'({ cwd } = {}) {
    if (!cwd || typeof cwd !== 'string') throw new Error('git.dirty requires `cwd`');
    try {
      const { stdout } = await run('git', ['-C', cwd, 'status', '--porcelain'], { timeout: 4000 });
      return { dirty: stdout.trim().length > 0 };
    } catch { return { dirty: false }; }
  },

  // Push-only git status. Returns an initial snapshot + sets up an
  // fs.watch on .git/HEAD + .git/index so the relay can push a frame
  // when (and ONLY when) the user's repo state actually changes —
  // a branch switch, a commit, a `git pull`, a file save that flips
  // dirty/clean. cp registers a consumer keyed by command id and
  // updates its cache off the pushed frames; zero polling either side.
  async 'git.status'({ cwd } = {}, ctx) {
    if (!cwd || typeof cwd !== 'string') throw new Error('git.status requires `cwd`');
    const initial = await _probeGitStatus(cwd);
    _startGitWatcher(cwd, ctx, initial);
    return initial;
  },

  // Open a folder/file in the OS's native file browser. Used by the
  // hosted Local-tab folder chip — without this, /api/open-folder ran
  // against cp's container filesystem and was useless from the browser.
  // Mac uses `open`, Linux uses `xdg-open`, Windows uses `explorer`.
  async 'fs.open'({ path } = {}) {
    if (!path || typeof path !== 'string') throw new Error('fs.open requires `path`');
    const plat = process.platform;
    const cmd = plat === 'darwin' ? 'open' : plat === 'win32' ? 'explorer' : 'xdg-open';
    try {
      await run(cmd, [path], { timeout: 4000 });
      return { ok: true };
    } catch (e) {
      // `explorer` on Windows exits 1 even on success — treat as ok.
      if (plat === 'win32') return { ok: true };
      throw e;
    }
  },

  // Cheap "does this path exist on the user's Mac?" check. cp uses it
  // to decide whether to render `folder_open` (exists) vs `folder_off`
  // (deleted) instead of forcing repo_status='ok' for every chip.
  async 'fs.exists'({ path } = {}) {
    if (!path || typeof path !== 'string') throw new Error('fs.exists requires `path`');
    return { exists: existsSync(path) };
  },

  // Agent's own package.json version. cp polls this to decide whether
  // a newer release is available and to surface "update available" in
  // the relay pill. `npm_package_version` is only set when run via npm
  // lifecycle scripts (start/dev), NOT under launchd/systemd — so the
  // previous fallback "0.3.0" was being reported forever in prod.
  async 'agent.version'() {
    return { version: VERSION };
  },

  // Streaming pm2 log tail. Spawns `pm2 logs NAME --raw --lines 0` and
  // forwards stdout/stderr line by line via ctx.send({type:'log', line})
  // frames. ctx is the same object the WSS handler uses, so cp can
  // forward each frame to the dashboard's /logs websocket.
  // Single concurrent stream per process name — re-issuing kills the
  // prior tail. Returns immediately; ctx.send keeps emitting until
  // pm2.logs.stop or relay disconnect.
  async 'pm2.logs.tail'({ name } = {}, ctx) {
    if (!name || typeof name !== 'string') throw new Error('pm2.logs.tail requires `name`');
    const bin = process.env.JG_PM2_BIN || 'pm2';
    const key = `logs:${name}`;
    const prev = _backgroundProcs.get(key);
    if (prev) { try { prev.kill('SIGTERM'); } catch (_) {} }
    // --lines 100 flushes the last 100 historical lines BEFORE following new
    // ones. With --lines 0 (the prior default) pm2 only emitted brand-new
    // lines, so the user saw "waiting for log lines…" whenever the proc
    // was idle — even when the log file was full of useful past output.
    const child = spawn(bin, ['logs', name, '--raw', '--lines', '100'], { stdio: ['ignore', 'pipe', 'pipe'] });
    _backgroundProcs.set(key, child);
    // Without this, a missing pm2 binary fires 'error' on the child and —
    // because spawn has no default error handler — crashes the whole relay
    // process. launchd would restart us a few seconds later but every
    // command in flight would already be lost.
    child.on('error', (err) => {
      _backgroundProcs.delete(key);
      try { ctx?.send?.({ type: 'log', id: ctx?.id, stream: 'err', line: `[relay] pm2 spawn failed: ${err.message}` }); } catch (_) {}
    });
    // Include the command id in every log frame so cp can correlate
    // multiple concurrent log tails to the right WSS client.
    const cmdId = ctx?.id;
    const onLine = (stream) => (chunk) => {
      const lines = chunk.toString('utf8').split(/\r?\n/);
      for (const line of lines) {
        if (!line) continue;
        try { ctx?.send?.({ type: 'log', id: cmdId, stream, line }); } catch (_) {}
      }
    };
    child.stdout.on('data', onLine('out'));
    child.stderr.on('data', onLine('err'));
    child.on('exit', () => { _backgroundProcs.delete(key); });
    return { ok: true, name, streaming: true };
  },

  async 'pm2.logs.stop'({ name } = {}) {
    if (!name) throw new Error('pm2.logs.stop requires `name`');
    const c = _backgroundProcs.get(`logs:${name}`);
    if (!c) return { ok: true, stopped: false };
    try { c.kill('SIGTERM'); } catch (_) {}
    _backgroundProcs.delete(`logs:${name}`);
    return { ok: true, stopped: true };
  },

  // Tunnel management — relays' Mac runs cloudflared. We track named
  // tunnels we've spawned ourselves and parse pgrep to surface any
  // pre-existing cloudflared processes the user started outside cp.
  async 'tunnel.list'() {
    const out = await run('pgrep', ['-af', 'cloudflared']).catch(() => ({ stdout: '' }));
    const lines = (out.stdout || '').split(/\r?\n/).filter(Boolean);
    const tunnels = [];
    for (const line of lines) {
      const [pidStr, ...rest] = line.split(/\s+/);
      const cmd = rest.join(' ');
      // Match `cloudflared tunnel run <NAME>` or `--name <NAME>`.
      const m = cmd.match(/tunnel\s+(?:--config\s+\S+\s+)?run\s+([^\s]+)/)
             || cmd.match(/--name\s+([^\s]+)/);
      if (m) tunnels.push({ pid: parseInt(pidStr, 10), name: m[1], running: true });
    }
    // Add any tracked tunnels that pgrep missed (race condition).
    for (const [key, child] of _backgroundProcs) {
      if (!key.startsWith('tunnel:')) continue;
      const name = key.slice('tunnel:'.length);
      if (!tunnels.some(t => t.name === name)) {
        tunnels.push({ pid: child.pid, name, running: child.exitCode === null });
      }
    }
    return { tunnels };
  },

  async 'tunnel.start'({ name } = {}) {
    if (!name || typeof name !== 'string') throw new Error('tunnel.start requires `name`');
    const key = `tunnel:${name}`;
    if (_backgroundProcs.has(key)) return { ok: true, alreadyRunning: true, name };
    const bin = process.env.JG_CLOUDFLARED_BIN || 'cloudflared';
    const child = spawn(bin, ['tunnel', 'run', name], { stdio: ['ignore', 'pipe', 'pipe'], detached: false });
    _backgroundProcs.set(key, child);
    child.on('error', (err) => {
      _backgroundProcs.delete(key);
      console.warn(`[tunnel] ${name} spawn failed: ${err.message}`);
    });
    child.on('exit', (code) => {
      _backgroundProcs.delete(key);
      console.log(`[tunnel] ${name} exited code=${code}`);
    });
    return { ok: true, name, pid: child.pid };
  },

  async 'tunnel.stop'({ name } = {}) {
    if (!name) throw new Error('tunnel.stop requires `name`');
    const child = _backgroundProcs.get(`tunnel:${name}`);
    if (child) {
      try { child.kill('SIGTERM'); } catch (_) {}
      _backgroundProcs.delete(`tunnel:${name}`);
      return { ok: true, stopped: true, name };
    }
    // Not started by us — try pkill by name.
    await run('pkill', ['-f', `cloudflared.*${name}`]).catch(() => {});
    return { ok: true, stopped: true, name, viaPkill: true };
  },
};
