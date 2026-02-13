import { version } from "../package.json";

// Workflow credential utilities
export { setWorkflowCredentialsProvider } from "./lib/workflow-credentials";
export type { WorkflowCredentialsProvider } from "./lib/workflow-credentials";
export { decryptFromWorkflow, encryptForWorkflow } from "./lib/workflow-crypto";
export type { Encrypted, EncryptedPayload } from "./lib/workflow-crypto";
export {
  createWorkflowStorageClient,
  WorkflowStorageClient,
} from "./lib/workflow-storage-client";

// Entry points are intentionally shallow; import explicitly from primitives or workflows
export * as primitives from "./primitives";
export * from "./types";
export * as workflows from "./workflows";

export { version };
