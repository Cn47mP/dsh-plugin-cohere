/**
 * `dsh-plugin-cohere` — a native DSH model provider for Cohere's v2 Chat API.
 *
 * The plugin owns the whole protocol boundary: DSH request vocabulary in,
 * Cohere v2 `/chat` payload out, Cohere SSE back into harness chunks. Nothing
 * here depends on a compatibility proxy.
 *
 * @module dsh-plugin-cohere
 */

import { assertUsableApiKey } from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import { CohereAdapter } from './adapter.js';
import { Config, PROVIDER, resolveOptions } from './config.js';
import { discoverCohereModels } from './discovery.js';
import { CohereFailure } from './failure.js';
import type { CohereStreamNotice } from './wire/event-stream.js';
import { makeImageAccessResolver, type AttachmentStoreLike } from './wire/images.js';

/** Cordis plugin name; the entry id in `cordis.patch.yml` must match. */
export const name = 'llm-cohere';

/** The `llm` service must exist before this plugin can register a route. */
export const inject = ['llm'];

/** Package name used in credential diagnostics. */
const PACKAGE = 'dsh-plugin-cohere';

export { Config };

/** The slice of `ctx.credentials` this plugin uses. */
interface CredentialsLike {
  resolve(ref: string): Promise<{ readonly value?: unknown } | undefined>;
}

/** The slice of `ctx` this plugin reaches for outside the `llm` service. */
interface ContextParts {
  get(name: string): unknown;
  logger?: { debug?: (...args: unknown[]) => void };
  fiber?: { entry?: { options?: { id?: string } } };
}

/**
 * Resolve the Cohere API key for one credential reference.
 *
 * The credentials service is authoritative; the launching environment is the
 * documented fallback for headless runs. `assertUsableApiKey` rejects values
 * that cannot be sent as a header before any request is made.
 * @param parts - the plugin context, narrowed to what this needs.
 * @param ref - credential reference name.
 * @returns a usable API key.
 * @throws CohereFailure with `MISSING_CREDENTIAL` when neither source has one.
 */
async function resolveApiKey(parts: ContextParts, ref: string): Promise<string> {
  const credentials = parts.get('credentials') as CredentialsLike | undefined;
  if (credentials !== undefined && typeof credentials.resolve === 'function') {
    const hit = await credentials.resolve(ref);
    const value = hit?.value;
    if (typeof value === 'string' && value.trim().length > 0) {
      return assertUsableApiKey(value, PACKAGE, ref);
    }
  }
  const ambient = process.env[ref];
  if (typeof ambient === 'string' && ambient.trim().length > 0) {
    return assertUsableApiKey(ambient, PACKAGE, ref);
  }
  throw new CohereFailure(
    `cohere: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials service (the web Models page writes it), or export ${ref} in the launching environment`,
    'MISSING_CREDENTIAL',
  );
}

/**
 * Mount the Cohere provider route.
 * @param ctx - the plugin context; `inject` guarantees the `llm` service.
 * @param config - the resolved plugin configuration row.
 */
export function apply(ctx: Context, config: Record<string, unknown>): void {
  const options = resolveOptions(config);
  const parts = ctx as unknown as ContextParts;
  const settingsNs = parts.fiber?.entry?.options?.id ?? name;

  const onNotice = (notice: CohereStreamNotice): void => {
    parts.logger?.debug?.('cohere stream notice', notice.kind);
  };

  const adapter = new CohereAdapter({
    options: () => options,
    resolveApiKey: (ref) => resolveApiKey(parts, ref),
    resolveAttachments: () => parts.get('attachments') as AttachmentStoreLike | undefined,
    resolveImageAccess: makeImageAccessResolver((hostPath) => {
      const fs = parts.get('fs') as
        | { processPathFromHostPath?: (path: string) => string | undefined }
        | undefined;
      return fs?.processPathFromHostPath?.(hostPath);
    }),
    onNotice,
  });

  // Declare the route before registering it so the settings surface can offer
  // the provider even while its credential is still missing.
  ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER,
      displayName: options.providerName,
      settingsNs,
      settingsPath: [],
    },
  ]);

  ctx.llm.registerModelDiscovery(settingsNs, async (request, signal) =>
    discoverCohereModels(
      request,
      options.baseURL,
      options.apiKeyEnv,
      (ref) => resolveApiKey(parts, ref),
      signal,
    ),
  );

  ctx.llm.registerAdapter([PROVIDER], adapter);
}
