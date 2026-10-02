/**
 * Endpoint model discovery for the settings surface.
 *
 * Verified live (2026-10-02): Cohere serves the catalog at **both**
 * `GET /v2/models` and `GET /v1/models`, each returning the same 17 chat
 * models. Discovery therefore follows the configured API node's own version
 * (`{baseURL}/models`, so a `…/v2` node asks `/v2/models`) and only falls back
 * to the origin's `/v1/models` when that version path is absent — which keeps a
 * custom gateway or a v1-only deployment working.
 *
 * Discovery only *adopts* metadata: the shipped catalog stays authoritative for
 * context windows, because the harness needs a window synchronously at dispatch.
 *
 * Source: https://docs.cohere.com/reference/list-models
 *
 * @module dsh-plugin-cohere/discovery
 */

import { attributionHeaders } from '@deepseek-ai/dsh-llm';
import type { LlmDiscoveredModel, LlmModelDiscoveryRequest } from '@deepseek-ai/dsh-llm';
import { failureFromResponse, failureFromTransport } from './failure.js';

/** Cohere's maximum page size, which covers the whole published catalog. */
const PAGE_SIZE = 1_000;

/** Read an own property off an unknown value without asserting a shape. */
function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

/**
 * Candidate model-list endpoints for one configured base URL, in try order.
 *
 * The first honours whatever version the node names; the second is the origin's
 * documented v1 path, used only when the first answers 404/405.
 * @param baseURL - the configured chat base URL.
 * @returns distinct absolute candidate URLs.
 */
export function discoveryCandidates(baseURL: string): string[] {
  const urls: string[] = [];
  try {
    const withSlash = baseURL.endsWith('/') ? baseURL : `${baseURL}/`;
    urls.push(new URL('models', withSlash).href);
  } catch {
    // A base URL that does not parse simply contributes no candidate.
  }
  try {
    urls.push(new URL('/v1/models', baseURL).href);
  } catch {
    // Same: skip an unparseable fallback.
  }
  return [...new Set(urls)];
}

/** Project one `{ models: [...] }` payload onto discovered chat routes. */
function readModels(body: unknown): readonly LlmDiscoveredModel[] {
  const rows = field(body, 'models');
  if (!Array.isArray(rows)) return [];
  const discovered: LlmDiscoveredModel[] = [];
  for (const row of rows) {
    const id = field(row, 'name');
    if (typeof id !== 'string' || id.length === 0) continue;
    if (field(row, 'is_deprecated') === true) continue;
    const endpoints = field(row, 'endpoints');
    if (Array.isArray(endpoints) && !endpoints.includes('chat')) continue;
    const contextLength = field(row, 'context_length');
    discovered.push({
      id,
      name: id,
      ...(typeof contextLength === 'number' && Number.isFinite(contextLength)
        ? { contextWindow: Math.floor(contextLength) }
        : {}),
      inputModalities: ['text'],
    });
  }
  return discovered;
}

/**
 * Interrogate Cohere for the models that serve the chat endpoint.
 * @param request - the draft endpoint and optional one-shot credential.
 * @param fallbackBaseURL - the plugin's configured base URL.
 * @param defaultRef - credential reference to use when the draft carries no key.
 * @param resolveApiKey - credential resolution for `defaultRef`.
 * @param signal - caller cancellation.
 * @returns advertised chat models in endpoint order.
 */
export async function discoverCohereModels(
  request: LlmModelDiscoveryRequest,
  fallbackBaseURL: string,
  defaultRef: string,
  resolveApiKey: (ref: string) => Promise<string>,
  signal?: AbortSignal,
): Promise<readonly LlmDiscoveredModel[]> {
  const baseURL =
    typeof request.baseURL === 'string' && request.baseURL.length > 0
      ? request.baseURL
      : fallbackBaseURL;

  const apiKey =
    typeof request.apiKey === 'string' && request.apiKey.length > 0
      ? request.apiKey
      : await resolveApiKey(defaultRef);

  const headers = {
    authorization: `Bearer ${apiKey}`,
    accept: 'application/json',
    'x-client-name': 'dsh-plugin-cohere',
    ...attributionHeaders(),
  };

  let missing: Response | undefined;
  for (const href of discoveryCandidates(baseURL)) {
    const url = new URL(href);
    url.searchParams.set('endpoint', 'chat');
    url.searchParams.set('page_size', String(PAGE_SIZE));

    let response: Response;
    try {
      response = await fetch(url.href, {
        method: 'GET',
        headers,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      throw failureFromTransport(error, signal);
    }
    if (response.ok) return readModels(await response.json());
    // Only an absent version path justifies the fallback; anything else is real.
    if (response.status === 404 || response.status === 405) {
      missing = response;
      continue;
    }
    throw await failureFromResponse(response);
  }
  if (missing !== undefined) throw await failureFromResponse(missing);
  return [];
}
