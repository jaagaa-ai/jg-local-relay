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

// Per-tunnel ring buffer of recent stdout/stderr lines so a subscriber
// arriving after tunnel.start gets the last ~200 lines as history
// (parity with pm2.logs.tail's --lines 100 behavior). Each entry is
// {stream:'out'|'err', line:string}.
const _tunnelLogBuffers = new Map(); // name → Array<{stream, line}>
const _TUNNEL_LOG_CAP   = 200;

// Live subscribers per tunnel. tunnel.start fans every new line out to
// every entry in the matching set. Each entry is {ctx, send} where send
// is a pre-bound `(stream, line) => ctx.send({type:'log', id, stream, line})`.
const _tunnelLogSubs = new Map(); // name → Set<{ctx, send}>

// ─── Self-log buffer ─────────────────────────────────────────────────────────
// Capture the relay's own stdout/stderr (everything its `log()`, `console.log`,
// `console.warn`, `console.error` calls produce) into an in-memory ring buffer
// and fan it out to any active relay.logs.tail subscriber. Lets the dashboard's
// log pane show "what the relay itself is doing" — install issues, command
// errors, reconnect chatter — without the user SSH'ing into ~/Library/Logs.
//
// The console patch is a side effect at module load so anything that prints
// after this file is `require()`d gets captured. Early boot lines (before
// commands.js loads) are NOT captured — they're only in the launchd file
// logs. In practice this misses the first ~100ms of startup, which is fine.
const _selfLogBuffer = [];      // Array<{stream, line, ts}>
const _SELF_LOG_CAP  = 500;
const _selfLogSubs   = new Set(); // Set<{ctx, send}>

function _pushSelfLog(stream, raw) {
  // Split on newlines so multi-line console.log calls render one frame per line.
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line) continue;
    const entry = { stream, line, ts: Date.now() };
    _selfLogBuffer.push(entry);
    if (_selfLogBuffer.length > _SELF_LOG_CAP) {
      _selfLogBuffer.splice(0, _selfLogBuffer.length - _SELF_LOG_CAP);
    }
    for (const { send } of _selfLogSubs) {
      try { send(stream, line); } catch (_) { /* ignore */ }
    }
  }
}

(function _patchConsole() {
  // Keep references to the real console methods so we still write to stdout
  // (launchd captures it for the on-disk log files).
  const origLog  = console.log.bind(console);
  const origInfo = console.info.bind(console);
  const origWarn = console.warn.bind(console);
  const origErr  = console.error.bind(console);
  const fmt = (args) => args.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
  console.log   = (...args) => { _pushSelfLog('out', fmt(args)); origLog(...args); };
  console.info  = (...args) => { _pushSelfLog('out', fmt(args)); origInfo(...args); };
  console.warn  = (...args) => { _pushSelfLog('err', fmt(args)); origWarn(...args); };
  console.error = (...args) => { _pushSelfLog('err', fmt(args)); origErr(...args); };
})();

// Build the platform-specific helper script for relay self-management.
// Each script: (1) waits ~2s so the relay ACK can land, (2) performs the
// launchctl / systemctl / schtasks operation, (3) for uninstall also wipes
// installed files + logs. Returns { interpreter, args } describing how to
// spawn it.
function _selfMgmtScript(op) {
  const platform = process.platform;
  if (platform === 'darwin') {
    // macOS LaunchAgent uid = process.getuid(); fall back to env if needed.
    const uid = (typeof process.getuid === 'function' && process.getuid()) || process.env.UID || 501;
    const LABEL = 'ai.jaagaa.localrelay';
    const PLIST = `${os.homedir()}/Library/LaunchAgents/${LABEL}.plist`;
    const APP   = `${os.homedir()}/Library/Application Support/jg-local-relay`;
    const LOGS  = `${os.homedir()}/Library/Logs/jg-local-relay`;
    let body = '';
    if (op === 'restart') {
      // kickstart -k = stop-then-start; KeepAlive brings it back if it dies.
      body = `launchctl kickstart -k gui/${uid}/${LABEL}`;
    } else if (op === 'stop') {
      // bootout cancels the agent for THIS session; disable persists across
      // logins so KeepAlive doesn't immediately respawn it on next login.
      body = `launchctl bootout gui/${uid}/${LABEL} 2>/dev/null; launchctl disable gui/${uid}/${LABEL} 2>/dev/null`;
    } else if (op === 'uninstall') {
      body = `launchctl bootout gui/${uid}/${LABEL} 2>/dev/null; rm -f '${PLIST}'; rm -rf '${APP}'; rm -rf '${LOGS}'`;
    }
    return {
      interpreter: '/bin/sh',
      args: ['-c', `(sleep 2; ${body}) &`],
    };
  }
  if (platform === 'linux') {
    const UNIT = 'jg-local-relay.service';
    let body = '';
    if (op === 'restart') body = `systemctl --user restart ${UNIT}`;
    else if (op === 'stop') body = `systemctl --user stop ${UNIT}; systemctl --user disable ${UNIT}`;
    else if (op === 'uninstall') {
      const UNITF = `${os.homedir()}/.config/systemd/user/${UNIT}`;
      const APP   = `${os.homedir()}/.local/share/jg-local-relay`;
      const LOGS  = `${os.homedir()}/.local/state/jg-local-relay`;
      body = `systemctl --user disable --now ${UNIT} 2>/dev/null; rm -f '${UNITF}'; rm -rf '${APP}'; rm -rf '${LOGS}'; systemctl --user daemon-reload`;
    }
    return {
      interpreter: '/bin/sh',
      args: ['-c', `(sleep 2; ${body}) &`],
    };
  }
  if (platform === 'win32') {
    const TASK = 'JgLocalRelay';
    const APP  = `${process.env.LOCALAPPDATA}\\jg-local-relay`;
    let body = '';
    if (op === 'restart') {
      body = `schtasks /End /TN "${TASK}"; Start-Sleep -Seconds 1; schtasks /Run /TN "${TASK}"`;
    } else if (op === 'stop') {
      body = `schtasks /End /TN "${TASK}"; schtasks /Change /TN "${TASK}" /DISABLE`;
    } else if (op === 'uninstall') {
      body = `schtasks /End /TN "${TASK}" 2>$null; schtasks /Delete /TN "${TASK}" /F 2>$null; Remove-Item -Recurse -Force "${APP}" -ErrorAction SilentlyContinue`;
    }
    return {
      interpreter: 'powershell.exe',
      args: ['-NoProfile', '-Command', `Start-Sleep -Seconds 2; ${body}`],
    };
  }
  throw new Error(`unsupported platform: ${platform}`);
}

// Build the platform-specific self-update script. We don't pull from npm —
// the relay isn't published there. Instead we re-run cp's install script
// (install-relay.sh on Mac/Linux, install-relay.ps1 on Windows), which
// downloads the freshest bundle from cp.jaagaa.ai/relay-bundle.tar.gz,
// extracts over the existing install dir, npm-installs deps, rewrites the
// LaunchAgent / systemd unit, and reloads — exactly what manual re-install
// does, just without the user copy-pasting.
//
// Env vars (JG_RELAY_TOKEN, JG_CP_URL, JG_RELAY_PROJECTS, JG_RELAY_ID) are
// already in our process env (set by the LaunchAgent plist), so the install
// script picks them up non-interactively. Detached so this relay process
// can reply OK and exit cleanly when launchctl bootout fires inside the
// installer.
function _selfUpdateScript(_version) {
  // Derive https endpoint from JG_CP_URL (wss://cp.jaagaa.ai/relay →
  // https://cp.jaagaa.ai). Fallback to prod cp if unset.
  const cpWs   = process.env.JG_CP_URL || 'wss://cp.jaagaa.ai/relay';
  const cpHttp = cpWs.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:').replace(/\/relay\/?$/, '');
  const platform = process.platform;
  if (platform === 'darwin' || platform === 'linux') {
    const url = `${cpHttp}/install-relay.sh`;
    // sh -c: 2s preamble so we can return OK before our process is replaced.
    // -fsSL: fail on HTTP error, silent, follow redirects.
    // -H Authorization: cp gates /install-relay.sh on the per-user token.
    // | sh: pipe straight into install. JG_RELAY_TOKEN/JG_CP_URL/PROJECTS
    // env-vars are already in our process env and inherit to the sh child,
    // so install runs non-interactively.
    return {
      interpreter: '/bin/sh',
      args: ['-c', `(sleep 2; curl -fsSL "${url}" -H "Authorization: Bearer $JG_RELAY_TOKEN" | sh) >/dev/null 2>&1 &`],
    };
  }
  if (platform === 'win32') {
    const url = `${cpHttp}/install-relay.ps1`;
    return {
      interpreter: 'powershell.exe',
      args: ['-NoProfile', '-Command', `Start-Sleep -Seconds 2; iwr "${url}" -Headers @{Authorization="Bearer $env:JG_RELAY_TOKEN"} -UseBasicParsing | iex`],
    };
  }
  throw new Error(`unsupported platform: ${platform}`);
}

function _spawnSelfMgmtScript(op, script) {
  // Fully detach so the helper outlives this relay process. unref() lets
  // the relay exit naturally if the script's parent group is gone, and
  // stdio:'ignore' decouples its file descriptors from ours.
  try {
    const child = spawn(script.interpreter, script.args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return { ok: true, op, scheduled: true, willTerminate: op !== 'restart' || process.platform !== 'darwin' };
  } catch (err) {
    return { ok: false, op, error: err.message };
  }
}

// Parse the cloudflared tunnel name out of a full command line.
// cloudflared accepts:
//   `cloudflared tunnel run <NAME>`
//   `cloudflared tunnel run --url http://localhost:7050 <NAME>`
//   `cloudflared tunnel --config <path> run <NAME>`
//   `cloudflared tunnel --credentials-file <path> run --url http://... <UUID>`
//   `cloudflared tunnel run --name <NAME>` (rare)
// The tunnel name is the LAST positional argument after `run` (a token
// that isn't a flag and doesn't follow a flag that takes a value).
function _parseCloudflaredTunnelName(cmd) {
  const runIdx = cmd.search(/\srun(\s|$)/);
  if (runIdx < 0) {
    const m = cmd.match(/--name[=\s]+(\S+)/);
    return m ? m[1] : null;
  }
  const tail = cmd.slice(runIdx).trim().split(/\s+/).slice(1); // drop the "run"
  let last = null;
  for (let i = 0; i < tail.length; i++) {
    const t = tail[i];
    if (t.startsWith('--')) {
      // Flag — consume its value if the next token isn't itself a flag.
      // `--flag=value` carries its value inline; assume next is unrelated.
      if (!t.includes('=') && i + 1 < tail.length && !tail[i + 1].startsWith('--')) {
        i++;
      }
      continue;
    }
    last = t;
  }
  return last;
}

// Persistent state file — what the relay owns. Right now it tracks tunnels
// only (the things the relay spawns directly). PM2 services are managed by
// a separate pm2 daemon that survives relay restarts independently, so they
// don't need to be in here. On every tunnel.start/stop we rewrite this file
// synchronously; on boot we read it and replay (kill any stray cloudflared
// matching the saved name, fresh spawn under our control). No dependency on
// ps-based orphan detection or detached-child survival.
import { readFileSync as _readState, writeFileSync as _writeState, existsSync as _hasState, mkdirSync as _mkdirState } from 'node:fs';
function _stateFilePath() {
  const platform = process.platform;
  if (platform === 'darwin') return `${os.homedir()}/Library/Application Support/jg-local-relay/.state.json`;
  if (platform === 'linux')  return `${process.env.XDG_STATE_HOME || `${os.homedir()}/.local/state`}/jg-local-relay/.state.json`;
  if (platform === 'win32')  return `${process.env.LOCALAPPDATA}\\jg-local-relay\\.state.json`;
  throw new Error(`unsupported platform: ${platform}`);
}
function _loadOwnedState() {
  try {
    const p = _stateFilePath();
    if (!_hasState(p)) return { tunnels: {} };
    const parsed = JSON.parse(_readState(p, 'utf8'));
    return { tunnels: (parsed && parsed.tunnels) || {} };
  } catch (e) {
    console.warn(`[state] load failed: ${e.message} — starting empty`);
    return { tunnels: {} };
  }
}
function _saveOwnedState(state) {
  try {
    const p = _stateFilePath();
    _mkdirState(path.dirname(p), { recursive: true });
    _writeState(p, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch (e) {
    console.warn(`[state] save failed: ${e.message}`);
  }
}
// In-memory mirror of the on-disk state — keyed by tunnel name.
const _ownedTunnels = _loadOwnedState().tunnels;
function _recordTunnel(name, url) {
  _ownedTunnels[name] = { url: url || null, startedAt: Date.now() };
  _saveOwnedState({ tunnels: _ownedTunnels });
}
function _forgetTunnel(name) {
  delete _ownedTunnels[name];
  _saveOwnedState({ tunnels: _ownedTunnels });
}
// Replay the persisted state on relay boot — for each saved tunnel, kill any
// matching cloudflared in ps (regardless of who started it), then fresh
// spawn via tunnel.start. Result: every tunnel that WAS running before the
// last relay shutdown is running again under our control, with pipes we own
// for log streaming. Brief (~2s) downtime per tunnel during the kill+spawn.
export async function restoreOwnedTunnels() {
  const names = Object.keys(_ownedTunnels);
  if (!names.length) return { restored: 0, results: [] };
  // Snapshot ps once so we don't fork it per tunnel.
  const ps = await run('ps', ['-axo', 'pid=,command=']).catch(() => ({ stdout: '' }));
  const lines = (ps.stdout || '').split(/\r?\n/).filter(Boolean);
  const psPidsByName = new Map();
  for (const rawLine of lines) {
    const m0 = rawLine.match(/^\s*(\d+)\s+(.*)$/);
    if (!m0) continue;
    const cmd = m0[2];
    if (!/(^|\/)cloudflared(\s|$)/.test(cmd)) continue;
    const n = _parseCloudflaredTunnelName(cmd);
    if (n) {
      if (!psPidsByName.has(n)) psPidsByName.set(n, []);
      psPidsByName.get(n).push(parseInt(m0[1], 10));
    }
  }
  const results = [];
  for (const name of names) {
    const { url } = _ownedTunnels[name];
    const pids = psPidsByName.get(name) || [];
    for (const pid of pids) {
      try { process.kill(pid, 'SIGTERM'); } catch (_) { /* gone already */ }
    }
    if (pids.length) await new Promise((r) => setTimeout(r, 1500));
    try {
      // Clear any in-memory bookkeeping from the dead process before respawn.
      _backgroundProcs.delete(`tunnel:${name}`);
      const r2 = await commands['tunnel.start']({ name, url });
      results.push({ name, oldPids: pids, newPid: r2.pid, ok: true });
      console.log(`[tunnel] restored "${name}" from state (url=${url || 'none'}, pid=${r2.pid})`);
    } catch (e) {
      results.push({ name, oldPids: pids, ok: false, error: e.message });
      console.warn(`[tunnel] restore failed for "${name}": ${e.message}`);
    }
  }
  return { restored: results.filter((r) => r.ok).length, results };
}

// Pull the `--url <local>` argument out of a cloudflared command line, if any.
// Used by the orphan-adoption flow so we can re-spawn an existing tunnel with
// the same forward target it had before.
function _parseCloudflaredTunnelUrl(cmd) {
  const m = cmd.match(/--url[=\s]+(\S+)/);
  return m ? m[1] : null;
}

// Detect cloudflared processes the relay didn't spawn itself, then kill +
// re-spawn each one under our control so we own its stdout/stderr pipes
// (without that, tunnel.logs.tail can never produce log lines for them).
// Sole-ownership doctrine: the relay is the sole spawner of cloudflared on
// this machine. Anything else gets adopted.
//
// Safe to call multiple times — already-owned tunnels are skipped via the
// _backgroundProcs map. Brief (~2s) downtime per orphan during the SIGTERM →
// respawn window is an accepted trade-off.
export async function adoptOrphanTunnels() {
  const ps = await run('ps', ['-axo', 'pid=,command=']).catch(() => ({ stdout: '' }));
  const lines = (ps.stdout || '').split(/\r?\n/).filter(Boolean);
  const orphans = [];
  for (const rawLine of lines) {
    const m0 = rawLine.match(/^\s*(\d+)\s+(.*)$/);
    if (!m0) continue;
    const pid = parseInt(m0[1], 10);
    const cmd = m0[2];
    if (!/(^|\/)cloudflared(\s|$)/.test(cmd)) continue;
    const name = _parseCloudflaredTunnelName(cmd);
    if (!name) continue;
    if (_backgroundProcs.has(`tunnel:${name}`)) continue; // already ours
    orphans.push({ pid, name, url: _parseCloudflaredTunnelUrl(cmd) });
  }
  if (!orphans.length) return { adopted: 0, results: [] };
  const results = [];
  for (const o of orphans) {
    try {
      console.log(`[tunnel] adopting orphan "${o.name}" (pid=${o.pid}, url=${o.url || 'unknown'})`);
      try { process.kill(o.pid, 'SIGTERM'); } catch (e) {
        // EPERM (not our process) or ESRCH (already gone) — skip; tunnel.start
        // will fail loudly below if the port is still bound.
        console.warn(`[tunnel] kill ${o.pid} failed: ${e.message}`);
      }
      // Wait for the orphan to release the connection. cloudflared usually
      // exits within ~500ms on SIGTERM; give it 1.5s margin.
      await new Promise((r) => setTimeout(r, 1500));
      const r2 = await commands['tunnel.start']({ name: o.name, url: o.url });
      results.push({ name: o.name, oldPid: o.pid, newPid: r2.pid, ok: true });
      console.log(`[tunnel] re-spawned "${o.name}" under relay control (pid=${r2.pid})`);
    } catch (e) {
      results.push({ name: o.name, oldPid: o.pid, ok: false, error: e.message });
      console.warn(`[tunnel] adopt failed for "${o.name}": ${e.message}`);
    }
  }
  return { adopted: results.filter((r) => r.ok).length, results };
}

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
  async 'pm2.logs.tail'({ name, lines } = {}, ctx) {
    if (!name || typeof name !== 'string') throw new Error('pm2.logs.tail requires `name`');
    const bin = process.env.JG_PM2_BIN || 'pm2';
    const key = `logs:${name}`;
    const prev = _backgroundProcs.get(key);
    if (prev) { try { prev.kill('SIGTERM'); } catch (_) {} }
    // `lines` controls how many historical bytes pm2 replays before following
    // new ones. Default 100 for running services (gives context). Cp passes
    // 0 when the service is stopped — there's nothing useful in the previous
    // run's tail to surface alongside the "[manager] not running" notice,
    // and the historical content was confusing users into thinking the proc
    // was alive ("why am I seeing GET / 200 if it's stopped?").
    const linesArg = Number.isFinite(lines) && lines >= 0 ? String(lines) : '100';
    const child = spawn(bin, ['logs', name, '--raw', '--lines', linesArg], { stdio: ['ignore', 'pipe', 'pipe'] });
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
  // tunnels we've spawned ourselves and parse ps to surface any
  // pre-existing cloudflared processes the user started outside cp.
  //
  // NOTE: `pgrep -af` on macOS does NOT include command-line arguments
  // (the `-a` flag is only honored on Linux), so the previous
  // implementation never detected externally-spawned tunnels on the
  // platform we run on. `ps -axo pid=,command=` is portable across
  // macOS + Linux and gives us the full argv.
  async 'tunnel.list'() {
    const out = await run('ps', ['-axo', 'pid=,command=']).catch(() => ({ stdout: '' }));
    const lines = (out.stdout || '').split(/\r?\n/).filter(Boolean);
    const tunnels = [];
    for (const rawLine of lines) {
      const m0 = rawLine.match(/^\s*(\d+)\s+(.*)$/);
      if (!m0) continue;
      const pid = parseInt(m0[1], 10);
      const cmd = m0[2];
      if (!/(^|\/)cloudflared(\s|$)/.test(cmd)) continue;
      const name = _parseCloudflaredTunnelName(cmd);
      if (name) tunnels.push({ pid, name, running: true });
    }
    // Add any tracked tunnels that ps missed (race condition).
    for (const [key, child] of _backgroundProcs) {
      if (!key.startsWith('tunnel:')) continue;
      const name = key.slice('tunnel:'.length);
      if (!tunnels.some(t => t.name === name)) {
        tunnels.push({ pid: child.pid, name, running: child.exitCode === null });
      }
    }
    return { tunnels };
  },

  // tunnel.logs.tail({name}) — subscribe to live cloudflared stdout/stderr
  // for a tunnel WE spawned. Replays the in-memory buffer first (last
  // ~200 lines), then forwards every new line as `{type:'log', stream, line}`
  // frames over the same ctx.send pipe pm2.logs.tail uses, so cp's WS
  // handler can fan them out to the dashboard's tunnel-log pane.
  // Multiple subscribers (browsers) per tunnel are supported.
  async 'tunnel.logs.tail'({ name } = {}, ctx) {
    if (!name || typeof name !== 'string') throw new Error('tunnel.logs.tail requires `name`');
    const cmdId = ctx?.id;
    const send = (stream, line) => {
      try { ctx?.send?.({ type: 'log', id: cmdId, stream, line }); } catch (_) {}
    };
    // We can only capture stdout/stderr from cloudflared children WE spawned
    // (via tunnel.start). If the process was already running when this relay
    // started — adopted via ps detection — there's no pipe to read from, so
    // the buffer will stay empty forever. Detect this case and surface it so
    // the dashboard doesn't show "waiting for log lines…" indefinitely.
    const weOwnIt = _backgroundProcs.has(`tunnel:${name}`);
    if (!weOwnIt && !_tunnelLogBuffers.has(name)) {
      const notice = [
        `[relay] tunnel "${name}" is running but was not spawned by this relay session,`,
        `so cloudflared's stdout/stderr can't be captured. To enable live log streaming,`,
        `click Restart on the tunnel from the dashboard — that will re-spawn it under this relay.`,
      ].join(' ');
      _tunnelLogBuffers.set(name, [{ stream: 'err', line: notice }]);
    }
    // Replay buffered history
    const buf = _tunnelLogBuffers.get(name);
    if (buf) for (const { stream, line } of buf) send(stream, line);
    // Register live subscriber
    if (!_tunnelLogSubs.has(name)) _tunnelLogSubs.set(name, new Set());
    const entry = { ctx, send };
    _tunnelLogSubs.get(name).add(entry);
    // Stash a per-ctx unsubscribe so tunnel.logs.stop can find it.
    if (!ctx._tunnelLogEntries) ctx._tunnelLogEntries = new Map();
    ctx._tunnelLogEntries.set(name, entry);
    return { ok: true, name, streaming: true, owned: weOwnIt };
  },

  async 'tunnel.logs.stop'({ name } = {}, ctx) {
    if (!name) throw new Error('tunnel.logs.stop requires `name`');
    const subs = _tunnelLogSubs.get(name);
    const entry = ctx?._tunnelLogEntries?.get(name);
    if (subs && entry) subs.delete(entry);
    if (ctx?._tunnelLogEntries) ctx._tunnelLogEntries.delete(name);
    return { ok: true, stopped: true };
  },

  // relay.logs.tail() — subscribe to the relay's own stdout/stderr, captured
  // from console.log/warn/error since this module loaded. Replays the ring
  // buffer first, then forwards every new line as `{type:'log', stream, line}`
  // — same envelope as pm2.logs.tail and tunnel.logs.tail. Useful for
  // debugging "the relay itself is doing something weird" from the dashboard
  // without having to SSH and tail ~/Library/Logs/jg-local-relay/.
  async 'relay.logs.tail'(_args = {}, ctx) {
    const cmdId = ctx?.id;
    const send = (stream, line) => {
      try { ctx?.send?.({ type: 'log', id: cmdId, stream, line }); } catch (_) {}
    };
    for (const { stream, line } of _selfLogBuffer) send(stream, line);
    const entry = { ctx, send };
    _selfLogSubs.add(entry);
    if (ctx) ctx._selfLogEntry = entry;
    return { ok: true, streaming: true, buffered: _selfLogBuffer.length };
  },

  async 'relay.logs.stop'(_args = {}, ctx) {
    const entry = ctx?._selfLogEntry;
    if (entry) _selfLogSubs.delete(entry);
    if (ctx) delete ctx._selfLogEntry;
    return { ok: true, stopped: true };
  },

  // ── Self-management (restart / stop / uninstall) ────────────────────────────
  // The relay can't reliably run these inline because they involve killing
  // the relay process. We spawn a detached helper script that sleeps for
  // ~2s (long enough for the relay to ACK back to cp + cleanly close the
  // WebSocket), THEN performs the launchctl / systemctl / schtasks call.
  //
  // Mac auto-relaunches via the LaunchAgent's KeepAlive=true after bootout —
  // for "restart" that's what we want; for "stop" the same agent would
  // immediately respawn it, so stop also disables the agent until next
  // boot via `launchctl disable` (re-enable on next install).
  async 'relay.restart'() {
    return _spawnSelfMgmtScript('restart', _selfMgmtScript('restart'));
  },
  async 'relay.stop'() {
    return _spawnSelfMgmtScript('stop', _selfMgmtScript('stop'));
  },
  async 'relay.uninstall'() {
    return _spawnSelfMgmtScript('uninstall', _selfMgmtScript('uninstall'));
  },

  // Self-update: npm install -g the requested version, then trigger a
  // platform-native restart (launchctl kickstart on Mac, systemctl --user
  // restart on Linux, scheduled-task end+run on Windows). Runs detached so
  // we can reply OK before our own process is replaced.
  //
  // cp calls this automatically when the version reported in `hello` is
  // older than the target version cp shipped with — see the welcome path
  // in jg-control-plane/manager/server.js. Idempotent: calling with the
  // current version is harmless (npm no-ops, restart kicks).
  async 'relay.self_update'({ version } = {}) {
    if (!version || typeof version !== 'string') {
      throw new Error('relay.self_update requires a `version` string');
    }
    console.log(`[relay] self_update → ${version} (current ${VERSION})`);
    return _spawnSelfMgmtScript('self_update', _selfUpdateScript(version));
  },

  async 'tunnel.start'({ name, url } = {}) {
    if (!name || typeof name !== 'string') throw new Error('tunnel.start requires `name`');
    const key = `tunnel:${name}`;
    if (_backgroundProcs.has(key)) return { ok: true, alreadyRunning: true, name };
    const bin = process.env.JG_CLOUDFLARED_BIN || 'cloudflared';
    // Pass --url so cloudflared forwards traffic to the local dev port
    // without needing a per-tunnel ingress YAML on disk. Without --url,
    // `cloudflared tunnel run <name>` connects to the edge with no
    // ingress rules → CF returns 503 on every request to the hostname.
    const args = ['tunnel', 'run'];
    if (url && typeof url === 'string') args.push('--url', url);
    args.push(name);
    // detached:true puts cloudflared in its OWN process group so it survives
    // relay events that would otherwise SIGTERM the whole group — crash,
    // launchctl bootout (manual restart), self_update (auto-update). Without
    // this the user saw all tunnels go offline every time the relay updated
    // itself, even though pm2 services stayed up (pm2 has its own daemon).
    // unref() releases the event-loop ref so the relay can exit even while
    // cloudflared is running. stdio:['ignore','pipe','pipe'] preserves the
    // stdout/stderr pipes we need for tunnel.logs.tail.
    //
    // After relay restart, adoptOrphanTunnels() (see boot path in index.js)
    // detects the surviving cloudflared via `ps`, kills+respawns it under
    // the NEW relay so we own the pipes again. Brief ~2s downtime per tunnel
    // during that handoff is the trade-off vs total-outage.
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    child.unref();
    _backgroundProcs.set(key, child);
    child.on('error', (err) => {
      _backgroundProcs.delete(key);
      console.warn(`[tunnel] ${name} spawn failed: ${err.message}`);
    });
    child.on('exit', (code) => {
      _backgroundProcs.delete(key);
      console.log(`[tunnel] ${name} exited code=${code}`);
    });
    // Fan out stdout/stderr to the ring buffer + every live subscriber.
    // Without this, the dashboard's "tunnel: jg-web" log pane just shows
    // "waiting for log lines…" forever — even though cloudflared is
    // happily logging connection registrations.
    const fanout = (stream) => (chunk) => {
      const lines = chunk.toString('utf8').split(/\r?\n/);
      for (const line of lines) {
        if (!line) continue;
        const buf = _tunnelLogBuffers.get(name) || [];
        buf.push({ stream, line });
        if (buf.length > _TUNNEL_LOG_CAP) buf.splice(0, buf.length - _TUNNEL_LOG_CAP);
        _tunnelLogBuffers.set(name, buf);
        const subs = _tunnelLogSubs.get(name);
        if (subs) for (const { send } of subs) send(stream, line);
      }
    };
    child.stdout.on('data', fanout('out'));
    child.stderr.on('data', fanout('err'));
    // Persist ownership so a later relay restart can fully re-establish
    // this tunnel (see restoreOwnedTunnels in index.js boot path).
    _recordTunnel(name, url);
    return { ok: true, name, url: url || null, pid: child.pid };
  },

  // Adopt any cloudflared processes the relay didn't spawn itself: SIGTERM
  // the orphan, wait for it to release, then re-spawn it under tunnel.start
  // so we own stdout/stderr. Called automatically at relay boot; cp can also
  // trigger it remotely (e.g. when user clicks 'Adopt all' in the UI).
  async 'tunnel.adoptAll'() {
    return adoptOrphanTunnels();
  },

  async 'tunnel.stop'({ name } = {}) {
    if (!name) throw new Error('tunnel.stop requires `name`');
    const child = _backgroundProcs.get(`tunnel:${name}`);
    if (child) {
      try { child.kill('SIGTERM'); } catch (_) {}
      _backgroundProcs.delete(`tunnel:${name}`);
      // Intentional stop — forget so the next relay boot doesn't auto-restart.
      _forgetTunnel(name);
      return { ok: true, stopped: true, name };
    }
    // Not started by us — try pkill by name.
    await run('pkill', ['-f', `cloudflared.*${name}`]).catch(() => {});
    _forgetTunnel(name);
    return { ok: true, stopped: true, name, viaPkill: true };
  },
};
