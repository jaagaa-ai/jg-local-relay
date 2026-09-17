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
  is('thinking arrives as deltas of one block', out.slice(0, 2), [{ kind: 'thinking', text: 'Let me ', block: 1 }, { kind: 'thinking', text: 'look.', block: 1 }]);
  is('  and the answer as deltas of the next', out.slice(2, 4), [{ kind: 'say', text: 'There are ', block: 2 }, { kind: 'say', text: '3.', block: 2 }]);
  is('the whole message adds only the tool call', out.slice(4), [{ kind: 'tool', text: 'Bash — curl /api/x' }, { kind: 'result', text: 'ok fine' }]);
  is('  nothing is told twice', out.length, 6);
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
is('effort is passed when chosen, and only then', /if \(meter && effort\) a\.push\('--effort', effort\)/.test(src), true);
is('  after validation', /\/\^\(low\|medium\|high\|max\)\$\/\.test\(String\(args\?\.effort/.test(src), true);
is('deltas of one block are joined inside a batch', /last\.block === block && last\.kind === kind/.test(src), true);
is('a killed run hands back the answer so far', /said\.trim\(\)\s*\?\s*`\$\{said\.trim\(\)\}/.test(src), true);
console.log(fails ? `\n${fails} FAILED` : '\nall ok');
process.exit(fails ? 1 : 0);
