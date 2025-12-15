# Signed Playback Examples

These examples demonstrate how to use `@mux/ai` with assets that have **signed playback policies**.

## Prerequisites

1. **Create a signed asset** in Mux:
   - Go to Mux Dashboard → Assets → Create New Asset
   - Set **Playback Policy** to `signed`
   - Upload your video

2. **Create a signing key**:
   - Go to Mux Dashboard → Settings → Signing Keys
   - Click "Generate New Key"
   - Save both the **Signing Key ID** and **Private Key**

3. **Set environment variables**:

   ```bash
   # Mux API credentials
   export MUX_TOKEN_ID="your-token-id"
   export MUX_TOKEN_SECRET="your-token-secret"

   # Signing credentials (for signed playback policies)
   export MUX_SIGNING_KEY="your-signing-key-id"
   export MUX_PRIVATE_KEY="your-base64-encoded-private-key"

   # AI provider (at least one)
   export ANTHROPIC_API_KEY="your-anthropic-key"
   # or OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY
   ```

## Examples

### Basic Signed URL Generation

Verifies that signed URLs are correctly generated for storyboards, thumbnails, and transcripts:

```bash
npm run basic <signed-asset-id>
```

### Summarization with Signed Assets

Demonstrates the full summarization workflow with a signed asset:

```bash
npm run summarize <signed-asset-id>

# With options:
npm run summarize <signed-asset-id> -- --provider openai --tone playful
npm run summarize <signed-asset-id> -- -p google -t professional --no-transcript
```

**Options:**

- `-p, --provider <provider>` - AI provider: openai, anthropic, google (default: anthropic)
- `-m, --model <model>` - Model name (overrides default for provider)
- `-t, --tone <tone>` - Tone for summary: neutral, playful, professional (default: professional)
- `--no-transcript` - Exclude transcript from analysis

## How It Works

When signing credentials are available in environment variables (`MUX_SIGNING_KEY` and `MUX_PRIVATE_KEY`), the library automatically:

1. Detects if an asset has a signed playback policy
2. Generates JWT tokens with the correct claims:
   - `sub`: The playback ID
   - `aud`: Asset type (`v` for video, `t` for thumbnail, `s` for storyboard)
   - `exp`: Expiration time (default: 1 hour)
   - `kid`: Your signing key ID
3. Appends tokens to URLs as query parameters
4. Uses different tokens for different asset types (thumbnails, storyboards, etc.)

## Troubleshooting

### "Signed playback ID requires signing credentials"

Your asset has a signed playback policy but you haven't provided signing credentials. Set `MUX_SIGNING_KEY` and `MUX_PRIVATE_KEY` environment variables.

### "Invalid signature" or 403 errors

- Verify your signing key was created in the **same Mux environment** as your asset
- Check that `MUX_PRIVATE_KEY` is the full base64-encoded string from the dashboard
- Ensure your signing key hasn't been revoked

### "No signed playback ID found"

Your asset doesn't have a signed playback policy. Either:

- Create a new asset with `playback_policy: "signed"`
- Or use a public asset (no signing credentials needed)
