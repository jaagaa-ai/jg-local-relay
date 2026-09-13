// editor/terminal.js — node-pty shell ↔ the browser's xterm.js, addressed by a
// per-terminal id (multi-terminal: jg-console opens several, each its own PTY).
// Mirrors jg-sandbox-runner/src/lib/terminal.js so the console side is identical.
//
// The user's local `claude login` runs in one of these — the OAuth token is
// written by `claude` to ~/.claude on THIS machine and never crosses our wire.

import { spawn as ptySpawn } from 'node-pty';

const SHELL = process.env.SHELL || '/bin/bash';

/** How much output a detached terminal remembers, so a reconnecting browser can
 *  be shown what it missed. Enough for a `claude` answer and a stack trace; not
 *  so much that an idle relay holds a log file in memory. */
const SCROLLBACK_BYTES = 256 * 1024;

export class Terminal {
  /**
   * A TERMINAL OUTLIVES THE SOCKET THAT OPENED IT.
   *
   * `getWs` is a function, not a socket. The relay's connection to the control
   * plane drops for ordinary reasons - a sleeping lid, a network blip, a cp
   * restart - and reconnects moments later. A terminal that captured the old
   * socket would go on writing into a closed pipe; a terminal that was KILLED on
   * that drop (what happened before) takes the user's shell, their running
   * `claude`, and anything it had not finished with it.
   *
   * So the PTY belongs to the session, and the socket is looked up per write.
   * While nothing is connected, output accumulates in a bounded buffer and is
   * replayed on attach.
   */
  constructor({ getWs, ws, id, cwd, env }) {
    this.getWs = typeof getWs === 'function' ? getWs : () => ws;
    this.id = id;     // the term.open command id (the browser keys frames on it)
    this.cwd = cwd;   // the project workspace dir
    // A PTY opened for a CLI sign-in needs the widened PATH the agent runs use,
    // or it starts a shell that cannot find the very binary it was opened for.
    this.env = env || null;
    this.pty = null;
    this.buf = [];    // detached output, replayed on attach
    this.bufBytes = 0;
    this.attached = true;
    this.lastUsed = Date.now();
  }

  /** Stop writing to a socket that is going away. The PTY keeps running. */
  detach() { this.attached = false; }

  /**
   * A browser is back. Replay what it missed, oldest first, then resume live.
   * Replayed as ONE frame: a hundred small ones make xterm repaint a hundred
   * times and the reader watches their scrollback assemble itself.
   */
  attach() {
    this.attached = true;
    this.lastUsed = Date.now();
    if (!this.buf.length) return;
    const data = this.buf.join('');
    this.buf = []; this.bufBytes = 0;
    this._send({ type: 'term-data', id: this.id, data: Buffer.from(data, 'utf8').toString('base64'), replay: true });
  }

  open({ cols = 80, rows = 24 } = {}) {
    if (this.pty) return;
    this.pty = ptySpawn(SHELL, [], {
      name: 'xterm-color',
      cols,
      rows,
      // No silent HOME fallback: term.open refuses to construct this without a
      // workspace, so reaching here with none is a bug worth seeing rather than
      // a shell in the wrong directory that looks like it works.
      cwd: this.cwd,
      env: { ...(this.env || process.env), TERM: 'xterm-256color' },
    });
    this.pty.onData((data) => {
      this.lastUsed = Date.now();
      if (this.attached) {
        this._send({ type: 'term-data', id: this.id, data: Buffer.from(data, 'utf8').toString('base64') });
        return;
      }
      // Nobody is listening. Keep the tail, drop the head — the end of the
      // output is what somebody coming back wants to read.
      this.buf.push(data); this.bufBytes += data.length;
      while (this.bufBytes > SCROLLBACK_BYTES && this.buf.length > 1) {
        this.bufBytes -= this.buf.shift().length;
      }
    });
    this.pty.onExit(({ exitCode }) => {
      this._send({ type: 'term-exit', id: this.id, exitCode });
      this.pty = null;
    });
  }

  input(dataB64) {
    this.lastUsed = Date.now();
    if (!this.pty) return;
    try { this.pty.write(Buffer.from(String(dataB64), 'base64').toString('utf8')); }
    catch { /* the shell went away mid-write */ }
  }

  resize(cols, rows) {
    try { this.pty?.resize(Math.max(1, cols | 0), Math.max(1, rows | 0)); } catch { /* pty gone */ }
  }

  runLine(line) {
    if (this.pty) this.pty.write(`${line}\n`);
  }

  close() {
    try { this.pty?.kill(); } catch { /* already gone */ }
    this.pty = null;
  }

  _send(obj) {
    try {
      const ws = this.getWs();
      if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    } catch { /* closing */ }
  }
}
