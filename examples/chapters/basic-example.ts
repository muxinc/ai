import { generateChapters } from '../../src/chapters';
import { config } from 'dotenv';

// Load environment variables from project root
const result = config({ path: '.env', override: true });
console.log('Dotenv result:', result.error ? result.error.message : 'SUCCESS');

async function main() {
  const assetId = process.argv[2];
  const languageCode = process.argv[3] || 'en';
  const provider = process.argv[4] as 'openai' | 'anthropic' || 'openai';
  
  if (!assetId) {
    console.log('Usage: npm run example:chapters <asset-id> [language-code] [provider]');
    console.log('Example: npm run example:chapters ICwSGuYvLIHR00km1NMX00GH3le7wknGPx en openai');
    process.exit(1);
  }

  console.log(`🎯 Generating chapters for asset: ${assetId}`);
  console.log(`📝 Language: ${languageCode}`);
  console.log(`🤖 Provider: ${provider}\n`);

  try {
    const start = Date.now();
    
    const result = await generateChapters(assetId, languageCode, {
      provider,
      // Credentials from environment variables
      muxTokenId: process.env.MUX_TOKEN_ID,
      muxTokenSecret: process.env.MUX_TOKEN_SECRET,
      openaiApiKey: process.env.OPENAI_API_KEY,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    });

    const duration = Date.now() - start;

    console.log('✅ Success!');
    console.log(`⏱️  Duration: ${duration}ms`);
    console.log(`📊 Generated ${result.chapters.length} chapters\n`);

    console.log('📋 Chapter List:');
    result.chapters.forEach((chapter, i) => {
      const minutes = Math.floor(chapter.startTime / 60);
      const seconds = Math.floor(chapter.startTime % 60);
      console.log(`  ${i + 1}. ${minutes}:${seconds.toString().padStart(2, '0')} - ${chapter.title}`);
    });

    console.log('\n🎬 Mux Player Format:');
    console.log(JSON.stringify(result.chapters, null, 2));

  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();