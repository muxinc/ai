import type { WorkflowScope } from "../types.ts";

import { LegacyMuxAiError } from "./legacy-mux-ai-error.ts";
import type { ClassifiedErrorsOption, MuxAiErrorFacts } from "./mux-ai-error.ts";
import { MUX_AI_ERROR_CODES, MUX_AI_ERROR_SOURCES, MUX_AI_ERROR_TYPES, MuxAiError } from "./mux-ai-error.ts";

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

/** Options for {@link resolveWorkflowScope}. */
export interface ResolveWorkflowScopeOptions extends ClassifiedErrorsOption {
  /** Named in a classified `asset_duration_unavailable` error. */
  assetId?: string;
}

/** `invalid_scope`, blamed on the scope bounds the caller passed. */
export function invalidScopeError(message: string, facts: MuxAiErrorFacts, inputs: string[]): MuxAiError {
  return new MuxAiError(message, {
    code: MUX_AI_ERROR_CODES.INVALID_SCOPE,
    type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR,
    source: MUX_AI_ERROR_SOURCES.REQUEST,
    facts: { ...facts, inputs },
  });
}

/** A bound as a JSON-safe fact: NaN and infinities become their names. */
function boundFact(value: number): number | string {
  return Number.isFinite(value) ? value : String(value);
}

/**
 * Validates a caller-provided scope and fills omitted boundaries from the
 * asset duration.
 */
export function resolveWorkflowScope(
  scope: WorkflowScope | undefined,
  assetDurationSeconds: number | undefined,
  options: ResolveWorkflowScopeOptions = {},
): ResolvedWorkflowScope {
  const classified = options.classifiedErrors === true;
  if (
    assetDurationSeconds === undefined ||
    !Number.isFinite(assetDurationSeconds) ||
    assetDurationSeconds <= 0
  ) {
    if (classified) {
      throw new MuxAiError("Asset has no valid duration.", {
        code: MUX_AI_ERROR_CODES.ASSET_DURATION_UNAVAILABLE,
        type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR,
        source: MUX_AI_ERROR_SOURCES.ASSET,
        facts: { ...(options.assetId && { assetId: options.assetId }) },
      });
    }
    throw new LegacyMuxAiError("Asset has no valid duration.", { type: "validation_error" });
  }

  const startTime = scope?.startTime ?? 0;
  const endTime = scope?.endTime ?? assetDurationSeconds;

  if (!Number.isFinite(startTime) || startTime < 0) {
    const message = `scope.startTime must be a finite, non-negative number (received ${startTime}).`;
    if (classified) {
      throw invalidScopeError(message, { reason: "invalid_start_time", received: boundFact(startTime) }, ["scope.startTime"]);
    }
    throw new LegacyMuxAiError(message, { type: "validation_error" });
  }

  if (!Number.isFinite(endTime) || endTime < 0) {
    const message = `scope.endTime must be a finite, non-negative number (received ${endTime}).`;
    if (classified) {
      throw invalidScopeError(message, { reason: "invalid_end_time", received: boundFact(endTime) }, ["scope.endTime"]);
    }
    throw new LegacyMuxAiError(message, { type: "validation_error" });
  }

  if (endTime > assetDurationSeconds) {
    const message = `scope.endTime (${endTime}) cannot exceed the asset duration (${assetDurationSeconds}).`;
    if (classified) {
      throw invalidScopeError(message, { reason: "exceeds_duration", endTime, assetDurationSeconds }, ["scope.endTime"]);
    }
    throw new LegacyMuxAiError(message, { type: "validation_error" });
  }

  if (startTime >= endTime) {
    const message = `scope.startTime (${startTime}) must be less than scope.endTime (${endTime}).`;
    if (classified) {
      // An omitted end defaults to the asset's end, so only the bounds the caller set are blamed.
      const inputs = scope?.endTime === undefined ? ["scope.startTime"] : ["scope.startTime", "scope.endTime"];
      throw invalidScopeError(message, { reason: "empty_range", startTime, endTime }, inputs);
    }
    throw new LegacyMuxAiError(message, { type: "validation_error" });
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
    throw new LegacyMuxAiError("The requested scope does not include any renderable video.", {
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
