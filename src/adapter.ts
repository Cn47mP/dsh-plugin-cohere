/**
 * The Cohere provider adapter.
 *
 * `LlmRuntime.stream()` treats this class as the final boundary: whatever
 * `stream()` throws is normalized into a terminal `error`/`aborted` finish
 * chunk, and whatever it yields must satisfy the chunk contract in
 * {@link module:dsh-plugin-cohere/wire/event-stream}.
 *
 * @module dsh-plugin-cohere/adapter
 */

import { LlmAdapter, attributionHeaders } from '@deepseek-ai/dsh-llm';
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ReasoningEffortId,
  StreamChunk,
} from '@deepseek-ai/dsh-llm';
import type { CohereModelConfig, CohereOptions } from './config.js';
import {
  CohereFailure,
  failureFromProtocol,
  failureFromResponse,
  failureFromTransport,
  readErrorDetail,
  unsupportedFeature,
  type UnsupportedFeature,
} from './failure.js';
import { findCatalogEntry } from './models.js';
import { buildChatRequest, type CohereChatRequest } from './wire/request.js';
import { translateChatStream, type CohereStreamNotice } from './wire/event-stream.js';
import {
  messagesHaveImage,
  prepareImages,
  withOffloadedPlaceholders,
  type AttachmentStoreLike,
  type ImageAccessResolver,
  type PreparedImages,
} from './wire/images.js';

/** Reasoning efforts this adapter exposes for reasoning-capable routes. */
const REASONING_EFFORTS: readonly { id: ReasoningEffortId; name: string; description: string }[] = [
  {
    // `ReasoningEffortId` is an arbitrary branded string; declaring `off` lets
    // the harness accept an explicit "no thinking" request, which maps onto
    // Cohere's `thinking: { type: 'disabled' }`.
    id: 'off' as ReasoningEffortId,
    name: 'Off',
    description: 'Disable thinking entirely.',
  },
  {
    id: 'low' as ReasoningEffortId,
    name: 'Low',
    description: 'Short thinking budget (4,096 tokens).',
  },
  {
    id: 'high' as ReasoningEffortId,
    name: 'High',
    description: 'Long thinking budget (16,384 tokens).',
  },
];

/** Fallback capability metadata for a model id absent from the catalog. */
const UNLISTED_MODEL: CohereModelConfig = {
  id: '',
  name: '',
  description: '',
  contextWindow: 128_000,
  maxTokens: 8_192,
  inputModalities: ['text'],
  reasoning: false,
  tools: true,
  citations: true,
  strictTools: true,
  deprecated: false,
};

/** Whether one request still carries a field the provider may reject. */
function requestCarries(request: CohereChatRequest, feature: UnsupportedFeature): boolean {
  switch (feature) {
    case 'tools':
      return request.tools !== undefined;
    case 'citations':
      return request.citation_options !== undefined;
    case 'strict_tools':
      return request.strict_tools === true;
    case 'response_format':
      return request.response_format !== undefined;
  }
}

/** Rebuild one request without the named field (and what depends on it). */
function withoutFeature(
  request: CohereChatRequest,
  feature: UnsupportedFeature,
): CohereChatRequest {
  switch (feature) {
    case 'tools': {
      // strict_tools only constrains tool calls, so it leaves with the tools.
      const { tools: _tools, strict_tools: _strict, ...rest } = request;
      return rest;
    }
    case 'citations': {
      const { citation_options: _citations, ...rest } = request;
      return rest;
    }
    case 'strict_tools': {
      const { strict_tools: _strict, ...rest } = request;
      return rest;
    }
    case 'response_format': {
      const { response_format: _format, ...rest } = request;
      return rest;
    }
  }
}

/** Everything the adapter needs from the plugin instance. */
export interface CohereAdapterDeps {
  /**
   * Read the live plugin configuration. Called per request so a settings edit or
   * an HMR rebuild takes effect without re-registering the adapter.
   */
  readonly options: () => CohereOptions;
  /** Resolve the API key named by a credential reference. */
  readonly resolveApiKey: (ref: string) => Promise<string>;
  /** Read the durable attachment store used for image input, when it is mounted. */
  readonly resolveAttachments?: () => AttachmentStoreLike | undefined;
  /** Resolve read access for one durable image reference (placeholder text). */
  readonly resolveImageAccess?: ImageAccessResolver;
  /** Side channel for events that have no harness representation. */
  readonly onNotice?: (notice: CohereStreamNotice) => void;
}

/** Resolve the catalog entry for one route, falling back to text-only defaults. */
function modelFor(options: CohereOptions, id: string): CohereModelConfig {
  return findCatalogEntry(options.models, id) ?? { ...UNLISTED_MODEL, id, name: id };
}

/** Decode a `fetch` byte stream into text, releasing the body on every exit. */
async function* decodeBody(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done === true) break;
      if (value !== undefined) yield decoder.decode(value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail.length > 0) yield tail;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // A body that is already closed or errored needs no cancellation.
    }
  }
}

/** Re-arm a watchdog every time one upstream item arrives. */
async function* rearmOnItem<T>(
  source: AsyncIterable<T>,
  arm: () => void,
): AsyncGenerator<T, void, undefined> {
  for await (const item of source) {
    arm();
    yield item;
  }
}

/** The Cohere adapter: one provider route, streamed over Cohere v2 `/chat`. */
export class CohereAdapter extends LlmAdapter {
  readonly #deps: CohereAdapterDeps;

  /**
   * Request fields the provider refused for a model, remembered for the
   * process lifetime.
   *
   * The catalog declares each route's live Cohere `features`, but a
   * hand-added row or an endpoint change can over-declare one. Remembering the
   * refusal turns that into a single failed request instead of every call on
   * that route failing with the same 400.
   */
  readonly #degraded = new Map<string, Set<UnsupportedFeature>>();

  /**
   * @param deps - live configuration access, credential resolution, diagnostics.
   */
  constructor(deps: CohereAdapterDeps) {
    super();
    this.#deps = deps;
  }

  /** Drop every field the provider has refused for this model. */
  #applyDegraded(modelId: string, request: CohereChatRequest): CohereChatRequest {
    const features = this.#degraded.get(modelId);
    if (features === undefined || features.size === 0) return request;
    let current = request;
    for (const feature of features) {
      if (requestCarries(current, feature)) current = withoutFeature(current, feature);
    }
    return current;
  }

  /**
   * POST one chat request, retrying at most once without a field the provider
   * rejects for this model.
   *
   * A route that lacks a live Cohere feature (`tools`, `citations`,
   * `strict_tools`, `response_format`) answers 400 naming the field. The
   * catalog already gates the shipped routes, so this only fires for rows the
   * catalog got wrong; the refusal is remembered so the next call on the route
   * goes out correct the first time.
   * @param request - the request body to send.
   * @param send - everything else the send needs: route, endpoint, key,
   *   the composed abort signal for `fetch`, and the caller's own signal for
   *   abort classification (a watchdog abort must stay a `TIMEOUT`).
   * @returns the first successful (2xx) response.
   * @throws CohereFailure for transport errors and non-retryable rejections.
   */
  async #sendChat(
    request: CohereChatRequest,
    send: {
      readonly model: CohereModelConfig;
      readonly baseURL: string;
      readonly apiKey: string;
      readonly signal: AbortSignal;
      readonly callerSignal?: AbortSignal;
    },
  ): Promise<Response> {
    let current = this.#applyDegraded(send.model.id, request);
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(`${send.baseURL}/chat`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${send.apiKey}`,
            'content-type': 'application/json',
            accept: 'text/event-stream',
            'x-client-name': 'dsh-plugin-cohere',
            ...attributionHeaders(),
          },
          body: JSON.stringify(current),
          signal: send.signal,
        });
      } catch (error) {
        throw failureFromTransport(error, send.callerSignal);
      }
      if (response.ok) return response;

      // The failure path consumes the body for its message, so the detail is
      // read from a clone and the original stays intact for the failure.
      const detail = await readErrorDetail(response.clone());
      const feature = attempt === 0 ? unsupportedFeature(detail) : undefined;
      if (feature === undefined || !requestCarries(current, feature)) {
        throw await failureFromResponse(response);
      }
      const degraded = this.#degraded.get(send.model.id) ?? new Set<UnsupportedFeature>();
      degraded.add(feature);
      this.#degraded.set(send.model.id, degraded);
      current = withoutFeature(current, feature);
      this.#deps.onNotice?.({
        kind: 'unsupported-feature',
        detail: { model: send.model.id, feature, message: detail },
      });
    }
  }

  /** @inheritdoc */
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.#deps.options().providerName };
  }

  /** @inheritdoc */
  override listModels(provider: string): Promise<LlmModelInfo[]> {
    return Promise.resolve(
      this.#deps.options().models.map((model) => ({
        provider,
        id: model.id,
        name: model.name,
        ...(model.description.length === 0 ? {} : { description: model.description }),
        inputModalities: [...model.inputModalities],
      })),
    );
  }

  /** @inheritdoc */
  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const entry = modelFor(this.#deps.options(), model);
    return Promise.resolve({
      provider,
      id: entry.id,
      name: entry.name,
      ...(entry.description.length === 0 ? {} : { description: entry.description }),
      inputModalities: [...entry.inputModalities],
      context: { contextWindow: entry.contextWindow },
      defaultMaxTokens: entry.maxTokens,
      ...(entry.reasoning ? { reasoning: { efforts: REASONING_EFFORTS } } : {}),
    });
  }

  /** @inheritdoc */
  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk, void, undefined> {
    const config = this.#deps.options();
    const model = modelFor(config, options.model);
    const apiKey = await this.#deps.resolveApiKey(config.apiKeyEnv);

    // Image input is read from the durable attachment store and re-encoded as
    // base64 data URLs. Offloaded occurrences become placeholder text first.
    let effective = options;
    let images: PreparedImages | undefined;
    if (messagesHaveImage(options.messages)) {
      if (!model.inputModalities.includes('image')) {
        throw new CohereFailure(
          `cohere: model "${model.id}" does not accept image input`,
          'UNSUPPORTED_CONTENT',
        );
      }
      const store = this.#deps.resolveAttachments?.();
      if (store === undefined) {
        throw failureFromProtocol(
          'image input requires the durable attachment service (ctx "attachments")',
        );
      }
      const access: ImageAccessResolver = (_store, ref) =>
        this.#deps.resolveImageAccess?.(store, ref);
      images = await prepareImages(
        options.messages,
        store,
        {
          maxRequestImageBytes: config.maxRequestImageBytes,
          maxPixels: config.requestImagePixelBudget,
          maxImageBytes: config.requestImageMaxBytes,
        },
        access,
        options.signal,
      );
      effective = {
        ...options,
        messages: withOffloadedPlaceholders(options.messages, images.placeholder),
      };
    }

    const request = buildChatRequest(effective, model, config, images);

    const headerAbort = new AbortController();
    const idleAbort = new AbortController();
    const headerTimer = setTimeout(() => {
      headerAbort.abort(
        new CohereFailure(
          `cohere: no response headers within ${config.requestTimeoutMs}ms`,
          'TIMEOUT',
        ),
      );
    }, config.requestTimeoutMs);
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdle = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleAbort.abort(
          new CohereFailure(
            `cohere: no stream traffic for ${config.streamIdleTimeoutMs}ms`,
            'TIMEOUT',
          ),
        );
      }, config.streamIdleTimeoutMs);
    };

    const caller = options.signal;
    const signal = AbortSignal.any([
      headerAbort.signal,
      idleAbort.signal,
      ...(caller === undefined ? [] : [caller]),
    ]);

    let response: Response;
    try {
      response = await this.#sendChat(request, {
        model,
        baseURL: config.baseURL,
        apiKey,
        signal,
        callerSignal: caller,
      });
    } catch (error) {
      throw failureFromTransport(error, caller);
    } finally {
      clearTimeout(headerTimer);
    }

    try {
      if (!response.ok) throw await failureFromResponse(response);
      if (response.body === null) {
        throw failureFromProtocol('the response carried no body to stream');
      }
      armIdle();
      yield* translateChatStream(rearmOnItem(decodeBody(response.body), armIdle), {
        ...(this.#deps.onNotice === undefined ? {} : { onNotice: this.#deps.onNotice }),
        // Citations are requested only when the operator asked for them, and are
        // surfaced as a trailing footnote block by the translator.
        ...(config.includeCitations ? { citations: true } : {}),
      });
    } catch (error) {
      throw failureFromTransport(error, caller);
    } finally {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleAbort.abort();
    }
  }
}
