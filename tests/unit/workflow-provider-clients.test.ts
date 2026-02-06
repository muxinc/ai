import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";
import { describe, expect, it } from "vitest";

import {
  normalizeWorkflowAnthropicClient,
  normalizeWorkflowElevenLabsClient,
  normalizeWorkflowGoogleClient,
  normalizeWorkflowHiveClient,
  normalizeWorkflowOpenAIClient,
  WorkflowAnthropicClient,
  WorkflowElevenLabsClient,
  WorkflowGoogleClient,
  WorkflowHiveClient,
  WorkflowOpenAIClient,
} from "../../src/lib/workflow-provider-clients";

describe("workflow provider clients", () => {
  it("serializes and deserializes openai client", () => {
    const client = new WorkflowOpenAIClient({ apiKey: "openai-test-key" });
    const serialized = WorkflowOpenAIClient[WORKFLOW_SERIALIZE](client);
    const deserialized = WorkflowOpenAIClient[WORKFLOW_DESERIALIZE](serialized);

    expect(serialized.provider).toBe("openai");
    expect(deserialized).toBeInstanceOf(WorkflowOpenAIClient);
    expect(deserialized.chat("gpt-5.1")).toBeTruthy();
    expect(deserialized.embedding("text-embedding-3-small")).toBeTruthy();
  });

  it("serializes and deserializes anthropic client", () => {
    const client = new WorkflowAnthropicClient({ apiKey: "anthropic-test-key" });
    const serialized = WorkflowAnthropicClient[WORKFLOW_SERIALIZE](client);
    const deserialized = WorkflowAnthropicClient[WORKFLOW_DESERIALIZE](serialized);

    expect(serialized.provider).toBe("anthropic");
    expect(deserialized).toBeInstanceOf(WorkflowAnthropicClient);
    expect(deserialized.chat("claude-sonnet-4-5")).toBeTruthy();
  });

  it("serializes and deserializes google client", () => {
    const client = new WorkflowGoogleClient({ apiKey: "google-test-key" });
    const serialized = WorkflowGoogleClient[WORKFLOW_SERIALIZE](client);
    const deserialized = WorkflowGoogleClient[WORKFLOW_DESERIALIZE](serialized);

    expect(serialized.provider).toBe("google");
    expect(deserialized).toBeInstanceOf(WorkflowGoogleClient);
    expect(deserialized.chat("gemini-3-flash-preview")).toBeTruthy();
    expect(deserialized.embedding("gemini-embedding-001")).toBeTruthy();
  });

  it("normalizes serialized provider client shapes", () => {
    const openaiNormalized = normalizeWorkflowOpenAIClient({
      provider: "openai",
      options: { apiKey: "openai-test-key" },
    });
    const anthropicNormalized = normalizeWorkflowAnthropicClient({
      provider: "anthropic",
      options: { apiKey: "anthropic-test-key" },
    });
    const googleNormalized = normalizeWorkflowGoogleClient({
      provider: "google",
      options: { apiKey: "google-test-key" },
    });
    const hiveNormalized = normalizeWorkflowHiveClient({
      provider: "hive",
      options: { apiKey: "hive-test-key" },
    });
    const elevenLabsNormalized = normalizeWorkflowElevenLabsClient({
      provider: "elevenlabs",
      options: { apiKey: "elevenlabs-test-key" },
    });

    expect(openaiNormalized).toBeInstanceOf(WorkflowOpenAIClient);
    expect(anthropicNormalized).toBeInstanceOf(WorkflowAnthropicClient);
    expect(googleNormalized).toBeInstanceOf(WorkflowGoogleClient);
    expect(hiveNormalized).toBeInstanceOf(WorkflowHiveClient);
    expect(elevenLabsNormalized).toBeInstanceOf(WorkflowElevenLabsClient);
    expect(hiveNormalized?.getApiKey()).toBe("hive-test-key");
    expect(elevenLabsNormalized?.getApiKey()).toBe("elevenlabs-test-key");
  });

  it("serializes and deserializes hive and elevenlabs clients", () => {
    const hiveClient = new WorkflowHiveClient({ apiKey: "hive-test-key" });
    const serializedHive = WorkflowHiveClient[WORKFLOW_SERIALIZE](hiveClient);
    const deserializedHive = WorkflowHiveClient[WORKFLOW_DESERIALIZE](serializedHive);

    const elevenLabsClient = new WorkflowElevenLabsClient({ apiKey: "elevenlabs-test-key" });
    const serializedElevenLabs = WorkflowElevenLabsClient[WORKFLOW_SERIALIZE](elevenLabsClient);
    const deserializedElevenLabs = WorkflowElevenLabsClient[WORKFLOW_DESERIALIZE](serializedElevenLabs);

    expect(serializedHive.provider).toBe("hive");
    expect(serializedElevenLabs.provider).toBe("elevenlabs");
    expect(deserializedHive).toBeInstanceOf(WorkflowHiveClient);
    expect(deserializedElevenLabs).toBeInstanceOf(WorkflowElevenLabsClient);
    expect(deserializedHive.getApiKey()).toBe("hive-test-key");
    expect(deserializedElevenLabs.getApiKey()).toBe("elevenlabs-test-key");
  });
});
