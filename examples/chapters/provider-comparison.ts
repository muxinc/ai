import 'dotenv/config';
import { generateChapters } from '../../src/chapters';


async function main() {
  const assetId = process.argv[2];
  const languageCode = process.argv[3] || 'en';

  if (!assetId) {
    console.log('Usage: npm run example:moderation:compare <asset-id> [language-code]');
    console.log('Example: npm run example:moderation:compare ICwSGuYvLIHR00km1NMX00GH3le7wknGPx en');
    process.exit(1);
  }

  console.log(`🎯 Comparing chapter generation for asset: ${assetId}`);
  console.log(`📝 Language: ${languageCode}\n`);

  try {
    console.log('1️⃣ Testing OpenAI chapter generation...');
    const openaiStart = Date.now();
    const openaiResult = await generateChapters(assetId, languageCode, {
      provider: 'openai'
    });
    const openaiDuration = Date.now() - openaiStart;

    console.log('📊 OpenAI Results:');
    console.log(`  Duration: ${openaiDuration}ms`);
    console.log(`  Generated chapters: ${openaiResult.chapters.length}`);
    console.log('  Chapter breakdown:');
    openaiResult.chapters.forEach((chapter, index) => {
      const minutes = Math.floor(chapter.startTime / 60);
      const seconds = Math.floor(chapter.startTime % 60);
      console.log(`    ${index + 1}. ${minutes}:${seconds.toString().padStart(2, '0')} - ${chapter.title}`);
    });
    console.log();

    console.log('2️⃣ Testing Anthropic chapter generation...');
    const anthropicStart = Date.now();
    const anthropicResult = await generateChapters(assetId, languageCode, {
      provider: 'anthropic'
    });
    const anthropicDuration = Date.now() - anthropicStart;

    console.log('📊 Anthropic Results:');
    console.log(`  Duration: ${anthropicDuration}ms`);
    console.log(`  Generated chapters: ${anthropicResult.chapters.length}`);
    console.log('  Chapter breakdown:');
    anthropicResult.chapters.forEach((chapter, index) => {
      const minutes = Math.floor(chapter.startTime / 60);
      const seconds = Math.floor(chapter.startTime % 60);
      console.log(`    ${index + 1}. ${minutes}:${seconds.toString().padStart(2, '0')} - ${chapter.title}`);
    });

    console.log('\n🏁 Provider Comparison:');
    console.log(`OpenAI chapters:    ${openaiResult.chapters.length}`);
    console.log(`Anthropic chapters: ${anthropicResult.chapters.length}`);
    console.log(`Speed comparison:   OpenAI ${openaiDuration}ms vs Anthropic ${anthropicDuration}ms`);

    // Compare chapter titles for similarity
    const commonTopics = new Set();
    const openaiTitles = openaiResult.chapters.map(c => c.title.toLowerCase());
    const anthropicTitles = anthropicResult.chapters.map(c => c.title.toLowerCase());

    openaiTitles.forEach(title => {
      anthropicTitles.forEach(anthropicTitle => {
        // Simple keyword overlap check
        const openaiWords = title.split(' ').filter(w => w.length > 3);
        const anthropicWords = anthropicTitle.split(' ').filter(w => w.length > 3);
        const overlap = openaiWords.filter(word => anthropicWords.includes(word));
        if (overlap.length > 1) {
          commonTopics.add(overlap.join(' '));
        }
      });
    });

    if (commonTopics.size > 0) {
      console.log(`🤝 Common topics found: ${Array.from(commonTopics).join(', ')}`);
    } else {
      console.log('🤔 No obvious common topics detected - providers may have different approaches');
    }

  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();