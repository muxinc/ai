# Ask Questions Examples

Examples demonstrating how to use the `askQuestions` workflow to answer yes/no questions about video content.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Set the required environment variables:
   - `OPENAI_API_KEY` - Your OpenAI API key
   - `MUX_TOKEN_ID` - Your Mux API token ID
   - `MUX_TOKEN_SECRET` - Your Mux API token secret

## Examples

### Basic Example

Ask a single yes/no question about a video:

```bash
# From the examples/ask-questions directory
npm run basic <asset-id> "Does this video contain cooking?"

# Or from the root directory
npm run example:ask-questions -- <asset-id> "Does this video contain cooking?"
```

#### Options

- `-m, --model <model>` - Specify the OpenAI model to use (default: gpt-5.1)
- `--no-transcript` - Exclude the transcript from analysis (visual only)

#### Examples

```bash
# Ask if a video contains cooking
npm run basic abc123 "Does this video contain cooking?"

# Ask if people are visible, without using transcript
npm run basic abc123 "Are there people visible in this video?" --no-transcript

# Use a specific model
npm run basic abc123 "Is this video shot outdoors?" --model gpt-4o
```

### Multiple Questions Example

Ask multiple yes/no questions about a video in a single call (more efficient):

```bash
# From the examples/ask-questions directory
npm run multiple <asset-id> "Question 1?" "Question 2?" "Question 3?"

# Or from the root directory
npm run example:ask-questions:multiple -- <asset-id> "Question 1?" "Question 2?" "Question 3?"
```

#### Options

- `-m, --model <model>` - Specify the OpenAI model to use (default: gpt-5.1)
- `--no-transcript` - Exclude the transcript from analysis (visual only)

#### Examples

```bash
# Ask multiple questions at once
npm run multiple abc123 "Does this contain cooking?" "Are there people visible?" "Is this outdoors?"

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
2. **Generates storyboard** - Creates a grid of frames showing the video timeline
3. **Fetches transcript** - Optionally includes the video's transcript/captions
4. **Analyzes content** - Sends the storyboard and transcript to the AI model
5. **Returns structured answers** - Provides yes/no answer, confidence score (0-1), and reasoning

## Answer Format

Each answer includes:
- **answer**: "yes" or "no"
- **confidence**: Float between 0 and 1 (e.g., 0.95 = 95% confident)
- **reasoning**: Explanation citing specific visual or audio evidence
- **question**: The original question

## Multiple Questions

You can ask multiple questions in a single call for efficiency. See the [Multiple Questions Example](#multiple-questions-example) above for a command-line demonstration, or use the API directly:

```typescript
import { askQuestions } from "@mux/ai/workflows";

const result = await askQuestions("asset-id", [
  { question: "Does this video contain cooking?" },
  { question: "Are there people visible?" },
  { question: "Is this shot indoors?" },
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
