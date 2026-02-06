import { version } from "../package.json";

// Workflow credential utilities
export { setWorkflowCredentialsProvider } from "./lib/workflow-credentials";
export type { WorkflowCredentialsProvider } from "./lib/workflow-credentials";
export { WorkflowMuxClient } from "./lib/workflow-mux-client";
export { serializeForWorkflow, WorkflowNativeCredentials } from "./lib/workflow-native-credentials";
export {
  WorkflowAnthropicClient,
  WorkflowElevenLabsClient,
  WorkflowGoogleClient,
  WorkflowHiveClient,
  WorkflowOpenAIClient,
} from "./lib/workflow-provider-clients";
export {
  createWorkflowStorageClient,
  WorkflowStorageClient,
} from "./lib/workflow-storage-client";

// Entry points are intentionally shallow; import explicitly from primitives or workflows
export * as primitives from "./primitives";
export * from "./types";
export * as workflows from "./workflows";

export { version };
