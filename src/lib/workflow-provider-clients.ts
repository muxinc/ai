import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";

import type { EmbeddingModel, LanguageModel } from "ai";

type OpenAIOptions = Parameters<typeof createOpenAI>[0];
type AnthropicOptions = Parameters<typeof createAnthropic>[0];
type GoogleOptions = Parameters<typeof createGoogleGenerativeAI>[0];
interface HiveOptions { apiKey?: string }
interface ElevenLabsOptions { apiKey?: string }

type OpenAIChatModelId = Parameters<ReturnType<typeof createOpenAI>["chat"]>[0];
type OpenAIEmbeddingModelId = Parameters<ReturnType<typeof createOpenAI>["embedding"]>[0];
type AnthropicChatModelId = Parameters<ReturnType<typeof createAnthropic>["chat"]>[0];
type GoogleChatModelId = Parameters<ReturnType<typeof createGoogleGenerativeAI>["chat"]>[0];
type GoogleEmbeddingModelId = Parameters<ReturnType<typeof createGoogleGenerativeAI>["textEmbeddingModel"]>[0];

interface SerializedOpenAIClient { provider: "openai"; options: OpenAIOptions }
interface SerializedAnthropicClient { provider: "anthropic"; options: AnthropicOptions }
interface SerializedGoogleClient { provider: "google"; options: GoogleOptions }
interface SerializedHiveClient { provider: "hive"; options: HiveOptions }
interface SerializedElevenLabsClient { provider: "elevenlabs"; options: ElevenLabsOptions }

export class WorkflowOpenAIClient {
  private readonly options: OpenAIOptions;

  constructor(options: OpenAIOptions = {}) {
    this.options = options;
  }

  chat(modelId: OpenAIChatModelId): LanguageModel {
    const openai = createOpenAI(this.options);
    return openai(modelId);
  }

  embedding(modelId: OpenAIEmbeddingModelId): EmbeddingModel {
    const openai = createOpenAI(this.options);
    return openai.embedding(modelId);
  }

  static [WORKFLOW_SERIALIZE](instance: WorkflowOpenAIClient): SerializedOpenAIClient {
    return { provider: "openai", options: instance.options };
  }

  static [WORKFLOW_DESERIALIZE](this: typeof WorkflowOpenAIClient, value: SerializedOpenAIClient): WorkflowOpenAIClient {
    return new this(value.options);
  }
}

export class WorkflowAnthropicClient {
  private readonly options: AnthropicOptions;

  constructor(options: AnthropicOptions = {}) {
    this.options = options;
  }

  chat(modelId: AnthropicChatModelId): LanguageModel {
    const anthropic = createAnthropic(this.options);
    return anthropic(modelId);
  }

  static [WORKFLOW_SERIALIZE](instance: WorkflowAnthropicClient): SerializedAnthropicClient {
    return { provider: "anthropic", options: instance.options };
  }

  static [WORKFLOW_DESERIALIZE](this: typeof WorkflowAnthropicClient, value: SerializedAnthropicClient): WorkflowAnthropicClient {
    return new this(value.options);
  }
}

export class WorkflowGoogleClient {
  private readonly options: GoogleOptions;

  constructor(options: GoogleOptions = {}) {
    this.options = options;
  }

  chat(modelId: GoogleChatModelId): LanguageModel {
    const google = createGoogleGenerativeAI(this.options);
    return google(modelId);
  }

  embedding(modelId: GoogleEmbeddingModelId): EmbeddingModel {
    const google = createGoogleGenerativeAI(this.options);
    return google.textEmbeddingModel(modelId);
  }

  static [WORKFLOW_SERIALIZE](instance: WorkflowGoogleClient): SerializedGoogleClient {
    return { provider: "google", options: instance.options };
  }

  static [WORKFLOW_DESERIALIZE](this: typeof WorkflowGoogleClient, value: SerializedGoogleClient): WorkflowGoogleClient {
    return new this(value.options);
  }
}

export class WorkflowHiveClient {
  private readonly options: HiveOptions;

  constructor(options: HiveOptions = {}) {
    this.options = options;
  }

  getApiKey(): string | undefined {
    return this.options.apiKey;
  }

  static [WORKFLOW_SERIALIZE](instance: WorkflowHiveClient): SerializedHiveClient {
    return { provider: "hive", options: instance.options };
  }

  static [WORKFLOW_DESERIALIZE](this: typeof WorkflowHiveClient, value: SerializedHiveClient): WorkflowHiveClient {
    return new this(value.options);
  }
}

export class WorkflowElevenLabsClient {
  private readonly options: ElevenLabsOptions;

  constructor(options: ElevenLabsOptions = {}) {
    this.options = options;
  }

  getApiKey(): string | undefined {
    return this.options.apiKey;
  }

  static [WORKFLOW_SERIALIZE](instance: WorkflowElevenLabsClient): SerializedElevenLabsClient {
    return { provider: "elevenlabs", options: instance.options };
  }

  static [WORKFLOW_DESERIALIZE](this: typeof WorkflowElevenLabsClient, value: SerializedElevenLabsClient): WorkflowElevenLabsClient {
    return new this(value.options);
  }
}

function isSerializedOpenAIClient(value: unknown): value is SerializedOpenAIClient {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as SerializedOpenAIClient;
  return candidate.provider === "openai" && "options" in candidate;
}

function isSerializedAnthropicClient(value: unknown): value is SerializedAnthropicClient {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as SerializedAnthropicClient;
  return candidate.provider === "anthropic" && "options" in candidate;
}

function isSerializedGoogleClient(value: unknown): value is SerializedGoogleClient {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as SerializedGoogleClient;
  return candidate.provider === "google" && "options" in candidate;
}

function isSerializedHiveClient(value: unknown): value is SerializedHiveClient {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as SerializedHiveClient;
  return candidate.provider === "hive" && "options" in candidate;
}

function isSerializedElevenLabsClient(value: unknown): value is SerializedElevenLabsClient {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as SerializedElevenLabsClient;
  return candidate.provider === "elevenlabs" && "options" in candidate;
}

export function normalizeWorkflowOpenAIClient(value: unknown): WorkflowOpenAIClient | undefined {
  if (value instanceof WorkflowOpenAIClient) {
    return value;
  }
  if (isSerializedOpenAIClient(value)) {
    return new WorkflowOpenAIClient(value.options);
  }
  return undefined;
}

export function normalizeWorkflowAnthropicClient(value: unknown): WorkflowAnthropicClient | undefined {
  if (value instanceof WorkflowAnthropicClient) {
    return value;
  }
  if (isSerializedAnthropicClient(value)) {
    return new WorkflowAnthropicClient(value.options);
  }
  return undefined;
}

export function normalizeWorkflowGoogleClient(value: unknown): WorkflowGoogleClient | undefined {
  if (value instanceof WorkflowGoogleClient) {
    return value;
  }
  if (isSerializedGoogleClient(value)) {
    return new WorkflowGoogleClient(value.options);
  }
  return undefined;
}

export function normalizeWorkflowHiveClient(value: unknown): WorkflowHiveClient | undefined {
  if (value instanceof WorkflowHiveClient) {
    return value;
  }
  if (isSerializedHiveClient(value)) {
    return new WorkflowHiveClient(value.options);
  }
  return undefined;
}

export function normalizeWorkflowElevenLabsClient(value: unknown): WorkflowElevenLabsClient | undefined {
  if (value instanceof WorkflowElevenLabsClient) {
    return value;
  }
  if (isSerializedElevenLabsClient(value)) {
    return new WorkflowElevenLabsClient(value.options);
  }
  return undefined;
}

export function createWorkflowOpenAIClient(options: OpenAIOptions = {}): WorkflowOpenAIClient {
  return new WorkflowOpenAIClient(options);
}

export function createWorkflowAnthropicClient(options: AnthropicOptions = {}): WorkflowAnthropicClient {
  return new WorkflowAnthropicClient(options);
}

export function createWorkflowGoogleClient(options: GoogleOptions = {}): WorkflowGoogleClient {
  return new WorkflowGoogleClient(options);
}

export function createWorkflowHiveClient(options: HiveOptions = {}): WorkflowHiveClient {
  return new WorkflowHiveClient(options);
}

export function createWorkflowElevenLabsClient(options: ElevenLabsOptions = {}): WorkflowElevenLabsClient {
  return new WorkflowElevenLabsClient(options);
}
