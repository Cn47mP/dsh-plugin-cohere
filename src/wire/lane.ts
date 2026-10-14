/**
 * Which wire lane one request travels on.
 *
 * The plugin owns two protocol boundaries to the same provider:
 *
 * - **compat** — Cohere's OpenAI-compatible endpoint
 *   (`POST {compatBaseURL}/chat/completions`), the contract Cohere maintains for
 *   OpenAI-shaped clients; and
 * - **native** — Cohere's own v2 chat endpoint (`POST {baseURL}/chat`), the only
 *   lane that can carry Cohere's proprietary request fields.
 *
 * The split is not a preference, it is forced by what the compatibility layer
 * does with proprietary fields (all verified live against
 * `https://api.cohere.ai/compatibility/v1`, see WORKLOG for the probe scripts):
 *
 * | field | compatibility layer |
 * | :--- | :--- |
 * | `citation_options` | **HTTP 422** `unknown field: parameter 'citation_options' is not a valid field` |
 * | `reasoning_effort: 'low' \| 'medium'` | **HTTP 422** `reasoning_effort 'medium' and 'low' are not supported. Use 'high' instead` |
 * | `documents` | HTTP 200 but **silently dropped** — the answer is identical to the no-documents control and carries no citations, so RAG does not happen |
 * | `connectors`, `citations`, arbitrary unknown fields | HTTP 200 but silently dropped |
 *
 * A silently dropped field is the worst outcome available: the caller believes
 * they asked for citations or retrieval and gets a plain answer with no error.
 * So every request that depends on such a field is routed to the native lane
 * rather than sent to the compatibility layer.
 *
 * **Images are not such a field.** A v0.2.0 probe saw `UND_ERR_HEADERS_TIMEOUT`
 * on both lanes and left the compatibility lane unverified, so images were kept
 * on the native lane as a precaution. The 2026-10-13 probe round could not
 * reproduce that timeout anywhere — 1×1 through 20MB images, one or two images
 * per message, image+tools, image+tool-result history, streaming and
 * non-streaming, `fetch` and `node:https` — and every case answered HTTP 200 on
 * **both** lanes (`test/probe-vision.mjs`, `test/probe-vision-combos.mjs`). The
 * timeout was a transient proxy condition, not a lane capability, so image
 * requests now ride the compatibility lane like everything else. An operator who
 * wants the old path can still pin `wire: 'native'`.
 *
 * @module dsh-plugin-cohere/wire/lane
 */

import type { CohereModelConfig, CohereOptions, WireModeSetting } from '../config.js';

/** The two protocol boundaries this plugin can speak. */
export type WireLane = 'compat' | 'native';

/** Operator-facing lane preference; the single source of truth is configuration. */
export type WireMode = WireModeSetting;

/**
 * Why a request left the compatibility lane.
 *
 * `default` means the compatibility lane was used; every other member names the
 * capability that forced the native lane.
 */
export type LaneReason =
  | 'default'
  | 'forced-compat'
  | 'forced-native'
  | 'unsupported-mode'
  | 'citations'
  | 'thinking-budget'
  | 'compat-lane-disabled';

/** One lane decision plus the evidence for it. */
export interface LaneDecision {
  /** The endpoint family to speak to. */
  readonly lane: WireLane;
  /** Why this lane was chosen, for logs and diagnostics. */
  readonly reason: LaneReason;
}

/**
 * Reasoning efforts the compatibility layer accepts.
 *
 * Verified live: `none` and `high` are accepted; `low` and `medium` answer
 * HTTP 422 telling the caller to use `high` instead. A missing effort is also
 * accepted — it just leaves the model on its own default. `off`/`disabled` are
 * the plugin's own ids for Cohere's disabled thinking and are encoded as
 * `reasoning_effort: 'none'`, which the endpoint accepts, so they stay on this
 * lane too.
 */
const COMPAT_REASONING_EFFORTS: ReadonlySet<string> = new Set([
  'none',
  'high',
  'off',
  'disabled',
]);

/** Inputs the lane decision depends on. */
export interface LaneInputs {
  /** Operator lane preference from configuration. */
  readonly mode: string;
  /** Whether the plugin was asked to surface Cohere citation spans. */
  readonly includeCitations: boolean;
  /** The route being called. */
  readonly model: CohereModelConfig;
  /** The harness reasoning effort, when the caller set one. */
  readonly reasoningEffort?: string | undefined;
  /**
   * Whether the compatibility lane may be used at all, as resolved by
   * configuration (a cleared node, or a `baseURL` redirected to a custom gateway
   * with no compatibility node named, disables it).
   */
  readonly compatLaneEnabled: boolean;
}

/** Narrow the configured mode, treating anything unrecognised as `auto`. */
function normalizeMode(mode: string): WireMode {
  return mode === 'compat' || mode === 'native' ? mode : 'auto';
}

/**
 * Decide which wire lane one request travels on.
 *
 * `auto` uses the compatibility lane (the forward-looking contract, and the one
 * whose SSE carries exact usage) and leaves it only for the capabilities the
 * compatibility layer provably cannot carry. An explicit `mode` overrides all
 * of the automatic rules except that `compat` still refuses to silently drop a
 * requested capability: the operator asked for the compatibility lane, so the
 * capability is dropped *deliberately* and reported as `forced-compat` instead
 * of being sent as a request that cannot work.
 * @param inputs - everything the decision depends on.
 * @returns the chosen lane and the reason for it.
 */
export function decideLane(inputs: LaneInputs): LaneDecision {
  const mode = normalizeMode(inputs.mode);

  // No compatibility node is usable (cleared, or never named while `baseURL`
  // points at a custom gateway): the native lane is the only one to send on.
  if (!inputs.compatLaneEnabled) {
    return { lane: 'native', reason: 'compat-lane-disabled' };
  }
  if (mode === 'native') return { lane: 'native', reason: 'forced-native' };
  if (mode === 'compat') return { lane: 'compat', reason: 'forced-compat' };

  // `citation_options` is rejected outright by the compatibility layer, so a
  // citation request would either fail or (worse) be answered without citations.
  if (inputs.includeCitations && inputs.model.citations !== false) {
    return { lane: 'native', reason: 'citations' };
  }

  // The compatibility layer accepts only `none` and `high`; every other effort
  // is a 422 there but an ordinary `thinking.token_budget` on the native lane.
  const effort = inputs.reasoningEffort;
  if (
    effort !== undefined &&
    inputs.model.reasoning &&
    !COMPAT_REASONING_EFFORTS.has(effort)
  ) {
    return { lane: 'native', reason: 'thinking-budget' };
  }

  // No image rule here: images are verified on both lanes (see the module note),
  // so an image request takes the default path like any other.
  return { lane: 'compat', reason: 'default' };
}

/**
 * Read the lane switches out of resolved plugin configuration.
 * @param options - the adapter's resolved options.
 * @param ids - the per-request facts the decision needs.
 * @returns the lane decision for this request.
 */
export function laneFor(
  options: CohereOptions,
  ids: {
    readonly model: CohereModelConfig;
    readonly reasoningEffort?: string | undefined;
  },
): LaneDecision {
  return decideLane({
    mode: options.wire,
    includeCitations: options.includeCitations,
    model: ids.model,
    reasoningEffort: ids.reasoningEffort,
    compatLaneEnabled: options.compatLaneEnabled,
  });
}
