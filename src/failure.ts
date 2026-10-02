/**
 * Provider-neutral failure type for the Cohere adapter.
 *
 * The harness normalizes whatever an adapter throws through
 * `normalizeLlmFailure` (`@deepseek-ai/dsh-llm/adapter-failure`). That function
 * reads two **own data properties** off the thrown error — `code` and
 * `failure` — and trusts the carried snapshot only when the two agree:
 *
 * ```js
 * const carried = ownFailureSnapshot(error);
 * if (carried !== undefined && carried.code === ownErrorCode(error)) return carried;
 * return Object.freeze({ message: errorMessage(error), code: harnessErrorCode(error) });
 * ```
 *
 * `ownErrorCode` uses `Object.getOwnPropertyDescriptor`, so a cross-package copy
 * of this error class still satisfies that comparison; the `instanceof
 * HarnessError` fallback in `harnessErrorCode` would otherwise degrade every
 * failure to `UNKNOWN` and disable retry policy. `HarnessError` already assigns
 * an own `code`, so extending it is correct in both worlds and we only add the
 * own `failure` snapshot beside it.
 *
 * @module dsh-plugin-cohere/failure
 */

import { HarnessError, isContextWindowExceededError, isQuotaExceededError } from '@deepseek-ai/dsh-llm';
import type { LlmFailure, ProviderRequestId } from '@deepseek-ai/dsh-llm';

/** Structured provider facts accepted beside {@link CohereFailure}. */
export interface CohereFailureOptions {
  /** HTTP status observed at the Cohere boundary. */
  readonly status?: number;
  /** Positive provider-requested delay in milliseconds (`Retry-After`). */
  readonly providerRetryAfterMs?: number;
  /** Opaque Cohere request id (`x-request-id` or the body's response id). */
  readonly requestId?: string;
  /** Additional oldest image occurrences to offload (`IMAGE_OFFLOAD_REQUIRED`). */
  readonly offloadImages?: number;
  /** Underlying transport or parse error. */
  readonly cause?: unknown;
}

/**
 * One provider or transport failure. Carries both the own `code` string and the
 * matching own `failure` snapshot the harness requires to keep the taxonomy.
 */
export class CohereFailure extends HarnessError {
  /** Serializable facts retained beside this live Error. */
  readonly failure: LlmFailure;

  /**
   * @param message - non-empty human-readable failure summary.
   * @param code - non-empty stable provider-neutral machine code.
   * @param options - optional cause and validated serializable provider facts.
   */
  constructor(message: string, code: string, options: CohereFailureOptions = {}) {
    super(message, code, options.cause === undefined ? undefined : { cause: options.cause });
    this.failure = Object.freeze({
      message,
      code,
      ...(options.status === undefined ? {} : { status: options.status }),
      ...(options.providerRetryAfterMs === undefined
        ? {}
        : { providerRetryAfterMs: options.providerRetryAfterMs }),
      ...(options.requestId === undefined || options.requestId.length === 0
        ? {}
        : { requestId: options.requestId as ProviderRequestId }),
      ...(options.offloadImages === undefined || options.offloadImages <= 0
        ? {}
        : { offloadImages: options.offloadImages }),
    });
  }
}

/** Build a bare frozen failure snapshot for terminal `finish` chunks. */
export function makeFailure(
  message: string,
  code: string,
  options: CohereFailureOptions = {},
): LlmFailure {
  return new CohereFailure(message, code, options).failure;
}

/** Cohere's error envelope: `{ message }` at v2, sometimes nested. */
interface CohereErrorBody {
  readonly message?: unknown;
}

/** Extract the human-readable provider detail from an error response body. */
async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (text.length === 0) return '';
    try {
      const parsed = JSON.parse(text) as CohereErrorBody | string;
      if (typeof parsed === 'string') return parsed;
      if (typeof parsed?.message === 'string') return parsed.message;
    } catch {
      return text;
    }
    return text;
  } catch {
    return '';
  }
}

/** Parse a positive `Retry-After` header, in either seconds or HTTP-date form. */
export function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) {
    const delta = date - Date.now();
    if (delta > 0) return delta;
  }
  return undefined;
}

/**
 * Map one non-2xx Cohere response onto a `CohereFailure`.
 *
 * HTTP status fixes the class of failure; the body text only refines cases the
 * status cannot express (a 400 that is really a context overflow or an
 * exhausted balance).
 * @param response - the failed response.
 * @param requestId - opaque request id captured from the transport, when known.
 * @returns a failure carrying provider-neutral retry-relevant facts.
 */
export async function failureFromResponse(
  response: Response,
  requestId?: string,
): Promise<CohereFailure> {
  const detail = await readErrorDetail(response);
  const status = response.status;
  const suffix = detail.length === 0 ? '' : `: ${detail}`;
  const resolvedRequestId =
    requestId ?? response.headers.get('x-request-id') ?? undefined;
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
  const options: CohereFailureOptions = {
    status,
    ...(retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs }),
    ...(resolvedRequestId === undefined ? {} : { requestId: resolvedRequestId }),
  };

  if (status === 401 || status === 403) {
    return new CohereFailure(
      `cohere: credential rejected (HTTP ${status})${suffix}`,
      'AUTH',
      options,
    );
  }
  if (status === 429) {
    return new CohereFailure(
      `cohere: rate limited (HTTP 429)${suffix}`,
      'RATE_LIMIT',
      options,
    );
  }
  if (status === 498 || status === 499) {
    // 498: token deny-listed. 499: the client cancelled.
    return new CohereFailure(
      `cohere: request refused (HTTP ${status})${suffix}`,
      status === 499 ? 'ABORTED' : 'AUTH',
      options,
    );
  }
  if (status === 400 || status === 422) {
    if (isContextWindowExceededError(detail)) {
      return new CohereFailure(
        `cohere: request exceeds the model context window${suffix}`,
        'CONTEXT_WINDOW_EXCEEDED',
        options,
      );
    }
    if (isQuotaExceededError(detail)) {
      return new CohereFailure(`cohere: account quota exhausted${suffix}`, 'QUOTA', options);
    }
    return new CohereFailure(`cohere: invalid request (HTTP ${status})${suffix}`, 'INVALID_ARGS', options);
  }
  if (status === 404) {
    return new CohereFailure(
      `cohere: model or endpoint not found (HTTP 404)${suffix}`,
      'INVALID_ARGS',
      options,
    );
  }
  if (status >= 500) {
    return new CohereFailure(
      `cohere: provider unavailable (HTTP ${status})${suffix}`,
      'SERVER',
      options,
    );
  }
  return new CohereFailure(`cohere: request failed (HTTP ${status})${suffix}`, 'SERVER', options);
}

/**
 * Classify a transport failure raised by `fetch` or by body iteration.
 * @param error - the caught value.
 * @param signal - the caller's cancellation signal, when one was supplied.
 * @returns a failure marked `ABORTED` for caller cancellation, else `TRANSPORT`.
 */
export function failureFromTransport(error: unknown, signal?: AbortSignal): CohereFailure {
  if (signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')) {
    return new CohereFailure('cohere: request aborted', 'ABORTED', { cause: error });
  }
  if (error instanceof CohereFailure) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new CohereFailure(`cohere: transport failure: ${message}`, 'TRANSPORT', { cause: error });
}

/**
 * Classify a response that completed with an unusable body (invalid SSE frame,
 * or a decode failure mid-stream).
 * @param detail - human-readable account of what was rejected.
 * @returns a `SERVER` failure, which retry policy may safely repeat.
 */
export function failureFromProtocol(detail: string): CohereFailure {
  return new CohereFailure(`cohere: ${detail}`, 'SERVER');
}
