import { describe, it, expect } from 'vitest';
import 'dotenv/config';
import { getModerationScores } from '../../src/moderation';

describe('Moderation Integration Tests', () => {
  const safeAsset = '88Lb01qNUqFJrOFMITk00Ck201F00Qmcbpc5qgopNV4fCOk';
  const violentAsset = 'zYHICEOEbVJIdEfbZZ0048501iJjg9T4SgY00oPVWOaHNU';

  // Define reasonable thresholds for classification
  const VIOLENCE_THRESHOLD = 0.5;
  const SEXUAL_THRESHOLD = 0.5;

  describe('OpenAI provider', () => {
    it('should detect safe content (not violent, not sexual)', async () => {
      const result = await getModerationScores(safeAsset, {
        provider: 'openai',
        model: 'omni-moderation-latest',
        muxTokenId: process.env.MUX_TOKEN_ID,
        muxTokenSecret: process.env.MUX_TOKEN_SECRET,
        openaiApiKey: process.env.OPENAI_API_KEY,
      });

      // Assert that the result exists
      expect(result).toBeDefined();
      expect(result.assetId).toBe(safeAsset);

      // Verify structure
      expect(result).toHaveProperty('maxScores');
      expect(result).toHaveProperty('thumbnailScores');
      expect(result).toHaveProperty('exceedsThreshold');
      expect(result).toHaveProperty('thresholds');

      // Assert not violent and not sexual
      expect(result.maxScores.violence).toBeLessThan(VIOLENCE_THRESHOLD);
      expect(result.maxScores.sexual).toBeLessThan(SEXUAL_THRESHOLD);

      // Verify thumbnail scores exist
      expect(Array.isArray(result.thumbnailScores)).toBe(true);
      expect(result.thumbnailScores.length).toBeGreaterThan(0);
    });

    it('should detect violent content (violent but not sexual)', async () => {
      const result = await getModerationScores(violentAsset, {
        provider: 'openai',
        model: 'omni-moderation-latest',
        muxTokenId: process.env.MUX_TOKEN_ID,
        muxTokenSecret: process.env.MUX_TOKEN_SECRET,
        openaiApiKey: process.env.OPENAI_API_KEY,
      });

      // Assert that the result exists
      expect(result).toBeDefined();
      expect(result.assetId).toBe(violentAsset);

      // Verify structure
      expect(result).toHaveProperty('maxScores');
      expect(result).toHaveProperty('thumbnailScores');

      // Assert violent but not sexual
      expect(result.maxScores.violence).toBeGreaterThan(VIOLENCE_THRESHOLD);
      expect(result.maxScores.sexual).toBeLessThan(SEXUAL_THRESHOLD);

      // Verify thumbnail scores exist
      expect(Array.isArray(result.thumbnailScores)).toBe(true);
      expect(result.thumbnailScores.length).toBeGreaterThan(0);
    });
  });

  describe('Hive provider', () => {
    it('should detect safe content (not violent, not sexual)', async () => {
      const result = await getModerationScores(safeAsset, {
        provider: 'hive',
        muxTokenId: process.env.MUX_TOKEN_ID,
        muxTokenSecret: process.env.MUX_TOKEN_SECRET,
        hiveApiKey: process.env.HIVE_API_KEY,
      });

      // Assert that the result exists
      expect(result).toBeDefined();
      expect(result.assetId).toBe(safeAsset);

      // Verify structure
      expect(result).toHaveProperty('maxScores');
      expect(result).toHaveProperty('thumbnailScores');
      expect(result).toHaveProperty('exceedsThreshold');
      expect(result).toHaveProperty('thresholds');

      // Assert not violent and not sexual
      expect(result.maxScores.violence).toBeLessThan(VIOLENCE_THRESHOLD);
      expect(result.maxScores.sexual).toBeLessThan(SEXUAL_THRESHOLD);

      // Verify thumbnail scores exist
      expect(Array.isArray(result.thumbnailScores)).toBe(true);
      expect(result.thumbnailScores.length).toBeGreaterThan(0);
    });

    it('should detect violent content (violent but not sexual)', async () => {
      const result = await getModerationScores(violentAsset, {
        provider: 'hive',
        muxTokenId: process.env.MUX_TOKEN_ID,
        muxTokenSecret: process.env.MUX_TOKEN_SECRET,
        hiveApiKey: process.env.HIVE_API_KEY,
      });

      // Assert that the result exists
      expect(result).toBeDefined();
      expect(result.assetId).toBe(violentAsset);

      // Verify structure
      expect(result).toHaveProperty('maxScores');
      expect(result).toHaveProperty('thumbnailScores');

      // Assert violent but not sexual
      expect(result.maxScores.violence).toBeGreaterThan(VIOLENCE_THRESHOLD);
      expect(result.maxScores.sexual).toBeLessThan(SEXUAL_THRESHOLD);

      // Verify thumbnail scores exist
      expect(Array.isArray(result.thumbnailScores)).toBe(true);
      expect(result.thumbnailScores.length).toBeGreaterThan(0);
    });
  });
});
