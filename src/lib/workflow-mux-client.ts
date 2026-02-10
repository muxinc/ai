import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";

import type Mux from "@mux/mux-node";

export interface WorkflowMuxClientOptions {
  tokenId?: string;
  tokenSecret?: string;
  authorizationToken?: string;
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
  private readonly tokenId: string | null;
  private readonly tokenSecret: string | null;
  private readonly authorizationToken: string | null;
  private readonly signingKey?: string;
  private readonly privateKey?: string;

  constructor(options: WorkflowMuxClientOptions) {
    this.tokenId = options.tokenId ?? null;
    this.tokenSecret = options.tokenSecret ?? null;
    this.authorizationToken = options.authorizationToken ?? null;
    this.signingKey = options.signingKey;
    this.privateKey = options.privateKey;
  }

  async createClient(): Promise<Mux> {
    // Dynamic import to prevent @mux/mux-node (and its transitive dep jose)
    // from being bundled into workflow VM code where `require` is unavailable.
    const { default: MuxClient } = await import("@mux/mux-node");
    return new MuxClient({
      tokenId: this.tokenId,
      tokenSecret: this.tokenSecret,
      authorizationToken: this.authorizationToken,
    });
  }

  getTokenId(): string | null {
    return this.tokenId;
  }

  getTokenSecret(): string | null {
    return this.tokenSecret;
  }

  getAuthorizationToken(): string | null {
    return this.authorizationToken;
  }

  getSigningKey(): string | undefined {
    return this.signingKey;
  }

  getPrivateKey(): string | undefined {
    return this.privateKey;
  }

  static [WORKFLOW_SERIALIZE](instance: WorkflowMuxClient): WorkflowMuxClientOptions {
    return {
      tokenId: instance.tokenId ?? undefined,
      tokenSecret: instance.tokenSecret ?? undefined,
      authorizationToken: instance.authorizationToken ?? undefined,
      signingKey: instance.signingKey,
      privateKey: instance.privateKey,
    };
  }

  static [WORKFLOW_DESERIALIZE](this: typeof WorkflowMuxClient, value: WorkflowMuxClientOptions): WorkflowMuxClient {
    return new this(value);
  }
}
