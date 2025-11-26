import 'dotenv/config';
import { Command } from 'commander';
import { translateAudio } from '@mux/ai/functions';

const program = new Command();

program
  .name('translate-audio')
  .description('Translate audio (dubbing) for a Mux video asset')
  .argument('<asset-id>', 'Mux asset ID to translate')
  .option('-t, --to <language>', 'Target language code', 'es')
  .option('-s, --speakers <number>', 'Number of speakers (0 for auto-detect)', '0')
  .option('--no-upload', 'Skip uploading translated audio to Mux (returns presigned URL only)')
  .addHelpText('after', `
Notes:
  - Asset must have an audio.m4a static rendition
  - Uses default audio track, source language is auto-detected
  - Provider is ElevenLabs (currently the only supported audio translation provider)`)
  .action(async (assetId: string, options: {
    to: string;
    speakers: string;
    upload: boolean;
  }) => {
    const numSpeakers = parseInt(options.speakers, 10);

    if (isNaN(numSpeakers) || numSpeakers < 0) {
      console.error('❌ Invalid number of speakers. Must be a non-negative integer.');
      process.exit(1);
    }

    console.log(`Asset ID: ${assetId}`);
    console.log(`Audio Dubbing: auto-detect -> ${options.to}`);
    console.log(`Number of Speakers: ${numSpeakers === 0 ? 'auto-detect' : numSpeakers}`);
    console.log(`Upload to Mux: ${options.upload}\n`);

    try {
      console.log('🎙️ Starting audio dubbing...\n');

      const result = await translateAudio(assetId, options.to, {
        provider: 'elevenlabs',
        numSpeakers,
        uploadToMux: options.upload
      });

      console.log('\n📊 Audio Dubbing Results:');
      console.log(`Target Language: ${result.targetLanguageCode}`);
      console.log(`Asset ID: ${result.assetId}`);
      console.log(`ElevenLabs Dubbing ID: ${result.dubbingId}`);

      if (result.uploadedTrackId) {
        console.log(`🎬 Mux Audio Track ID: ${result.uploadedTrackId}`);
      }

      if (result.presignedUrl) {
        console.log(`🔗 Presigned URL: ${result.presignedUrl.substring(0, 80)}...`);
      }

      console.log('\n✅ Audio dubbing completed successfully!');

    } catch (error) {
      console.error('❌ Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();