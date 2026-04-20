# Ask Questions Examples

Examples demonstrating how to use the `askQuestions` workflow to answer questions about asset content. Each question can specify its own allowed answers (defaulting to `["yes", "no"]`), so simple binary checks and richer classification scales can be mixed in a single call.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Set the required environment variables:
   - `OPENAI_API_KEY` or Baseten/Anthropic/Google credentials for the provider you plan to use
   - `BASETEN_API_KEY`, `BASETEN_BASE_URL`, and `BASETEN_MODEL` when using Baseten
   - `MUX_TOKEN_ID` - Your Mux API token ID
   - `MUX_TOKEN_SECRET` - Your Mux API token secret

## Examples

### Per-question Answer Options (CLI syntax)

Each question's answer options default to yes/no. To specify custom allowed answers for a question, append a pipe character followed by a comma-separated list of options:

```
"Question text|option1,option2,option3"
```

The pipe must be inside the quoted string so the shell doesn't treat it as a command pipeline. For example:

```bash
"What is the production quality?|amateur,semi-pro,professional"
"What is the sentiment?|positive,neutral,negative"
"Does this contain cooking?"   # no pipe → answer options default to yes/no
```

### Basic Example

Ask a single question about a video:

```bash
# From the examples/ask-questions directory
npm run basic <asset-id> "Does this video contain cooking?"

# Or from the root directory
npm run example:ask-questions -- <asset-id> "Does this video contain cooking?"
```

#### Options

- `-m, --model <model>` - Specify the AI model to use (provider default when omitted)
- `-p, --provider <provider>` - Choose `openai`, `baseten`, `anthropic`, or `google` (default: `openai`)
- `--no-transcript` - Exclude the transcript from analysis (visual only)

#### Examples

```bash
# Yes/no question (default)
npm run basic abc123 "Does this video contain cooking?"

# Custom allowed answers via pipe syntax
npm run basic abc123 "What is the production quality?|amateur,semi-pro,professional"

# Ask if people are visible, without using transcript
npm run basic abc123 "Are there people visible in this video?" --no-transcript

# Use a specific model
npm run basic abc123 "Is this video shot outdoors?" --model gpt-4o

# Run against Baseten
npm run basic abc123 "Does this video contain cooking?" --provider baseten
```

### Multiple Questions Example

Ask multiple questions about a video in a single call (more efficient). Questions can mix yes/no checks with custom answer sets using the pipe syntax:

```bash
# From the examples/ask-questions directory
npm run multiple <asset-id> "Question 1?" "Question 2?" "Question 3?"

# Or from the root directory
npm run example:ask-questions:multiple -- <asset-id> "Question 1?" "Question 2?" "Question 3?"
```

### Audio-Only Example

Ask a question about an audio-only asset using transcript analysis:

```bash
# From the examples/ask-questions directory
npm run audio-only [audio-only-asset-id] ["Is there spoken dialogue in this content?"]

# Or from the root directory
npm run example:ask-questions:audio-only -- [audio-only-asset-id] ["Is there spoken dialogue in this content?"]
```

If no asset ID is provided, the script uses `MUX_TEST_ASSET_ID_AUDIO_ONLY`.

#### Options

- `-m, --model <model>` - Specify the AI model to use (provider default when omitted)
- `-p, --provider <provider>` - Choose `openai`, `baseten`, `anthropic`, or `google` (default: `openai`)

#### Examples

```bash
# Ask multiple yes/no questions at once
npm run multiple abc123 "Does this contain cooking?" "Are there people visible?" "Is this outdoors?"

# Mix yes/no with per-question answer sets
npm run multiple abc123 \
  "Does this contain cooking?" \
  "What is the production quality?|amateur,semi-pro,professional" \
  "What is the sentiment?|positive,neutral,negative"

# Multiple questions without transcript
npm run multiple abc123 "Is this a tutorial?" "Is it shot indoors?" --no-transcript
```

#### Output

The multiple questions example shows:
- Each question with its answer, confidence, and reasoning
- Summary statistics (yes/no counts, average confidence)
- Token usage for cost analysis

## How It Works

The `askQuestions` workflow:

1. **Fetches video data** - Gets the asset information and playback ID from Mux
2. **Generates storyboard** - Creates a grid of frames showing the video timeline (video assets only)
3. **Fetches transcript** - Optionally includes the video's transcript/captions
4. **Analyzes content** - Sends storyboard+transcript (video) or transcript-only (audio-only) to the AI model
5. **Returns structured answers** - Provides an answer drawn from the question's allowed options, a confidence score (0-1), and reasoning

## Answer Format

Each answer includes:
- **answer**: One of the question's allowed `answerOptions` (or `null` when skipped as irrelevant)
- **confidence**: Float between 0 and 1 (e.g., 0.95 = 95% confident)
- **reasoning**: Explanation citing specific visual or audio evidence
- **question**: The original question
- **skipped**: True when the question wasn't answerable from the asset content

## Multiple Questions

You can ask multiple questions in a single call for efficiency. Each question can carry its own `answerOptions`:

```typescript
import { askQuestions } from "@mux/ai/workflows";

const result = await askQuestions("asset-id", [
  { question: "Does this video contain cooking?" }, // answer options default to yes/no
  {
    question: "What is the primary content type?",
    answerOptions: ["tutorial", "entertainment", "news", "advertisement"],
  },
  {
    question: "What is the production quality?",
    answerOptions: ["amateur", "semi-pro", "professional"],
  },
]);

result.answers.forEach(answer => {
  console.log(`${answer.question}: ${answer.answer} (${answer.confidence})`);
});
```

This is more efficient than asking questions separately because all questions are processed in a single LLM call, reducing latency and cost.

## Use Cases

Perfect for:
- **Content moderation** - "Does this contain inappropriate content?"
- **Content classification** - "Is this a tutorial video?"
- **Quality checks** - "Is the audio clear and understandable?"
- **Metadata validation** - "Does the video match its title/description?"
- **Accessibility checks** - "Are there visible subtitles/captions?"
