// editor/link.js — the AI-Editor dial-home. A SECOND outbound WSS, to jg-api,
// entirely separate from the control-plane connection in src/index.js. Gated by
// JG_API_WS_URL: unset → this never runs and the cp path is 100% unchanged.
//
// Same outbound-only model as the cp link (no inbound ports). jg-api pairs a
// browser editor session to this relay and forwards command frames here; we run
// them against the local project workspace and stream results/logs/term-data
// back over this socket.
//
// Env:
//   JG_API_WS_URL    jg-api editor-relay endpoint (e.g. wss://api.jaagaa.ai/api/local/relay)
//   JG_RELAY_TOKEN   reused auth secret (same as the cp link)
//   JG_RELAY_ID      stable machine id (default hostname)

import WebSocket from 'ws';
import os from 'node:os';
import { makeEditorCommands } from './commands.js';
import { runCommand, send } from './protocol.js';

const HEARTBEAT_MS = 25_000;
const MAX_BACKOFF_MS = 30_000;

// Resolve the jg-api editor endpoint. Explicit JG_API_WS_URL wins; otherwise,
// in PRODUCTION (cp host = cp.<domain>) derive it as api.<domain> so the relay
// enables Local mode automatically after its built-in self-update — no manual
// env. Dev/unknown cp hosts stay OFF unless JG_API_WS_URL is set explicitly.
function resolveEditorUrl() {
  if (process.env.JG_API_WS_URL) return process.env.JG_API_WS_URL;
  try {
    const cp = new URL(process.env.JG_CP_URL || '');
    if (cp.hostname.startsWith('cp.')) return `wss://${cp.hostname.replace(/^cp\./, 'api.')}/api/local/relay`;
  } catch { /* malformed cp url */ }
  return '';
}

export function startEditorLink({ version }) {
  const url = resolveEditorUrl();
  if (!url) return; // feature off (no explicit url + non-prod cp) → cp path untouched
  const token = process.env.JG_RELAY_TOKEN || '';
  const relayId = process.env.JG_RELAY_ID || os.hostname();
  const log = (...a) => console.log(new Date().toISOString(), '[editor]', ...a);

  let ws = null;
  let backoff = 1_000;
  let heartbeat = null;
  let editor = null; // { table, dispose } — fresh per connection

  function connect() {
    log(`connecting → ${url} as "${relayId}"`);
    ws = new WebSocket(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    editor = makeEditorCommands({ ws });

    ws.on('open', () => {
      backoff = 1_000;
      send(ws, { type: 'hello', token, relay: { id: relayId, host: os.hostname(), user: os.userInfo().username, platform: process.platform, version, surface: 'editor' } });
      log('connected; sent hello (surface=editor)');
      clearInterval(heartbeat);
      heartbeat = setInterval(() => send(ws, { type: 'pong', ts: Date.now() }), HEARTBEAT_MS);
    });

    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'ping') return send(ws, { type: 'pong', ts: Date.now() });
      if (msg.type === 'command') return void runCommand(ws, editor.table, msg);
    });

    ws.on('close', () => {
      clearInterval(heartbeat);
      try { editor?.dispose(); } catch { /* gone */ }
      const wait = Math.min(backoff, MAX_BACKOFF_MS);
      log(`disconnected; reconnecting in ${wait}ms`);
      setTimeout(connect, wait);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    });
    ws.on('error', (e) => log('ws error:', e.message));
  }

  connect();
}
