import { describe, it, expect } from 'vitest';
import 'dotenv/config';
import { getSummaryAndTags } from '../../src/summarization';

describe('Summarization Integration Tests', () => {
  const assetId = '88Lb01qNUqFJrOFMITk00Ck201F00Qmcbpc5qgopNV4fCOk';

  it('should generate summary and tags with OpenAI provider', async () => {
    const result = await getSummaryAndTags(assetId, {
      provider: 'openai',
      tone: 'normal',
      includeTranscript: true,
      muxTokenId: process.env.MUX_TOKEN_ID,
      muxTokenSecret: process.env.MUX_TOKEN_SECRET,
      openaiApiKey: process.env.OPENAI_API_KEY,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    });

    // Assert that the result exists
    expect(result).toBeDefined();

    // Verify structure
    expect(result).toHaveProperty('assetId');
    expect(result).toHaveProperty('title');
    expect(result).toHaveProperty('description');
    expect(result).toHaveProperty('tags');

    // Verify assetId matches
    expect(result.assetId).toBe(assetId);

    // Verify title
    expect(typeof result.title).toBe('string');
    expect(result.title.length).toBeGreaterThan(0);
    expect(result.title.length).toBeLessThanOrEqual(100);

    // Verify description
    expect(typeof result.description).toBe('string');
    expect(result.description.length).toBeGreaterThan(0);
    expect(result.description.length).toBeLessThanOrEqual(1000);

    // Verify tags
    expect(Array.isArray(result.tags)).toBe(true);
    expect(result.tags.length).toBeGreaterThan(0);
    result.tags.forEach((tag) => {
      expect(typeof tag).toBe('string');
    });
  });

  it('should generate summary and tags with Anthropic provider', async () => {
    const result = await getSummaryAndTags(assetId, {
      provider: 'anthropic',
      tone: 'normal',
      includeTranscript: true,
      muxTokenId: process.env.MUX_TOKEN_ID,
      muxTokenSecret: process.env.MUX_TOKEN_SECRET,
      openaiApiKey: process.env.OPENAI_API_KEY,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    });

    // Assert that the result exists
    expect(result).toBeDefined();

    // Verify structure
    expect(result).toHaveProperty('assetId');
    expect(result).toHaveProperty('title');
    expect(result).toHaveProperty('description');
    expect(result).toHaveProperty('tags');

    // Verify assetId matches
    expect(result.assetId).toBe(assetId);

    // Verify title
    expect(typeof result.title).toBe('string');
    expect(result.title.length).toBeGreaterThan(0);
    expect(result.title.length).toBeLessThanOrEqual(100);

    // Verify description
    expect(typeof result.description).toBe('string');
    expect(result.description.length).toBeGreaterThan(0);
    expect(result.description.length).toBeLessThanOrEqual(1000);

    // Verify tags
    expect(Array.isArray(result.tags)).toBe(true);
    expect(result.tags.length).toBeGreaterThan(0);
    result.tags.forEach((tag) => {
      expect(typeof tag).toBe('string');
    });
  });
});
