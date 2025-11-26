import 'dotenv/config';
import { getSummaryAndTags } from '@mux/ai/functions';

async function main() {
  const assetId = process.argv[2];
  const customPrompt =
    'Provide a detailed technical analysis of this video, focusing on production quality, visual composition, and any technical elements visible.';

  if (!assetId) {
    console.log('Usage: npm run custom <asset-id>');
    process.exit(1);
  }

  try {
    console.log('🎯 Using a custom prompt to override the default...\n');

    const result = await getSummaryAndTags(assetId, customPrompt, {
      tone: 'professional',
      model: 'gpt-5-mini',
      includeTranscript: true,
    });

    console.log('📋 Custom Analysis:');
    console.log(`Title: ${result.title}`);
    console.log(`Description: ${result.description}`);
    console.log('\n🏷️  Tags:');
    console.log(result.tags.join(', '));
    console.log('\n🖼️  Storyboard URL:');
    console.log(result.storyboardUrl);
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
  }
}

main();