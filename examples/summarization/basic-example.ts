import { getSummaryAndTags } from '@mux/ai';
import { config } from 'dotenv';

// Load environment variables from parent directory - override existing
const result = config({ path: '../../.env', override: true });
console.log('Dotenv result:', result.error ? result.error.message : 'SUCCESS');
console.log('Loading from:', '../../.env');

async function main() {
  const assetId = process.argv[2];
  
  if (!assetId) {
    console.log('Usage: npm run basic <asset-id>');
    process.exit(1);
  }

  // Debug: Check if env vars are loaded
  console.log('Debug - Environment variables:');
  console.log('MUX_TOKEN_ID:', process.env.MUX_TOKEN_ID ? `${process.env.MUX_TOKEN_ID.substring(0, 10)}...` : 'NOT SET');
  console.log('MUX_TOKEN_SECRET:', process.env.MUX_TOKEN_SECRET ? `${process.env.MUX_TOKEN_SECRET.substring(0, 10)}...` : 'NOT SET'); 
  console.log('OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? `${process.env.OPENAI_API_KEY.substring(0, 10)}...` : 'NOT SET');
  console.log('Asset ID:', assetId);

  try {
    // Uses the default prompt built into the library
    const result = await getSummaryAndTags(assetId, {
      tone: 'sassy',
      model: 'gpt-4o-mini',
      includeTranscript: true,
      // Credentials can be passed in options or via environment variables
      muxTokenId: process.env.MUX_TOKEN_ID,
      muxTokenSecret: process.env.MUX_TOKEN_SECRET,
      openaiApiKey: process.env.OPENAI_API_KEY,
    });

    console.log('📝 Title:');
    console.log(result.title);
    console.log('\n📋 Description:');
    console.log(result.description);
    console.log('\n🏷️  Tags:');
    console.log(result.tags.join(', '));
    console.log('\n🖼️  Storyboard URL:');
    console.log(result.storyboardUrl);

  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
  }
}

main();