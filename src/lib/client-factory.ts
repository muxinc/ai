import Mux from '@mux/mux-node';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { MuxAIOptions } from '../types';

export interface ClientCredentials {
  muxTokenId?: string;
  muxTokenSecret?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
}

export interface ValidatedCredentials {
  muxTokenId: string;
  muxTokenSecret: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
}

/**
 * Validates and retrieves credentials from options or environment variables
 */
export function validateCredentials(
  options: ClientCredentials,
  requiredProvider?: 'openai' | 'anthropic'
): ValidatedCredentials {
  const muxTokenId = options.muxTokenId || process.env.MUX_TOKEN_ID;
  const muxTokenSecret = options.muxTokenSecret || process.env.MUX_TOKEN_SECRET;
  const openaiApiKey = options.openaiApiKey || process.env.OPENAI_API_KEY;
  const anthropicApiKey = options.anthropicApiKey || process.env.ANTHROPIC_API_KEY;

  if (!muxTokenId || !muxTokenSecret) {
    throw new Error(
      'Mux credentials are required. Provide muxTokenId and muxTokenSecret in options or set MUX_TOKEN_ID and MUX_TOKEN_SECRET environment variables.'
    );
  }

  if (requiredProvider === 'openai' && !openaiApiKey) {
    throw new Error(
      'OpenAI API key is required. Provide openaiApiKey in options or set OPENAI_API_KEY environment variable.'
    );
  }

  if (requiredProvider === 'anthropic' && !anthropicApiKey) {
    throw new Error(
      'Anthropic API key is required. Provide anthropicApiKey in options or set ANTHROPIC_API_KEY environment variable.'
    );
  }

  return {
    muxTokenId,
    muxTokenSecret,
    openaiApiKey,
    anthropicApiKey,
  };
}

/**
 * Creates a Mux client with validated credentials
 */
export function createMuxClient(credentials: ValidatedCredentials): Mux {
  if (!credentials.muxTokenId || !credentials.muxTokenSecret) {
    throw new Error('Mux credentials are required. Provide muxTokenId and muxTokenSecret in options or set MUX_TOKEN_ID and MUX_TOKEN_SECRET environment variables.');
  }
  return new Mux({
    tokenId: credentials.muxTokenId,
    tokenSecret: credentials.muxTokenSecret,
  });
}

/**
 * Creates an OpenAI client with validated credentials
 */
export function createOpenAIClient(credentials: ValidatedCredentials): OpenAI {
  if (!credentials.openaiApiKey) {
    throw new Error('OpenAI API key is required to create OpenAI client');
  }
  return new OpenAI({
    apiKey: credentials.openaiApiKey,
  });
}

/**
 * Creates an Anthropic client with validated credentials
 */
export function createAnthropicClient(credentials: ValidatedCredentials): Anthropic {
  if (!credentials.anthropicApiKey) {
    throw new Error('Anthropic API key is required to create Anthropic client');
  }
  return new Anthropic({
    apiKey: credentials.anthropicApiKey,
  });
}

/**
 * Factory for creating all necessary clients for a workflow
 */
export interface WorkflowClients {
  mux: Mux;
  openai?: OpenAI;
  anthropic?: Anthropic;
  credentials: ValidatedCredentials;
}

export function createWorkflowClients(
  options: MuxAIOptions,
  provider?: 'openai' | 'anthropic'
): WorkflowClients {
  const credentials = validateCredentials(options, provider);

  const clients: WorkflowClients = {
    mux: createMuxClient(credentials),
    credentials,
  };

  if (provider === 'openai' || credentials.openaiApiKey) {
    clients.openai = createOpenAIClient(credentials);
  }

  if (provider === 'anthropic' || credentials.anthropicApiKey) {
    clients.anthropic = createAnthropicClient(credentials);
  }

  return clients;
}
