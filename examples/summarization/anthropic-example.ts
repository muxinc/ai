import 'dotenv/config';
import { getSummaryAndTags } from '@mux/ai';


async function main() {
  const assetId = process.argv[2];
  
  if (!assetId) {
    console.log('Usage: npm run anthropic <asset-id>');
    process.exit(1);
  }

  // Debug: Check if env vars are loaded
  console.log('Debug - Environment variables:');
  console.log('MUX_TOKEN_ID:', process.env.MUX_TOKEN_ID ? `${process.env.MUX_TOKEN_ID.substring(0, 10)}...` : 'NOT SET');
  console.log('MUX_TOKEN_SECRET:', process.env.MUX_TOKEN_SECRET ? `${process.env.MUX_TOKEN_SECRET.substring(0, 10)}...` : 'NOT SET'); 
  console.log('ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? `${process.env.ANTHROPIC_API_KEY.substring(0, 10)}...` : 'NOT SET');
  console.log('Asset ID:', assetId);

  try {
    // Uses the default prompt with Anthropic provider
    const result = await getSummaryAndTags(assetId, {
      provider: 'anthropic',
      model: 'claude-3-5-haiku-20241022',
      tone: 'sassy',
      includeTranscript: true,
    });

    console.log('🤖 Anthropic Analysis Results:');
    console.log('📝 Title:');
    console.log(result.title);
    console.log('\n📋 Description:');
    console.log(result.description);
    console.log('\n🏷️  Tags:');
    console.log(result.tags.join(', '));
    console.log('\n🖼️  Storyboard URL:');
    console.log(result.storyboardUrl);
    console.log('\n📦 Asset ID:', result.assetId);

  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
  }
}

main();