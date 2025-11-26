import 'dotenv/config';
import { Command } from 'commander';
import { translateAudio } from '@mux/ai/functions';

const program = new Command();

program
  .name('dubbing-only')
  .description('Create ElevenLabs dubbing without uploading to Mux')
  .argument('<asset-id>', 'Mux asset ID to translate')
  .option('-t, --to <language>', 'Target language code', 'es')
  .option('-s, --speakers <number>', 'Number of speakers (0 for auto-detect)', '0')
  .addHelpText('after', `
Notes:
  - This will only create the ElevenLabs dubbing job, not upload to Mux
  - Asset must have an audio.m4a static rendition
  - Uses default audio track, source language is auto-detected
  - To download the dubbed audio, use the ElevenLabs dashboard or API`)
  .action(async (assetId: string, options: {
    to: string;
    speakers: string;
  }) => {
    const numSpeakers = parseInt(options.speakers, 10);

    if (isNaN(numSpeakers) || numSpeakers < 0) {
      console.error('❌ Invalid number of speakers. Must be a non-negative integer.');
      process.exit(1);
    }

    console.log(`Asset ID: ${assetId}`);
    console.log(`Audio Dubbing: auto-detect -> ${options.to} (dubbing only)`);
    console.log(`Number of Speakers: ${numSpeakers === 0 ? 'auto-detect' : numSpeakers}\n`);

    try {
      console.log('🎙️ Starting ElevenLabs dubbing (no upload to Mux)...\n');

      const result = await translateAudio(assetId, options.to, {
        provider: 'elevenlabs',
        numSpeakers,
        uploadToMux: false // Only dub, don't upload
      });

      console.log('\n📊 Audio Dubbing Results:');
      console.log(`Target Language: ${result.targetLanguageCode}`);
      console.log(`Asset ID: ${result.assetId}`);
      console.log(`ElevenLabs Dubbing ID: ${result.dubbingId}`);

      console.log('\n✅ ElevenLabs dubbing completed successfully!');
      console.log('💡 To download the dubbed audio, use the ElevenLabs dashboard or API');

    } catch (error) {
      console.error('❌ Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
