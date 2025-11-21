import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { LanguageModel } from 'ai';
import { MuxAIOptions } from '../types';

// Hosted Mux Gemini path intentionally not exposed yet; limited to BYO providers for now.
export type SupportedProvider = 'openai' | 'anthropic' | 'google';

// Model ID unions inferred from ai-sdk provider call signatures
type OpenAIModelId = Parameters<ReturnType<typeof createOpenAI>['chat']>[0];
type AnthropicModelId = Parameters<ReturnType<typeof createAnthropic>['chat']>[0];
type GoogleModelId = Parameters<ReturnType<typeof createGoogleGenerativeAI>['chat']>[0];

export type ModelIdByProvider = {
  openai: OpenAIModelId;
  anthropic: AnthropicModelId;
  google: GoogleModelId;
};

export interface ModelRequestOptions<P extends SupportedProvider = SupportedProvider> extends MuxAIOptions {
  provider?: P;
  model?: ModelIdByProvider[P];
}

export interface ResolvedModel<P extends SupportedProvider = SupportedProvider> {
  provider: P;
  modelId: ModelIdByProvider[P];
  model: LanguageModel;
  /**
   * Indicates whether the model relies on Mux tokens instead of BYO provider keys.
   * (Future hosted Mux models will flip this to true.)
   */
  usesMuxTokens: boolean;
}

const DEFAULT_LANGUAGE_MODELS: { [K in SupportedProvider]: ModelIdByProvider[K] } = {
  openai: 'gpt-5-mini',
  anthropic: 'claude-sonnet-4-5',
  google: 'gemini-2.5-flash',
};

function requireEnv(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing ${name}. Set ${name} in your environment or pass it in options.`);
  }
  return value;
}

/**
 * Resolves a language model using Vercel's AI SDK providers.
 * - BYO: defaults to the provider-specific env var conventions used by ai-sdk
 * - Mux-hosted: reserved for a future path that does not require provider keys
 */
export function resolveLanguageModel<P extends SupportedProvider = SupportedProvider>(
  options: ModelRequestOptions<P> = {}
): ResolvedModel<P> {
  const provider = options.provider || ('openai' as P);
  const modelId = (options.model || DEFAULT_LANGUAGE_MODELS[provider]) as ModelIdByProvider[P];

  switch (provider) {
    case 'openai': {
      const apiKey = options.openaiApiKey || process.env.OPENAI_API_KEY;
      requireEnv(apiKey, 'OPENAI_API_KEY');
      const openai = createOpenAI({
        apiKey,
      });

      return {
        provider,
        modelId,
        model: openai(modelId),
        usesMuxTokens: false,
      };
    }
    case 'anthropic': {
      const apiKey = options.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
      requireEnv(apiKey, 'ANTHROPIC_API_KEY');
      const anthropic = createAnthropic({
        apiKey,
      });

      return {
        provider,
        modelId,
        model: anthropic(modelId),
        usesMuxTokens: false,
      };
    }
    case 'google': {
      const apiKey = options.googleApiKey || process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_API_KEY;
      requireEnv(apiKey, 'GOOGLE_GENERATIVE_AI_API_KEY');
      const google = createGoogleGenerativeAI({
        apiKey,
      });

      return {
        provider,
        modelId,
        model: google(modelId),
        usesMuxTokens: false,
      };
    }
    default: {
      const exhaustiveCheck: never = provider;
      throw new Error(`Unsupported provider: ${exhaustiveCheck}`);
    }
  }
}
