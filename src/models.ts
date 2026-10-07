/**
 * Cohere model catalog.
 *
 * Cohere publishes per-model `context_length` through `GET /v1/models`, but the
 * harness needs a context window synchronously for compaction and for the model
 * picker, so the shipped catalog is the primary source and endpoint discovery is
 * an optional enrichment.
 *
 * The `tools` / `citations` / `strictTools` flags are the live per-model
 * `features` of `GET /v2/models?endpoint=chat` (read on 2026-10-02): a route
 * that lacks a feature rejects the corresponding request field with a 400
 * ("tool use is not supported by the provided model", "citations are not
 * supported for this model", …), and a request the provider refuses is worse
 * than a slightly reduced one — so the flags are per-route, not per-family.
 * The adapter additionally degrades at runtime when a route rejects a field
 * the catalog got wrong (see `adapter.ts`).
 *
 * Verified against the live `GET /v1/models?endpoint=chat` on 2026-10-02:
 * the context windows below are the API's `context_length` values, which differ
 * from the older documentation figures for several routes.
 *
 * Sources: https://docs.cohere.com/v2/docs/models · https://docs.cohere.com/reference/list-models
 */

/** One catalog entry as the plugin declares it in configuration. */
export interface CohereCatalogEntry {
  /** Exact model id accepted by `POST /v2/chat`. */
  readonly id: string;
  /** Human-readable name for selectors. */
  readonly name: string;
  /** Optional user-facing distinction from otherwise similar models. */
  readonly description: string;
  /** Maximum combined request and response context in tokens. */
  readonly contextWindow: number;
  /** Maximum output tokens the route accepts. */
  readonly maxTokens: number;
  /** Accepted request modalities. */
  readonly inputModalities: readonly ('text' | 'image')[];
  /** Whether the route accepts `thinking` and emits thinking content. */
  readonly reasoning: boolean;
  /** Whether the route accepts the `tools` parameter at all. */
  readonly tools: boolean;
  /** Whether the route accepts `citation_options`. */
  readonly citations: boolean;
  /** Whether the route accepts `strict_tools` (and `tool_choice`). */
  readonly strictTools: boolean;
  /** Whether Cohere marks the model deprecated. */
  readonly deprecated: boolean;
}

/** Default model id: the current text+image flagship. */
export const DEFAULT_MODEL_ID = 'command-a-plus-05-2026';

/** Models shipped with the plugin, in adapter-preferred display order. */
export const COHERE_MODELS: readonly CohereCatalogEntry[] = [
  {
    id: 'command-a-plus-05-2026',
    name: 'Command A Plus (05-2026)',
    description: 'Flagship MoE model: vision, agentic tool use, reasoning, translation.',
    contextWindow: 436_000,
    maxTokens: 64_000,
    inputModalities: ['text', 'image'],
    reasoning: true,
    tools: true,
    citations: true,
    strictTools: true,
    deprecated: false,
  },
  {
    id: 'command-a-reasoning-08-2025',
    name: 'Command A Reasoning (08-2025)',
    description: 'Reasoning-focused Command A.',
    contextWindow: 288_768,
    maxTokens: 32_000,
    inputModalities: ['text'],
    reasoning: true,
    tools: true,
    citations: true,
    strictTools: true,
    deprecated: false,
  },
  {
    id: 'command-a-03-2025',
    name: 'Command A (03-2025)',
    description: 'Long-context text model with strong tool use.',
    contextWindow: 288_000,
    maxTokens: 8_000,
    inputModalities: ['text'],
    reasoning: false,
    tools: true,
    citations: true,
    strictTools: true,
    deprecated: false,
  },
  {
    // No `tools` feature live: sending `tools` to this route is a 400.
    id: 'command-a-vision-07-2025',
    name: 'Command A Vision (07-2025)',
    description: 'Vision-capable Command A.',
    contextWindow: 128_000,
    maxTokens: 8_000,
    inputModalities: ['text', 'image'],
    reasoning: false,
    tools: false,
    citations: true,
    strictTools: false,
    deprecated: false,
  },
  {
    id: 'command-a-translate-08-2025',
    name: 'Command A Translate (08-2025)',
    description: 'Translation-specialized Command A.',
    contextWindow: 8_992,
    maxTokens: 8_000,
    inputModalities: ['text'],
    reasoning: false,
    tools: true,
    citations: true,
    strictTools: false,
    deprecated: false,
  },
  {
    id: 'command-r-plus-08-2024',
    name: 'Command R+ (08-2024)',
    description: 'RAG and tool-use workhorse.',
    contextWindow: 128_000,
    maxTokens: 4_000,
    inputModalities: ['text'],
    reasoning: false,
    tools: true,
    citations: true,
    strictTools: true,
    deprecated: false,
  },
  {
    id: 'command-r-08-2024',
    name: 'Command R (08-2024)',
    description: 'Cheaper RAG and tool-use model.',
    contextWindow: 128_000,
    maxTokens: 4_000,
    inputModalities: ['text'],
    reasoning: false,
    tools: true,
    citations: true,
    strictTools: true,
    deprecated: false,
  },
  {
    id: 'command-r7b-12-2024',
    name: 'Command R7B (12-2024)',
    description: 'Small and fast; first model with `tool_choice` and `strict_tools`.',
    contextWindow: 132_000,
    maxTokens: 4_000,
    inputModalities: ['text'],
    reasoning: false,
    tools: true,
    citations: true,
    strictTools: true,
    deprecated: false,
  },
  {
    id: 'command-r7b-arabic-02-2025',
    name: 'Command R7B Arabic (02-2025)',
    description: 'Arabic-tuned Command R7B.',
    contextWindow: 128_000,
    maxTokens: 4_000,
    inputModalities: ['text'],
    reasoning: false,
    tools: true,
    citations: true,
    strictTools: true,
    deprecated: false,
  },
  {
    // The live `features` include `reasoning`; tool use is fully supported but
    // citations are not — requesting them 400s the whole call.
    id: 'north-mini-code-1-0',
    name: 'North Mini Code 1.0',
    description: 'Code-specialized North model with reasoning and tool use.',
    contextWindow: 436_000,
    maxTokens: 64_000,
    inputModalities: ['text'],
    reasoning: true,
    tools: true,
    citations: false,
    strictTools: true,
    deprecated: false,
  },
  {
    id: 'north-small-translate-09-2026',
    name: 'North Small Translate (09-2026)',
    description: 'Compact translation model.',
    contextWindow: 32_768,
    maxTokens: 16_000,
    inputModalities: ['text'],
    reasoning: false,
    tools: false,
    citations: false,
    strictTools: false,
    deprecated: false,
  },
  {
    id: 'c4ai-aya-expanse-32b',
    name: 'Aya Expanse 32B',
    description: 'Multilingual Aya model.',
    contextWindow: 128_000,
    maxTokens: 4_000,
    inputModalities: ['text'],
    reasoning: false,
    tools: false,
    citations: false,
    strictTools: false,
    deprecated: false,
  },
  {
    id: 'c4ai-aya-vision-32b',
    name: 'Aya Vision 32B',
    description: 'Multimodal Aya model.',
    contextWindow: 16_384,
    maxTokens: 4_000,
    inputModalities: ['text', 'image'],
    reasoning: false,
    tools: false,
    citations: true,
    strictTools: false,
    deprecated: false,
  },
  {
    id: 'tiny-aya-earth',
    name: 'Tiny Aya Earth',
    description: 'Small multilingual Aya variant.',
    contextWindow: 8_192,
    maxTokens: 2_000,
    inputModalities: ['text'],
    reasoning: false,
    tools: true,
    citations: true,
    strictTools: false,
    deprecated: false,
  },
  {
    id: 'tiny-aya-fire',
    name: 'Tiny Aya Fire',
    description: 'Small multilingual Aya variant.',
    contextWindow: 8_192,
    maxTokens: 2_000,
    inputModalities: ['text'],
    reasoning: false,
    tools: true,
    citations: true,
    strictTools: false,
    deprecated: false,
  },
  {
    id: 'tiny-aya-global',
    name: 'Tiny Aya Global',
    description: 'Small multilingual Aya variant.',
    contextWindow: 8_192,
    maxTokens: 2_000,
    inputModalities: ['text'],
    reasoning: false,
    tools: true,
    citations: true,
    strictTools: false,
    deprecated: false,
  },
  {
    id: 'tiny-aya-water',
    name: 'Tiny Aya Water',
    description: 'Small multilingual Aya variant.',
    contextWindow: 8_192,
    maxTokens: 2_000,
    inputModalities: ['text'],
    reasoning: false,
    tools: true,
    citations: true,
    strictTools: false,
    deprecated: false,
  },
];

/**
 * Find one catalog entry by exact model id.
 * @param models - the effective catalog (shipped defaults merged with configuration).
 * @param id - exact model id from the request.
 * @returns the matching entry, or `undefined` when the route is unlisted.
 */
export function findCatalogEntry(
  models: readonly CohereCatalogEntry[],
  id: string,
): CohereCatalogEntry | undefined {
  return models.find((model) => model.id === id);
}
