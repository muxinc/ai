import { version } from "../package.json";

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

// Error types
export { MuxAiError, wrapError } from "./lib/mux-ai-error.ts";
export type { MuxAiErrorType } from "./lib/mux-ai-error.ts";

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
  planTextTrackReplacement,
  replaceAndCreateTextTrack,
  replaceAndCreateTrack,
  summarizeTextTrack,
  validateTrackPassthrough,
} from "./lib/mux-tracks.ts";
export type {
  ReplaceableTrackType,
  ReplaceAndCreateTextTrackInput,
  ReplaceAndCreateTextTrackResult,
  ReplaceAndCreateTrackInput,
  ReplaceExistingTracksPolicy,
  TextTrackReplacementPlan,
  TextTrackSummary,
  TextTrackTarget,
  TrackSummary,
  TrackTarget,
} from "./lib/mux-tracks.ts";

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
