/**
 * DSH request vocabulary → Cohere OpenAI-compatible `/chat/completions` payload.
 *
 * The compatibility node (`POST {compatBaseURL}/chat/completions`) speaks the
 * OpenAI chat-completions contract, so every wire name here is the OpenAI one —
 * `max_tokens`, `stop`, `tool_calls`, `reasoning_effort` — while the shaping
 * rules stay those of the native builder in `../request.js`, so one harness
 * conversation projects to the same turns on either lane.
 *
 * Three harness facts shape this module:
 *
 * - `GenerateOptions.system` is the *one-shot caller's* system field and must be
 *   mapped ahead of `messages`; the agent loop leaves it empty and carries the
 *   rendered prompt as a leading `system`-role message instead, so both paths
 *   have to work.
 * - `inputModalities` is a negative capability signal, so text-only routes never
 *   receive image blocks. A block that contradicts the declared capability is a
 *   configuration error and fails loudly rather than being silently dropped.
 * - The harness routinely emits `[text, tool-call]` in one assistant message.
 *   The compatibility layer accepts that shape as a single message (verified
 *   live, HTTP 200), so — unlike the native lane — no turn splitting is needed.
 *
 * Live-verified facts about this endpoint (probe requests against
 * `https://api.cohere.ai/compatibility/v1`, see WORKLOG for the probe scripts):
 *
 * | shape | result |
 * | :--- | :--- |
 * | replaying `tool_calls[].function.arguments: ""` | **HTTP 400** `invalid tool call provided in messages[N].tool_calls[0]: function arguments could not be parsed` |
 * | one assistant message with `content` **and** `tool_calls` | HTTP 200 |
 * | `stop: "text"` (bare string) | **HTTP 422** `invalid type: parameter 'stop' is of type string but should be of type []Object` |
 * | `stop: ["text"]`, `max_tokens`, `seed`, `response_format: {type:'json_object'}`, `stream_options: {include_usage:true}`, tool `function.strict: true` | HTTP 200 |
 * | `reasoning_effort: 'none' \| 'high'` | HTTP 200 |
 * | `reasoning_effort: 'low' \| 'medium'` | **HTTP 422** `reasoning_effort 'medium' and 'low' are not supported. Use 'high' instead` |
 * | `citation_options`, `top_logprobs`, `logit_bias`, `n`, `store`, `parallel_tool_calls` | **HTTP 422** |
 * | `documents`, `connectors`, arbitrary unknown fields | HTTP 200 but **silently dropped** |
 *
 * A silently dropped field is the worst outcome available — the caller believes
 * they asked for retrieval or citations and gets a plain answer with no error —
 * so this module never emits one, and `../lane.js` keeps such requests on the
 * native lane instead.
 *
 * @module dsh-plugin-cohere/wire/openai/request
 */

import type {
  ContentBlock,
  GenerateOptions,
  Message,
  RequestMessage,
  ToolSchema,
} from '@deepseek-ai/dsh-llm';
import type { CohereModelConfig } from '../../config.js';
import { failureFromProtocol } from '../../failure.js';
import { imageDataUrl, type ImageRefLike, type PreparedImages } from '../images.js';
import { projectTools, replayableArguments, strictToolsCompatible } from '../request.js';

/** An OpenAI chat-completions text content part. */
export interface OpenAITextBlock {
  readonly type: 'text';
  readonly text: string;
}

/** An OpenAI chat-completions image content part. */
export interface OpenAIImageBlock {
  readonly type: 'image_url';
  readonly image_url: { readonly url: string; readonly detail?: 'low' | 'high' | 'auto' };
}

/** Any content part this adapter emits for a multi-part user turn. */
export type OpenAIContentBlock = OpenAITextBlock | OpenAIImageBlock;

/** One assistant tool call, in the OpenAI `tool_calls` shape. */
export interface OpenAIToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

/** One tool declaration, in the OpenAI `tools` shape. */
export interface OpenAITool {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
    readonly strict?: boolean;
  };
}

/** One chat-completions message. */
export interface OpenAIChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content?: string | readonly OpenAIContentBlock[] | null;
  readonly tool_calls?: readonly OpenAIToolCall[];
  readonly tool_call_id?: string;
}

/** The `/chat/completions` request body this adapter sends. */
export interface OpenAIChatRequest {
  readonly model: string;
  readonly messages: readonly OpenAIChatMessage[];
  readonly stream: true;
  readonly stream_options?: { readonly include_usage: true };
  readonly tools?: readonly OpenAITool[];
  /**
   * Only `none` and `high` exist on this endpoint: `low` and `medium` are a 422
   * ("reasoning_effort 'medium' and 'low' are not supported. Use 'high'
   * instead"), so a request carrying one is routed to the native lane instead.
   */
  readonly reasoning_effort?: 'none' | 'high';
  readonly response_format?: { readonly type: 'json_object' };
  readonly max_tokens?: number;
  readonly temperature?: number;
  /** ALWAYS an array: a bare string is a 422 on this endpoint. */
  readonly stop?: readonly string[];
}

/** Request-shaping switches resolved from plugin configuration. */
export interface OpenAIRequestPolicy {
  /** Whether tool `function.strict` may be sent for catalog routes that accept it. */
  readonly strictTools: boolean;
  /** Whether to request a bare JSON object as the answer. */
  readonly jsonMode: boolean;
  /** Send `stream_options.include_usage` so the stream carries exact usage. Defaults to true. */
  readonly includeUsage?: boolean;
}

/**
 * Stop sequences this endpoint documents as its maximum.
 *
 * Live probing only confirmed that an array is required, not its length bound;
 * four is the OpenAI contract's documented maximum, and a shorter array is
 * always accepted where a longer one may not be.
 */
const MAX_STOP_SEQUENCES = 4;

/** Read an own property off an unknown value without asserting a shape. */
function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

/** Concatenate the text of every `text` block, ignoring non-text blocks. */
function joinText(blocks: readonly ContentBlock[]): string {
  let text = '';
  for (const block of blocks) {
    if (block.type === 'text') text += block.text;
  }
  return text;
}

/**
 * Collapse projected blocks to the wire's compact string form.
 *
 * Only a lone text part collapses: with several parts the block list is kept so
 * the boundaries the caller authored survive the round trip, and the endpoint
 * accepts either shape for user content.
 * @param projected - the projected content blocks, in order.
 * @returns the joined string, or the block list.
 */
function compactText(
  projected: readonly OpenAIContentBlock[],
): string | readonly OpenAIContentBlock[] {
  if (projected.length === 1 && projected[0]!.type === 'text') {
    return (projected[0] as OpenAITextBlock).text;
  }
  return projected;
}

/**
 * Project one user-role content list onto OpenAI user content.
 *
 * An image resolves through the prepared request versions; a reference the
 * store returned no bytes for degrades to its placeholder text, exactly as the
 * native lane does.
 * @param blocks - the harness content blocks, in order.
 * @param model - the route being called, for the capability check.
 * @param images - request-ready image bytes, when the request carried any.
 * @returns the compact string form, or a content-part list.
 */
function projectUserContent(
  blocks: readonly ContentBlock[],
  model: CohereModelConfig,
  images: PreparedImages | undefined,
): string | readonly OpenAIContentBlock[] {
  const projected: OpenAIContentBlock[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      projected.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'image') {
      if (!model.inputModalities.includes('image')) {
        // The harness gates images by declared modality, so reaching this branch
        // means the configured catalog claims a capability the adapter cannot
        // encode — a configuration error, not a normal request.
        throw failureFromProtocol(
          `model "${model.id}" is configured as text-only but the request carried an image block`,
        );
      }
      if (images === undefined) {
        throw failureFromProtocol(
          'image input requires the durable attachment service (ctx "attachments")',
        );
      }
      const ref = block.attachment as unknown as ImageRefLike;
      const version = images.versions.get(ref.attachmentId);
      if (version === undefined) {
        // Offloaded images are already placeholder text by this point; this
        // guards a reference the store returned no bytes for.
        projected.push({ type: 'text', text: images.placeholder(ref) });
      } else {
        projected.push({ type: 'image_url', image_url: { url: imageDataUrl(version) } });
      }
      continue;
    }
  }
  // A single text part is the wire's compact form; the endpoint accepts either.
  return compactText(projected);
}

/**
 * Project one assistant message onto exactly one OpenAI assistant message.
 *
 * The compatibility layer accepts a message that carries prose *and* tool calls
 * at once (verified live, HTTP 200), so the native lane's turn splitting is not
 * needed and the harness's own message boundary survives the projection.
 * @param message - one assistant message from the harness.
 * @returns the single OpenAI assistant message, or none when it is empty.
 */
function projectAssistant(message: Message): readonly OpenAIChatMessage[] {
  let text = '';
  const toolCalls: OpenAIToolCall[] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      text += block.text;
      continue;
    }
    if (block.type === 'tool-call') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: replayableArguments(block.arguments) },
      });
    }
    // Reasoning blocks are provider-internal and are deliberately not replayed:
    // the endpoint has no request field for them, and replaying the text would
    // feed the model its own chain of thought as ordinary prose.
  }
  if (toolCalls.length > 0) {
    // An assistant turn with calls but no prose must say `content: null`; the
    // key is present and empty rather than absent (verified live).
    return [{ role: 'assistant', content: text.length === 0 ? null : text, tool_calls: toolCalls }];
  }
  if (text.length === 0) return [];
  return [{ role: 'assistant', content: text }];
}

/**
 * Project one harness message onto zero or more OpenAI messages.
 * @param message - one request message that carries a role and a source.
 * @param model - the route being called, for capability checks.
 * @param images - request-ready image bytes, when the request carried any.
 * @returns the OpenAI messages, in order; empty when the message has no wire form.
 */
function projectMessage(
  message: Message,
  model: CohereModelConfig,
  images: PreparedImages | undefined,
): readonly OpenAIChatMessage[] {
  switch (message.role) {
    case 'system': {
      const text = joinText(message.content);
      return text.length === 0 ? [] : [{ role: 'system', content: text }];
    }
    case 'developer': {
      // Developer messages publish incremental tool-set changes. OpenAI
      // chat-completions has no developer slot, so their prose is folded into a
      // system message; the structured tool-addition/removal blocks are already
      // reflected by the `tools` array of the current request.
      const text = joinText(message.content);
      return text.length === 0 ? [] : [{ role: 'system', content: text }];
    }
    case 'user':
      return [{ role: 'user', content: projectUserContent(message.content, model, images) }];
    case 'assistant':
      return projectAssistant(message);
    case 'tool': {
      const text = joinText(message.content);
      const body = text.length === 0 ? '{}' : text;
      return [{ role: 'tool', content: body, tool_call_id: message.toolCallId }];
    }
    default:
      return [];
  }
}

/**
 * Project the harness tool catalog onto OpenAI tool declarations.
 * @param tools - the harness tool schemas, when the caller sent any.
 * @param strict - whether every function may carry `strict: true`.
 * @returns the declarations, or `undefined` when there are no tools to declare.
 */
export function projectOpenAITools(
  tools: readonly ToolSchema[] | undefined,
  strict: boolean,
): readonly OpenAITool[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(strict ? { strict: true } : {}),
    },
  }));
}

/**
 * Whether this request may carry tool `function.strict: true`.
 *
 * The keyword allow-list lives in the native module and is reused rather than
 * duplicated: `strict` is the same JSON-Schema constraint set on both lanes
 * (Cohere validates it once, before running anything), so the gate runs the
 * native-shaped declarations through {@link strictToolsCompatible}.
 * @param tools - the harness tool schemas, when the caller sent any.
 * @param model - the route being called, for the per-route feature flag.
 * @param policy - the configured strict-tool switch.
 * @returns true when every declaration is safe to send with `strict: true`.
 */
function strictToolsAllowed(
  tools: readonly ToolSchema[] | undefined,
  model: CohereModelConfig,
  policy: OpenAIRequestPolicy,
): boolean {
  if (!policy.strictTools || model.strictTools === false) return false;
  const nativeTools = projectTools(tools);
  if (nativeTools === undefined) return false;
  return strictToolsCompatible(nativeTools);
}

/**
 * Resolve the `reasoning_effort` control for one request, when it applies.
 *
 * Only `off`/`disabled` and `high` have an equivalent here. Every other effort
 * (`low`, `medium`, …) is a 422 on this endpoint, and `lane.js` routes those
 * requests to the native lane — reaching this function with one means the lane
 * decision and the projection disagree, so the field is omitted rather than
 * sent as a request the endpoint is documented to reject.
 * @param options - the full harness request.
 * @param model - the resolved catalog entry for `options.model`.
 * @returns the effort to send, or `undefined` to leave the model's default.
 */
function reasoningEffortFor(
  options: GenerateOptions,
  model: CohereModelConfig,
): OpenAIChatRequest['reasoning_effort'] | undefined {
  if (model.reasoning === false) return undefined;
  const effort = options.reasoningEffort as string | undefined;
  if (effort === undefined) return undefined;
  if (effort === 'off' || effort === 'disabled') return 'none';
  if (effort === 'high') return 'high';
  return undefined;
}

/**
 * Build the OpenAI-compatible `/chat/completions` body for one harness call.
 * @param options - the full harness request.
 * @param model - the resolved catalog entry for `options.model`.
 * @param policy - strict-tool, JSON-mode and usage switches from configuration.
 * @param images - request-ready image bytes, when the request carried any.
 * @returns the streaming request body.
 */
export function buildOpenAIChatRequest(
  options: GenerateOptions,
  model: CohereModelConfig,
  policy: OpenAIRequestPolicy,
  images?: PreparedImages,
): OpenAIChatRequest {
  const messages: OpenAIChatMessage[] = [];

  // The one-shot caller's system field precedes every message.
  if (options.system !== undefined && options.system.length > 0) {
    messages.push({ role: 'system', content: options.system });
  }

  for (const message of options.messages as readonly RequestMessage[]) {
    if (typeof message !== 'object' || message === null) continue;
    if (message.role === 'user' && !('source' in message)) {
      // RequestUserInput: a bare user turn contributed by the caller.
      messages.push({
        role: 'user',
        content: projectUserContent(message.content, model, images),
      });
      continue;
    }
    const projected = projectMessage(message as Message, model, images);
    for (const entry of projected) messages.push(entry);
  }

  // A route without the live `tools` feature rejects the whole request, so an
  // incapable catalog row degrades to a text-only call instead of a dead
  // request — the same rule the native lane applies.
  const tools =
    model.tools === false
      ? undefined
      : projectOpenAITools(options.tools, strictToolsAllowed(options.tools, model, policy));
  // `stop` is always an array here: a bare string is a 422 on this endpoint.
  const stop = options.stop?.slice(0, MAX_STOP_SEQUENCES);
  // Mirrors the native clamp exactly: a caller cap is floored to at least one
  // token and can never exceed what the route accepts.
  const maxTokens = Math.min(
    options.maxTokens !== undefined && Number.isFinite(options.maxTokens)
      ? Math.max(1, Math.floor(options.maxTokens))
      : model.maxTokens,
    model.maxTokens,
  );
  const reasoningEffort = reasoningEffortFor(options, model);

  return {
    model: model.id,
    messages,
    stream: true,
    // Exact usage arrives in a final chunk whose `choices` is empty; without
    // this the stream reports no usage at all.
    ...(policy.includeUsage === false ? {} : { stream_options: { include_usage: true as const } }),
    ...(tools === undefined ? {} : { tools }),
    ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
    ...(policy.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
    max_tokens: maxTokens,
    ...(typeof options.temperature === 'number' && Number.isFinite(options.temperature)
      ? { temperature: options.temperature }
      : {}),
    ...(stop === undefined || stop.length === 0 ? {} : { stop }),
  };
}

/** Read the request's diagnostic surface without asserting a shape. */
export function describeOpenAIRequest(request: OpenAIChatRequest): Record<string, unknown> {
  return {
    model: request.model,
    messages: request.messages.length,
    tools: field(request, 'tools') === undefined ? 0 : (request.tools?.length ?? 0),
    strictTools: request.tools?.some((tool) => tool.function.strict === true) === true,
    jsonMode: request.response_format?.type === 'json_object',
    reasoningEffort: request.reasoning_effort ?? 'default',
    maxTokens: request.max_tokens,
  };
}
