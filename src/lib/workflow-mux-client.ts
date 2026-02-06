import Mux from "@mux/mux-node";
import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";

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

export interface WorkflowMuxClientOptions {
  tokenId: string;
  tokenSecret: string;
  signingKey?: string;
  privateKey?: string;
}

/**
 * Serializable Mux API client wrapper for workflow boundaries.
 *
 * Carries Mux API credentials and optional URL-signing keys.
 * The Workflow DevKit handles secure serialization across step boundaries.
 */
export class WorkflowMuxClient {
  private readonly tokenId: string;
  private readonly tokenSecret: string;
  private readonly signingKey?: string;
  private readonly privateKey?: string;

  constructor(options: WorkflowMuxClientOptions) {
    this.tokenId = options.tokenId;
    this.tokenSecret = options.tokenSecret;
    this.signingKey = options.signingKey;
    this.privateKey = options.privateKey;
  }

  createClient(): Mux {
    return new Mux({
      tokenId: this.tokenId,
      tokenSecret: this.tokenSecret,
    });
  }

  getTokenId(): string {
    return this.tokenId;
  }

  getTokenSecret(): string {
    return this.tokenSecret;
  }

  getSigningKey(): string | undefined {
    return this.signingKey;
  }

  getPrivateKey(): string | undefined {
    return this.privateKey;
  }

  static [WORKFLOW_SERIALIZE](instance: WorkflowMuxClient): WorkflowMuxClientOptions {
    return {
      tokenId: instance.tokenId,
      tokenSecret: instance.tokenSecret,
      signingKey: instance.signingKey,
      privateKey: instance.privateKey,
    };
  }

  static [WORKFLOW_DESERIALIZE](value: WorkflowMuxClientOptions): WorkflowMuxClient {
    return new WorkflowMuxClient(value);
  }
}

registerWorkflowMuxClientClass();
