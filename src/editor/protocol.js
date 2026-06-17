// editor/protocol.js — wire envelope for the AI-EDITOR link (jg-console ↔ this
// relay, bridged by jg-api). Deliberately the SAME vocabulary jg-sandbox-runner
// speaks (command/result/log/term-data) so jg-console's editor code is byte-for-
// byte identical whether it drives a cloud sandbox or this local relay.
//
// This is ADDITIVE and fully separate from the cp dial-home in src/index.js —
// nothing here touches the existing control-plane path.
//
// Frames (JSON, one per WS message):
//   relay → server  { type:'result',  id, ok, data?, error? }
//   relay → server  { type:'log',     stream, line }
//   relay → server  { type:'term-data', id, data }   // PTY bytes (base64)
//   relay → server  { type:'term-exit', id, exitCode }
//   server → relay  { type:'command', id, cmd, args }

export function send(ws, obj) {
  try {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  } catch {
    /* socket racing close; the next reconnect re-syncs */
  }
}

export function logLine(ws, stream, line) {
  send(ws, { type: 'log', stream, line: String(line) });
}

/** Resolve a command from the table and emit its `result`, capturing errors. */
export async function runCommand(ws, table, { id, cmd, args }) {
  const fn = table[cmd];
  if (typeof fn !== 'function') {
    send(ws, { type: 'result', id, ok: false, error: `unknown command: ${cmd}` });
    return;
  }
  try {
    const data = await fn(args || {}, { ws, id, send: (o) => send(ws, o), logLine: (s, l) => logLine(ws, s, l) });
    send(ws, { type: 'result', id, ok: true, data });
  } catch (e) {
    send(ws, { type: 'result', id, ok: false, error: (e?.message || String(e)).slice(0, 500) });
  }
}
