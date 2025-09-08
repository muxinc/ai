import Mux from '@mux/mux-node';
import Anthropic from '@anthropic-ai/sdk';
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { MuxAIOptions } from './types';

export interface TranslationResult {
  assetId: string;
  sourceLanguageCode: string;
  targetLanguageCode: string;
  originalVtt: string;
  translatedVtt: string;
  uploadedTrackId?: string;
  presignedUrl?: string;
}

export interface TranslationOptions extends MuxAIOptions {
  provider?: 'anthropic';
  model?: string;
  s3Endpoint?: string;
  s3Region?: string;
  s3Bucket?: string;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
  uploadToMux?: boolean;
}

export async function translateCaptions(
  assetId: string,
  fromLanguageCode: string,
  toLanguageCode: string,
  options: TranslationOptions = {}
): Promise<TranslationResult> {
  const {
    provider = 'anthropic',
    model = 'claude-sonnet-4-20250514',
    muxTokenId,
    muxTokenSecret,
    anthropicApiKey,
    ...config
  } = options;

  if (provider !== 'anthropic') {
    throw new Error('Only Anthropic provider is currently supported for translation');
  }

  // Validate required credentials
  const muxId = muxTokenId || process.env.MUX_TOKEN_ID;
  const muxSecret = muxTokenSecret || process.env.MUX_TOKEN_SECRET;
  const anthropicKey = anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  
  // S3 configuration
  const s3Endpoint = options.s3Endpoint || process.env.S3_ENDPOINT;
  const s3Region = options.s3Region || process.env.S3_REGION || 'auto';
  const s3Bucket = options.s3Bucket || process.env.S3_BUCKET;
  const s3AccessKeyId = options.s3AccessKeyId || process.env.S3_ACCESS_KEY_ID;
  const s3SecretAccessKey = options.s3SecretAccessKey || process.env.S3_SECRET_ACCESS_KEY;
  const uploadToMux = options.uploadToMux !== false; // Default to true

  if (!muxId || !muxSecret) {
    throw new Error('Mux credentials are required. Provide muxTokenId and muxTokenSecret in options or set MUX_TOKEN_ID and MUX_TOKEN_SECRET environment variables.');
  }

  if (!anthropicKey) {
    throw new Error('Anthropic API key is required. Provide anthropicApiKey in options or set ANTHROPIC_API_KEY environment variable.');
  }
  
  if (uploadToMux && (!s3Endpoint || !s3Bucket || !s3AccessKeyId || !s3SecretAccessKey)) {
    throw new Error('S3 configuration is required for uploading to Mux. Provide s3Endpoint, s3Bucket, s3AccessKeyId, and s3SecretAccessKey in options or set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY environment variables.');
  }

  // Initialize clients
  const mux = new Mux({
    tokenId: muxId,
    tokenSecret: muxSecret,
  });

  const anthropicClient = new Anthropic({
    apiKey: anthropicKey,
  });

  // Fetch asset data from Mux
  let assetData;
  try {
    const asset = await mux.video.assets.retrieve(assetId);
    assetData = asset;
  } catch (error) {
    throw new Error(`Failed to fetch asset from Mux: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  // Get playback ID for caption URL
  const playbackId = assetData.playback_ids?.[0]?.id;
  if (!playbackId) {
    throw new Error('No playback ID found for this asset');
  }

  // Find text track with the source language
  if (!assetData.tracks) {
    throw new Error('No tracks found for this asset');
  }

  const sourceTextTrack = assetData.tracks.find((track) => 
    track.type === 'text' && 
    track.status === 'ready' && 
    track.language_code === fromLanguageCode
  );

  if (!sourceTextTrack) {
    throw new Error(`No ready text track found with language code '${fromLanguageCode}' for this asset`);
  }

  // Fetch the VTT file content
  const vttUrl = `https://stream.mux.com/${playbackId}/text/${sourceTextTrack.id}.vtt`;
  let vttContent: string;
  
  try {
    const vttResponse = await fetch(vttUrl);
    if (!vttResponse.ok) {
      throw new Error(`Failed to fetch VTT file: ${vttResponse.statusText}`);
    }
    vttContent = await vttResponse.text();
  } catch (error) {
    throw new Error(`Failed to fetch VTT content: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  console.log(`Found VTT content for language '${fromLanguageCode}':`);
  console.log(vttContent.substring(0, 200) + '...'); // Log first 200 chars

  // Translate VTT content using Anthropic
  let translatedVtt: string;
  
  try {
    const response = await anthropicClient.messages.create({
      model,
      max_tokens: 4000,
      messages: [
        {
          role: 'user',
          content: `Translate the following VTT subtitle file from ${fromLanguageCode} to ${toLanguageCode}. Return the translated VTT in JSON format with the key 'translation'. Preserve all timestamps and VTT formatting exactly as they appear.\n\n${vttContent}`
        }
      ]
    });

    const content = response.content[0];
    if (content.type === 'text') {
      // Parse JSON from Anthropic response
      const responseText = content.text.trim();
      try {
        // Remove code block markers if present
        const cleanedResponse = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleanedResponse);
        translatedVtt = parsed.translation;
      } catch (parseError) {
        throw new Error(`Failed to parse JSON response from Anthropic: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`);
      }
    } else {
      throw new Error('Unexpected response type from Anthropic');
    }
  } catch (error) {
    throw new Error(`Failed to translate VTT with Anthropic: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  console.log(`\n✅ Translation completed successfully!`);
  
  // If uploadToMux is false, just return the translation
  if (!uploadToMux) {
    console.log(`Translated VTT content (${toLanguageCode}):`);
    console.log(translatedVtt);
    
    return {
      assetId,
      sourceLanguageCode: fromLanguageCode,
      targetLanguageCode: toLanguageCode,
      originalVtt: vttContent,
      translatedVtt: translatedVtt
    };
  }
  
  // Upload translated VTT to S3-compatible storage
  console.log('📤 Uploading translated VTT to S3-compatible storage...');
  
  const s3Client = new S3Client({
    region: s3Region,
    endpoint: s3Endpoint,
    credentials: {
      accessKeyId: s3AccessKeyId!,
      secretAccessKey: s3SecretAccessKey!
    },
    forcePathStyle: true // Often needed for non-AWS S3 services
  });
  
  // Create unique key for the VTT file
  const vttKey = `translations/${assetId}/${fromLanguageCode}-to-${toLanguageCode}-${Date.now()}.vtt`;
  
  let presignedUrl: string;
  
  try {
    // Upload VTT to S3
    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: s3Bucket!,
        Key: vttKey,
        Body: translatedVtt,
        ContentType: 'text/vtt'
      }
    });
    
    await upload.done();
    console.log(`✅ VTT uploaded successfully to: ${vttKey}`);
    
    // Generate presigned URL (valid for 1 hour)
    const getObjectCommand = new GetObjectCommand({
      Bucket: s3Bucket!,
      Key: vttKey
    });
    
    presignedUrl = await getSignedUrl(s3Client, getObjectCommand, { 
      expiresIn: 3600 // 1 hour
    });
    
    console.log(`🔗 Generated presigned URL (expires in 1 hour)`);
    
  } catch (error) {
    throw new Error(`Failed to upload VTT to S3: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
  
  // Add translated track to Mux asset
  console.log('📹 Adding translated track to Mux asset...');
  
  let uploadedTrackId: string | undefined;
  
  try {
    const languageNames: Record<string, string> = {
      'es': 'Spanish',
      'fr': 'French', 
      'de': 'German',
      'it': 'Italian',
      'pt': 'Portuguese',
      'ja': 'Japanese',
      'ko': 'Korean',
      'zh': 'Chinese',
      'ru': 'Russian',
      'ar': 'Arabic'
    };
    
    const languageName = languageNames[toLanguageCode] || toLanguageCode.toUpperCase();
    const trackName = `${languageName} (auto-translated)`;
    
    const trackResponse = await mux.video.assets.createTrack(assetId, {
      type: 'text',
      text_type: 'subtitles',
      language_code: toLanguageCode,
      name: trackName,
      url: presignedUrl
    });
    
    uploadedTrackId = trackResponse.id;
    console.log(`✅ Track added to Mux asset with ID: ${uploadedTrackId}`);
    console.log(`📋 Track name: "${trackName}"`);
    
  } catch (error) {
    console.warn(`⚠️ Failed to add track to Mux asset: ${error instanceof Error ? error.message : 'Unknown error'}`);
    console.log('🔗 You can manually add the track using this presigned URL:');
    console.log(presignedUrl);
  }
  
  return {
    assetId,
    sourceLanguageCode: fromLanguageCode,
    targetLanguageCode: toLanguageCode,
    originalVtt: vttContent,
    translatedVtt: translatedVtt,
    uploadedTrackId,
    presignedUrl
  };
}