/**
 * THE RUN, NARRATED — from the CLI's wire format to lines a person can read.
 *
 * `claude -p --output-format stream-json --verbose --include-partial-messages`
 * emits one JSON object per line: whole `assistant` and `user` messages at the
 * end of each turn, and — because of the last flag — `stream_event` objects
 * while the model is still producing them. Those carry the model's THINKING
 * and its answer a few tokens at a time, which is the difference between a
 * reader watching a run and a reader watching a spinner with a step count.
 *
 * Pure on purpose: it takes a `step(kind, text, block)` sink and nothing else,
 * so it can be fed synthetic events in a test and checked line by line.
 *
 * Kinds:
 *   thinking  a delta of the model's reasoning, `block` numbers the block
 *   say       a delta of what it is saying to the reader, likewise
 *   tool      a tool call, one line
 *   result    a tool result, one line; `error` when the tool refused
 *   think     a whole text block, only when partials were NOT streamed
 *
 * A whole `assistant` message arrives after its partials; its text and
 * thinking blocks are then skipped, or every line would be told twice. Its
 * tool_use blocks are still read from there, because the partial stream does
 * not carry a tool call's input in one piece.
 */
export function makeNarrator(step) {
  let usedModel = null;
  let partial = false;
  let block = 0;
  let cur = null;            // { id, kind } for the content block being streamed
  const narrate = (ev) => {
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'stream_event' && ev.event && typeof ev.event === 'object') {
      const e = ev.event;
      partial = true;
      if (e.type === 'message_start' && e.message && e.message.model && !usedModel) usedModel = String(e.message.model);
      if (e.type === 'content_block_start' && e.content_block) {
        const t = e.content_block.type;
        cur = t === 'thinking' ? { id: ++block, kind: 'thinking' }
          : t === 'text' ? { id: ++block, kind: 'say' }
            : null;
        return;
      }
      if (e.type === 'content_block_delta' && e.delta && cur) {
        if (e.delta.type === 'thinking_delta' && cur.kind === 'thinking') step('thinking', String(e.delta.thinking || ''), cur.id);
        else if (e.delta.type === 'text_delta' && cur.kind === 'say') step('say', String(e.delta.text || ''), cur.id);
        return;
      }
      if (e.type === 'content_block_stop') { cur = null; }
      return;
    }
    if (ev.type === 'assistant' && ev.message) {
      if (!usedModel && ev.message.model) usedModel = String(ev.message.model);
      if (!Array.isArray(ev.message.content)) return;
      for (const c of ev.message.content) {
        if (c.type === 'tool_use') {
          const inp = c.input || {};
          // The API call itself is the interesting part of an API task.
          const what = inp.url || inp.path || inp.command || inp.file_path || inp.pattern || '';
          step('tool', what ? `${c.name} — ${String(what).slice(0, 200)}` : String(c.name));
        } else if (partial) {
          continue;                                   // already told, as it happened
        } else if (c.type === 'thinking' && c.thinking && String(c.thinking).trim()) {
          step('thinking', String(c.thinking).trim(), ++block);
        } else if (c.type === 'text' && c.text && c.text.trim()) {
          step('think', c.text.trim());
        }
      }
      return;
    }
    if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
      for (const c of ev.message.content) {
        if (c.type !== 'tool_result') continue;
        const body = typeof c.content === 'string'
          ? c.content
          : Array.isArray(c.content) ? c.content.map((x) => x?.text || '').join(' ') : '';
        step(c.is_error ? 'error' : 'result', String(body).replace(/\s+/g, ' ').trim().slice(0, 200));
      }
    }
  };
  return { narrate, model: () => usedModel, streamed: () => partial };
}
