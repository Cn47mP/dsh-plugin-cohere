/**
 * DSH image blocks → Cohere v2 `image_url` payload.
 *
 * The harness owns durable image bytes behind the `attachments` service. A route
 * that declares `image` in `inputModalities` receives real image blocks; every
 * other route receives placeholder text instead, so an unconvertible image here
 * is a configuration error, not a normal case.
 *
 * Budget accounting mirrors the first-party adapters:
 *
 * - each image is re-encoded to an aspect-preserving target within a pixel budget
 *   (`requestImagePixelBudget`) and an encoded-byte budget (`requestImageMaxBytes`);
 * - the whole request must then fit `maxRequestImageBytes` as base64, or the
 *   adapter raises `IMAGE_OFFLOAD_REQUIRED` naming how many more oldest
 *   occurrences the harness must offload before retrying;
 * - images already marked `offloaded` become stable placeholder text.
 *
 * `requestImageDimensions` is reproduced from
 * `@deepseek-ai/dsh-attachment/request-projection` (pure geometry) so this plugin
 * needs no dependency beyond `@deepseek-ai/dsh-llm`.
 *
 * @module dsh-plugin-cohere/wire/images
 */

import {
  contentHasImage,
  IMAGE_OFFLOAD_REQUIRED_CODE,
  offloadedImageText,
  projectOffloadedImages,
  requiredImageOffload,
  resolveImageAttachmentAccess,
} from '@deepseek-ai/dsh-llm';
import type { ContentBlock, Message, RequestMessage } from '@deepseek-ai/dsh-llm';
import { CohereFailure } from '../failure.js';

/** Durable image reference as the harness stores it (structural view). */
export interface ImageRefLike {
  readonly attachmentId: string;
  readonly mediaType: string;
  readonly width: number;
  readonly height: number;
}

/** One request-ready image returned by the attachment store. */
export interface RequestImageLike extends ImageRefLike {
  readonly data: Uint8Array;
  readonly bytes: number;
}

/** The slice of the durable attachment store this adapter uses. */
export interface AttachmentStoreLike {
  readImageRequest(
    ref: ImageRefLike,
    target: { readonly width: number; readonly height: number; readonly maxBytes: number },
    signal?: AbortSignal,
  ): Promise<RequestImageLike>;
}

/** Resolve provider-side read access for one durable image reference. */
export type ImageAccessResolver = (
  store: AttachmentStoreLike,
  ref: ImageRefLike,
) => unknown;

/** Request-image budgets, surfaced as plugin configuration. */
export interface ImagePolicy {
  /** Whole-request base64 byte bound before offloading is required. */
  readonly maxRequestImageBytes: number;
  /** Per-image width×height cap used to pick the re-encode target. */
  readonly maxPixels: number;
  /** Per-image encoded byte cap used to pick the re-encode target. */
  readonly maxImageBytes: number;
}

/** Everything the request builder needs to project images. */
export interface PreparedImages {
  /** Request-ready bytes keyed by `attachmentId`. */
  readonly versions: ReadonlyMap<string, RequestImageLike>;
  /** Placeholder text for one offloaded image. */
  readonly placeholder: (ref: ImageRefLike) => string;
}

/** Compute aspect-preserving integer dimensions within a total-pixel cap. */
export function requestImageDimensions(
  width: number,
  height: number,
  maxPixels: number,
): { width: number; height: number } {
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
  if (scale === 1) return { width, height };
  if (width >= height) {
    let projectedWidth = Math.max(1, Math.floor(width * scale));
    let projectedHeight = Math.max(1, Math.round((projectedWidth * height) / width));
    while (projectedWidth * projectedHeight > maxPixels && projectedWidth > 1) {
      projectedWidth -= 1;
      projectedHeight = Math.max(1, Math.round((projectedWidth * height) / width));
    }
    return { width: projectedWidth, height: projectedHeight };
  }
  let projectedHeight = Math.max(1, Math.floor(height * scale));
  let projectedWidth = Math.max(1, Math.round((projectedHeight * width) / height));
  while (projectedWidth * projectedHeight > maxPixels && projectedHeight > 1) {
    projectedHeight -= 1;
    projectedWidth = Math.max(1, Math.round((projectedHeight * width) / height));
  }
  return { width: projectedWidth, height: projectedHeight };
}

/** Deterministic re-encode target for one source under the route budgets. */
function requestImageTarget(
  ref: ImageRefLike,
  policy: ImagePolicy,
): { width: number; height: number; maxBytes: number } {
  return {
    ...requestImageDimensions(ref.width, ref.height, policy.maxPixels),
    maxBytes: policy.maxImageBytes,
  };
}

/** Whether any message carries an image block. */
export function messagesHaveImage(messages: readonly RequestMessage[]): boolean {
  return messages.some(
    (message) => contentHasImage((message as Message).content as readonly ContentBlock[]) === true,
  );
}

/** Collect the distinct non-offloaded image references across messages. */
function collectImageRefs(
  messages: readonly RequestMessage[],
  refs: Map<string, ImageRefLike>,
): void {
  for (const message of messages) {
    const content = (message as Message).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type !== 'image') continue;
      const ref = block.attachment as unknown as ImageRefLike;
      if (block.offloaded === true) continue;
      if (typeof ref?.attachmentId === 'string') refs.set(ref.attachmentId, ref);
    }
  }
}

/**
 * Read every request image and enforce the whole-request byte bound.
 * @param messages - request messages, before offloaded placeholders are applied.
 * @param store - the durable attachment store.
 * @param policy - resolved image budgets.
 * @param access - resolver for offloaded placeholder text.
 * @param signal - caller cancellation.
 * @returns request-ready versions plus the placeholder function.
 * @throws CohereFailure `IMAGE_OFFLOAD_REQUIRED` when the request is over budget.
 */
export async function prepareImages(
  messages: readonly RequestMessage[],
  store: AttachmentStoreLike,
  policy: ImagePolicy,
  access: ImageAccessResolver,
  signal?: AbortSignal,
): Promise<PreparedImages> {
  const refs = new Map<string, ImageRefLike>();
  collectImageRefs(messages, refs);
  const ordered = [...refs.values()];
  const prepared = await Promise.all(
    ordered.map((ref) =>
      store.readImageRequest(ref, requestImageTarget(ref, policy), signal),
    ),
  );
  const versions = new Map<string, RequestImageLike>();
  for (const [index, ref] of ordered.entries()) {
    const version = prepared[index];
    if (version !== undefined) versions.set(ref.attachmentId, version);
  }

  if (Number.isFinite(policy.maxRequestImageBytes) && policy.maxRequestImageBytes > 0) {
    const over = requiredImageOffload(
      messages as readonly never[],
      { representation: 'base64', maxBytes: policy.maxRequestImageBytes },
      (block: { attachment: ImageRefLike }) =>
        versions.get(block.attachment.attachmentId)?.bytes ?? 0,
    );
    if (over > 0) {
      throw new CohereFailure(
        `cohere: request images exceed the ${policy.maxRequestImageBytes}-byte base64 bound; ${over} more oldest occurrence(s) must be offloaded`,
        IMAGE_OFFLOAD_REQUIRED_CODE,
        { offloadImages: over },
      );
    }
  }

  const placeholder = (ref: ImageRefLike): string =>
    offloadedImageText(ref as never, access(store, ref) as never);

  return { versions, placeholder };
}

/** Apply the offloaded-image placeholders across one message list. */
export function withOffloadedPlaceholders(
  messages: readonly RequestMessage[],
  placeholder: (ref: ImageRefLike) => string,
): RequestMessage[] {
  return projectOffloadedImages(
    messages as readonly never[],
    (ref) => placeholder(ref as unknown as ImageRefLike),
  ) as RequestMessage[];
}

/** Resolve durable read access through the harness attachment helper. */
export function makeImageAccessResolver(
  mapHostPath: (hostPath: string) => string | undefined,
): ImageAccessResolver {
  return (store, ref) =>
    resolveImageAttachmentAccess(
      store as never,
      mapHostPath,
      ref as never,
    );
}

/** Encode one request image as the Cohere `image_url` data URL. */
export function imageDataUrl(version: RequestImageLike): string {
  const base64 = Buffer.from(version.data).toString('base64');
  return `data:${version.mediaType};base64,${base64}`;
}
