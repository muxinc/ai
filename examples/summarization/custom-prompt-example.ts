import 'dotenv/config';
import { getSummaryAndTags } from '@mux/ai';

async function main() {
  const assetId = 'your-mux-asset-id-here';
  const customPrompt = 'Provide a detailed technical analysis of this video, focusing on production quality, visual composition, and any technical elements visible.';

  try {
    console.log('🎯 Using a custom prompt to override the default...\n');
    
    // Override the default prompt with a custom one
    const result = await getSummaryAndTags(assetId, customPrompt, {
      tone: 'professional',
      model: 'gpt-4o-mini',
      includeTranscript: true,
    });

    console.log('📋 Custom Analysis:');
    console.log(result.summary);
    console.log('\n🏷️  Tags:');
    console.log(result.tags.join(', '));
    console.log('\n🖼️  Storyboard URL:');
    console.log(result.storyboardUrl);

  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
  }
}

main();