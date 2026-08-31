'use strict';

/*
 * Shared streaming call to the Anthropic Messages API, asking for structured
 * JSON output. Extracted out of lib/analysis.js once a second caller
 * (lib/module-trends.js) needed the exact same streaming/error-handling
 * machinery — neither file has any HTTP/auth concerns of its own, and this
 * one has no domain knowledge of sessions, modules, or prompts.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';

/* Reads the SSE body of a streaming Messages API response, accumulating the
   text deltas into the final response text. Streaming shape:
   content_block_delta{delta:{type:"text_delta",text}} for content,
   message_delta{delta:{stop_reason}} for how the turn ended, and an "error"
   event for a mid-stream failure (e.g. the model overloaded after already
   starting to respond). */
async function readSseStream(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let stopReason = null;
  let usage = null;
  let streamError = null;

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    /* normalise CRLF on the whole remaining buffer, not just this chunk — a
       \r\n could straddle two reads. SSE permits either line ending, and
       \r\n\r\n does not contain \n\n as a substring, so without this an
       event stream delivered with CRLF line endings would never find a
       frame boundary at all and every generation would silently accumulate
       zero text. */
    buffer = buffer.replace(/\r\n/g, '\n');

    let sepIdx;
    while ((sepIdx = buffer.indexOf('\n\n')) >= 0) {
      const rawEvent = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + 2);

      const dataLine = rawEvent.split('\n').find(function (l) { return l.indexOf('data:') === 0; });
      if (!dataLine) continue;

      let evt;
      try {
        evt = JSON.parse(dataLine.slice(5).trim());
      } catch (e) {
        continue; /* a malformed/partial frame — skip rather than abort the whole stream over it */
      }

      if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') {
        text += evt.delta.text;
      } else if (evt.type === 'message_delta') {
        if (evt.delta && evt.delta.stop_reason) stopReason = evt.delta.stop_reason;
        if (evt.usage) usage = evt.usage;
      } else if (evt.type === 'error') {
        streamError = (evt.error && evt.error.message) || JSON.stringify(evt.error || evt);
      }
    }
  }

  return { text: text, stopReason: stopReason, usage: usage, streamError: streamError };
}

/*
 * callStructured({apiKey, model, systemPrompt, schema, userContent,
 * maxOutputTokens, effort, timeoutMs, schemaFileHint}) -> {data, model, usage}
 *
 * schemaFileHint is only used in the MAX_TOKENS error message, so a caller
 * whose constant lives in a different file (e.g. lib/module-trends.js
 * instead of lib/analysis.js) points the operator at the right place to
 * raise it.
 */
async function callStructured(opts) {
  const apiKey = opts.apiKey;
  if (!apiKey) {
    const err = new Error('ANTHROPIC_API_KEY is not set.');
    err.code = 'NO_API_KEY';
    throw err;
  }

  const ctrl = new AbortController();
  const t = setTimeout(function () { ctrl.abort(); }, opts.timeoutMs);

  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxOutputTokens,
        stream: true,
        system: opts.systemPrompt,
        output_config: {
          effort: opts.effort || 'medium',
          format: { type: 'json_schema', schema: opts.schema }
        },
        messages: [{ role: 'user', content: opts.userContent }]
      })
    });

    /* A request-level failure (bad key, bad schema, rate limit) returns a
       normal JSON error body before any streaming starts — same shape as the
       old non-streaming path. */
    if (!res.ok) {
      const bodyText = await res.text().catch(function () { return ''; });
      const err = new Error('Anthropic API error (' + res.status + '): ' + bodyText.slice(0, 500));
      err.code = 'API_ERROR';
      err.status = res.status;
      throw err;
    }

    const stream = await readSseStream(res);

    if (stream.streamError) {
      const err = new Error('The model stopped mid-generation: ' + stream.streamError);
      err.code = 'STREAM_ERROR';
      throw err;
    }
    if (stream.stopReason === 'refusal') {
      const err = new Error('The model declined to generate this response.');
      err.code = 'REFUSAL';
      throw err;
    }
    if (stream.stopReason === 'max_tokens') {
      /* Caught explicitly rather than left to surface as a generic JSON
         parse failure below — a max_tokens cutoff mid-response produces
         truncated JSON, which fails to parse the same way genuinely
         malformed output would, but the fix is completely different (raise
         maxOutputTokens) and worth knowing immediately rather than
         re-diagnosing from a "not valid JSON" message again. */
      const err = new Error(
        'Hit the output token limit (max_tokens) before the response finished — the JSON was cut off ' +
        'mid-way through. ' + (opts.schemaFileHint || 'The caller') + '’s max output tokens may need to be raised further.'
      );
      err.code = 'MAX_TOKENS';
      throw err;
    }
    if (!stream.text) {
      const err = new Error('No text content in the model response.');
      err.code = 'EMPTY_RESPONSE';
      throw err;
    }

    let parsed;
    try {
      parsed = JSON.parse(stream.text);
    } catch (e) {
      const err = new Error('Model response was not valid JSON (' + stream.text.length + ' chars, stop_reason: ' + (stream.stopReason || 'unknown') + ').');
      err.code = 'BAD_JSON';
      throw err;
    }

    return { data: parsed, model: opts.model, usage: stream.usage || null };
  } catch (err) {
    if (err && err.code) throw err; /* already one of ours */
    const timedOut = err && err.name === 'AbortError';
    const wrapped = new Error(timedOut ? 'Anthropic API request timed out.' : ((err && err.message) || 'Request failed.'));
    wrapped.code = timedOut ? 'TIMEOUT' : 'FETCH_FAILED';
    throw wrapped;
  } finally {
    clearTimeout(t);
  }
}

module.exports = { callStructured };
