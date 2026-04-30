import { version } from "../package.json";

// Error types
export { MuxAiError, wrapError } from "./lib/mux-ai-error.ts";
export type { MuxAiErrorType } from "./lib/mux-ai-error.ts";

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
