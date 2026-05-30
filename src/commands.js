// commands.js — local executors the relay runs on behalf of the control-plane.
// Each command is `async (args, ctx) => data`. ctx.send(msg) lets long-running
// commands stream {type:'log', id, line} frames before the final result.
//
// Start small + safe; grow this to full parity with the manager's local actions
// (pm2 start/stop/restart, logs.tail, tunnel.start/stop, git.*, env.read/write).

import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

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
