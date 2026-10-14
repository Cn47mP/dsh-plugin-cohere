/**
 * Cohere v2 SSE → harness {@link StreamChunk} stream.
 *
 * The harness contract this translator upholds:
 *
 * - block indices tie interleaved deltas to one block;
 * - `block-end` carries the fully assembled block;
 * - **`usage` must precede the terminal `finish`, and nothing may follow it** —
 *   so the terminal chunk is held back until the source is exhausted, which also
 *   neutralises any trailing junk a proxy might append;
 * - tool arguments stay the raw JSON string the provider streamed.
 *
 * Cohere v2 emits twelve event types. Two of them have no harness
 * representation: `debug` (which carries the full outgoing prompt, including
 * tools and documents) is always surfaced as a notice, never as content; the
 * citation family — the harness has no citation content block — either becomes
 * one trailing footnote text block or stays a notice, as the `citationDisplay`
 * hook decides.
 *
 * Source: https://docs.cohere.com/docs/streaming
 *
 * @module dsh-plugin-cohere/wire/event-stream
 */

import type {
  ContentBlock,
  FinishReason,
  StreamChunk,
  TokenUsage,
  ToolCallBlock,
  ToolCallId,
} from '@deepseek-ai/dsh-llm';
import type { CitationDisplaySetting } from '../config.js';
import { failureFromProtocol, makeFailure } from '../failure.js';

/** One event the harness cannot represent, surfaced for logging only. */
export interface CohereStreamNotice {
  /** Cohere event type, or `unparsed` for a frame that was not JSON. */
  readonly kind: string;
  /** Event payload, or the raw frame text when parsing failed. */
  readonly detail: unknown;
}

/** Translator side channels. */
export interface CohereStreamHooks {
  /** Called once per unrepresentable event; never affects the chunk stream. */
  readonly onNotice?: (notice: CohereStreamNotice) => void;
  /**
   * Surface collected citations as one trailing text block. The harness has no
   * citation content block, so this is the only way a citation reaches the user.
   */
  readonly citations?: boolean;
  /**
   * Where surfaced citations go: one trailing footnote text block
   * (`'footnote'`, the default) or the notice side channel (`'notice'`), which
   * leaves the answer stream untouched. Only read when `citations` is true.
   */
  readonly citationDisplay?: CitationDisplaySetting;
}

/**
 * One citation span Cohere reported for the answer text.
 *
 * `sources` holds only the labels that survived {@link describeSource}'s
 * validity gate, so a record with an empty list is never collected at all.
 */
interface CitationRecord {
  /** The cited answer text (may be empty when Cohere omits it). */
  readonly text: string;
  /** Human-facing descriptions of the cited sources. */
  readonly sources: readonly string[];
}

/** One citation source resolved into what can be said about it. */
interface SourceDescription {
  /** Best-effort label, used for the footnote when the source is valid. */
  readonly label: string;
  /** Whether the label identifies anything a reader could act on. */
  readonly valid: boolean;
}

/** A block currently being assembled from deltas. */
interface OpenTextBlock {
  readonly kind: 'text' | 'reasoning';
  readonly index: number;
  text: string;
}

/** A tool call currently being assembled from delta fragments. */
interface OpenToolBlock {
  readonly kind: 'tool-call';
  readonly index: number;
  readonly id: string;
  readonly name: string;
  arguments: string;
}

type OpenBlock = OpenTextBlock | OpenToolBlock;

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
 * Map Cohere's `finish_reason` onto the harness taxonomy.
 * @param raw - the raw `finish_reason` string.
 * @param errorDetail - the `error` object Cohere attaches to a `message-end`
 *   frame when `finish_reason` is `"ERROR"` (its documented `message` and
 *   `http_status` fields), when present.
 * @returns the mapped finish reason.
 */
export function mapFinishReason(raw: string | undefined, errorDetail?: unknown): FinishReason {
  switch (raw) {
    case 'COMPLETE':
    case 'STOP_SEQUENCE':
      return { kind: 'stop' };
    case 'MAX_TOKENS':
      return { kind: 'max-tokens' };
    case 'TOOL_CALL':
      return { kind: 'tool-calls' };
    case 'ERROR':
      return {
        kind: 'error',
        failure: makeFailure(
          `cohere: provider reported an error finish reason${formatErrorDetail(errorDetail)}`,
          'SERVER',
        ),
      };
    case 'TIMEOUT':
      return {
        kind: 'error',
        failure: makeFailure('cohere: provider timed out', 'TIMEOUT'),
      };
    default:
      // Cohere omits the field only on an interrupted stream, which the caller
      // detects because no `message-end` arrived.
      return { kind: 'stop' };
  }
}

/**
 * Render Cohere's `message-end` `error` object into a short, readable suffix.
 * @param errorDetail - the `error` field of an `ERROR` `message-end` frame.
 * @returns a `: message (http_status N)` suffix, or the empty string.
 */
function formatErrorDetail(errorDetail: unknown): string {
  if (typeof errorDetail !== 'object' || errorDetail === null) return '';
  const message = str(field(errorDetail, 'message'));
  const status = num(field(errorDetail, 'http_status'));
  const parts: string[] = [];
  if (message !== undefined) parts.push(`: ${message}`);
  if (status !== undefined) parts.push(` (http_status ${status})`);
  return parts.join('');
}

/**
 * Map Cohere usage onto harness token accounting.
 *
 * Harness counts are disjoint: `inputTokens` excludes cached input, which is
 * reported separately as `cacheReadTokens`. Cohere folds cache hits into
 * `tokens.input_tokens` and exposes the cached share as `cached_tokens`, so the
 * cached portion is subtracted out. Billed units are only a fallback, because
 * they are priced units rather than real tokens.
 * @param usage - the `usage` object from `message-end`.
 * @returns harness usage, or `undefined` when the payload carries no counts.
 */
export function mapUsage(usage: unknown): TokenUsage | undefined {
  if (typeof usage !== 'object' || usage === null) return undefined;
  const tokens = field(usage, 'tokens');
  const billed = field(usage, 'billed_units');
  const input = num(field(tokens, 'input_tokens')) ?? num(field(billed, 'input_tokens'));
  const output = num(field(tokens, 'output_tokens')) ?? num(field(billed, 'output_tokens'));
  if (input === undefined && output === undefined) return undefined;
  // Image tokens are reported *beside* the prompt count, not inside it, so they
  // belong to the disjoint input total. Verified live: adding one image moved
  // `input_tokens` by 1 while `image_tokens` read 259.
  const image = Math.max(
    0,
    num(field(tokens, 'image_tokens')) ?? num(field(billed, 'image_tokens')) ?? 0,
  );
  const total = (input ?? 0) + image;
  const produced = output ?? 0;
  const cached = Math.min(Math.max(0, num(field(usage, 'cached_tokens')) ?? 0), total);
  // Reasoning tokens are a subset of the output count (verified live), so they
  // are reported beside it and never added to the disjoint total.
  const reasoning =
    num(field(tokens, 'reasoning_tokens')) ?? num(field(billed, 'reasoning_tokens'));
  return {
    inputTokens: total - cached,
    outputTokens: produced,
    totalTokens: total + produced,
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
    ...(reasoning !== undefined && reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
}

/**
 * Labels that identify nothing, and therefore mark a source invalid.
 *
 * These are the synthesised fallbacks a citation falls back to when the
 * provider sent no usable title or URL: a document source with neither field
 * (`document`), a tool source with no name (`tool:unknown`), and the
 * citation-level fallback for a span with no sources at all (`未命名来源`).
 * They are provenance noise, so a source that only yields one of them is
 * rejected (WORKLOG §13.2).
 */
const PLACEHOLDER_LABELS: ReadonlySet<string> = new Set([
  'document',
  'tool:unknown',
  '未命名来源',
]);

/** A trimmed, non-empty string, or `undefined` when the value is not usable text. */
function usableText(value: unknown): string | undefined {
  const text = str(value)?.trim();
  return text === undefined || text.length === 0 ? undefined : text;
}

/**
 * Describe one citation source without asserting its full shape.
 *
 * Validity rule (WORKLOG §13.2): a source is valid only when it yields a usable
 * **title** or a usable **URL** — a document's `title`, a URL attached to the
 * document or to the source itself, or a tool output's `name` (the only title a
 * tool result has). Everything else is a placeholder: the synthesised
 * `document` / `tool:unknown` / `未命名来源` labels, the empty string, and a
 * bare positional id such as Cohere's `doc:0`. A citation whose every source is
 * invalid never enters the footnote, and a footnote left with nothing in it is
 * not emitted at all — the answer stream stays exactly as the model wrote it.
 * @param source - one entry of a citation's `sources` array.
 * @returns the best-effort label, plus whether it is usable provenance.
 */
function describeSource(source: unknown): SourceDescription {
  const type = str(field(source, 'type'));
  const id = usableText(field(source, 'id'));
  const document = field(source, 'document');
  const toolOutput = field(source, 'tool_output') ?? field(source, 'toolOutput');
  const isTool = toolOutput !== undefined || type === 'tool';
  const title =
    usableText(field(document, 'title')) ??
    usableText(field(source, 'title')) ??
    usableText(field(toolOutput, 'name'));
  const url = usableText(field(document, 'url')) ?? usableText(field(source, 'url'));
  // A tool output is titled by its tool's name; the `tool:` prefix keeps the
  // footnote reading as provenance rather than prose (the 0.2.0 label format).
  const label = title === undefined ? url : isTool ? `tool:${title}` : title;
  // Validity follows the title/URL alone, so a bare id never passes the gate.
  const valid = label !== undefined && !PLACEHOLDER_LABELS.has(label);
  if (label !== undefined) return { label, valid };
  // Nothing usable: report the placeholder this source would have fallen back
  // to, so a rejected citation still carries a readable reason.
  const placeholder = isTool
    ? `tool:${id ?? 'unknown'}`
    : document !== undefined || type === 'document'
      ? 'document'
      : (id ?? type ?? '');
  return { label: placeholder, valid: false };
}

/**
 * Render collected citations as one compact footnote block.
 * @param citations - the spans the provider reported, in arrival order. Every
 *   span carries at least one source that passed {@link describeSource}'s
 *   validity gate, so no placeholder label can reach the rendered text.
 * @returns the block text, or an empty string when there is nothing to show.
 */
function renderCitations(citations: readonly CitationRecord[]): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const citation of citations) {
    const label = citation.sources.join('、');
    if (seen.has(label)) continue;
    seen.add(label);
    const raw = citation.text.trim().replace(/\s+/g, ' ');
    const snippet = raw.length > 120 ? `${raw.slice(0, 120)}…` : raw;
    lines.push(`${lines.length + 1}. ${label}${snippet.length > 0 ? ` — 「${snippet}」` : ''}`);
    if (lines.length >= 20) break;
  }
  return lines.length === 0 ? '' : `\n\n引用来源：\n${lines.join('\n')}`;
}

/**
 * Translate one Cohere v2 SSE stream into harness chunks.
 * @param source - decoded response body text, in arrival order.
 * @param hooks - optional side channel for unrepresentable events.
 * @returns the chunk stream, ending in exactly one `finish`.
 * @throws CohereFailure when the stream ends without a usable terminal event.
 */
export async function* translateChatStream(
  source: AsyncIterable<string>,
  hooks: CohereStreamHooks = {},
): AsyncGenerator<StreamChunk, void, undefined> {
  const notice = (kind: string, detail: unknown): void => {
    hooks.onNotice?.({ kind, detail });
  };

  // `citationDisplay: 'notice'` keeps the model-generated text pristine:
  // citations are reported through the side channel instead of a trailing
  // footnote block. Surfacing stays off entirely when it was not requested.
  const surfaceCitations = hooks.citations === true && hooks.citationDisplay !== 'notice';

  let open: OpenBlock | undefined;
  let nextIndex = 0;
  let producedContent = 0;
  let sawTerminal = false;
  let pendingFinish: FinishReason | undefined;
  let responseId: string | undefined;
  const citations: CitationRecord[] = [];

  const close = (): StreamChunk | undefined => {
    if (open === undefined) return undefined;
    // Only a block the user can actually read counts as produced content: a bare
    // content-start/content-end pair is not a usable answer, and neither is a
    // reasoning block. A turn that only thought and then stopped leaves an empty
    // assistant message on screen, so it must fall through to the
    // `EMPTY_RESPONSE` guard below — which the harness retries
    // (`policyKey` lists `EMPTY_RESPONSE` among its retryable codes). Verified
    // live: `command-a-plus-05-2026` can answer with thinking alone and
    // `finish_reason: COMPLETE` (session-1e322330, turn 6).
    const meaningful = open.kind === 'tool-call' || (open.kind === 'text' && open.text.length > 0);
    const block: ContentBlock =
      open.kind === 'tool-call'
        ? ({
            type: 'tool-call',
            id: open.id as ToolCallId,
            name: open.name,
            // Cohere sends `"arguments": ""` and no deltas for a tool that takes
            // no parameters (verified live). An empty string is not a JSON
            // document, so it would break the tool executor here and be rejected
            // on replay ("tool arguments must be a stringified JSON object").
            arguments: open.arguments.length === 0 ? '{}' : open.arguments,
          } satisfies ToolCallBlock)
        : { type: open.kind, text: open.text };
    if (meaningful) producedContent += 1;
    const chunk: StreamChunk = { type: 'block-end', index: open.index, block };
    open = undefined;
    return chunk;
  };

  for await (const frame of frames(source)) {
    // Cohere closes the stream with a bare `data: [DONE]` sentinel (no event
    // name). Verified against the live API; it is terminal, not content.
    if (frame.data === '[DONE]') break;
    let payload: unknown;
    try {
      payload = JSON.parse(frame.data);
    } catch {
      notice('unparsed', frame.data);
      continue;
    }
    const type = str(field(payload, 'type')) ?? frame.event ?? 'unknown';
    const delta = field(payload, 'delta');
    const messageDelta = field(delta, 'message');

    switch (type) {
      case 'message-start': {
        responseId = str(field(payload, 'id')) ?? str(field(messageDelta, 'id'));
        break;
      }
      case 'content-start': {
        const closed = close();
        if (closed !== undefined) yield closed;
        const raw = str(field(field(messageDelta, 'content'), 'type')) ?? 'text';
        const kind = raw === 'thinking' ? 'reasoning' : 'text';
        open = { kind, index: nextIndex++, text: '' };
        yield { type: 'block-start', index: open.index, blockType: open.kind };
        break;
      }
      case 'content-delta': {
        const content = field(messageDelta, 'content') ?? field(delta, 'content');
        const text = str(field(content, 'text')) ?? str(field(content, 'thinking')) ?? '';
        let current = open;
        if (current === undefined) {
          current = { kind: 'text', index: nextIndex++, text: '' };
          open = current;
          yield { type: 'block-start', index: current.index, blockType: 'text' };
        }
        // A content delta that arrives inside a tool call is malformed; the
        // tool block owns the index until its own end event.
        if (current.kind === 'tool-call') break;
        if (text.length === 0) break;
        current.text += text;
        yield current.kind === 'reasoning'
          ? { type: 'reasoning-delta', index: current.index, text }
          : { type: 'text-delta', index: current.index, text };
        break;
      }
      case 'content-end': {
        const closed = close();
        if (closed !== undefined) yield closed;
        break;
      }
      case 'tool-plan-delta': {
        // Cohere's pre-tool plan is prose with no harness block of its own.
        notice('tool-plan-delta', field(messageDelta, 'tool_plan') ?? field(delta, 'tool_plan'));
        break;
      }
      case 'tool-call-start': {
        const closed = close();
        if (closed !== undefined) yield closed;
        const raw = field(messageDelta, 'tool_calls');
        const call = Array.isArray(raw) ? raw[0] : raw;
        const fn = field(call, 'function');
        open = {
          kind: 'tool-call',
          index: nextIndex++,
          id: str(field(call, 'id')) ?? '',
          name: str(field(fn, 'name')) ?? '',
          arguments: str(field(fn, 'arguments')) ?? '',
        };
        yield { type: 'block-start', index: open.index, blockType: 'tool-call' };
        break;
      }
      case 'tool-call-delta': {
        const raw = field(messageDelta, 'tool_calls') ?? field(delta, 'tool_calls');
        const call = Array.isArray(raw) ? raw[0] : raw;
        const fragment =
          str(field(field(call, 'function'), 'arguments')) ??
          str(field(field(field(call, 'function'), 'arguments'), 'arguments')) ??
          '';
        if (open === undefined || open.kind !== 'tool-call') {
          if (fragment.length === 0) break;
          throw failureFromProtocol('received a tool-call delta before any tool call started');
        }
        if (fragment.length === 0) break;
        open.arguments += fragment;
        yield {
          type: 'tool-call-delta',
          index: open.index,
          id: open.id as ToolCallId,
          argumentsDelta: fragment,
        };
        break;
      }
      case 'tool-call-end': {
        const closed = close();
        if (closed !== undefined) yield closed;
        break;
      }
      case 'citation-start': {
        const raw =
          field(messageDelta, 'citations') ?? field(delta, 'citations') ?? field(payload, 'citations');
        const node = Array.isArray(raw) ? raw[0] : raw;
        if (!surfaceCitations) {
          notice('citation-start', node);
          break;
        }
        const sources: string[] = [];
        const list = field(node, 'sources');
        if (Array.isArray(list)) {
          for (const source of list) {
            const described = describeSource(source);
            if (described.valid) sources.push(described.label);
          }
        }
        // A span whose every source is a placeholder (or that has none) carries
        // no provenance, so it never enters the footnote. If that leaves the
        // footnote empty, the terminal handler emits no block at all.
        if (sources.length > 0) {
          citations.push({ text: str(field(node, 'text')) ?? '', sources });
        }
        break;
      }
      case 'citation-end': {
        if (!surfaceCitations) notice('citation-end', field(delta, 'message') ?? delta);
        break;
      }
      case 'message-end': {
        const closed = close();
        if (closed !== undefined) yield closed;
        // Citations surface as one trailing text block, before the terminal
        // usage/finish pair the harness contract requires to stay last. Spans
        // whose sources were all placeholders were never collected, so an empty
        // list means "nothing worth showing" and yields no extra block.
        if (surfaceCitations && citations.length > 0) {
          const text = renderCitations(citations);
          if (text.length > 0) {
            const index = nextIndex++;
            producedContent += 1;
            yield { type: 'block-start', index, blockType: 'text' };
            yield { type: 'text-delta', index, text };
            yield { type: 'block-end', index, block: { type: 'text', text } };
          }
        }
        const usage = mapUsage(field(delta, 'usage') ?? field(payload, 'usage'));
        if (usage !== undefined) yield { type: 'usage', usage };
        const finishReason = str(field(delta, 'finish_reason')) ?? str(field(payload, 'finish_reason'));
        pendingFinish = mapFinishReason(
          finishReason,
          finishReason === 'ERROR' ? field(delta, 'error') ?? field(payload, 'error') : undefined,
        );
        sawTerminal = true;
        break;
      }
      case 'debug': {
        // The debug event repeats the entire outgoing prompt. It is never
        // forwarded: it would inject the request back into the transcript.
        notice('debug', undefined);
        break;
      }
      default: {
        notice(type, payload);
        break;
      }
    }
  }

  const trailing = close();
  if (trailing !== undefined) yield trailing;

  if (!sawTerminal || pendingFinish === undefined) {
    throw failureFromProtocol('stream ended without a message-end event');
  }

  const reason: FinishReason =
    producedContent === 0 && pendingFinish.kind === 'stop'
      ? {
          kind: 'error',
          failure: makeFailure('cohere: model produced no content', 'EMPTY_RESPONSE'),
        }
      : pendingFinish;

  yield {
    type: 'finish',
    reason,
    ...(responseId === undefined
      ? {}
      : { replayState: { response: { id: responseId, finishReason: pendingFinish.kind } } }),
  };
}
