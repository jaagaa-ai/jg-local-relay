// THE RUN, NARRATED — fed the wire format, checked line by line.
import { makeNarrator } from '../src/editor/narrate.js';
let fails = 0;
const is = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log((ok ? '  ok   ' : '  FAIL ') + what + (ok ? '' : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`));
};
console.log('narrate');
const feed = (events) => {
  const out = [];
  const n = makeNarrator((kind, text, block) => out.push(block == null ? { kind, text } : { kind, text, block }));
  for (const e of events) n.narrate(e);
  return { out, n };
};
const se = (event) => ({ type: 'stream_event', event });

// Partial messages: thinking and text arrive as deltas, numbered by block.
{
  const { out, n } = feed([
    se({ type: 'message_start', message: { model: 'claude-opus-5' } }),
    se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
    se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me ' } }),
    se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'look.' } }),
    se({ type: 'content_block_stop', index: 0 }),
    se({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }),
    se({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'There are ' } }),
    se({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '3.' } }),
    se({ type: 'content_block_stop', index: 1 }),
    // The whole message follows its partials, and must not be told twice.
    { type: 'assistant', message: { model: 'claude-opus-5', content: [
      { type: 'thinking', thinking: 'Let me look.' },
      { type: 'text', text: 'There are 3.' },
      { type: 'tool_use', name: 'Bash', input: { command: 'curl /api/x' } },
    ] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok  fine', is_error: false }] } },
  ]);
  is('a thinking block is announced as a state, then its deltas join it', out.slice(0, 3), [{ kind: 'thinking', text: 'Thinking…', block: 1 }, { kind: 'thinking', text: 'Let me ', block: 1 }, { kind: 'thinking', text: 'look.', block: 1 }]);
  is('  and the answer as deltas of the next', out.slice(3, 5), [{ kind: 'say', text: 'There are ', block: 2 }, { kind: 'say', text: '3.', block: 2 }]);
  is('the whole message adds only the tool call', out.slice(5), [{ kind: 'tool', text: 'Bash — curl /api/x' }, { kind: 'result', text: 'ok fine' }]);
  is('  nothing is told twice', out.length, 7);
  // What the CLI actually sends today: a thinking block with empty deltas.
  const empty = feed([se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }), se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } }), se({ type: 'content_block_stop', index: 0 })]).out;
  is('an empty thinking block still shows as thinking', empty, [{ kind: 'thinking', text: 'Thinking…', block: 1 }]);
  is('the model is read off the stream', n.model(), 'claude-opus-5');
  is('  and the run knows it streamed', n.streamed(), true);
}
// Without partials (an older CLI), whole blocks are still narrated.
{
  const { out, n } = feed([
    { type: 'assistant', message: { model: 'claude-sonnet-5', content: [
      { type: 'thinking', thinking: ' deep thought ' },
      { type: 'text', text: 'Done.' },
    ] } },
  ]);
  is('a whole thinking block is one numbered step', out[0], { kind: 'thinking', text: 'deep thought', block: 1 });
  is('  and a whole text block is a think line', out[1], { kind: 'think', text: 'Done.' });
  is('  the model still comes from the message', n.model(), 'claude-sonnet-5');
  is('  and nothing streamed', n.streamed(), false);
}
// A tool that refused is an error; junk is ignored.
{
  const { out } = feed([
    null, 'text', { type: 'weird' },
    { type: 'user', message: { content: [{ type: 'tool_result', content: [{ text: 'no such' }, { text: 'route' }], is_error: true }] } },
  ]);
  is('a refused tool is an error line', out, [{ kind: 'error', text: 'no such route' }]);
}
// The flags that make this possible are on the command line.
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../src/editor/commands.js', import.meta.url), 'utf8');
is('partials are asked for', /a\.push\('--include-partial-messages'\)/.test(src), true);
is('the owner\'s own skills, commands and hooks stay out of the run', /a\.push\('--setting-sources', 'project', '--disable-slash-commands'\)/.test(src), true);
is('the log says when the first progress frame left', /first progress after/.test(src), true);
is('the brief forbids answering from a backup or export', /LIVE DATA ONLY: never answer from a backup/.test(src), true);
is('agent.run receives the context its progress frames are sent through', /'agent\.run': async \(args, ctx\) => \{/.test(src), true);
is('  and nothing in it sends without one', !/'agent\.run': async \(args\) =>/.test(src), true);
is('a run keeps the bypass, or token calls are refused as simple_expansion', /const a = \['-p', '--dangerously-skip-permissions'\];/.test(src), true);
is('  and no allow list, which refuses $VAR in a command', !/'--allowedTools',\s*'mcp__workspace__/.test(src), true);
is('  and what it may never do', /'Bash\(rm \*\)', 'Bash\(sudo \*\)', 'Bash\(git \*\)', 'Bash\(wrangler \*\)'/.test(src), true);
is('effort is passed when chosen, and only then', /if \(meter && effort\) a\.push\('--effort', effort\)/.test(src), true);
is('  after validation', /\/\^\(low\|medium\|high\|max\)\$\/\.test\(String\(args\?\.effort/.test(src), true);
is('deltas of one block are joined inside a batch', /last\.block === block && last\.kind === kind/.test(src), true);
is('a killed run hands back the answer so far', /said\.trim\(\)\s*\?\s*`\$\{said\.trim\(\)\}/.test(src), true);
// A RESTART WAITS FOR THE QUESTION. Every path that exits the process asks the
// in-flight count first; the count is kept by agent.run on every way out.
import * as inflight from '../src/inflight.js';
inflight.begin(); inflight.begin(); inflight.end();
is('runs are counted in and out', inflight.count(), 1);
const t0 = Date.now(); await inflight.whenIdle(300);
is('  whenIdle gives up after its ceiling when a run never ends', Date.now() - t0 >= 250, true);
inflight.end();
is('  and returns at once when nothing is in flight', await inflight.whenIdle(5000), 0);
const cmd = readFileSync(new URL('../src/editor/commands.js', import.meta.url), 'utf8');
const upd = readFileSync(new URL('../src/self-update.js', import.meta.url), 'utf8');
const idx = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
is('agent.run counts itself in', /inflight\.begin\(\);\s*return await new Promise\(\(resolve0\)/.test(cmd), true);
is('  and out on every exit', /const resolve = \(v\) => \{ if \(!settled\) \{ settled = true; inflight\.end\(\); \} resolve0\(v\); \};/.test(cmd), true);
is('the console restart waits for idle', /inflight\.whenIdle\(\)\.then\(\(\) => process\.exit\(0\)\)/.test(cmd), true);
is('the self-update waits for idle', /await inflight\.whenIdle\(\);\s*process\.exit\(0\);/.test(upd), true);
is('a signal says what it costs', /shutting down \(\$\{sig\}\)\$\{busy \? ` with \$\{busy\} run/.test(idx), true);
console.log(fails ? `\n${fails} FAILED` : '\nall ok');
process.exit(fails ? 1 : 0);
