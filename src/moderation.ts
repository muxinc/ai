import { MuxAIOptions } from './types';

export interface ModerationScore {
  category: string;
  score: number;
  flagged: boolean;
}

export interface ModerationResult {
  assetId: string;
  scores: ModerationScore[];
  overallFlagged: boolean;
}

export interface ModerationOptions extends MuxAIOptions {
  provider?: 'anthropic' | 'openai';
  model?: string;
  categories?: string[];
}

export async function getModerationScores(
  assetId: string,
  options: ModerationOptions = {}
): Promise<ModerationResult> {
  const { provider = 'anthropic', model, ...config } = options;
  
  // TODO: Implement moderation logic
  throw new Error('getModerationScores not implemented yet');
}