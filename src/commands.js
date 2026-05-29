// commands.js — local executors the relay runs on behalf of the control-plane.
// Each command is `async (args, ctx) => data`. ctx.send(msg) lets long-running
// commands stream {type:'log', id, line} frames before the final result.
//
// Start small + safe; grow this to full parity with the manager's local actions
// (pm2 start/stop/restart, logs.tail, tunnel.start/stop, git.*, env.read/write).

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';

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
  // the relay pill.
  async 'agent.version'() {
    return { version: process.env.npm_package_version || '0.1.0' };
  },
};
