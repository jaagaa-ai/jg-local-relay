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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeEditorCommands } from './commands.js';
import { runCommand, send } from './protocol.js';
import { checkForUpdateNow } from '../self-update.js';

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
  // Accounts allowed to drive THIS machine's relay, beyond the one that claims
  // it first. Declared here rather than server-side on purpose: driving a relay
  // means running commands on this machine, so the authority to grant that
  // belongs to whoever holds the machine — not to anyone who can reach the API.
  // One email per line in allowed-accounts.txt (# comments ok), or JG_RELAY_ALLOW.
  // `owner=<email>` names the account this machine belongs to; bare lines are
  // additional accounts. The owner MUST be declared here rather than inferred
  // from whoever connects first: an allowed second account connecting before the
  // owner left the relay unclaimed, and the next account to arrive claimed it —
  // which locked the actual owner out of their own machine.
  const readAccounts = () => {
    const allow = new Set();
    let owner = (process.env.JG_RELAY_OWNER || '').trim().toLowerCase() || null;
    for (const e of (process.env.JG_RELAY_ALLOW || '').split(',')) {
      const v = e.trim().toLowerCase(); if (v) allow.add(v);
    }
    try {
      const f = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'allowed-accounts.txt');
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        const v = line.split('#')[0].trim().toLowerCase();
        if (!v) continue;
        const m = v.match(/^owner\s*[=:]\s*(.+)$/);
        if (m) { owner = m[1].trim(); continue; }
        allow.add(v);
      }
    } catch { /* no file → env only */ }
    return { owner, allow: [...allow] };
  };

  let ws = null;
  let backoff = 1_000;
  let heartbeat = null;
  // ISOLATION: one command-table instance PER PROJECT, not one global. Each
  // instance owns its own workspace/previews/procs/terms closure, so two
  // project tabs driving the same relay can never see each other's workspace or
  // dev server. Routed by the command's `args.project`.
  let editors = new Map(); // project -> { table, dispose }
  const editorFor = (account, project) => {
    // Keyed by account AND project: the same project opened by two accounts on
    // one machine gets two sessions with two workspaces, so neither inherits the
    // other's uncommitted work, checked-out branch or dev server.
    const key = `${String(account || '__noacct__')}::${String(project || '__default__')}`;
    let e = editors.get(key);
    if (!e) { e = makeEditorCommands({ ws, version }); editors.set(key, e); log(`spawned editor session for project "${key}"`); }
    return e;
  };
  const disposeAll = () => { for (const e of editors.values()) { try { e.dispose(); } catch { /* gone */ } } editors = new Map(); };

  function connect() {
    log(`connecting → ${url} as "${relayId}"`);
    ws = new WebSocket(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    disposeAll();

    let alive = true;
    ws.on('pong', () => { alive = true; });
    ws.on('open', () => {
      backoff = 1_000;
      alive = true;
      // Re-read the allow list on every (re)connect, so editing the file and
      // restarting nothing but the socket is enough to grant or revoke.
      const { owner, allow } = readAccounts();
      send(ws, { type: 'hello', token, relay: { id: relayId, host: os.hostname(), user: os.userInfo().username, platform: process.platform, version, surface: 'editor', owner, allow } });
      log(`connected; sent hello (surface=editor${owner ? `, owner=${owner}` : ''}${allow.length ? `, ${allow.length} allowed` : ''})`);
      // We know the platform is reachable right now — cheapest moment to notice
      // a new build, and far better than waiting out an hourly timer.
      void checkForUpdateNow('editor connect');
      clearInterval(heartbeat);
      // ws-level ping; terminate if jg-api misses a pong (half-open after a
      // redeploy) so the 'close' handler reconnects instead of sitting dead.
      heartbeat = setInterval(() => {
        if (!alive) { log('no pong — terminating dead editor link'); try { ws.terminate(); } catch { /* gone */ } return; }
        alive = false; try { ws.ping(); } catch { /* gone */ }
      }, HEARTBEAT_MS);
    });

    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'ping') return send(ws, { type: 'pong', ts: Date.now() });
      // Route to the per-account, per-project editor session (isolated workspace
      // + processes). `account` is stamped by the hub from the proven session —
      // never sent by the browser — and is passed down in args so the command
      // table can put each account's checkout under its own root.
      if (msg.type === 'command') {
        const account = String(msg.account || '');
        // `pods` is stamped by the hub from the proven pair scope, exactly like
        // `account`. Absent = unrestricted (owner, operator, or an older
        // jg-api that does not send it).
        const withAccount = { ...msg, args: { ...(msg.args || {}), account, ...(Array.isArray(msg.pods) ? { pods: msg.pods } : {}) } };
        return void runCommand(ws, editorFor(account, msg.args?.project).table, withAccount);
      }
    });

    ws.on('close', () => {
      clearInterval(heartbeat);
      disposeAll();
      const wait = Math.min(backoff, MAX_BACKOFF_MS);
      log(`disconnected; reconnecting in ${wait}ms`);
      setTimeout(connect, wait);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    });
    ws.on('error', (e) => log('ws error:', e.message));
  }

  connect();
}
