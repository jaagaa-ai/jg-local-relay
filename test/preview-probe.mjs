// test/preview-probe.mjs — the two probes behind a pod's P and T dots.
//
// A `web` pod sat orange for hours with a dev server that was serving, a
// cloudflared with four registered connections, and a preview that loaded fine
// in the browser. Two separate defects, both in readiness:
//
// 1. THE PUBLIC PROBE ASKED THIS MACHINE'S DNS. It used global `fetch`, which
//    goes through getaddrinfo. On a machine running Tailscale, MagicDNS answers
//    for the tunnel hostname authoritatively — NXDOMAIN — so nothing retried and
//    nothing fell through to the next resolver. `dig` resolved the name
//    perfectly the whole time; c-ares and getaddrinfo both said ENOTFOUND. A
//    plain cached negative in mDNSResponder does the same thing.
//
//    Readiness therefore never went true, and after 90s the console labelled it
//    "started but never served a request" — a sentence that was false in every
//    clause. The fix resolves the name against public resolvers when the system
//    denies it, and connects to the address with the hostname in SNI + Host.
//
// 2. THE LOCAL PROBE WAS AN HTTP HEAD. Status is polled every 2.5s while a pod
//    is open and every 3s for any pod that is starting or failed — so the pod's
//    own Logs tab filled with `HEAD / 200 OK`, for ever, from a request nobody
//    made. Read as "it is stuck in a loop", which is exactly what it looked
//    like. A TCP connect answers the same question and writes nothing.
//
//   node test/preview-probe.mjs
import http from 'node:http';
import net from 'node:net';
import { probePort, probePublic } from '../src/editor/commands.js';

let pass = 0; let fail = 0;
const ok = (name, cond, why = '') => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${why ? ` — ${why}` : ''}`); }
};

const listen = (server) => new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
const freePort = async () => {
  const s = net.createServer();
  const p = await listen(s);
  await new Promise((r) => s.close(r));
  return p;
};

// ── probePort ────────────────────────────────────────────────────────────────
{
  // Counts every HTTP request that reaches it. The point of the change is that
  // this stays at zero: a probe must not appear in the pod's own log.
  let requests = 0;
  const server = http.createServer((req, res) => { requests++; res.end('hi'); });
  const port = await listen(server);

  ok('a listening port probes true', await probePort(port) === true);
  ok('  and again (the probe is repeatable, it runs every 3s)', await probePort(port) === true);
  ok('THE PROBE SENDS NO HTTP REQUEST', requests === 0,
    `${requests} request(s) reached the server — that is the "HEAD / 200 OK" loop filling the Logs tab`);

  await new Promise((r) => server.close(r));
  ok('a closed port probes false', await probePort(port) === false);
}
{
  const port = await freePort();
  ok('a port nothing ever listened on probes false', await probePort(port) === false);
}

// ── probePublic ──────────────────────────────────────────────────────────────
// Hermetic cases only: anything needing the real internet would make this suite
// fail on a plane, and the DNS-bypass path is verified against a live tunnel by
// hand (see the header). What is asserted here is that every failure is
// REPORTED rather than swallowed — the reason is what the console shows, and a
// silent `false` is what left the old message free to invent one.
{
  const bad = await probePublic('not a url');
  ok('a malformed url is not ready', bad.ok === false);
  ok('  and says why', typeof bad.reason === 'string' && bad.reason.length > 0);
}
{
  // .invalid is reserved by RFC 2606 — no resolver anywhere answers for it, so
  // this exercises the both-resolvers-failed branch without touching a network
  // that might.
  const r = await probePublic('https://jaagaa-preview-probe.invalid/');
  ok('a name no resolver knows is not ready', r.ok === false);
  ok('  and the reason names the host, not "unknown error"', /jaagaa-preview-probe\.invalid/.test(r.reason || ''),
    r.reason);
  ok('  and blames DNS rather than the dev server', /resolve/i.test(r.reason || ''), r.reason);
}
{
  // Reachable, and reachable through the system resolver: localhost. The
  // connection is refused (nothing is on :443 here), which must read as the
  // TUNNEL being unreachable — never as ready.
  const r = await probePublic('https://localhost/');
  ok('a host that resolves but refuses is not ready', r.ok === false);
  ok('  and is reported as a tunnel problem, not a DNS one', /tunnel/i.test(r.reason || ''), r.reason);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
