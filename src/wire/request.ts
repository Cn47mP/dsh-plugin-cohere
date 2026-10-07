/**
 * DSH request vocabulary → Cohere v2 `/chat` payload.
 *
 * Two harness facts shape this module:
 *
 * - `GenerateOptions.system` is the *one-shot caller's* system field and must be
 *   mapped into the provider's system slot ahead of `messages`. The agent loop
 *   leaves it empty and instead carries the rendered prompt as a leading
 *   `system`-role message, so both paths have to work.
 * - `inputModalities` is a negative capability signal, so text-only routes never
 *   receive image blocks. A block that contradicts the declared capability is a
 *   configuration error and fails loudly rather than being silently dropped.
 *
 * Source for the wire shape: https://docs.cohere.com/reference/chat
 *
 * @module dsh-plugin-cohere/wire/request
 */

import type {
  ContentBlock,
  GenerateOptions,
  Message,
  RequestMessage,
  ToolSchema,
} from '@deepseek-ai/dsh-llm';
import type { CohereModelConfig } from '../config.js';
import { failureFromProtocol } from '../failure.js';
import { imageDataUrl, type ImageRefLike, type PreparedImages } from './images.js';

/** A Cohere v2 text content block. */
export interface CohereTextBlock {
  readonly type: 'text';
  readonly text: string;
}

/** A Cohere v2 image content block. */
export interface CohereImageBlock {
  readonly type: 'image_url';
  readonly image_url: { readonly url: string; readonly detail?: 'low' | 'high' | 'auto' };
}

/** Any Cohere v2 content block this adapter emits. */
export type CohereContentBlock = CohereTextBlock | CohereImageBlock;

/** One Cohere v2 assistant tool call. */
export interface CohereToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

/** One Cohere v2 tool declaration. */
export interface CohereTool {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

/** One Cohere v2 chat message. */
export interface CohereChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content?: string | readonly CohereContentBlock[];
  readonly tool_calls?: readonly CohereToolCall[];
  readonly tool_call_id?: string;
}

/** The Cohere v2 `/chat` request body this adapter sends. */
export interface CohereChatRequest {
  readonly model: string;
  readonly messages: readonly CohereChatMessage[];
  readonly stream: true;
  readonly tools?: readonly CohereTool[];
  readonly strict_tools?: boolean;
  readonly citation_options?: { readonly mode: 'ENABLED' | 'DISABLED' | 'OFF' };
  /** Structured output; the schema field is `json_schema` (verified live). */
  readonly response_format?: {
    readonly type: 'json_object';
    readonly json_schema?: Record<string, unknown>;
  };
  readonly thinking?: { readonly type: 'enabled' | 'disabled'; readonly token_budget?: number };
  readonly max_tokens?: number;
  readonly temperature?: number;
  readonly stop_sequences?: readonly string[];
}

/** Request-shaping switches resolved from plugin configuration. */
export interface RequestPolicy {
  /** Whether to ask Cohere for citation spans (and surface them). */
  readonly includeCitations: boolean;
  /** Whether `strict_tools` may be sent for catalog routes that accept it. */
  readonly strictTools: boolean;
  /** Whether to request a bare JSON object as the answer. */
  readonly jsonMode: boolean;
}

/** Thinking-token budgets per declared reasoning effort. */
const THINKING_BUDGETS: Readonly<Record<string, number>> = {
  low: 4_096,
  high: 16_384,
};

/** Cohere accepts at most five stop sequences. */
const MAX_STOP_SEQUENCES = 5;

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

/** Project one user-role content list onto Cohere user content. */
function projectUserContent(
  blocks: readonly ContentBlock[],
  model: CohereModelConfig,
  images: PreparedImages | undefined,
): string | readonly CohereContentBlock[] {
  const projected: CohereContentBlock[] = [];
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
  // A single text part is the wire's compact form; Cohere accepts either shape.
  return compactText(projected);
}

/**
 * Collapse projected blocks to the wire's compact string form.
 *
 * Only a lone text part collapses: with several parts the block list is kept so
 * the boundaries the caller authored survive the round trip, and Cohere accepts
 * either shape for user and assistant content alike.
 * @param projected - the projected content blocks, in order.
 * @returns the joined string, or the block list.
 */
function compactText(
  projected: readonly CohereContentBlock[],
): string | readonly CohereContentBlock[] {
  if (projected.length === 1 && projected[0]!.type === 'text') {
    return (projected[0] as CohereTextBlock).text;
  }
  return projected;
}

/**
 * Coerce one harness tool-call `arguments` string into the shape Cohere replays.
 *
 * Cohere streams `"arguments": ""` for a tool that takes no parameters (verified
 * live) and then rejects that same empty string on replay:
 * "invalid tool call provided in messages[N].tool_calls[0]: tool arguments must
 * be a stringified JSON object". `"null"` is accepted but `"[]"` is not, so the
 * requirement is a JSON *object*. Anything else would 400 the whole request,
 * which costs far more than losing a malformed argument payload.
 * @param argumentsText - the arguments string carried by the harness block.
 * @returns a stringified JSON object that is safe to send back to Cohere.
 */
function replayableArguments(argumentsText: string): string {
  if (argumentsText.length === 0) return '{}';
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return argumentsText;
    }
  } catch {
    // Not JSON at all: fall through to the empty object.
  }
  return '{}';
}

/**
 * Project one assistant message onto one or two Cohere assistant messages.
 *
 * Cohere v2 draws a hard line between the two assistant shapes: a message with
 * `tool_calls` may not also carry text content
 * (`messages with non-empty 'tool_calls' cannot contain content items of type
 * 'text'`, verified live on every tool-capable route). The harness routinely
 * produces exactly that shape — a model that narrates before calling a tool
 * yields `[text, tool-call]` in one assistant message — so the prose is
 * replayed as its own assistant turn immediately before the calls.
 *
 * Cohere's `tool_plan` field would be the natural home for that prose, but it is
 * route-gated: `command-a-plus-05-2026` and `north-mini-code-1-0` both answer
 * 400 "`tool plan` cannot be used with this model". Consecutive assistant turns
 * are accepted everywhere tested, so they are the portable shape.
 *
 * @param message - one assistant message from the harness.
 * @returns zero, one, or two Cohere assistant messages, in order.
 */
function projectAssistant(message: Message): readonly CohereChatMessage[] {
  const parts: CohereTextBlock[] = [];
  const toolCalls: CohereToolCall[] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text });
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
    // Cohere v2 assistant content carries text, tool calls, and citations only.
  }
  if (toolCalls.length > 0) {
    const plan = parts.map((part) => part.text).join('');
    return [
      ...(plan.length === 0 ? [] : [{ role: 'assistant' as const, content: plan }]),
      { role: 'assistant', tool_calls: toolCalls },
    ];
  }
  const content = compactText(parts);
  if (content.length === 0) return [];
  return [{ role: 'assistant', content }];
}

/**
 * Project one harness message onto zero or more Cohere messages.
 * @param message - one request message that carries a role and a source.
 * @param model - the route being called, for capability checks.
 * @returns the Cohere messages, in order; empty when the message has no wire form.
 */
function projectMessage(
  message: Message,
  model: CohereModelConfig,
  images: PreparedImages | undefined,
): readonly CohereChatMessage[] {
  switch (message.role) {
    case 'system': {
      const text = joinText(message.content);
      return text.length === 0 ? [] : [{ role: 'system', content: text }];
    }
    case 'developer': {
      // Developer messages publish incremental tool-set changes. Cohere v2 has
      // no developer slot, so their prose is folded into a system message; the
      // structured tool-addition/removal blocks are already reflected by the
      // `tools` array of the current request.
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

/** Project the harness tool catalog onto Cohere tool declarations. */
export function projectTools(
  tools: readonly ToolSchema[] | undefined,
): readonly CohereTool[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/**
 * JSON-Schema keywords Cohere's `strict_tools` mode accepts.
 *
 * Cohere validates the entire tool catalog before it runs anything, and rejects
 * the whole request with HTTP 400 ("invalid function at tools[N].function: extra
 * restrictions to tool parameters apply when strict_tools=true") for any
 * constraint outside this set. Verified live against `command-a-03-2025`:
 *
 * | accepted | rejected |
 * | :--- | :--- |
 * | `type` (incl. `['string','null']`), `enum`, `format`, `default` | `pattern`, `minLength`, `maxLength` |
 * | `additionalProperties` (bool or schema), `uniqueItems` | `minimum`, `maximum`, `multipleOf` |
 * | `anyOf`, `exclusiveMinimum`, nested objects with `required`, `items` | `minItems`, `minProperties` |
 * | | `oneOf`, `allOf`, `not`, `const` |
 *
 * Because unknown keywords are refused as well, this is an allow-list: a schema
 * outside it only costs the optimisation, never a failed request. Only keywords
 * verified accepted live are listed, so `exclusiveMaximum` stays out even
 * though its `exclusiveMinimum` sibling is in.
 */
const STRICT_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  'type',
  'title',
  'description',
  'default',
  'example',
  'examples',
  'enum',
  'format',
  'properties',
  'required',
  'items',
  'additionalProperties',
  'anyOf',
  'uniqueItems',
  'exclusiveMinimum',
]);

/**
 * Whether one JSON Schema node keeps every object satisfiable under
 * `strict_tools`.
 *
 * Two rules bite even inside the allowed keyword set, both verified live:
 * every `object` node must declare at least one `required` field ("`object`
 * type must have at least one required field"), and each `required` entry must
 * name a property that the same node defines ("`required` contains an undefined
 * field"). A structural keyword without a `type` is refused too ("missing
 * required field 'type'").
 * @param node - any JSON Schema node.
 * @returns true when Cohere's strict mode accepts this node.
 */
function strictCompatibleNode(node: unknown): boolean {
  if (typeof node !== 'object' || node === null) return true;
  const record = node as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!STRICT_SCHEMA_KEYWORDS.has(key)) return false;
  }

  const type = record.type;
  const declaresType = typeof type === 'string' || Array.isArray(type);
  const properties = record.properties;
  const objectLike = type === 'object' || (type === undefined && properties !== undefined);
  if (objectLike) {
    const required = record.required;
    if (!Array.isArray(required) || required.length === 0) return false;
    const declared = new Set(
      typeof properties === 'object' && properties !== null
        ? Object.keys(properties as Record<string, unknown>)
        : [],
    );
    for (const entry of required) {
      if (typeof entry !== 'string' || !declared.has(entry)) return false;
    }
  }
  if (!declaresType && (properties !== undefined || record.items !== undefined)) return false;

  if (Array.isArray(record.items)) {
    for (const item of record.items) if (!strictCompatibleNode(item)) return false;
  } else if (record.items !== undefined && !strictCompatibleNode(record.items)) {
    return false;
  }
  if (properties !== undefined) {
    if (typeof properties !== 'object' || properties === null) return false;
    for (const value of Object.values(properties as Record<string, unknown>)) {
      if (!strictCompatibleNode(value)) return false;
    }
  }
  if (
    record.additionalProperties !== undefined &&
    typeof record.additionalProperties === 'object' &&
    !strictCompatibleNode(record.additionalProperties)
  ) {
    return false;
  }
  if (Array.isArray(record.anyOf)) {
    for (const entry of record.anyOf) if (!strictCompatibleNode(entry)) return false;
  }
  return true;
}

/**
 * Whether every declared tool is safe to send with `strict_tools: true`.
 * @param tools - the projected Cohere tool declarations.
 * @returns true when the whole catalog satisfies Cohere's strict-shaped rule.
 */
export function strictToolsCompatible(tools: readonly CohereTool[]): boolean {
  for (const tool of tools) {
    if (!strictCompatibleNode(tool.function.parameters)) return false;
  }
  return true;
}

/**
 * Build the Cohere v2 `/chat` body for one harness call.
 * @param options - the full harness request.
 * @param model - the resolved catalog entry for `options.model`.
 * @param policy - citation and strict-tool switches from configuration.
 * @returns the streaming request body.
 */
export function buildChatRequest(
  options: GenerateOptions,
  model: CohereModelConfig,
  policy: RequestPolicy,
  images?: PreparedImages,
): CohereChatRequest {
  const messages: CohereChatMessage[] = [];

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

  // A route without the live `tools` feature rejects the entire request with a
  // 400 ("tool use is not supported by the provided model"), so an incapable
  // catalog row degrades to a text-only call instead of a dead request.
  const tools = model.tools === false ? undefined : projectTools(options.tools);
  const stop = options.stop?.slice(0, MAX_STOP_SEQUENCES);
  const maxTokens = Math.min(
    options.maxTokens !== undefined && Number.isFinite(options.maxTokens)
      ? Math.max(1, Math.floor(options.maxTokens))
      : model.maxTokens,
    model.maxTokens,
  );
  // The thinking budget must be resolved against the *final* max_tokens: Cohere
  // rejects `token_budget > max_tokens` with a 400.
  const thinking = thinkingFor(options, model, maxTokens);

  const request: CohereChatRequest = {
    model: model.id,
    messages,
    stream: true,
    ...(tools === undefined ? {} : { tools }),
    ...(tools !== undefined &&
    policy.strictTools &&
    model.strictTools !== false &&
    strictToolsCompatible(tools)
      ? { strict_tools: true }
      : {}),
    // Citations are a per-route feature too: a model that rejects
    // `citation_options` 400s the whole call, so the flag is honoured only
    // where the route advertises the feature.
    ...(policy.includeCitations && model.citations !== false
      ? { citation_options: { mode: 'ENABLED' as const } }
      : {}),
    ...(policy.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
    ...(thinking === undefined ? {} : { thinking }),
    max_tokens: maxTokens,
    ...(typeof options.temperature === 'number' && Number.isFinite(options.temperature)
      ? { temperature: options.temperature }
      : {}),
    ...(stop === undefined || stop.length === 0 ? {} : { stop_sequences: stop }),
  };
  return request;
}

/** Resolve the Cohere `thinking` control for one request, when it applies. */
function thinkingFor(
  options: GenerateOptions,
  model: CohereModelConfig,
  maxTokens: number,
): CohereChatRequest['thinking'] | undefined {
  if (!model.reasoning) return undefined;
  const effort = options.reasoningEffort as string | undefined;
  if (effort === undefined) return undefined;
  if (effort === 'off' || effort === 'disabled') {
    // Cohere rejects `token_budget: 0` ("must be greater than 0"), so the
    // disabled control must carry no budget at all (verified live).
    return { type: 'disabled' };
  }
  const budget = THINKING_BUDGETS[effort];
  if (budget === undefined) return undefined;
  // Cohere requires `0 < token_budget <= max_tokens`, and the budget is part of
  // the same output cap, so it is clamped to the resolved request budget.
  const capped = Math.min(budget, model.maxTokens, maxTokens);
  if (capped < 1) return undefined;
  return { type: 'enabled', token_budget: capped };
}

/** Read a nested string for diagnostics without asserting a shape. */
export function describeRequest(request: CohereChatRequest): Record<string, unknown> {
  return {
    model: request.model,
    messages: request.messages.length,
    tools: field(request, 'tools') === undefined ? 0 : (request.tools?.length ?? 0),
    strictTools: request.strict_tools === true,
    citations: request.citation_options?.mode ?? 'DISABLED',
    maxTokens: request.max_tokens,
  };
}
