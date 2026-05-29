// commands.js — local executors the relay runs on behalf of the control-plane.
// Each command is `async (args, ctx) => data`. ctx.send(msg) lets long-running
// commands stream {type:'log', id, line} frames before the final result.
//
// Start small + safe; grow this to full parity with the manager's local actions
// (pm2 start/stop/restart, logs.tail, tunnel.start/stop, git.*, env.read/write).

import { execFile } from 'node:child_process';
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
};
