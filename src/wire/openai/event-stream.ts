/**
 * OpenAI-compatible SSE → harness {@link StreamChunk} stream.
 *
 * This is the second wire lane of the plugin: the OpenAI-shaped contract Cohere
 * maintains for OpenAI clients at
 * `POST https://api.cohere.ai/compatibility/v1/chat/completions`. Each frame is
 * `data: <json>` terminated by a blank line, and the stream closes with a bare
 * `data: [DONE]` sentinel:
 *
 * ```
 * data: {"id":"…","object":"chat.completion.chunk","created":1791824185,
 *        "choices":[{"index":0,"finish_reason":null,"logprobs":null,
 *                    "delta":{"role":"assistant","reasoning_content":"The user","content":""}}]}
 *
 * data: [DONE]
 * ```
 *
 * `delta.reasoning_content` streams the model's thinking and `delta.content` the
 * answer. They are **separate harness blocks** (never one merged text block, or
 * the durable history would present the thinking as the answer), each is
 * optional, and either may be an empty string — which is never content and must
 * never open a block. Tool calls arrive incrementally in `delta.tool_calls`:
 * the first fragment for a `tool_calls[].index` opens a block, later fragments
 * may omit `id`/`name` and carry only `function.arguments`, and the arguments
 * are forwarded exactly as the provider streamed them (never re-encoded).
 *
 * Usage arrives in one final chunk with `"choices": []`:
 *
 * ```json
 * {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":48,"total_tokens":59,
 *  "prompt_tokens_details":{"cached_tokens":0,…},
 *  "completion_tokens_details":{"reasoning_tokens":35,…}}}
 * ```
 *
 * Harness token counts are **disjoint**, so the cached share of the prompt is
 * split out of the input count:
 *
 * | harness field | compat-lane source |
 * | :--- | :--- |
 * | `cacheReadTokens` | `usage.prompt_tokens_details.cached_tokens` (omitted when 0) |
 * | `inputTokens` | `max(0, usage.prompt_tokens - cacheReadTokens)` |
 * | `outputTokens` | `usage.completion_tokens` |
 * | `totalTokens` | `inputTokens + outputTokens + cacheReadTokens` |
 * | `reasoningTokens` | `usage.completion_tokens_details.reasoning_tokens`, optional and **never added to the total** — it is a subset of the output count |
 *
 * The harness contract this translator upholds:
 *
 * - block indices tie interleaved deltas to one block, in first-appearance order;
 * - `block-end` carries the fully assembled block;
 * - **`usage` must precede the terminal `finish`, and nothing may follow it** —
 *   so the terminal chunk is held back until the source is exhausted, which also
 *   neutralises any trailing junk a proxy might append;
 * - tool arguments stay the raw JSON string the provider streamed;
 * - a stream that never reports a `finish_reason` is a `SERVER` failure, not a
 *   silent success.
 *
 * Nothing on this lane is silently dropped: a malformed frame is reported
 * through {@link OpenAIStreamHooks.onNotice} and skipped.
 *
 * @module dsh-plugin-cohere/wire/openai/event-stream
 */

import type {
  ContentBlock,
  FinishReason,
  StreamChunk,
  TokenUsage,
  ToolCallBlock,
  ToolCallId,
} from '@deepseek-ai/dsh-llm';
import { failureFromProtocol, makeFailure } from '../../failure.js';

/** One event the harness cannot represent, surfaced for logging only. */
export interface OpenAIStreamNotice {
  /** Notice kind, or `unparsed` for a frame that was not usable JSON. */
  readonly kind: string;
  /** Event payload, or the raw frame text when parsing failed. */
  readonly detail: unknown;
}

/** Translator side channels. */
export interface OpenAIStreamHooks {
  /** Called once per unrepresentable event; never affects the chunk stream. */
  readonly onNotice?: (notice: OpenAIStreamNotice) => void;
}

/** A reasoning or answer block currently being assembled from deltas. */
interface OpenTextBlock {
  readonly kind: 'text' | 'reasoning';
  readonly index: number;
  text: string;
}

/** A tool call currently being assembled from delta fragments. */
interface OpenToolBlock {
  readonly kind: 'tool-call';
  readonly index: number;
  /** Provider call id, adopted from a later fragment when the provider defers it. */
  id: string;
  /** Tool name, adopted from a later fragment when the provider defers it. */
  name: string;
  arguments: string;
}

/** Read an own property off an unknown value without asserting a shape. */
function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

/** Narrow an unknown value to a finite number. */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Narrow an unknown value to a string. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** One parsed SSE frame. */
interface SseFrame {
  readonly event?: string;
  readonly data: string;
}

/** Parse one SSE frame, honouring multi-line `data:` accumulations. */
function parseFrame(frame: string): SseFrame | undefined {
  let event: string | undefined;
  const data: string[] = [];
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0 || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const name = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (name === 'event') event = value;
    else if (name === 'data') data.push(value);
  }
  if (data.length === 0) return undefined;
  return { ...(event === undefined ? {} : { event }), data: data.join('\n') };
}

/** Split a decoded text stream into SSE frames on blank lines. */
async function* frames(source: AsyncIterable<string>): AsyncGenerator<SseFrame, void, undefined> {
  let buffer = '';
  for await (const chunk of source) {
    buffer += chunk;
    for (;;) {
      const match = /\r?\n\r?\n/.exec(buffer);
      if (match === null) break;
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const parsed = parseFrame(frame);
      if (parsed !== undefined) yield parsed;
    }
  }
  // A final frame is legal without its blank-line terminator.
  const trailing = parseFrame(buffer);
  if (trailing !== undefined) yield trailing;
}

/**
 * Map the compatibility lane's `finish_reason` onto the harness taxonomy.
 * @param raw - the raw `finish_reason` string.
 * @returns the mapped finish reason.
 */
export function mapFinishReason(raw: string | undefined): FinishReason {
  switch (raw) {
    case 'stop':
      return { kind: 'stop' };
    case 'length':
      return { kind: 'max-tokens' };
    case 'tool_calls':
      return { kind: 'tool-calls' };
    case 'content_filter':
      // The harness has no content-filter reason and the filter is not a
      // transport failure, so a filtered answer ends as an ordinary stop.
      return { kind: 'stop' };
    default:
      // `undefined` is only reachable on a stream the caller detects as
      // truncated, because no `finish_reason` ever arrived.
      return { kind: 'stop' };
  }
}

/**
 * Map the compatibility lane's usage onto harness token accounting.
 *
 * Harness counts are disjoint: `inputTokens` excludes cached input, which is
 * reported separately as `cacheReadTokens`. OpenAI-shaped providers fold cache
 * hits into `prompt_tokens` and expose the cached share beside it, so that share
 * is subtracted out of the input count. `total_tokens` is recomputed from the
 * disjoint parts rather than trusted, so the total can never double-count the
 * cached prompt. Reasoning tokens are a subset of the output count (verified
 * live), so they are reported beside it and never added to the disjoint total.
 * @param usage - the `usage` object of a compat-lane chunk.
 * @returns harness usage, or `undefined` when the payload carries no counts.
 */
export function mapUsage(usage: unknown): TokenUsage | undefined {
  if (typeof usage !== 'object' || usage === null) return undefined;
  const prompt = num(field(usage, 'prompt_tokens'));
  const completion = num(field(usage, 'completion_tokens'));
  if (prompt === undefined && completion === undefined) return undefined;
  const cached = Math.max(
    0,
    num(field(field(usage, 'prompt_tokens_details'), 'cached_tokens')) ?? 0,
  );
  const inputTokens = Math.max(0, (prompt ?? 0) - cached);
  const outputTokens = completion ?? 0;
  const reasoning = num(field(field(usage, 'completion_tokens_details'), 'reasoning_tokens'));
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens + cached,
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
    ...(reasoning !== undefined && reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
}

/**
 * Translate one OpenAI-compatible SSE stream into harness chunks.
 * @param source - decoded response body text, in arrival order.
 * @param hooks - optional side channel for unrepresentable events.
 * @returns the chunk stream, ending in exactly one `finish`.
 * @throws CohereFailure when the stream ends without a finish reason.
 */
export async function* translateOpenAIStream(
  source: AsyncIterable<string>,
  hooks: OpenAIStreamHooks = {},
): AsyncGenerator<StreamChunk, void, undefined> {
  const notice = (kind: string, detail: unknown): void => {
    hooks.onNotice?.({ kind, detail });
  };

  /** The one open reasoning/answer block, while the provider streams text. */
  let openText: OpenTextBlock | undefined;
  /**
   * Tool-call blocks by provider `tool_calls[].index`, in opening order. Unlike
   * text, several may be open at once: parallel tool calls interleave, and a
   * call must never be split into two harness blocks just because another call
   * spoke in between.
   */
  const openTools = new Map<number, OpenToolBlock>();
  let nextIndex = 0;
  let pendingUsage: TokenUsage | undefined;
  let pendingFinish: FinishReason | undefined;
  /** Blocks that actually carried something, for the empty-answer rule. */
  let producedContent = 0;
  /** The provider's completion id, echoed on the terminal `finish`. */
  let responseId: string | undefined;

  /** Close the open reasoning/answer block, assembling the text it received. */
  const closeText = (): StreamChunk | undefined => {
    const block = openText;
    if (block === undefined) return undefined;
    openText = undefined;
    // Only the answer counts, never the thinking: a reasoning-only turn leaves an
    // empty assistant message, so it must reach the `EMPTY_RESPONSE` guard below
    // and let the harness retry it (its retry policy lists `EMPTY_RESPONSE`).
    // Verified live on this lane: `command-a-plus-05-2026` can emit
    // `reasoning_content` and then `finish_reason: stop` with no `content` at all
    // (session-1e322330, turn 6).
    if (block.kind === 'text' && block.text.length > 0) producedContent += 1;
    return {
      type: 'block-end',
      index: block.index,
      block: { type: block.kind, text: block.text },
    };
  };

  /** Close every open tool block, assembling the arguments it received. */
  const closeTools = (): StreamChunk[] => {
    const chunks: StreamChunk[] = [];
    for (const block of openTools.values()) {
      const assembled: ContentBlock = {
        type: 'tool-call',
        id: block.id as ToolCallId,
        name: block.name,
        // A tool that takes no parameters streams no argument fragments at all.
        // An empty string is not a JSON document, so leaving it would break the
        // tool executor here and be rejected on replay ("tool arguments must be
        // a stringified JSON object"); verified live on the native lane, where
        // the same model sends `"arguments": ""`.
        arguments: block.arguments.length === 0 ? '{}' : block.arguments,
      } satisfies ToolCallBlock;
      chunks.push({ type: 'block-end', index: block.index, block: assembled });
      producedContent += 1;
    }
    openTools.clear();
    return chunks;
  };

  for await (const frame of frames(source)) {
    // The provider closes the stream with a bare `data: [DONE]` sentinel
    // (verified live). It is terminal, not content, and never a notice.
    if (frame.data === '[DONE]') break;
    let payload: unknown;
    try {
      payload = JSON.parse(frame.data);
    } catch {
      // Trailing junk after the finish reason is swallowed: the terminal finish
      // is the last thing the harness may observe.
      if (pendingFinish === undefined) notice('unparsed', frame.data);
      continue;
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      if (pendingFinish === undefined) notice('unparsed', frame.data);
      continue;
    }

    // Usage is the one field that legitimately follows the finish reason: the
    // provider reports it in a final `"choices": []` chunk.
    const usage = mapUsage(field(payload, 'usage'));
    if (usage !== undefined) pendingUsage = usage;
    // Every chunk echoes the completion id; the first one is the response id.
    if (responseId === undefined) responseId = str(field(payload, 'id'));

    const choices = field(payload, 'choices');
    if (!Array.isArray(choices)) {
      if (pendingFinish === undefined) notice('chunk', payload);
      continue;
    }
    if (choices.length > 1) {
      // One compat response is one completion; the harness has nowhere to put
      // the alternatives.
      notice('multiple-choices', payload);
    }
    const choice = choices[0];
    if (choice === undefined) continue; // The usage-only final chunk.
    if (pendingFinish !== undefined) continue; // Nothing may grow a finished answer.

    const delta = field(choice, 'delta');
    const reasoning = str(field(delta, 'reasoning_content'));
    if (reasoning !== undefined && reasoning.length > 0) {
      let current = openText;
      if (current === undefined || current.kind !== 'reasoning') {
        const closed = closeText();
        if (closed !== undefined) yield closed;
        current = { kind: 'reasoning', index: nextIndex++, text: '' };
        openText = current;
        yield { type: 'block-start', index: current.index, blockType: 'reasoning' };
      }
      current.text += reasoning;
      yield { type: 'reasoning-delta', index: current.index, text: reasoning };
    }

    const content = str(field(delta, 'content'));
    if (content !== undefined && content.length > 0) {
      let current = openText;
      if (current === undefined || current.kind !== 'text') {
        const closed = closeText();
        if (closed !== undefined) yield closed;
        current = { kind: 'text', index: nextIndex++, text: '' };
        openText = current;
        yield { type: 'block-start', index: current.index, blockType: 'text' };
      }
      current.text += content;
      yield { type: 'text-delta', index: current.index, text: content };
    }

    const calls = field(delta, 'tool_calls');
    if (Array.isArray(calls)) {
      for (const call of calls) {
        const fn = field(call, 'function');
        const id = str(field(call, 'id'));
        const name = str(field(fn, 'name'));
        const fragment = str(field(fn, 'arguments')) ?? '';
        // `index` is the call's identity. A fragment that omitted it can only be
        // a continuation of the single call that is already open.
        const explicit = num(field(call, 'index'));
        const key =
          explicit ?? (openTools.size === 1 ? [...openTools.keys()][0] : undefined);
        if (key === undefined) {
          notice('tool-call', call);
          continue;
        }

        const open = openTools.get(key);
        if (open !== undefined) {
          // Later fragments normally carry only `arguments`; adopt an id or name
          // the provider deferred so the assembled block is still whole.
          if (open.id.length === 0 && id !== undefined) open.id = id;
          if (open.name.length === 0 && name !== undefined) open.name = name;
          if (fragment.length === 0) continue;
          open.arguments += fragment;
          yield {
            type: 'tool-call-delta',
            index: open.index,
            id: open.id as ToolCallId,
            argumentsDelta: fragment,
          };
          continue;
        }

        // A tool call ends the open reasoning/answer block: they are separate
        // harness blocks, and the answer is over once the model calls a tool.
        const closed = closeText();
        if (closed !== undefined) yield closed;
        const opened: OpenToolBlock = {
          kind: 'tool-call',
          index: nextIndex++,
          id: id ?? '',
          name: name ?? '',
          arguments: '',
        };
        openTools.set(key, opened);
        yield { type: 'block-start', index: opened.index, blockType: 'tool-call' };
        opened.arguments += fragment;
        yield {
          type: 'tool-call-delta',
          index: opened.index,
          id: opened.id as ToolCallId,
          ...(opened.name.length === 0 ? {} : { name: opened.name }),
          argumentsDelta: fragment,
        };
      }
    }

    const rawReason = str(field(choice, 'finish_reason'));
    // The finish reason may share a chunk with the last delta, so it is read
    // after the delta and only the first one counts.
    if (rawReason !== undefined && pendingFinish === undefined) {
      pendingFinish = mapFinishReason(rawReason);
    }
  }

  const trailing = closeText();
  if (trailing !== undefined) yield trailing;
  for (const closed of closeTools()) yield closed;

  if (pendingFinish === undefined) {
    throw failureFromProtocol('the provider stream ended without a finish reason');
  }

  // A clean stop that carried nothing is not a successful empty turn: the native
  // lane reports it as `EMPTY_RESPONSE`, and a lane that reported it as a plain
  // `stop` would leave the caller with a silently blank answer.
  const reason: FinishReason =
    producedContent === 0 && pendingFinish.kind === 'stop'
      ? {
          kind: 'error',
          failure: makeFailure('cohere: model produced no content', 'EMPTY_RESPONSE'),
        }
      : pendingFinish;

  if (pendingUsage !== undefined) yield { type: 'usage', usage: pendingUsage };
  yield {
    type: 'finish',
    reason,
    ...(responseId === undefined
      ? {}
      : { replayState: { response: { id: responseId, finishReason: pendingFinish.kind } } }),
  };
}
