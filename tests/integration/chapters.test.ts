import { describe, it, expect } from 'vitest';
import 'dotenv/config';
import { generateChapters } from '../../src/chapters';

describe('Chapters Integration Tests', () => {
  it('should generate chapters for a known asset without errors', async () => {
    const assetId = 'ICwSGuYvLIHR00km1NMX00GH3le7wknGPx';
    const languageCode = 'en';

    const result = await generateChapters(assetId, languageCode, {
      provider: 'openai',
      muxTokenId: process.env.MUX_TOKEN_ID,
      muxTokenSecret: process.env.MUX_TOKEN_SECRET,
      openaiApiKey: process.env.OPENAI_API_KEY,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    });

    // Assert that the result exists
    expect(result).toBeDefined();

    // Assert that chapters array exists
    expect(result.chapters).toBeDefined();
    expect(Array.isArray(result.chapters)).toBe(true);

    // Assert that at least one chapter was generated
    expect(result.chapters.length).toBeGreaterThan(0);

    // Verify chapter structure
    result.chapters.forEach((chapter) => {
      expect(chapter).toHaveProperty('startTime');
      expect(chapter).toHaveProperty('title');
      expect(typeof chapter.startTime).toBe('number');
      expect(typeof chapter.title).toBe('string');
    });
  });
});
