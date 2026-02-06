# Examples

See the `examples/` directory for complete working examples.
For audio-only support details, see [Audio-Only Workflows](./AUDIO-ONLY.md).

## Prerequisites

Create a `.env` file in the project root with your API credentials:

```bash
MUX_TOKEN_ID=your_token_id
MUX_TOKEN_SECRET=your_token_secret
OPENAI_API_KEY=your_openai_key
ANTHROPIC_API_KEY=your_anthropic_key
GOOGLE_GENERATIVE_AI_API_KEY=your_google_key
HIVE_API_KEY=your_hive_key # required for Hive moderation runs
```

All examples automatically load environment variables using `dotenv`.

## Quick Start (Run from Root)

You can run examples directly from the project root without installing dependencies in each example folder:

```bash
# Chapters
npm run example:chapters <asset-id> [language-code] [provider]
npm run example:chapters:compare <asset-id> [language-code]

# Burned-in Caption Detection
npm run example:burned-in <asset-id> [provider]
npm run example:burned-in:compare <asset-id>

# Ask Questions
npm run example:ask-questions <asset-id> "<question>"
npm run example:ask-questions:multiple <asset-id> "<question1>" "<question2>" ...

# Summarization
npm run example:summarization <asset-id> [provider]
npm run example:summarization:compare <asset-id>

# Moderation
npm run example:moderation <asset-id> [provider]
npm run example:moderation:compare <asset-id>

# Caption Translation
npm run example:translate-captions <asset-id> [from-lang] [to-lang] [provider]

# Audio Translation (Dubbing)
npm run example:translate-audio <asset-id> [to-lang]

# Signed Playback (for assets with signed playback policies)
npm run example:signed-playback <signed-asset-id>
npm run example:signed-playback:summarize <signed-asset-id> [provider]
```

**Example Commands:**

```bash
# Generate chapters with OpenAI
npm run example:chapters abc123 en openai

# Detect burned-in captions with Anthropic
npm run example:burned-in abc123 anthropic

# Ask a yes/no question about a video
npm run example:ask-questions abc123 "Does this video contain cooking?"

# Ask multiple questions at once
npm run example:ask-questions:multiple abc123 "Does this video contain people?" "Is this in color?"

# Compare OpenAI vs Anthropic chapter generation
npm run example:chapters:compare abc123 en

# Run moderation analysis with Hive
npm run example:moderation abc123 hive

# Translate captions from English to Spanish with Anthropic (default)
npm run example:translate-captions abc123 en es anthropic

# Summarize a video with Claude Sonnet 4.5 (default)
npm run example:summarization abc123 anthropic

# Create AI-dubbed audio in French
npm run example:translate-audio abc123 fr
```

## Summarization Examples

- **Basic Usage**: Default prompt with different tones
- **Custom Prompts**: Override prompt sections with presets (SEO, social, technical, ecommerce)
- **Tone Variations**: Compare analysis styles

```bash
cd examples/summarization
npm install
npm run basic <your-asset-id> [provider]
npm run tones <your-asset-id>

# Custom prompts with presets
npm run custom <your-asset-id> --preset seo
npm run custom <your-asset-id> --preset social
npm run custom <your-asset-id> --preset technical
npm run custom <your-asset-id> --preset ecommerce

# Or provide individual overrides
npm run custom <your-asset-id> --task "Focus on product features"
```

## Moderation Examples

- **Basic Moderation**: Analyze content with default thresholds
- **Custom Thresholds**: Compare strict/default/permissive settings
- **Provider Comparison**: Compare OpenAI's dedicated Moderation API with Hive's visual moderation API

```bash
cd examples/moderation
npm install
npm run basic <your-asset-id> [provider]   # provider: openai | hive
npm run thresholds <your-asset-id>
npm run compare <your-asset-id>
```

Supported moderation providers: `openai` (default) and `hive`. Use `HIVE_API_KEY` when selecting Hive.

## Burned-in Caption Examples

- **Basic Detection**: Detect burned-in captions with different AI providers
- **Provider Comparison**: Compare OpenAI vs Anthropic vs Google detection accuracy

```bash
cd examples/burned-in-captions
npm install
npm run burned-in:basic <your-asset-id> [provider]
npm run compare <your-asset-id>
```

## Ask Questions Examples

- **Basic Usage**: Answer single yes/no questions about video content
- **Multiple Questions**: Process multiple questions efficiently in one API call

```bash
cd examples/ask-questions
npm install

# Single question with OpenAI (default)
npm run basic <your-asset-id> "Does this video contain music?"

# Multiple questions
npm run multiple <your-asset-id> "Does this show people?" "Is this in color?" "Does it have dialogue?"

# Use different providers
npm run basic <your-asset-id> "Is this a tutorial?" --provider anthropic
npm run basic <your-asset-id> "Does this show cooking?" --provider google

# Without transcript (visual-only analysis)
npm run basic <your-asset-id> "Does this video show text?" --no-transcript

# Custom model
npm run basic <your-asset-id> "Is this a tutorial?" --model gpt-4o
```

**Use Cases:**

- Content classification and categorization
- Quality checks and validation
- Content moderation decisions
- Accessibility audits
- Metadata verification

Supports OpenAI, Anthropic, and Google providers.

## Chapter Generation Examples

- **Basic Chapters**: Generate chapters with different AI providers
- **Provider Comparison**: Compare OpenAI vs Anthropic vs Google chapter generation

```bash
cd examples/chapters
npm install
npm run chapters:basic <your-asset-id> [language-code] [provider]
npm run compare <your-asset-id> [language-code]
```

## Caption Translation Examples

- **Basic Translation**: Translate captions and upload to Mux
- **Translation Only**: Translate without uploading to Mux
- **AWS SDK Adapter**: Translate captions using `storageAdapter` backed by AWS SDK v3

```bash
cd examples/translate-captions
npm install
npm run basic <your-asset-id> en es [provider]
npm run translation-only <your-asset-id> en fr [provider]
npm run aws-sdk-adapter <your-asset-id> -- --s3-bucket <bucket-name>
```

**Translation Workflow:**

1. Fetches existing captions from Mux asset
2. Translates VTT content using your selected provider (default: Claude Sonnet 4.5)
3. Uploads translated VTT to S3-compatible storage
4. Generates presigned URL (1-hour expiry)
5. Adds new subtitle track to Mux asset
6. Track name: "{Language} (auto-translated)"

> **💡 Tip:** After translation completes, verify your new subtitle tracks at `https://player.mux.com/{PLAYBACK_ID}`

## Audio Dubbing Examples

- **Basic Dubbing**: Create AI-dubbed audio and upload to Mux
- **Dubbing Only**: Create dubbed audio without uploading to Mux

```bash
cd examples/translate-audio
npm install
npm run basic <your-asset-id> es
npm run dubbing-only <your-asset-id> fr
```

**Audio Dubbing Workflow:**

1. Checks asset has audio.m4a static rendition
2. Downloads default audio track from Mux
3. Creates ElevenLabs dubbing job with automatic language detection
4. Polls for completion (up to 30 minutes)
5. Downloads dubbed audio file
6. Uploads to S3-compatible storage
7. Generates presigned URL (1-hour expiry)
8. Adds new audio track to Mux asset
9. Track name: "{Language} (auto-dubbed)"

> **💡 Tip:** After dubbing completes, listen to your new audio tracks at `https://player.mux.com/{PLAYBACK_ID}`

## Signed Playback Examples

- **URL Generation Test**: Verify signed URLs work for storyboards, thumbnails, and transcripts
- **Signed Summarization**: Full summarization workflow with a signed asset

```bash
cd examples/signed-playback
npm install

# Verify signed URL generation
npm run basic <signed-asset-id>

# Summarize a signed asset
npm run summarize <signed-asset-id> [provider]
```

**Prerequisites:**

1. Create a Mux asset with `playback_policy: "signed"`
2. Create a signing key in Mux Dashboard → Settings → Signing Keys
3. Set `MUX_SIGNING_KEY` and `MUX_PRIVATE_KEY` environment variables

**How Signed Playback Works:**
When signing credentials are available in environment variables, the library automatically:

- Detects if an asset has a signed playback policy
- Generates JWT tokens with RS256 algorithm
- Uses the correct `aud` claim for each asset type (video, thumbnail, storyboard)
- Appends tokens to URLs as query parameters
