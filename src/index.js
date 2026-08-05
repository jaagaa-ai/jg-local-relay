#!/usr/bin/env node
// jg-local-relay — dials home to the Jaagaa control-plane over outbound WSS and
// runs local dev/ops commands on its behalf. No inbound ports (NAT-friendly),
// no per-machine manager UI. One cp (cp.jaagaa.ai) drives every machine through
// its relay.
//
// Config (env):
//   JG_CP_URL          control-plane relay endpoint (default ws://localhost:7090/relay)
//   JG_RELAY_TOKEN     shared secret the cp validates on connect
//   JG_RELAY_ID        stable id for this machine (default: hostname)
//   JG_RELAY_PROJECTS  comma-separated projects this machine serves (e.g. jaagaa,cricket)
//   JG_PM2_BIN         path to pm2 (default: `pm2` on PATH)

import WebSocket from 'ws';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { commands, adoptOrphanTunnels, restoreOwnedTunnels } from './commands.js';
import { startEditorLink } from './editor/link.js';
import { startSelfUpdate } from './self-update.js';

// Last-resort guards — even one un-caught spawn error has killed the relay
// hard enough that launchd takes ~8s to bring us back. During that window cp
// thinks the user is offline and every action 503s. Keep us alive and log
// loudly instead.
process.on('uncaughtException', (err) => {
  try { console.error('[relay] uncaughtException:', err?.stack || err); } catch (_) {}
});
process.on('unhandledRejection', (reason) => {
  try { console.error('[relay] unhandledRejection:', reason); } catch (_) {}
});

const CP_URL = process.env.JG_CP_URL || 'ws://localhost:7090/relay';
const TOKEN = process.env.JG_RELAY_TOKEN || '';
const RELAY_ID = process.env.JG_RELAY_ID || os.hostname();
const PROJECTS = (process.env.JG_RELAY_PROJECTS || '').split(',').map((s) => s.trim()).filter(Boolean);
// Read VERSION from package.json so a single bump there propagates here AND
// into the bundle cp serves. The earlier hardcoded `0.1.0` constant was
// silently stale through 0.2.0/0.3.0 — installed agents kept reporting 0.1.0
// to cp, which then incorrectly flagged every install as "outdated".
const _pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const VERSION = (() => {
  try { return JSON.parse(readFileSync(_pkgPath, 'utf8'))?.version || '0.0.0'; }
  catch { return '0.0.0'; }
})();
const HEARTBEAT_MS = 25_000;
const MAX_BACKOFF_MS = 30_000;

let ws = null;
let backoff = 1_000;
let heartbeat = null;

function log(...a) {
  console.log(new Date().toISOString(), '[relay]', ...a);
}

// Boot marker — first thing the relay says on startup. Useful when verifying
// that auto-update actually replaced the running process (the new boot line
// shows up in the live-logs pane right after launchctl bootstrap).
log(`booting v${VERSION} on ${process.platform} (pid ${process.pid})`);

function send(obj) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch {
    /* socket racing close — next reconnect re-syncs */
  }
}

function connect() {
  log(`connecting → ${CP_URL} as "${RELAY_ID}" (projects: ${PROJECTS.join(',') || 'all'})`);
  ws = new WebSocket(CP_URL, { headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {} });

  ws.on('open', () => {
    backoff = 1_000;
    send({
      type: 'hello',
      token: TOKEN,
      relay: {
        id: RELAY_ID,
        host: os.hostname(),
        user: os.userInfo().username,
        platform: process.platform,
        version: VERSION,
        projects: PROJECTS,
      },
    });
    log('connected; sent hello');
    clearInterval(heartbeat);
    heartbeat = setInterval(() => send({ type: 'pong', ts: Date.now() }), HEARTBEAT_MS);
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    void handle(msg);
  });

  ws.on('close', () => {
    clearInterval(heartbeat);
    scheduleReconnect();
  });
  ws.on('error', (e) => log('ws error:', e.message));
}

function scheduleReconnect() {
  const wait = Math.min(backoff, MAX_BACKOFF_MS);
  log(`disconnected; reconnecting in ${wait}ms`);
  setTimeout(connect, wait);
  backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
}

async function handle(msg) {
  switch (msg.type) {
    case 'welcome':
      log(`registered with cp as relayId=${msg.relayId ?? RELAY_ID}`);
      break;
    case 'ping':
      send({ type: 'pong', ts: Date.now() });
      break;
    case 'command':
      await runCommand(msg);
      break;
    default:
      break;
  }
}

async function runCommand({ id, cmd, args }) {
  const fn = commands[cmd];
  if (typeof fn !== 'function') {
    send({ type: 'result', id, ok: false, error: `unknown command: ${cmd}` });
    return;
  }
  try {
    const data = await fn(args || {}, { send, id });
    send({ type: 'result', id, ok: true, data });
  } catch (e) {
    send({
      type: 'result',
      id,
      ok: false,
      error: (e?.message || String(e)).slice(0, 500),
      stderr: (e?.stderr || '').toString().slice(0, 1_000),
    });
  }
}

process.on('SIGINT', () => {
  log('shutting down');
  try { ws?.close(); } catch {}
  process.exit(0);
});
process.on('SIGTERM', () => {
  try { ws?.close(); } catch {}
  process.exit(0);
});

// Sole-ownership re-establishment. Two passes in order, both non-blocking:
//
// 1) restoreOwnedTunnels — reads the persisted state file
//    (~/Library/Application Support/jg-local-relay/.state.json on Mac) and
//    for every tunnel WE previously owned, kills any matching cloudflared
//    in ps + fresh spawns under our control. This is the authoritative path
//    after a relay update / crash / reboot: tunnels marked "ours" come back
//    automatically without needing to be guessed at via ps detection.
//
// 2) adoptOrphanTunnels — best-effort safety net for cloudflared started
//    OUTSIDE the relay (e.g. by the legacy :5400 manager, or by hand). Same
//    kill + respawn idea, just keyed on ps rather than the state file.
//    Skipped tunnels already restored in (1).
//
// ~2s downtime per tunnel during the kill→respawn window is the accepted
// trade-off vs leaving stale processes around or losing log pipes.
restoreOwnedTunnels()
  .then((r) => {
    if (r.restored > 0) {
      log(`[tunnel] restored ${r.restored} tunnel(s) from state: ${r.results.filter((x) => x.ok).map((x) => x.name).join(', ')}`);
    }
    return adoptOrphanTunnels();
  })
  .then((r) => {
    if (r && r.adopted > 0) {
      log(`[tunnel] adopted ${r.adopted} additional orphan(s): ${r.results.map((x) => x.name).join(', ')}`);
    }
  })
  .catch((e) => log(`[tunnel] boot restore error: ${e.message}`));

connect();

// AI-Editor surface (additive, gated by JG_API_WS_URL). A second outbound WSS
// to jg-api for the Local Editor; no-op when the env var is unset, so the
// control-plane behavior above is completely unaffected. See src/editor/.
try { startEditorLink({ version: VERSION }); } catch (e) { log('[editor] start failed (non-fatal):', e.message); }
// Keep this machine on the current build without anyone copying files onto it.
try { startSelfUpdate(); } catch (e) { log('[update] start failed (non-fatal):', e.message); }
