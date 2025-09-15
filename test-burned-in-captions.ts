import { hasBurnedInCaptions } from './src/burned-in-captions';
import { config } from 'dotenv';

const result = config({ path: '.env', override: true });
console.log('Dotenv result:', result.error ? result.error.message : 'SUCCESS');

async function testBurnedInCaptions() {
  // Get asset ID from command line argument or use default
  const assetId = process.argv[2] || 'ICwSGuYvLIHR00km1NMX00GH3le7wknGPx';
  
  console.log(`🔍 Testing burned-in caption detection for asset: ${assetId}\n`);
  
  try {
    console.log('1️⃣ Testing OpenAI burned-in caption detection...');
    const openaiStart = Date.now();
    const openaiResult = await hasBurnedInCaptions(assetId, {
      provider: 'openai'
    });
    const openaiDuration = Date.now() - openaiStart;
    
    console.log('📊 OpenAI Results:');
    console.log(`  Duration: ${openaiDuration}ms`);
    console.log(`  Has burned-in captions: ${openaiResult.hasBurnedInCaptions}`);
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
    console.log(`  Has burned-in captions: ${anthropicResult.hasBurnedInCaptions}`);
    console.log(`  Confidence: ${(anthropicResult.confidence * 100).toFixed(1)}%`);
    console.log(`  Detected language: ${anthropicResult.detectedLanguage || 'N/A'}`);
    console.log(`  Storyboard URL: ${anthropicResult.storyboardUrl}`);
    
    console.log('\n🏁 Summary:');
    console.log(`OpenAI:    ${openaiResult.hasBurnedInCaptions ? '✅' : '❌'} burned-in captions (${(openaiResult.confidence * 100).toFixed(1)}% confidence)`);
    console.log(`Anthropic: ${anthropicResult.hasBurnedInCaptions ? '✅' : '❌'} burned-in captions (${(anthropicResult.confidence * 100).toFixed(1)}% confidence)`);
    
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
  }
}

testBurnedInCaptions().catch(console.error);