import { getSummaryAndTags, ToneType } from '@mux/ai';

async function demonstrateToneVariations(assetId: string) {
  const tones: ToneType[] = ['normal', 'sassy', 'professional'];

  console.log('🎭 Demonstrating different tone variations for video analysis...\n');
  console.log('Using the built-in default prompt with different tones.\n');

  for (const tone of tones) {
    try {
      console.log(`\n--- ${tone.toUpperCase()} TONE ---`);
      
      // Uses the default prompt built into the library
      const result = await getSummaryAndTags(assetId, {
        tone,
        model: 'gpt-4o-mini',
        includeTranscript: true,
      });

      console.log(`Summary: ${result.summary}`);
      console.log(`Tags: ${result.tags.join(', ')}`);
      console.log('---\n');

    } catch (error) {
      console.error(`❌ Error with ${tone} tone:`, error instanceof Error ? error.message : error);
    }
  }
}

async function main() {
  const assetId = process.argv[2];
  
  if (!assetId) {
    console.log('Usage: npx ts-node tone-variations.ts <asset-id>');
    process.exit(1);
  }

  await demonstrateToneVariations(assetId);
}

main();