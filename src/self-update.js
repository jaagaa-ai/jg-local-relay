// Keep the relay current by itself.
//
// Until now it only changed when someone copied files onto the machine by hand.
// A relay sat five weeks behind without anyone noticing, so fixes shipped to the
// server had no effect on the half that runs on the laptop — and the failures
// that produced (publish dying on a missing token, a stale editor session)
// looked like new bugs rather than old code.
//
// Check the build the platform is serving, and if it differs from what's
// installed, unpack the new one beside it, swap it in, and exit. launchd (or
// systemd) restarts us, so "update" and "restart" are the same event.
//
// Safety: the download is extracted to a temp directory and REJECTED unless it
// contains a plausible relay. Nothing touches the live install until the new
// copy is known good, so a truncated download or a bad tarball leaves the
// working relay exactly where it was.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAMP = path.join(ROOT, '.dist-sha');
const log = (...a) => console.log(new Date().toISOString(), '[update]', ...a);

const apiBase = () => {
  if (process.env.JG_API_URL) return process.env.JG_API_URL.replace(/\/$/, '');
  try {
    const u = new URL(process.env.JG_CP_URL || '');
    if (/(^|\.)jaagaa\.ai$/.test(u.hostname)) return 'https://api.jaagaa.ai';
  } catch { /* not configured */ }
  return null;
};

const run = (cmd, args, opts = {}) => new Promise((res, rej) => {
  execFile(cmd, args, { timeout: 300_000, maxBuffer: 1 << 26, ...opts }, (e, so, se) => (e ? rej(new Error(se || e.message)) : res(so)));
});

const installedSha = () => { try { return fs.readFileSync(STAMP, 'utf8').trim(); } catch { return ''; } };

async function checkOnce() {
  const base = apiBase();
  const token = process.env.JG_RELAY_TOKEN || '';
  if (!base || !token) return; // not enrolled — nothing to update against
  const headers = { authorization: `Bearer ${token}` };

  const vr = await fetch(`${base}/api/local/relay-version`, { headers }).catch(() => null);
  if (!vr || !vr.ok) return;
  const { sha } = await vr.json().catch(() => ({}));
  if (!sha) return;

  const have = installedSha();
  // First run after a manual install has no stamp. Record and stay put rather
  // than reinstalling on top of a copy that is already correct.
  if (!have) { try { fs.writeFileSync(STAMP, sha); } catch { /* read-only */ } return; }
  if (have === sha) return;

  log(`new build ${sha.slice(0, 7)} (have ${have.slice(0, 7)}) — updating`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-relay-'));
  try {
    const dr = await fetch(`${base}/api/local/relay-dist`, { headers });
    if (!dr.ok) throw new Error(`dist ${dr.status}`);
    const tgz = path.join(tmp, 'dist.tgz');
    fs.writeFileSync(tgz, Buffer.from(await dr.arrayBuffer()));
    const unpack = path.join(tmp, 'new');
    fs.mkdirSync(unpack);
    await run('tar', ['-xzf', tgz, '-C', unpack, '--strip-components=1']);

    // Refuse anything that doesn't look like a relay. Swapping in a truncated
    // download would take the machine offline with no way to recover remotely.
    if (!fs.existsSync(path.join(unpack, 'src', 'index.js')) || !fs.existsSync(path.join(unpack, 'package.json'))) {
      throw new Error('downloaded build is missing src/index.js or package.json');
    }
    await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--silent'], { cwd: unpack });

    // Keep machine-local state that is NOT part of the build.
    for (const keep of ['allowed-accounts.txt', 'state.json', '.env']) {
      const from = path.join(ROOT, keep);
      if (fs.existsSync(from)) { try { fs.copyFileSync(from, path.join(unpack, keep)); } catch { /* best effort */ } }
    }
    fs.writeFileSync(path.join(unpack, '.dist-sha'), sha);

    const old = `${ROOT}.old-${Date.now()}`;
    fs.renameSync(ROOT, old);
    try { fs.renameSync(unpack, ROOT); }
    catch (e) { fs.renameSync(old, ROOT); throw e; } // put it back, stay on the working build
    fs.rmSync(old, { recursive: true, force: true });

    log(`updated to ${sha.slice(0, 7)} — restarting`);
    process.exit(0); // KeepAlive brings us back on the new code
  } catch (e) {
    log(`update failed, staying on current build: ${e.message}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Ask now, not on the next tick of a timer. The editor link reconnects often
// (redeploys, sleep/wake, network blips), and each one is a moment we already
// know the platform is reachable — so it is the cheapest possible moment to
// notice a new build. Waiting an hour meant a machine installed minutes before
// a fix kept running the broken code, with the person watching the same error
// and no way to tell that the fix already existed.
let lastCheck = 0;
export async function checkForUpdateNow(reason = 'reconnect') {
  if (process.env.JG_RELAY_NO_SELF_UPDATE) return;
  // Don't re-check on a flapping connection; a reconnect storm shouldn't turn
  // into a download storm.
  if (Date.now() - lastCheck < 120_000) return;
  lastCheck = Date.now();
  log(`checking for updates (${reason})`);
  await checkOnce();
}

export function startSelfUpdate() {
  if (process.env.JG_RELAY_NO_SELF_UPDATE) { log('self-update disabled'); return; }
  // A few seconds after boot, then hourly. The delay keeps an update from
  // racing the relay's own startup on a machine that just came back.
  setTimeout(() => { lastCheck = Date.now(); void checkOnce(); }, 15_000).unref?.();
  // Hourly is now just the backstop for a relay that never reconnects.
  setInterval(() => { lastCheck = Date.now(); void checkOnce(); }, 60 * 60_000).unref?.();
}
