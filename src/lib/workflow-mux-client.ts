import Mux from "@mux/mux-node";

import { getMuxCredentialsFromEnv } from "@mux/ai/lib/client-factory";
import type { WorkflowCredentialsInput } from "@mux/ai/types";

const WORKFLOW_SERIALIZE = Symbol.for("workflow-serialize");
const WORKFLOW_DESERIALIZE = Symbol.for("workflow-deserialize");
const WORKFLOW_CLASS_REGISTRY = Symbol.for("workflow-class-registry");
const WORKFLOW_MUX_CLIENT_CLASS_ID = "mux.ai.workflow-mux-client";

type AnyObject = Record<PropertyKey, unknown>;

function registerWorkflowMuxClientClass(): void {
  const globalRegistry = globalThis as AnyObject;
  const existingRegistry = globalRegistry[WORKFLOW_CLASS_REGISTRY] as Map<string, unknown> | undefined;
  const registry = existingRegistry ?? new Map<string, unknown>();

  if (!existingRegistry) {
    globalRegistry[WORKFLOW_CLASS_REGISTRY] = registry as unknown;
  }

  registry.set(WORKFLOW_MUX_CLIENT_CLASS_ID, WorkflowMuxClient);

  const ctor = WorkflowMuxClient as unknown as { classId?: string };
  if (ctor.classId !== WORKFLOW_MUX_CLIENT_CLASS_ID) {
    Object.defineProperty(WorkflowMuxClient, "classId", {
      value: WORKFLOW_MUX_CLIENT_CLASS_ID,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
}

/**
 * Serializable Mux API client wrapper for workflow boundaries.
 */
export class WorkflowMuxClient {
  constructor(
    private readonly tokenId: string,
    private readonly tokenSecret: string,
  ) {}

  createClient(): Mux {
    return new Mux({
      tokenId: this.tokenId,
      tokenSecret: this.tokenSecret,
    });
  }

  static [WORKFLOW_SERIALIZE](instance: WorkflowMuxClient): { tokenId: string; tokenSecret: string } {
    return {
      tokenId: instance.tokenId,
      tokenSecret: instance.tokenSecret,
    };
  }

  static [WORKFLOW_DESERIALIZE](value: { tokenId: string; tokenSecret: string }): WorkflowMuxClient {
    return new WorkflowMuxClient(value.tokenId, value.tokenSecret);
  }
}

registerWorkflowMuxClientClass();

export async function createWorkflowMuxClient(
  credentials?: WorkflowCredentialsInput,
): Promise<WorkflowMuxClient> {
  const { muxTokenId, muxTokenSecret } = await getMuxCredentialsFromEnv(credentials);
  return new WorkflowMuxClient(muxTokenId, muxTokenSecret);
}
