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

/**
 * Default Cohere OpenAI-compatible endpoint.
 *
 * Verified live: `GET {this}/models` answers with the same 35 routes as the
 * native catalog listing, and `POST {this}/chat/completions` speaks the OpenAI
 * chat-completions contract (see `wire/lane.ts` for what it cannot carry).
 */
export const DEFAULT_COMPAT_BASE_URL = 'https://api.cohere.ai/compatibility/v1';

/** Lane selection modes accepted by the `wire` setting. */
export const WIRE_MODES = ['auto', 'compat', 'native'] as const;

/** One accepted lane selection mode. */
export type WireModeSetting = (typeof WIRE_MODES)[number];

/**
 * Where a reported citation reaches the user, accepted by `citationDisplay`.
 *
 * The harness has no citation content block, so `footnote` appends one trailing
 * text block to the answer stream — the only on-screen path there is — while
 * `notice` leaves the answer exactly as the model wrote it and hands the
 * citations to the notice side channel, where they are logged.
 */
export const CITATION_DISPLAY_MODES = ['footnote', 'notice'] as const;

/** One accepted citation display mode. */
export type CitationDisplaySetting = (typeof CITATION_DISPLAY_MODES)[number];

/** Image detail levels Cohere's Chat API accepts for one image block. */
export const IMAGE_DETAIL_MODES = ['auto', 'low', 'high'] as const;

/** One accepted image detail level. */
export type ImageDetailSetting = (typeof IMAGE_DETAIL_MODES)[number];

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
  /** Cohere OpenAI-compatible base URL; `/chat/completions` is appended. */
  compatBaseURL: z.string().default(DEFAULT_COMPAT_BASE_URL).volatile(),
  /**
   * Which wire lane to speak.
   *
   * `auto` (the default) uses the OpenAI-compatible endpoint and quietly moves a
   * request to the native one when it needs a capability the compatibility layer
   * provably cannot carry — see `wire/lane.ts`. `compat` and `native` pin every
   * request to one lane regardless of its capabilities.
   */
  wire: z
    .union([z.const('auto'), z.const('compat'), z.const('native')])
    .default('auto')
    .volatile(),
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
  /**
   * Where the citations requested by `includeCitations` reach the user.
   *
   * `footnote` (the default, and the 0.2.0 behaviour) appends one trailing text
   * block to the answer; `notice` keeps the model's own text as the whole
   * answer and reports the citations through the notice side channel instead.
   * Ignored while `includeCitations` is off, and it never changes what is
   * requested from Cohere — only what the translator does with the reply.
   */
  citationDisplay: z
    .union([z.const('footnote'), z.const('notice')])
    .default('footnote')
    .volatile(),
  /** Send `strict_tools`, letting Cohere constrain tool arguments by schema. */
  strictTools: z.boolean().default(true).volatile(),
  /**
   * Structured output mode: sends `response_format: { type: 'json_object' }` so
   * the model answers with a bare JSON object. The harness has no structured
   * request field, so this is a plugin/model-level switch.
   */
  jsonMode: z.boolean().default(false).volatile(),
  /**
   * Image `detail` sent with every image block (`low` | `high` | `auto`).
   *
   * Cohere's image guide defines the rule this switch controls: with `auto`
   * (the provider default when the field is absent) an image is downscaled to
   * 512×512 and billed 256 tokens unless one side exceeds 768px, at which point
   * it is tiled at 1536×2048 with 256 tokens per 512×512 tile. The guide is
   * explicit that small text needs `high` — "if you have trouble reading the
   * text in an image, the model will too" — and a screenshot of a chat, a
   * terminal, or an editor is exactly the case `auto` resolves to `low` and
   * destroys. `high` is therefore the default here, at roughly two to three
   * times the image token cost; set `auto` to keep the provider's own choice.
   */
  imageDetail: z
    .union([z.const('auto'), z.const('low'), z.const('high')])
    .default('high')
    .volatile(),
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
  /** Cohere's OpenAI-compatible node; `/chat/completions` is appended. */
  readonly compatBaseURL: string;
  /**
   * Whether `auto` may use the compatibility lane at all.
   *
   * False when the node is cleared, and also when the operator redirected the
   * native `baseURL` to their own gateway without naming a compatibility node —
   * see `resolveOptions`.
   */
  readonly compatLaneEnabled: boolean;
  /** Lane preference: `auto` decides per request, the others pin it. */
  readonly wire: WireModeSetting;
  readonly providerName: string;
  readonly models: readonly CohereModelConfig[];
  readonly apiKeyEnv: string;
  readonly includeCitations: boolean;
  /** How requested citations reach the user; only read when citations are on. */
  readonly citationDisplay: CitationDisplaySetting;
  readonly strictTools: boolean;
  readonly jsonMode: boolean;
  /** Image `detail` sent with every image block. */
  readonly imageDetail: ImageDetailSetting;
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

/**
 * Narrow the `wire` setting to an accepted lane mode.
 * @param value - the resolved configuration field.
 * @returns the mode, defaulting to `auto` for anything unrecognised.
 */
function wireMode(value: unknown): WireModeSetting {
  return value === 'compat' || value === 'native' ? value : 'auto';
}

/**
 * Narrow the `citationDisplay` setting to an accepted display mode.
 *
 * Anything unrecognised — including a hand-edited settings file — falls back to
 * `footnote`, the 0.2.0 behaviour, so a typo can never silently drop citations
 * the operator asked for.
 * @param value - the resolved configuration field.
 * @returns the mode, defaulting to `footnote` for anything unrecognised.
 */
function citationDisplayMode(value: unknown): CitationDisplaySetting {
  return value === 'notice' ? 'notice' : 'footnote';
}

/**
 * Narrow the `imageDetail` setting to a level Cohere accepts.
 *
 * Anything unrecognised — including a hand-edited settings file — falls back to
 * `high`, the level the image guide prescribes for small text, so a typo cannot
 * silently downgrade every screenshot to a 512×512 thumbnail.
 * @param value - the resolved configuration field.
 * @returns the level, defaulting to `high` for anything unrecognised.
 */
function imageDetailMode(value: unknown): ImageDetailSetting {
  return value === 'auto' || value === 'low' ? value : 'high';
}

/**
 * Read an endpoint field that may be switched off.
 *
 * Unlike {@link nonEmptyString} this preserves an explicitly empty string: an
 * operator who clears the compatibility node means "do not use that lane", not
 * "restore the default". Trailing slashes are stripped so path joining is a
 * plain concatenation.
 * @param value - the resolved configuration field.
 * @param fallback - the endpoint to use when the field was never set.
 * @returns the endpoint, or the empty string when explicitly cleared.
 */
function endpointOrDisabled(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  return value.trim().replace(/\/+$/, '');
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

  // The compatibility lane is enabled when it has an endpoint AND the operator
  // either left the native node at Cohere's shipped default or pointed the
  // compatibility node somewhere of their own. An operator who redirected
  // `baseURL` at their own gateway and never named a compatibility node has not
  // asked for traffic to reach Cohere's public endpoint, so `auto` stays on
  // their node instead of silently sending requests to api.cohere.ai. That also
  // keeps every pre-2.0 configuration behaving exactly as it did.
  //
  // "Pointed somewhere of their own" is judged against the shipped default
  // rather than against presence: the configuration schema has already filled
  // every unset field with its default by the time this runs, so an untouched
  // `compatBaseURL` is indistinguishable from one the operator typed out in
  // full. Only a *different* endpoint shows the operator meant it.
  const rawBaseURL = read('baseURL');
  const rawCompatBaseURL = read('compatBaseURL');
  const baseURL = nonEmptyString(rawBaseURL, DEFAULT_BASE_URL).replace(/\/+$/, '');
  const compatBaseURL = endpointOrDisabled(rawCompatBaseURL, DEFAULT_COMPAT_BASE_URL);
  const compatLaneEnabled =
    compatBaseURL.length > 0 &&
    (baseURL === DEFAULT_BASE_URL || compatBaseURL !== DEFAULT_COMPAT_BASE_URL);

  return Object.freeze({
    baseURL,
    compatBaseURL,
    compatLaneEnabled,
    wire: wireMode(read('wire')),
    providerName: nonEmptyString(read('providerName'), 'Cohere'),
    models: Object.freeze(effective),
    apiKeyEnv: credentialRefName(read('apiKeyEnv')),
    includeCitations: read('includeCitations') === true,
    citationDisplay: citationDisplayMode(read('citationDisplay')),
    strictTools: read('strictTools') !== false,
    jsonMode: read('jsonMode') === true,
    imageDetail: imageDetailMode(read('imageDetail')),
    streamIdleTimeoutMs: positiveInt(read('streamIdleTimeoutMs'), 300_000),
    requestTimeoutMs: positiveInt(read('requestTimeoutMs'), 120_000),
    maxRequestImageBytes: positiveInt(read('maxRequestImageBytes'), 20 * 1024 * 1024),
    requestImagePixelBudget: positiveInt(read('requestImagePixelBudget'), 2048 * 2048),
    requestImageMaxBytes: positiveInt(read('requestImageMaxBytes'), 1024 * 1024),
  });
}
