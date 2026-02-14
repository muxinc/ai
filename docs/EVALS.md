# Evaluations

> **No new workflow in @mux/ai is considered "done" until it ships with attached eval coverage that can be run locally and in CI.**

This library uses [Evalite](https://v1.evalite.dev/) for AI evaluation testing. Evals measure the efficacy, efficiency, and expense of AI workflows across multiple providers, enabling data-driven decisions about model selection and prompt optimization.

**[View the latest evaluation results →](https://evaluating-mux-ai.vercel.app/)**

Results are published automatically on every push to `main`, so the dashboard always reflects the current state of the library's default models and prompts.

## The 3 E's Framework

Every eval in this library measures workflows against three dimensions:

### Efficacy — "Does it work correctly?"

- Does the model produce accurate, high-quality results?
- Are outputs properly formatted and schema-compliant?
- Does the model avoid common failure modes (hallucinations, filler phrases)?
- How does output quality compare across providers?

### Efficiency — "How fast and scalable is it?"

- How many tokens does it consume?
- What's the wall clock latency from request to response?
- Is token usage within efficient operating ranges?

### Expense — "What does it cost?"

- What does each request cost across providers?
- How do costs compare for equivalent quality?
- Where are opportunities for prompt optimization?

This framework enables systematic evaluation of default model selections across all supported providers and helps users understand the tradeoffs between OpenAI, Anthropic, and Google.

### Practical Application

Not all workflows can measure all 3 E's with equal precision from day one:

- **Efficacy** can be challenging to dial in—defining ground truth, building representative test sets, and calibrating quality thresholds takes iteration. For some workflows (translation quality, creative summarization), efficacy measurement may evolve over time.

- **Efficiency and Expense** are always measurable. Token counts, latency, and costs are objective metrics that can establish early signals for any workflow, even before efficacy scoring is fully developed.

- **Foundational model workflows** (those relying exclusively on OpenAI, Anthropic, or Google) should target all 3 E's. These workflows have predictable inputs/outputs and can leverage scorers like semantic similarity, faithfulness (useful for translations), and others for efficacy measurement.

When adding a new workflow, start with Efficiency and Expense coverage immediately, then iterate on Efficacy as you build confidence in ground truth data.

## Running Evals

### Local Development

```bash
# Run evals once and serve the UI
npm run test:eval

# Or run directly with evalite
npx evalite serve tests/eval
```

This runs all `*.eval.ts` files in one pass and opens the Evalite UI at `http://localhost:3006` for exploring results. There is no watch mode—you'll need to manually re-run when you're ready to test changes.

**Running a single eval file:**

```bash
# Run in CLI only (no UI)
npx evalite summarization.eval.ts

# Run and serve UI
npx evalite serve summarization.eval.ts
```

### CI/CD

Evals run automatically on pushes to `main` (or via manual workflow dispatch). The CI job executes the evals, exports the JSON output, and posts the raw results to the Evalite API used by `evaluating-mux-ai`.

**For local development/testing:**

```bash
# Run evals and export results as a dry run (inspect without publishing)
npm run evalite:post-results:dev
```

**For production (internal maintainers only):**

> ⚠️ The production script posts results to the live Evalite dashboard and is not intended for OSS contributors. It requires internal credentials and should only be run by project maintainers.

```bash
# Run evals, export results, and post to production endpoint
npm run evalite:post-results:production
```

The post step requires `EVALITE_RESULTS_ENDPOINT` (full URL to `/api/evalite-results`) and uses `EVALITE_INGEST_SECRET` as the shared secret header.

## Eval Structure

Each eval follows a consistent structure:

```typescript
import { evalite } from "evalite";
import { reportTrace } from "evalite/traces";

evalite("Workflow Name", {
  // Test data with inputs and expected outputs
  data: [
    {
      input: { assetId: "...", provider: "openai" },
      expected: { /* ground truth */ },
    },
  ],

  // The task to evaluate
  task: async (input) => {
    const startTime = performance.now();
    const result = await workflowFunction(input);
    const latencyMs = performance.now() - startTime;

    // Report trace for the UI
    reportTrace({
      input,
      output: result,
      usage: result.usage,
      start: startTime,
      end: startTime + latencyMs,
    });

    return { ...result, latencyMs };
  },

  // Scorers measure different aspects
  scorers: [
    // Efficacy scorers
    { name: "accuracy", scorer: ({ output, expected }) => /* 0-1 */ },

    // Efficiency scorers
    { name: "latency-performance", scorer: ({ output }) => /* 0-1 */ },
    { name: "token-efficiency", scorer: ({ output }) => /* 0-1 */ },

    // Expense scorers
    { name: "cost-within-budget", scorer: ({ output }) => /* 0-1 */ },
  ],
});
```

## Scorer Categories

### Efficacy Scorers

Measure output quality against ground truth. Examples include:

- **Detection/Classification Accuracy** — Does the output match expected labels?
- **Confidence Calibration** — Are confidence scores appropriately high/low?
- **Response Integrity** — Are all fields valid and properly formatted?
- **Semantic Similarity** — Do outputs match reference answers semantically?
- **No Filler Phrases** — Does output avoid meta-descriptive language?

### Efficiency Scorers

Measure performance characteristics:

- **Latency Performance** — Wall clock time normalized against thresholds
- **Token Efficiency** — Total tokens normalized against budget

### Expense Scorers

Measure cost characteristics:

- **Usage Data Present** — Validates token usage is returned
- **Cost Within Budget** — Estimated USD cost normalized against threshold

## Adding New Evals

When adding a new workflow, create a corresponding eval file:

1. Create `tests/eval/{workflow-name}.eval.ts`
2. Define test assets with ground truth expectations
3. Implement scorers for each of the 3 E's
4. Run locally to verify: `npx evalite serve tests/eval/{workflow-name}.eval.ts`

Example thresholds to consider:

```typescript
// Efficacy
const CONFIDENCE_THRESHOLD = 0.8;

// Efficiency
const LATENCY_THRESHOLD_GOOD_MS = 5000;
const LATENCY_THRESHOLD_ACCEPTABLE_MS = 12000;
const TOKEN_THRESHOLD_EFFICIENT = 4000;

// Expense
const COST_THRESHOLD_USD = 0.012;
```

## Cross-Provider Testing

All evals test across multiple providers to compare results:

```typescript
const providers: SupportedProvider[] = ["openai", "anthropic", "google"];

const data = providers.flatMap(provider =>
  testAssets.map(asset => ({
    input: { assetId: asset.assetId, provider },
    expected: asset.expected,
  })),
);
```

This enables side-by-side comparison of:

- Quality differences between providers
- Latency characteristics
- Token consumption patterns
- Cost per request

## Model Pricing

Evals calculate estimated costs using provider pricing for the default models:

| Provider | Model | Input (per 1M tokens) | Output (per 1M tokens) |
|----------|-------|----------------------|------------------------|
| OpenAI | gpt-5.1 | $1.25 | $10.00 |
| Anthropic | claude-sonnet-4-5 | $3.00 | $15.00 |
| Google | gemini-3-flash-preview | $0.50 | $3.00 |

Pricing sources (verify periodically):
- [OpenAI Pricing](https://openai.com/api/pricing)
- [Anthropic Pricing](https://www.anthropic.com/pricing)
- [Google AI Pricing](https://ai.google.dev/pricing)

## Resources

- [Evalite Documentation](https://v1.evalite.dev/)
- [Evalite CLI Reference](https://v1.evalite.dev/api/cli/)
- [CI/CD Integration Guide](https://v1.evalite.dev/tips/run-evals-on-ci-cd)
