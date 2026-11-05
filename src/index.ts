import { version } from "../package.json";

// Error types
export {
  classifyDependencyFailure,
  dependencyError,
  httpStatusOf,
  isTransientStatus,
  requestIdOf,
} from "./lib/dependency-error.ts";
export type { DependencyErrorInit } from "./lib/dependency-error.ts";

// Language code utilities
export {
  getLanguageCodePair,
  getLanguageName,
  isUndeterminedLanguageCode,
  isValidISO639_1,
  isValidISO639_3,
  toISO639_1,
  toISO639_3,
} from "./lib/language-codes.ts";
export type {
  ISO639_1,
  ISO639_3,
  LanguageCodePair,
  SupportedISO639_1,
  SupportedISO639_3,
} from "./lib/language-codes.ts";
export {
  assertNever,
  classificationInit,
  ClassifiedError,
  errorDetailFact,
  internalError,
  MUX_AI_ERROR_CATALOG,
  MUX_AI_ERROR_CODE_VALUES,
  MUX_AI_ERROR_CODES,
  MUX_AI_ERROR_DEPENDENCIES,
  MUX_AI_ERROR_DEPENDENCY_VALUES,
  MUX_AI_ERROR_SOURCE_VALUES,
  MUX_AI_ERROR_SOURCES,
  MUX_AI_ERROR_TYPE_VALUES,
  MUX_AI_ERROR_TYPES,
  MuxAiError,
  restoreClassification,
  serializeClassification,
  wrapError,
} from "./lib/mux-ai-error.ts";
export type {
  ClassifiedErrorInit,
  ErrorCatalogEntry,
  ErrorCauseSummary,
  MuxAiErrorCode,
  MuxAiErrorDependency,
  MuxAiErrorFacts,
  MuxAiErrorFactValue,
  MuxAiErrorInit,
  MuxAiErrorSource,
  MuxAiErrorType,
  SerializedClassification,
} from "./lib/mux-ai-error.ts";
// Mux static renditions created by the deprecated `mp4_support` option
export {
  getLegacyMp4SupportRenditionSizeError,
  resolveLegacyMp4SupportRendition,
  STATIC_RENDITIONS_GUIDE_URL,
  usesLegacyMp4Support,
} from "./lib/mux-static-renditions.ts";
export type { LegacyMp4SupportRendition } from "./lib/mux-static-renditions.ts";

// Mux text track replacement
export {
  buildMuxAiTrackPassthrough,
  findNameCollisionTextTracks,
  findSameLanguageTextTracks,
  isDuplicateTrackNameError,
  isMuxGeneratedTextTrack,
  MUX_TRACK_PASSTHROUGH_MAX_CHARS,
  normalizeTrackLanguageCode,
  normalizeTrackName,
  planSourceTrackReplacement,
  planTextTrackReplacement,
  replaceAndCreateTextTrack,
  replaceAndCreateTrack,
  replaceSourceTrack,
  summarizeTextTrack,
  trackReplacementBlockedError,
  validateTrackPassthrough,
} from "./lib/mux-tracks.ts";
export type {
  ReplaceableTrackType,
  ReplaceAndCreateTextTrackInput,
  ReplaceAndCreateTextTrackResult,
  ReplaceAndCreateTrackInput,
  ReplaceExistingTracksPolicy,
  ReplaceSourceTrackInput,
  SourceTrackReplacementPolicy,
  TextTrackReplacementPlan,
  TextTrackSummary,
  TextTrackTarget,
  TrackReplacementBlocked,
  TrackReplacementBlockedReason,
  TrackSummary,
  TrackTarget,
  TrackWriteCall,
  TrackWriteFailed,
} from "./lib/mux-tracks.ts";

// Mux playback URL utilities
export { getMuxPlaybackOrigin } from "./lib/mux-url.ts";
export type { MuxPlaybackService } from "./lib/mux-url.ts";

export {
  createPublicErrorView,
  genericPublicMessage,
  MUX_AI_ERROR_GENERIC_MESSAGES,
  MUX_AI_ERROR_PUBLIC_MAPPINGS,
  toPublicError,
} from "./lib/public-error.ts";
export type {
  MuxAiPublicError,
  PublicError,
  PublicErrorMapping,
} from "./lib/public-error.ts";

// Workflow credential utilities
export { setWorkflowCredentialsProvider } from "./lib/workflow-credentials.ts";
export type { WorkflowCredentialsProvider } from "./lib/workflow-credentials.ts";
export { decryptFromWorkflow, encryptForWorkflow } from "./lib/workflow-crypto.ts";
export type { Encrypted, EncryptedPayload } from "./lib/workflow-crypto.ts";
export {
  createWorkflowStorageClient,
  WorkflowStorageClient,
} from "./lib/workflow-storage-client.ts";

// Entry points are intentionally shallow; import explicitly from primitives or workflows
export * as primitives from "./primitives/index.ts";
export * from "./types.ts";
export * as workflows from "./workflows/index.ts";

export { version };
