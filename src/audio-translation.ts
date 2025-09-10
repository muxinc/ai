import Mux from '@mux/mux-node';
// Using direct HTTP requests instead of SDK for better compatibility
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { MuxAIOptions } from './types';

export interface AudioTranslationResult {
  assetId: string;
  targetLanguageCode: string;
  dubbingId: string;
  uploadedTrackId?: string;
  presignedUrl?: string;
}

export interface AudioTranslationOptions extends MuxAIOptions {
  provider?: 'elevenlabs';
  numSpeakers?: number;
  s3Endpoint?: string;
  s3Region?: string;
  s3Bucket?: string;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
  uploadToMux?: boolean;
  elevenLabsApiKey?: string;
}

export async function translateAudio(
  assetId: string,
  toLanguageCode: string,
  options: AudioTranslationOptions = {}
): Promise<AudioTranslationResult> {
  // Uses the default audio track on your asset, language is auto-detected by ElevenLabs
  const {
    provider = 'elevenlabs',
    numSpeakers = 0, // 0 = auto-detect
    muxTokenId,
    muxTokenSecret,
    elevenLabsApiKey,
    uploadToMux = true,
    ...config
  } = options;

  if (provider !== 'elevenlabs') {
    throw new Error('Only ElevenLabs provider is currently supported for audio translation');
  }

  // Validate required credentials
  const muxId = muxTokenId || process.env.MUX_TOKEN_ID;
  const muxSecret = muxTokenSecret || process.env.MUX_TOKEN_SECRET;
  const elevenLabsKey = elevenLabsApiKey || process.env.ELEVENLABS_API_KEY;
  
  // S3 configuration
  const s3Endpoint = options.s3Endpoint || process.env.S3_ENDPOINT;
  const s3Region = options.s3Region || process.env.S3_REGION || 'auto';
  const s3Bucket = options.s3Bucket || process.env.S3_BUCKET;
  const s3AccessKeyId = options.s3AccessKeyId || process.env.S3_ACCESS_KEY_ID;
  const s3SecretAccessKey = options.s3SecretAccessKey || process.env.S3_SECRET_ACCESS_KEY;

  if (!muxId || !muxSecret) {
    throw new Error('Mux credentials are required. Provide muxTokenId and muxTokenSecret in options or set MUX_TOKEN_ID and MUX_TOKEN_SECRET environment variables.');
  }

  if (!elevenLabsKey) {
    throw new Error('ElevenLabs API key is required. Provide elevenLabsApiKey in options or set ELEVENLABS_API_KEY environment variable.');
  }
  
  if (uploadToMux && (!s3Endpoint || !s3Bucket || !s3AccessKeyId || !s3SecretAccessKey)) {
    throw new Error('S3 configuration is required for uploading to Mux. Provide s3Endpoint, s3Bucket, s3AccessKeyId, and s3SecretAccessKey in options or set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY environment variables.');
  }

  // Initialize clients
  const mux = new Mux({
    tokenId: muxId,
    tokenSecret: muxSecret,
  });

  // Fetch asset data from Mux
  console.log(`🎬 Fetching Mux asset: ${assetId}`);
  let assetData;
  try {
    const asset = await mux.video.assets.retrieve(assetId);
    assetData = asset;
  } catch (error) {
    throw new Error(`Failed to fetch asset from Mux: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  // Check for audio-only static rendition
  console.log('🔍 Checking for audio-only static rendition...');
  
  if (!assetData.static_renditions || !assetData.static_renditions.files) {
    throw new Error('No static renditions found for this asset');
  }

  const staticRenditionFiles = assetData.static_renditions.files as any[];

  if (staticRenditionFiles.length === 0) {
    throw new Error('No static rendition files found for this asset');
  }

  const audioRendition = staticRenditionFiles.find((rendition: any) => 
    rendition.name === 'audio.m4a' && rendition.status === 'ready'
  );

  if (!audioRendition) {
    throw new Error('No ready audio-only static rendition found for this asset. Please ensure the asset has an audio.m4a static rendition.');
  }

  const audioUrl = `https://stream.mux.com/${assetData.playback_ids?.[0]?.id}/audio.m4a`;
  console.log(`✅ Found audio rendition: ${audioUrl}`);

  // Create dubbing job in ElevenLabs
  console.log(`🎙️ Creating ElevenLabs dubbing job (auto-detect → ${toLanguageCode})`);
  
  let dubbingId: string;
  
  try {
    // Fetch audio file and create dubbing job
    const audioResponse = await fetch(audioUrl);
    if (!audioResponse.ok) {
      throw new Error(`Failed to fetch audio file: ${audioResponse.statusText}`);
    }
    
    const audioBuffer = await audioResponse.arrayBuffer();
    const audioBlob = new Blob([audioBuffer], { type: 'audio/mp4' });
    const audioFile = audioBlob as any; // ElevenLabs accepts Blob
    
    // Create dubbing job using direct HTTP request
    const formData = new FormData();
    formData.append('file', audioFile);
    formData.append('target_lang', toLanguageCode);
    // Note: source_lang is omitted to enable automatic language detection
    formData.append('num_speakers', numSpeakers.toString());
    formData.append('name', `Mux Asset ${assetId} - auto to ${toLanguageCode}`);
    
    const dubbingResponse = await fetch('https://api.elevenlabs.io/v1/dubbing', {
      method: 'POST',
      headers: {
        'xi-api-key': elevenLabsKey!
      },
      body: formData
    });
    
    if (!dubbingResponse.ok) {
      throw new Error(`ElevenLabs API error: ${dubbingResponse.statusText}`);
    }
    
    const dubbingData = await dubbingResponse.json() as any;
    
    dubbingId = dubbingData.dubbing_id;
    console.log(`✅ Dubbing job created: ${dubbingId}`);
    console.log(`⏱️ Expected duration: ${dubbingData.expected_duration_sec}s`);
    
  } catch (error) {
    throw new Error(`Failed to create ElevenLabs dubbing job: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  // Poll for completion
  console.log('⏳ Waiting for dubbing to complete...');
  
  let dubbingStatus: string = 'dubbing';
  let pollAttempts = 0;
  const maxPollAttempts = 180; // 30 minutes at 10s intervals
  
  while (dubbingStatus === 'dubbing' && pollAttempts < maxPollAttempts) {
    await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds
    pollAttempts++;
    
    try {
      const statusResponse = await fetch(`https://api.elevenlabs.io/v1/dubbing/${dubbingId}`, {
        headers: {
          'xi-api-key': elevenLabsKey!
        }
      });
      
      if (!statusResponse.ok) {
        throw new Error(`Status check failed: ${statusResponse.statusText}`);
      }
      
      const statusData = await statusResponse.json() as any;
      dubbingStatus = statusData.status;
      
      console.log(`📊 Status check ${pollAttempts}: ${dubbingStatus}`);
      
      if (dubbingStatus === 'failed') {
        throw new Error('ElevenLabs dubbing job failed');
      }
      
    } catch (error) {
      throw new Error(`Failed to check dubbing status: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  if (dubbingStatus !== 'dubbed') {
    throw new Error(`Dubbing job timed out or failed. Final status: ${dubbingStatus}`);
  }
  
  console.log('✅ Dubbing completed successfully!');

  // If uploadToMux is false, just return the dubbing info
  if (!uploadToMux) {
    return {
      assetId,
      targetLanguageCode: toLanguageCode,
      dubbingId
    };
  }

  // Download dubbed audio from ElevenLabs
  console.log('📥 Downloading dubbed audio from ElevenLabs...');
  
  let dubbedAudioBuffer: ArrayBuffer;
  
  try {
    // Get dubbed audio using fetch (since the SDK method might not be available)
    const audioUrl = `https://api.elevenlabs.io/v1/dubbing/${dubbingId}/audio/${toLanguageCode}`;
    const audioResponse = await fetch(audioUrl, {
      headers: {
        'xi-api-key': elevenLabsKey!
      }
    });
    
    if (!audioResponse.ok) {
      throw new Error(`Failed to fetch dubbed audio: ${audioResponse.statusText}`);
    }
    
    dubbedAudioBuffer = await audioResponse.arrayBuffer();
    console.log(`✅ Downloaded dubbed audio (${dubbedAudioBuffer.byteLength} bytes)`);
    
  } catch (error) {
    throw new Error(`Failed to download dubbed audio: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  // Upload to S3-compatible storage
  console.log('📤 Uploading dubbed audio to S3-compatible storage...');
  
  const s3Client = new S3Client({
    region: s3Region,
    endpoint: s3Endpoint,
    credentials: {
      accessKeyId: s3AccessKeyId!,
      secretAccessKey: s3SecretAccessKey!
    },
    forcePathStyle: true
  });
  
  // Create unique key for the audio file
  const audioKey = `audio-translations/${assetId}/auto-to-${toLanguageCode}-${Date.now()}.m4a`;
  
  let presignedUrl: string;
  
  try {
    // Upload audio to S3
    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: s3Bucket!,
        Key: audioKey,
        Body: new Uint8Array(dubbedAudioBuffer),
        ContentType: 'audio/mp4'
      }
    });
    
    await upload.done();
    console.log(`✅ Audio uploaded successfully to: ${audioKey}`);
    
    // Generate presigned URL (valid for 1 hour)
    const getObjectCommand = new GetObjectCommand({
      Bucket: s3Bucket!,
      Key: audioKey
    });
    
    presignedUrl = await getSignedUrl(s3Client, getObjectCommand, { 
      expiresIn: 3600 // 1 hour
    });
    
    console.log(`🔗 Generated presigned URL (expires in 1 hour)`);
    
  } catch (error) {
    throw new Error(`Failed to upload audio to S3: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  // Add translated audio track to Mux asset
  console.log('🎬 Adding translated audio track to Mux asset...');
  
  let uploadedTrackId: string | undefined;
  
  try {
    const languageName = new Intl.DisplayNames(['en'], { type: 'language' }).of(toLanguageCode) || toLanguageCode.toUpperCase();
    const trackName = `${languageName} (auto-dubbed)`;
    
    const trackResponse = await mux.video.assets.createTrack(assetId, {
      type: 'audio',
      language_code: toLanguageCode,
      name: trackName,
      url: presignedUrl
    });
    
    uploadedTrackId = trackResponse.id;
    console.log(`✅ Audio track added to Mux asset with ID: ${uploadedTrackId}`);
    console.log(`🎵 Track name: "${trackName}"`);
    
  } catch (error) {
    console.warn(`⚠️ Failed to add audio track to Mux asset: ${error instanceof Error ? error.message : 'Unknown error'}`);
    console.log('🔗 You can manually add the track using this presigned URL:');
    console.log(presignedUrl);
  }

  return {
    assetId,
    targetLanguageCode: toLanguageCode,
    dubbingId,
    uploadedTrackId,
    presignedUrl
  };
}