export interface MuxAIConfig {
  muxTokenId?: string;
  muxTokenSecret?: string;
  openaiApiKey?: string;
  baseUrl?: string;
}

export interface MuxAIOptions extends MuxAIConfig {
  timeout?: number;
}

export type ToneType = 'normal' | 'sassy' | 'professional';