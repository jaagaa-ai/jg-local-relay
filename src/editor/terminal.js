// editor/terminal.js — node-pty shell ↔ the browser's xterm.js, addressed by a
// per-terminal id (multi-terminal: jg-console opens several, each its own PTY).
// Mirrors jg-sandbox-runner/src/lib/terminal.js so the console side is identical.
//
// The user's local `claude login` runs in one of these — the OAuth token is
// written by `claude` to ~/.claude on THIS machine and never crosses our wire.

import { spawn as ptySpawn } from 'node-pty';

const SHELL = process.env.SHELL || '/bin/bash';

export class Terminal {
  constructor({ ws, id, cwd }) {
    this.ws = ws;
    this.id = id;     // the term.open command id (the browser keys frames on it)
    this.cwd = cwd;   // the project workspace dir
    this.pty = null;
  }

  open({ cols = 80, rows = 24 } = {}) {
    if (this.pty) return;
    this.pty = ptySpawn(SHELL, [], {
      name: 'xterm-color',
      cols,
      rows,
      cwd: this.cwd || process.env.HOME || process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color' },
    });
    this.pty.onData((data) => {
      this._send({ type: 'term-data', id: this.id, data: Buffer.from(data, 'utf8').toString('base64') });
    });
    this.pty.onExit(({ exitCode }) => {
      this._send({ type: 'term-exit', id: this.id, exitCode });
      this.pty = null;
    });
  }

  input(dataB64) {
    if (this.pty) this.pty.write(Buffer.from(String(dataB64), 'base64').toString('utf8'));
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
      if (this.ws && this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(obj));
    } catch { /* closing */ }
  }
}
