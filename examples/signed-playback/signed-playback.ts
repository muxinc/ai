/**
 * Test script for signed playback URL generation.
 *
 * This script tests that signed URLs are correctly generated for assets
 * with signed playback policies. It verifies:
 * - Storyboard URL signing
 * - Thumbnail URL signing
 * - Transcript URL signing
 *
 * Prerequisites:
 * 1. Create a Mux asset with a SIGNED playback policy
 * 2. Create a signing key in Mux Dashboard → Settings → Signing Keys
 * 3. Set environment variables:
 *    - MUX_TOKEN_ID
 *    - MUX_TOKEN_SECRET
 *    - MUX_SIGNING_KEY (the signing key ID)
 *    - MUX_PRIVATE_KEY (the base64-encoded private key)
 *
 * Usage:
 *   npm run test <signed-asset-id>
 */

import 'dotenv/config';
import Mux from '@mux/mux-node';
import { getStoryboardUrl } from '@mux/ai/primitives';
import { getThumbnailUrls } from '@mux/ai/primitives';
import { buildTranscriptUrl, findCaptionTrack } from '@mux/ai/primitives';

interface SigningContext {
  keyId: string;
  keySecret: string;
}

async function main() {
  const assetId = process.argv[2];

  if (!assetId) {
    console.log('Usage: npm run basic <signed-asset-id>');
    console.log('\nThis script verifies signed URL generation for assets with signed playback policies.');
    console.log('\nRequired environment variables:');
    console.log('  MUX_TOKEN_ID        - Your Mux API token ID');
    console.log('  MUX_TOKEN_SECRET    - Your Mux API token secret');
    console.log('  MUX_SIGNING_KEY     - Signing key ID from Mux dashboard');
    console.log('  MUX_PRIVATE_KEY     - Base64-encoded private key from Mux dashboard');
    process.exit(1);
  }

  // Validate environment
  const muxTokenId = process.env.MUX_TOKEN_ID;
  const muxTokenSecret = process.env.MUX_TOKEN_SECRET;
  const signingKeyId = process.env.MUX_SIGNING_KEY;
  const privateKey = process.env.MUX_PRIVATE_KEY;

  if (!muxTokenId || !muxTokenSecret) {
    console.error('❌ Missing MUX_TOKEN_ID or MUX_TOKEN_SECRET');
    process.exit(1);
  }

  if (!signingKeyId || !privateKey) {
    console.error('❌ Missing MUX_SIGNING_KEY or MUX_PRIVATE_KEY');
    console.error('   These are required for signing URLs for assets with signed playback policies.');
    process.exit(1);
  }

  const signingContext: SigningContext = {
    keyId: signingKeyId,
    keySecret: privateKey,
  };

  console.log('🔐 Signed Playback URL Test\n');
  console.log(`Asset ID: ${assetId}`);
  console.log('');

  // Initialize Mux client
  const mux = new Mux({
    tokenId: muxTokenId,
    tokenSecret: muxTokenSecret,
  });

  // Fetch asset
  console.log('📡 Fetching asset from Mux...');
  let asset;
  try {
    asset = await mux.video.assets.retrieve(assetId);
  } catch (error) {
    console.error('❌ Failed to fetch asset:', error instanceof Error ? error.message : error);
    process.exit(1);
  }

  // Check playback policy
  const playbackIds = asset.playback_ids || [];
  const signedPlaybackId = playbackIds.find((pid) => pid.policy === 'signed');
  const publicPlaybackId = playbackIds.find((pid) => pid.policy === 'public');

  if (publicPlaybackId) {
    console.log(`⚠️  Asset has a PUBLIC playback ID: ${publicPlaybackId.id}`);
    console.log('   This test is designed for assets with SIGNED playback policies.');
    console.log('   The URLs will still be generated but signing is not required.\n');
  }

  if (!signedPlaybackId) {
    console.error('❌ No signed playback ID found for this asset.');
    console.error('   Create an asset with playback_policy: "signed" to test signed URL generation.');
    process.exit(1);
  }

  const playbackId = signedPlaybackId.id;
  console.log(`✅ Found signed playback ID: ${playbackId}\n`);

  // Test 1: Storyboard URL
  console.log('─'.repeat(60));
  console.log('📊 Test 1: Storyboard URL');
  console.log('─'.repeat(60));
  try {
    const storyboardUrl = await getStoryboardUrl(playbackId, 640, signingContext);
    console.log('Generated URL:');
    console.log(`  ${storyboardUrl.substring(0, 80)}...`);

    // Verify the URL works
    const response = await fetch(storyboardUrl, { method: 'HEAD' });
    if (response.ok) {
      console.log(`✅ URL is accessible (HTTP ${response.status})`);
    } else {
      console.log(`❌ URL returned HTTP ${response.status}`);
    }
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
  }
  console.log('');

  // Test 2: Thumbnail URLs
  console.log('─'.repeat(60));
  console.log('🖼️  Test 2: Thumbnail URLs');
  console.log('─'.repeat(60));
  try {
    const duration = asset.duration || 60;
    const thumbnailUrls = await getThumbnailUrls(playbackId, duration, {
      interval: 10,
      width: 320,
      signingContext,
    });

    console.log(`Generated ${thumbnailUrls.length} thumbnail URLs`);
    if (thumbnailUrls.length > 0) {
      console.log('First URL:');
      console.log(`  ${thumbnailUrls[0].substring(0, 80)}...`);

      // Verify the first URL works
      const response = await fetch(thumbnailUrls[0], { method: 'HEAD' });
      if (response.ok) {
        console.log(`✅ URL is accessible (HTTP ${response.status})`);
      } else {
        console.log(`❌ URL returned HTTP ${response.status}`);
      }
    }
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
  }
  console.log('');

  // Test 3: Transcript URL (if available)
  console.log('─'.repeat(60));
  console.log('📝 Test 3: Transcript URL');
  console.log('─'.repeat(60));
  try {
    const track = findCaptionTrack(asset);
    if (track && track.id) {
      console.log(`Found caption track: ${track.language_code} (${track.id})`);
      const transcriptUrl = await buildTranscriptUrl(playbackId, track.id, signingContext);
      console.log('Generated URL:');
      console.log(`  ${transcriptUrl.substring(0, 80)}...`);

      // Verify the URL works
      const response = await fetch(transcriptUrl, { method: 'HEAD' });
      if (response.ok) {
        console.log(`✅ URL is accessible (HTTP ${response.status})`);
      } else {
        console.log(`❌ URL returned HTTP ${response.status}`);
      }
    } else {
      console.log('ℹ️  No caption track found on this asset (skipping transcript test)');
    }
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
  }
  console.log('');

  // Summary
  console.log('─'.repeat(60));
  console.log('📋 Summary');
  console.log('─'.repeat(60));
  console.log('If all URLs above returned HTTP 200, signed URL generation is working correctly!');
  console.log('');
  console.log('Token details:');
  console.log('  - Algorithm: RS256');
  console.log('  - Expiration: 1 hour (default)');
  console.log('  - Claims: sub (playbackId), aud (asset type), exp, kid');
}

main().catch(console.error);

