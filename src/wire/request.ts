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
import { supportsStrictTools } from '../models.js';
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

/** Project one assistant message onto Cohere assistant content plus tool calls. */
function projectAssistant(message: Message): CohereChatMessage | undefined {
  const parts: CohereContentBlock[] = [];
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
        function: { name: block.name, arguments: block.arguments },
      });
    }
    // Reasoning blocks are provider-internal and are deliberately not replayed:
    // Cohere v2 assistant content carries text, tool calls, and citations only.
  }
  const content = compactText(parts);
  if (content.length === 0 && toolCalls.length === 0) return undefined;
  return {
    role: 'assistant',
    ...(content.length === 0 ? {} : { content }),
    ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
  };
}

/**
 * Project one harness message onto a Cohere message.
 * @param message - one request message that carries a role and a source.
 * @param model - the route being called, for capability checks.
 * @returns the Cohere message, or `undefined` when the message has no wire form.
 */
function projectMessage(
  message: Message,
  model: CohereModelConfig,
  images: PreparedImages | undefined,
): CohereChatMessage | undefined {
  switch (message.role) {
    case 'system': {
      const text = joinText(message.content);
      return text.length === 0 ? undefined : { role: 'system', content: text };
    }
    case 'developer': {
      // Developer messages publish incremental tool-set changes. Cohere v2 has
      // no developer slot, so their prose is folded into a system message; the
      // structured tool-addition/removal blocks are already reflected by the
      // `tools` array of the current request.
      const text = joinText(message.content);
      return text.length === 0 ? undefined : { role: 'system', content: text };
    }
    case 'user':
      return { role: 'user', content: projectUserContent(message.content, model, images) };
    case 'assistant':
      return projectAssistant(message);
    case 'tool': {
      const text = joinText(message.content);
      const body = text.length === 0 ? '{}' : text;
      return { role: 'tool', content: body, tool_call_id: message.toolCallId };
    }
    default:
      return undefined;
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
 * Whether one JSON Schema node keeps every object satisfiable under
 * `strict_tools`.
 *
 * Cohere rejects the whole request when any `object` node has no `required`
 * field ("extra restrictions to tool parameters apply when strict_tools=true"),
 * so the flag may only be sent for a fully compliant catalog.
 * @param node - any JSON Schema node.
 * @returns true when every reachable `object` node declares a `required` entry.
 */
function strictCompatibleNode(node: unknown): boolean {
  if (typeof node !== 'object' || node === null) return true;
  const record = node as Record<string, unknown>;
  const type = record.type;
  const objectLike =
    type === 'object' || (type === undefined && record.properties !== undefined);
  if (objectLike) {
    const required = record.required;
    if (!Array.isArray(required) || required.length === 0) return false;
  }
  if (Array.isArray(record.items)) {
    for (const item of record.items) if (!strictCompatibleNode(item)) return false;
  } else if (record.items !== undefined && !strictCompatibleNode(record.items)) {
    return false;
  }
  for (const key of ['properties', 'patternProperties', 'definitions', '$defs']) {
    const map = record[key];
    if (typeof map === 'object' && map !== null) {
      for (const value of Object.values(map as Record<string, unknown>)) {
        if (!strictCompatibleNode(value)) return false;
      }
    }
  }
  if (
    record.additionalProperties !== undefined &&
    typeof record.additionalProperties === 'object' &&
    !strictCompatibleNode(record.additionalProperties)
  ) {
    return false;
  }
  for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) {
    const list = record[key];
    if (Array.isArray(list)) {
      for (const entry of list) if (!strictCompatibleNode(entry)) return false;
    }
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
    if (projected !== undefined) messages.push(projected);
  }

  const tools = projectTools(options.tools);
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
    supportsStrictTools(model.id) &&
    strictToolsCompatible(tools)
      ? { strict_tools: true }
      : {}),
    ...(policy.includeCitations ? { citation_options: { mode: 'ENABLED' as const } } : {}),
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
