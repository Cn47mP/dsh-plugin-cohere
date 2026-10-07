/**
 * Live plugin configuration for the Cohere provider route.
 *
 * The schema is resolved by the harness before {@link apply} sees it, and the
 * GUI Models page renders these fields, so every declared field here is a real
 * user-visible setting. `apiKeyEnv` carries the `credential-ref` role, which is
 * what lets the settings surface store the secret through the credentials
 * service instead of writing it into configuration.
 *
 * @module dsh-plugin-cohere/config
 */

import z from '@deepseek-ai/schemastery';
import { COHERE_MODELS, DEFAULT_MODEL_ID, type CohereCatalogEntry } from './models.js';

/** Provider route key registered with `ctx.llm.registerAdapter`. */
export const PROVIDER = 'cohere';

/** Default Cohere v2 chat endpoint. */
export const DEFAULT_BASE_URL = 'https://api.cohere.com/v2';

/** Default credential reference read through the credentials service. */
export const DEFAULT_API_KEY_ENV = 'COHERE_API_KEY';

/**
 * Input modalities this adapter can actually encode into a Cohere request.
 *
 * Configuration may declare a provider-capable route as image-accepting, but
 * the harness treats `inputModalities` as a *negative capability* signal: it
 * decides from this list whether image blocks may reach the adapter at all.
 * Every effective entry is intersected with this set, so a route advertises
 * image input only when the catalog declares it *and* the adapter can encode it.
 */
export const ADAPTER_INPUT_MODALITIES: readonly ('text' | 'image')[] = ['text', 'image'];

/** Per-model settings row. */
const ModelConfig = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(''),
  contextWindow: z.number().default(128_000),
  maxTokens: z.number().default(8_192),
  inputModalities: z
    .array(z.union([z.const('text'), z.const('image')]))
    .default(['text']),
  reasoning: z.boolean().default(false),
  // Per-route request features, mirroring Cohere's live `features` list. A row
  // the operator adds by hand defaults to "capable"; the adapter retries
  // without a rejected field at runtime, so a wrong guess self-heals with one
  // extra request instead of failing every call.
  tools: z.boolean().default(true),
  citations: z.boolean().default(true),
  strictTools: z.boolean().default(true),
  deprecated: z.boolean().default(false),
});

/** Shipped catalog shaped as schema defaults. */
const DEFAULT_MODELS = COHERE_MODELS.map((model) => ({
  ...model,
  inputModalities: [...model.inputModalities],
}));

/**
 * Live plugin configuration schema.
 *
 * Every field is `volatile()`: this section is a settings surface, not part of
 * the reconstructable request, so its values must stay out of the frozen
 * configuration snapshot the agent loop hashes.
 */
export const Config = z.object({
  /** Cohere v2 base URL; `/chat` is appended. */
  baseURL: z.string().default(DEFAULT_BASE_URL).volatile(),
  /** Human-readable provider name shown in model selectors. */
  providerName: z.string().default('Cohere').volatile(),
  /** Advertised model catalog; replaces the shipped default when set. */
  models: z.array(ModelConfig).default(DEFAULT_MODELS).volatile(),
  /** Credential reference holding the Cohere API key. */
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV).volatile(),
  /**
   * Whether Cohere citations are requested *and surfaced*. The harness has no
   * citation content block, so an enabled request appends one trailing text
   * block listing the cited sources (see `wire/event-stream`).
   */
  includeCitations: z.boolean().default(false).volatile(),
  /** Send `strict_tools`, letting Cohere constrain tool arguments by schema. */
  strictTools: z.boolean().default(true).volatile(),
  /**
   * Structured output mode: sends `response_format: { type: 'json_object' }` so
   * the model answers with a bare JSON object. The harness has no structured
   * request field, so this is a plugin/model-level switch.
   */
  jsonMode: z.boolean().default(false).volatile(),
  /** Abort a streaming call after this long with no SSE traffic. */
  streamIdleTimeoutMs: z.number().default(300_000).volatile(),
  /** Abort the initial request after this long awaiting response headers. */
  requestTimeoutMs: z.number().default(120_000).volatile(),
  /** Whole-request base64 image bound; exceeding it asks the harness to offload. */
  maxRequestImageBytes: z.number().default(20 * 1024 * 1024).volatile(),
  /** Per-image width×height cap used to pick the re-encode target. */
  requestImagePixelBudget: z.number().default(2048 * 2048).volatile(),
  /** Per-image encoded byte cap used to pick the re-encode target. */
  requestImageMaxBytes: z.number().default(1024 * 1024).volatile(),
});

/** One effective model row after configuration resolution. */
export type CohereModelConfig = CohereCatalogEntry;

/** Detached, validated inputs the adapter runs on. */
export interface CohereOptions {
  readonly baseURL: string;
  readonly providerName: string;
  readonly models: readonly CohereModelConfig[];
  readonly apiKeyEnv: string;
  readonly includeCitations: boolean;
  readonly strictTools: boolean;
  readonly jsonMode: boolean;
  readonly streamIdleTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly maxRequestImageBytes: number;
  readonly requestImagePixelBudget: number;
  readonly requestImageMaxBytes: number;
}

/**
 * Unwrap a `volatile()` configuration field.
 *
 * Every field in this schema is declared `volatile()`, so the harness does not
 * hand `apply` the plain value the schema describes: it hands a resolver object
 * that carries the live value behind `get()`. Reading such a field directly
 * always misses and silently falls back to the default, which is how a
 * configured `baseURL` could still send traffic to the shipped endpoint. Plain
 * values — including a raw settings record — pass through untouched.
 * @param value - one resolved configuration field.
 * @returns the underlying value when the field is a resolver, else the input.
 */
export function unwrapVolatile(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const resolve = (value as { get?: unknown }).get;
  if (typeof resolve !== 'function') return value;
  try {
    return (resolve as () => unknown).call(value);
  } catch {
    // A resolver that throws is treated as an absent field.
    return undefined;
  }
}

/**
 * Read the credential reference name out of a resolved configuration field.
 *
 * Raw settings hold a plain string; the settings layer materializes a
 * `credential-ref` field into a resolver object. Both shapes reach `apply`, so
 * the value is unwrapped defensively rather than trusted to be one of them.
 * @param value - the resolved `apiKeyEnv` field.
 * @returns a non-empty credential reference name.
 */
export function credentialRefName(value: unknown): string {
  const resolved = unwrapVolatile(value);
  return typeof resolved === 'string' && resolved.trim().length > 0
    ? resolved.trim()
    : DEFAULT_API_KEY_ENV;
}

/** Narrow an unknown configuration field to a usable positive integer. */
function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

/** Narrow an unknown configuration field to a non-empty string. */
function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

/** Coerce one configured model row into the adapter's catalog shape. */
function normalizeModel(raw: unknown): CohereModelConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  if (id.length === 0) return undefined;
  const declared = Array.isArray(row.inputModalities)
    ? row.inputModalities.filter((m): m is 'text' | 'image' => m === 'text' || m === 'image')
    : [];
  const modalities = declared.filter((m) => ADAPTER_INPUT_MODALITIES.includes(m));
  return {
    id,
    name: nonEmptyString(row.name, id),
    description: typeof row.description === 'string' ? row.description : '',
    contextWindow: positiveInt(row.contextWindow, 128_000),
    maxTokens: positiveInt(row.maxTokens, 8_192),
    inputModalities: modalities.length > 0 ? modalities : ['text'],
    reasoning: row.reasoning === true,
    tools: row.tools !== false,
    citations: row.citations !== false,
    strictTools: row.strictTools !== false,
    deprecated: row.deprecated === true,
  };
}

/**
 * Detach the live configuration into the plain values the adapter reads.
 * @param config - resolved plugin configuration (a schemastery object or a raw record).
 * @returns validated, frozen adapter inputs.
 */
export function resolveOptions(config: Record<string, unknown>): CohereOptions {
  // `volatile()` fields reach this function as resolvers, never as the plain
  // values the schema declares, so every read goes through one unwrapping step.
  const source = (unwrapVolatile(config) ?? {}) as Record<string, unknown>;
  const read = (key: string): unknown => unwrapVolatile(source[key]);

  const rawModels = read('models');
  const rows = Array.isArray(rawModels) ? rawModels.map(unwrapVolatile) : DEFAULT_MODELS;
  const models = rows
    .map((model) => normalizeModel(model))
    .filter((model): model is CohereModelConfig => model !== undefined);
  const effective: CohereModelConfig[] =
    models.length > 0 ? [...models] : COHERE_MODELS.map((model) => ({ ...model }));
  if (!effective.some((model) => model.id === DEFAULT_MODEL_ID)) {
    // A configured catalog without the default model must still be routable.
    effective.push({ ...COHERE_MODELS[0]! });
  }
  return Object.freeze({
    baseURL: nonEmptyString(read('baseURL'), DEFAULT_BASE_URL).replace(/\/+$/, ''),
    providerName: nonEmptyString(read('providerName'), 'Cohere'),
    models: Object.freeze(effective),
    apiKeyEnv: credentialRefName(read('apiKeyEnv')),
    includeCitations: read('includeCitations') === true,
    strictTools: read('strictTools') !== false,
    jsonMode: read('jsonMode') === true,
    streamIdleTimeoutMs: positiveInt(read('streamIdleTimeoutMs'), 300_000),
    requestTimeoutMs: positiveInt(read('requestTimeoutMs'), 120_000),
    maxRequestImageBytes: positiveInt(read('maxRequestImageBytes'), 20 * 1024 * 1024),
    requestImagePixelBudget: positiveInt(read('requestImagePixelBudget'), 2048 * 2048),
    requestImageMaxBytes: positiveInt(read('requestImageMaxBytes'), 1024 * 1024),
  });
}
