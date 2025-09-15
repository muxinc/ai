import { hasBurnedInCaptions } from '../../src/burned-in-captions';
import { config } from 'dotenv';

// Load environment variables from project root
const result = config({ path: '.env', override: true });
console.log('Dotenv result:', result.error ? result.error.message : 'SUCCESS');

async function main() {
  const assetId = process.argv[2];
  const provider = process.argv[3] as 'openai' | 'anthropic' || 'openai';
  
  if (!assetId) {
    console.log('Usage: npm run burned-in:basic <asset-id> [provider]');
    console.log('Example: npm run burned-in:basic ICwSGuYvLIHR00km1NMX00GH3le7wknGPx openai');
    process.exit(1);
  }

  console.log(`🔍 Detecting burned-in captions for asset: ${assetId}`);
  console.log(`🤖 Provider: ${provider}\n`);

  try {
    const start = Date.now();
    
    const result = await hasBurnedInCaptions(assetId, {
      provider,
      // Credentials from environment variables
      muxTokenId: process.env.MUX_TOKEN_ID,
      muxTokenSecret: process.env.MUX_TOKEN_SECRET,
      openaiApiKey: process.env.OPENAI_API_KEY,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    });

    const duration = Date.now() - start;

    console.log('📊 Analysis Results:');
    console.log(`⏱️  Duration: ${duration}ms`);
    console.log(`🔤 Has burned-in captions: ${result.hasBurnedInCaptions ? '✅ YES' : '❌ NO'}`);
    console.log(`📈 Confidence: ${(result.confidence * 100).toFixed(1)}%`);
    console.log(`🌐 Detected language: ${result.detectedLanguage || 'Not detected'}`);
    console.log(`🖼️  Storyboard URL: ${result.storyboardUrl}`);

    if (result.hasBurnedInCaptions) {
      console.log('\n✨ This video appears to have burned-in captions!');
      if (result.detectedLanguage) {
        console.log(`   Language detected: ${result.detectedLanguage}`);
      }
      console.log('   Consider this when processing captions or accessibility features.');
    } else {
      console.log('\n📝 No burned-in captions detected.');
      console.log('   This video likely uses separate caption tracks or no captions.');
    }

  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();