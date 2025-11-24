import 'dotenv/config';
import { getModerationScores } from '@mux/ai/primitives';

const usage = `
Usage: npm run hive <asset-id> [submission-mode]

Arguments:
  asset-id         Required. Mux asset with a public playback ID.
  submission-mode  Optional. 'url' (default) or 'base64' to demonstrate Hive uploads.

Environment:
  MUX_TOKEN_ID, MUX_TOKEN_SECRET, HIVE_API_KEY must be set.
`;

async function main() {
  const assetId = process.argv[2];
  const submissionModeArg = process.argv[3];
  const submissionMode = submissionModeArg === 'base64' ? 'base64' : 'url';

  if (!assetId) {
    console.log(usage.trim());
    process.exit(1);
  }

  const hiveKey = process.env.HIVE_API_KEY;
  if (!hiveKey) {
    console.error('Missing HIVE_API_KEY. Please set it in your environment before running this example.');
    process.exit(1);
  }

  console.log(`🔐 Hive API key detected (${hiveKey.slice(0, 6)}…)\n`);
  console.log(`🎬 Target asset: ${assetId}`);
  console.log(`🛠️  Submission mode: ${submissionMode}\n`);

  try {
    console.log('🚀 Requesting Hive moderation scores...\n');
    const result = await getModerationScores(assetId, {
      provider: 'hive',
      thresholds: {
        sexual: 0.9,
        violence: 0.9,
      },
      hiveApiKey: hiveKey,
      imageSubmissionMode: submissionMode,
      // Lower concurrency to avoid hitting API rate limits for demos.
      maxConcurrent: 3,
    });

    console.log('📊 Hive Moderation Summary');
    console.log(`  Sexual score:   ${result.maxScores.sexual.toFixed(3)}`);
    console.log(`  Violence score: ${result.maxScores.violence.toFixed(3)}`);
    console.log(`  Flagged:        ${result.exceedsThreshold ? '⚠️  YES' : '✅ NO'}`);
    console.log(`  Thresholds:     sexual ${result.thresholds.sexual}, violence ${result.thresholds.violence}`);
    console.log(`  Thumbnails:     ${result.thumbnailScores.length}`);

    console.log('\n🔎 Per-thumbnail breakdown:');
    result.thumbnailScores.forEach((thumb, index) => {
      const status = thumb.error ? 'error' : 'ok';
      console.log(
        `  ${index + 1}. sexual=${thumb.sexual.toFixed(3)} | violence=${thumb.violence.toFixed(3)} (${status})`
      );
    });

    console.log('\n✅ Done.');
  } catch (error) {
    console.error('❌ Hive moderation example failed:');
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();

