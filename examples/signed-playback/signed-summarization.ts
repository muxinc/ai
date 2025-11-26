/**
 * Example: Summarization with signed playback assets.
 *
 * This demonstrates using the getSummaryAndTags function with an asset
 * that has a signed playback policy. The library automatically handles
 * URL signing when credentials are provided.
 *
 * Usage:
 *   npm run summarize <signed-asset-id> [provider]
 *
 * Example:
 *   npm run summarize abc123 anthropic
 */

import 'dotenv/config';
import { getSummaryAndTags } from '@mux/ai/functions';

type Provider = 'openai' | 'anthropic' | 'google';

const DEFAULT_MODELS: Record<Provider, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-5',
  google: 'gemini-2.0-flash',
};

async function main() {
  const assetId = process.argv[2];
  const provider = (process.argv[3] as Provider) || 'anthropic';

  if (!assetId) {
    console.log('Usage: npm run summarize <signed-asset-id> [provider]');
    console.log('\nThis example demonstrates summarization with signed playback assets.');
    console.log('\nRequired environment variables:');
    console.log('  MUX_TOKEN_ID        - Your Mux API token ID');
    console.log('  MUX_TOKEN_SECRET    - Your Mux API token secret');
    console.log('  MUX_SIGNING_KEY     - Signing key ID (for signed assets)');
    console.log('  MUX_PRIVATE_KEY     - Base64-encoded private key (for signed assets)');
    console.log('  ANTHROPIC_API_KEY   - (or OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY)');
    process.exit(1);
  }

  if (!['openai', 'anthropic', 'google'].includes(provider)) {
    console.error('❌ Unsupported provider. Choose from: openai, anthropic, google');
    process.exit(1);
  }

  // Check for signing credentials
  const hasSigningCredentials = process.env.MUX_SIGNING_KEY && process.env.MUX_PRIVATE_KEY;
  if (!hasSigningCredentials) {
    console.log('⚠️  No signing credentials found (MUX_SIGNING_KEY / MUX_PRIVATE_KEY)');
    console.log('   If your asset has a signed playback policy, this will fail.\n');
  }

  const model = DEFAULT_MODELS[provider];

  console.log('🎬 Signed Asset Summarization\n');
  console.log(`Asset ID: ${assetId}`);
  console.log(`Provider: ${provider} (${model})`);
  console.log(`Signing: ${hasSigningCredentials ? '✅ Credentials available' : '❌ No credentials'}`);
  console.log('');

  try {
    const result = await getSummaryAndTags(assetId, {
      tone: 'professional',
      provider,
      model,
      includeTranscript: true,
      // Mux API credentials
      muxTokenId: process.env.MUX_TOKEN_ID,
      muxTokenSecret: process.env.MUX_TOKEN_SECRET,
      // Signing credentials (used automatically for signed playback IDs)
      muxSigningKey: process.env.MUX_SIGNING_KEY,
      muxPrivateKey: process.env.MUX_PRIVATE_KEY,
      // AI provider credentials
      openaiApiKey: process.env.OPENAI_API_KEY,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      googleApiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    });

    console.log('─'.repeat(60));
    console.log('📝 Title:');
    console.log(result.title);
    console.log('');
    console.log('📋 Description:');
    console.log(result.description);
    console.log('');
    console.log('🏷️  Tags:');
    console.log(result.tags.join(', '));
    console.log('');
    console.log('🖼️  Storyboard URL (signed):');
    console.log(result.storyboardUrl.substring(0, 80) + '...');
    console.log('─'.repeat(60));
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);

    if (error instanceof Error && error.message.includes('signing credentials')) {
      console.log('\n💡 Hint: This asset likely has a signed playback policy.');
      console.log('   Set MUX_SIGNING_KEY and MUX_PRIVATE_KEY environment variables.');
    }
  }
}

main();

