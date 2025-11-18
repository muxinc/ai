import { hasBurnedInCaptions } from '../../src/burned-in-captions';
import { config } from 'dotenv';

// Load environment variables from project root
const result = config({ path: '.env', override: true });
console.log('Dotenv result:', result.error ? result.error.message : 'SUCCESS');

async function main() {
  const assetId = process.argv[2];

  if (!assetId) {
    console.log('Usage: npm run example:moderation:compare <asset-id>');
    console.log('Example: npm run example:moderation:compare ICwSGuYvLIHR00km1NMX00GH3le7wknGPx');
    process.exit(1);
  }

  console.log(`🔍 Comparing burned-in caption detection for asset: ${assetId}\n`);

  try {
    console.log('1️⃣ Testing OpenAI burned-in caption detection...');
    const openaiStart = Date.now();
    const openaiResult = await hasBurnedInCaptions(assetId, {
      provider: 'openai'
    });
    const openaiDuration = Date.now() - openaiStart;

    console.log('📊 OpenAI Results:');
    console.log(`  Duration: ${openaiDuration}ms`);
    console.log(`  Has burned-in captions: ${openaiResult.hasBurnedInCaptions ? '✅ YES' : '❌ NO'}`);
    console.log(`  Confidence: ${(openaiResult.confidence * 100).toFixed(1)}%`);
    console.log(`  Detected language: ${openaiResult.detectedLanguage || 'N/A'}`);
    console.log(`  Storyboard URL: ${openaiResult.storyboardUrl}`);
    console.log();

    console.log('2️⃣ Testing Anthropic burned-in caption detection...');
    const anthropicStart = Date.now();
    const anthropicResult = await hasBurnedInCaptions(assetId, {
      provider: 'anthropic'
    });
    const anthropicDuration = Date.now() - anthropicStart;

    console.log('📊 Anthropic Results:');
    console.log(`  Duration: ${anthropicDuration}ms`);
    console.log(`  Has burned-in captions: ${anthropicResult.hasBurnedInCaptions ? '✅ YES' : '❌ NO'}`);
    console.log(`  Confidence: ${(anthropicResult.confidence * 100).toFixed(1)}%`);
    console.log(`  Detected language: ${anthropicResult.detectedLanguage || 'N/A'}`);
    console.log(`  Storyboard URL: ${anthropicResult.storyboardUrl}`);

    console.log('\n🏁 Provider Comparison:');
    console.log(`OpenAI:    ${openaiResult.hasBurnedInCaptions ? '✅' : '❌'} burned-in captions (${(openaiResult.confidence * 100).toFixed(1)}% confidence)`);
    console.log(`Anthropic: ${anthropicResult.hasBurnedInCaptions ? '✅' : '❌'} burned-in captions (${(anthropicResult.confidence * 100).toFixed(1)}% confidence)`);

    // Analysis
    const agreement = openaiResult.hasBurnedInCaptions === anthropicResult.hasBurnedInCaptions;
    console.log(`\n🤝 Provider Agreement: ${agreement ? '✅ AGREE' : '❌ DISAGREE'}`);

    if (!agreement) {
      console.log('   Consider manually reviewing the storyboard to determine ground truth.');
      console.log(`   Storyboard: ${openaiResult.storyboardUrl}`);
    }

    const avgConfidence = (openaiResult.confidence + anthropicResult.confidence) / 2;
    console.log(`📊 Average Confidence: ${(avgConfidence * 100).toFixed(1)}%`);

  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();