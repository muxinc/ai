/**
 * Default model configurations for each provider
 */
export interface ProviderModelConfig {
  default: string;
  fast: string;
  powerful: string;
}

export const PROVIDER_MODELS: Record<string, ProviderModelConfig> = {
  openai: {
    default: 'gpt-5-mini',
    fast: 'gpt-5-mini',
    powerful: 'gpt-5.1',
  },
  anthropic: {
    default: 'claude-3-5-haiku-20241022',
    fast: 'claude-3-5-haiku-20241022',
    powerful: 'claude-3-5-sonnet-20241022',
  },
};

/**
 * Gets the default model for a provider
 */
export function getDefaultModel(provider: 'openai' | 'anthropic'): string {
  return PROVIDER_MODELS[provider].default;
}

/**
 * Validates that a provider is supported
 */
export function validateProvider(provider: string): asserts provider is 'openai' | 'anthropic' {
  if (provider !== 'openai' && provider !== 'anthropic') {
    throw new Error(`Unsupported provider: ${provider}. Supported providers are: openai, anthropic`);
  }
}
