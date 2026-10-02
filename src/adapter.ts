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
import { CohereFailure, failureFromProtocol, failureFromResponse, failureFromTransport } from './failure.js';
import { findCatalogEntry } from './models.js';
import { buildChatRequest } from './wire/request.js';
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
  deprecated: false,
};

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
   * @param deps - live configuration access, credential resolution, diagnostics.
   */
  constructor(deps: CohereAdapterDeps) {
    super();
    this.#deps = deps;
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
      response = await fetch(`${config.baseURL}/chat`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'x-client-name': 'dsh-plugin-cohere',
          ...attributionHeaders(),
        },
        body: JSON.stringify(request),
        signal,
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
