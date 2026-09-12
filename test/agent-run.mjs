// ONE QUESTION, ONE ANSWER. agent.chat streams frames at a browser and resolves
// an exit code — right for a person watching a terminal, useless to a caller
// that wants the answer. A job needs the text back, bounded on both axes,
// because the caller is a program and programs retry.
//
// Driven against a stub CLI rather than a real `claude`: what is being tested is
// the contract (collect, cap, time out, report), not the model.
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

let fails = 0;
const is = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log((ok ? '  ok   ' : '  FAIL ') + what + (ok ? '' : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`));
};
console.log('agent-run');

// The runner's contract, lifted out so it can be driven without a control plane.
const run = ({ bin, argv, cwd, timeoutMs = 5000, maxOut = 1024 }) => new Promise((resolve) => {
  let child;
  try { child = spawn(bin, argv, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { return void resolve({ ok: false, error: `failed to start ${bin}: ${e.message}` }); }
  let out = '', err = '', truncated = false, done = false;
  const take = (d, which) => {
    const t = d.toString('utf8');
    if (which === 'out') {
      if (out.length + t.length > maxOut) { out += t.slice(0, Math.max(0, maxOut - out.length)); truncated = true; }
      else out += t;
    } else if (err.length < 8192) err += t.slice(0, 8192 - err.length);
  };
  child.stdout?.on('data', (d) => take(d, 'out'));
  child.stderr?.on('data', (d) => take(d, 'err'));
  const timer = setTimeout(() => {
    if (done) return;
    try { child.kill('SIGKILL'); } catch {}
    done = true;
    resolve({ ok: false, error: `timed out after ${timeoutMs}ms`, timedOut: true, output: out, stderr: err, truncated });
  }, timeoutMs);
  child.on('error', (e) => { if (done) return; done = true; clearTimeout(timer); resolve({ ok: false, error: String(e.message) }); });
  child.on('close', (exitCode) => { if (done) return; done = true; clearTimeout(timer); resolve({ ok: exitCode === 0, exitCode, output: out, stderr: err, truncated }); });
});

const dir = mkdtempSync(join(tmpdir(), 'agentrun-'));
const stub = (name, body) => {
  const f = join(dir, name);
  writeFileSync(f, `#!/bin/sh\n${body}\n`);
  chmodSync(f, 0o755);
  return f;
};

const ok = await run({ bin: stub('ok.sh', 'echo "the answer is 42"'), argv: [], cwd: dir });
is('the answer comes back, not a stream', ok.output.trim(), 'the answer is 42');
is('  with the exit code', ok.exitCode, 0);
is('  and ok when it exited clean', ok.ok, true);

const bad = await run({ bin: stub('bad.sh', 'echo "nope" 1>&2; exit 3'), argv: [], cwd: dir });
is('a failure reports its code', bad.exitCode, 3);
is('  is not ok', bad.ok, false);
is('  and carries what it complained about', /nope/.test(bad.stderr), true);

const big = await run({ bin: stub('big.sh', 'i=0; while [ $i -lt 400 ]; do echo "0123456789012345678901234567890123456789"; i=$((i+1)); done'), argv: [], cwd: dir, maxOut: 1024 });
is('output is capped', big.output.length <= 1024, true);
is('  and says so rather than lying by omission', big.truncated, true);

// THE FAILURE MODE THAT MATTERS: a CLI that never returns would otherwise wedge
// the queue behind it forever.
const hung = await run({ bin: stub('hang.sh', 'echo "partial"; sleep 30'), argv: [], cwd: dir, timeoutMs: 700 });
is('a hung CLI is killed', hung.timedOut, true);
is('  and what it managed to say is kept', /partial/.test(hung.output), true);
is('  reported as a failure, with a reason', [hung.ok, /timed out/.test(hung.error)], [false, true]);

const missing = await run({ bin: join(dir, 'nope-not-here'), argv: [], cwd: dir });
is('a missing CLI fails cleanly rather than throwing', missing.ok, false);

if (fails) { console.error(`${fails} failed`); process.exit(1); }
console.log('  all good');
