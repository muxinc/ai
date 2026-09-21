import type { WorkflowScope } from "../types.ts";

import { MuxAiError } from "./mux-ai-error.ts";

/** A workflow scope with both asset-relative boundaries resolved. */
export interface ResolvedWorkflowScope {
  /** Inclusive start offset in seconds. */
  startTime: number;
  /** Exclusive end offset in seconds. */
  endTime: number;
}

/** Returns whether a scope actually narrows an asset-relative range. */
export function hasWorkflowScopeBoundaries(
  scope: WorkflowScope | undefined,
): scope is WorkflowScope {
  return scope?.startTime !== undefined || scope?.endTime !== undefined;
}

/**
 * Validates a caller-provided scope and fills omitted boundaries from the
 * asset duration.
 */
export function resolveWorkflowScope(
  scope: WorkflowScope | undefined,
  assetDurationSeconds: number | undefined,
): ResolvedWorkflowScope {
  if (
    assetDurationSeconds === undefined ||
    !Number.isFinite(assetDurationSeconds) ||
    assetDurationSeconds <= 0
  ) {
    throw new MuxAiError("Asset has no valid duration.", { type: "validation_error" });
  }

  const startTime = scope?.startTime ?? 0;
  const endTime = scope?.endTime ?? assetDurationSeconds;

  if (!Number.isFinite(startTime) || startTime < 0) {
    throw new MuxAiError(
      `scope.startTime must be a finite, non-negative number (received ${startTime}).`,
      { type: "validation_error" },
    );
  }

  if (!Number.isFinite(endTime) || endTime < 0) {
    throw new MuxAiError(
      `scope.endTime must be a finite, non-negative number (received ${endTime}).`,
      { type: "validation_error" },
    );
  }

  if (endTime > assetDurationSeconds) {
    throw new MuxAiError(
      `scope.endTime (${endTime}) cannot exceed the asset duration (${assetDurationSeconds}).`,
      { type: "validation_error" },
    );
  }

  if (startTime >= endTime) {
    throw new MuxAiError(
      `scope.startTime (${startTime}) must be less than scope.endTime (${endTime}).`,
      { type: "validation_error" },
    );
  }

  return { startTime, endTime };
}

/**
 * Resolves an asset-relative scope and clamps it to the portion of the asset
 * that can be rendered as video.
 */
export function resolveRenderableVideoScope(
  scope: WorkflowScope | undefined,
  assetDurationSeconds: number | undefined,
  videoTrackDurationSeconds: number | undefined,
): ResolvedWorkflowScope | undefined {
  if (!hasWorkflowScopeBoundaries(scope)) {
    return undefined;
  }

  const resolvedScope = resolveWorkflowScope(scope, assetDurationSeconds);
  let renderableEndTime = resolvedScope.endTime;
  if (
    videoTrackDurationSeconds !== undefined &&
    Number.isFinite(videoTrackDurationSeconds) &&
    videoTrackDurationSeconds >= 0
  ) {
    renderableEndTime = Math.min(videoTrackDurationSeconds, resolvedScope.endTime);
  }
  const renderableScope = {
    startTime: Math.min(resolvedScope.startTime, renderableEndTime),
    endTime: renderableEndTime,
  };

  if (renderableScope.startTime >= renderableScope.endTime) {
    throw new MuxAiError("The requested scope does not include any renderable video.", {
      type: "validation_error",
    });
  }

  return renderableScope;
}

/** Returns true when two asset-relative time ranges overlap. */
export function timeRangesOverlap(
  firstStart: number,
  firstEnd: number,
  second: WorkflowScope,
): boolean {
  const secondStart = second.startTime ?? 0;
  const secondEnd = second.endTime ?? Number.POSITIVE_INFINITY;
  return firstStart < secondEnd && firstEnd > secondStart;
}
