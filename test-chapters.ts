import { generateChapters } from './src/chapters';
import { config } from 'dotenv';

const result = config({ path: '.env', override: true });
console.log('Dotenv result:', result.error ? result.error.message : 'SUCCESS');

async function testChapters() {
  // Test with the asset that has captions
  const assetId = 'ICwSGuYvLIHR00km1NMX00GH3le7wknGPx';
  const languageCode = 'en'; // Assuming English captions
  
  console.log(`🎯 Testing chapter generation for asset: ${assetId}`);
  console.log(`📝 Using language: ${languageCode}\n`);
  
  try {
    console.log('1️⃣ Testing OpenAI chapter generation...');
    const openaiStart = Date.now();
    const openaiResult = await generateChapters(assetId, languageCode, {
      provider: 'openai'
    });
    const openaiDuration = Date.now() - openaiStart;
    
    console.log('📊 OpenAI Results:');
    console.log(`  Duration: ${openaiDuration}ms`);
    console.log(`  Chapters: ${openaiResult.chapters.length}`);
    console.log('  Chapter list:');
    openaiResult.chapters.forEach((chapter, i) => {
      const minutes = Math.floor(chapter.startTime / 60);
      const seconds = Math.floor(chapter.startTime % 60);
      console.log(`    ${i + 1}. ${minutes}:${seconds.toString().padStart(2, '0')} - ${chapter.title}`);
    });
    console.log('\n  Mux Player format:');
    console.log(JSON.stringify(openaiResult.chapters, null, 2));
    console.log();
    
    console.log('2️⃣ Testing Anthropic chapter generation...');
    const anthropicStart = Date.now();
    const anthropicResult = await generateChapters(assetId, languageCode, {
      provider: 'anthropic'
    });
    const anthropicDuration = Date.now() - anthropicStart;
    
    console.log('📊 Anthropic Results:');
    console.log(`  Duration: ${anthropicDuration}ms`);
    console.log(`  Chapters: ${anthropicResult.chapters.length}`);
    console.log('  Chapter list:');
    anthropicResult.chapters.forEach((chapter, i) => {
      const minutes = Math.floor(chapter.startTime / 60);
      const seconds = Math.floor(chapter.startTime % 60);
      console.log(`    ${i + 1}. ${minutes}:${seconds.toString().padStart(2, '0')} - ${chapter.title}`);
    });
    console.log('\n  Mux Player format:');
    console.log(JSON.stringify(anthropicResult.chapters, null, 2));
    
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
  }
}

testChapters().catch(console.error);