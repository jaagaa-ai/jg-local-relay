/**
 * HOW MANY QUESTIONS THIS RELAY IS ANSWERING RIGHT NOW.
 *
 * A restart is routine here - the hourly self-update does one, and so does
 * the console's Restart - and a restart while an agent run is in flight kills
 * the `claude` child with it. The reader's question then sits in the portal
 * until the control plane gives up on it: "The machine has not answered in
 * five minutes." 2026-09-18, 66 seconds into a question. So every restart
 * path asks this first, and waits for zero.
 */
let n = 0;
export function begin() { n += 1; }
export function end() { n = Math.max(0, n - 1); }
export function count() { return n; }
/** Resolve once nothing is in flight, or after `maxMs` regardless. */
export function whenIdle(maxMs = 10 * 60_000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (n === 0 || Date.now() - t0 >= maxMs) return resolve(n);
      setTimeout(tick, 2_000);   // ref'd on purpose: a pending restart must keep the loop alive
    };
    tick();
  });
}
