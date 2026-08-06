# Vision-Capable Models

The `baseten` and `openai-compatible` providers serve user-deployed models, so `@mux/ai` can't know whether your model accepts images. Workflows that analyze storyboards or frames — `getSummaryAndTags`, `hasBurnedInCaptions`, `askQuestions`, and `generateEngagementInsights` — require a vision-capable model. Text-only workflows (`generateChapters`, `translateCaptions`, `editCaptions`) work with almost any language model — they still need structured-output support and a context window large enough for the transcript.

A model must satisfy two requirements to work with the image-based workflows:

1. **Image input via `image_url`.** By default (`imageSubmissionMode: "url"`) workflows send the storyboard as a remote URL, which the inference endpoint fetches server-side. The URL must be reachable over HTTPS from wherever the model runs. If your endpoint can't fetch remote URLs, set `imageSubmissionMode: "base64"` and the image is inlined instead.
2. **Structured outputs (`response_format: json_schema`).** Workflows request schema-constrained JSON. Endpoints without JSON schema support fail loudly rather than producing unparseable output.

## Baseten Model APIs

Verified against [Baseten's Model APIs catalog](https://docs.baseten.co/development/model-apis/overview) and tested with `@mux/ai` (August 2026):

| Model | Slug | Notes |
| --- | --- | --- |
| Kimi K3 | `moonshotai/Kimi-K3` | Verified with `@mux/ai`. Up to 96 images / 240 MB per request via URL. |
| Inkling | `thinkingmachines/inkling` | Verified with `@mux/ai`. Reasoning model; occasionally emits degenerate output on an otherwise-healthy request — `withRetry` handles this automatically. |
| Inkling Small | `thinkingmachines/inkling-small` | Verified with `@mux/ai`. Smaller, cheaper Inkling variant. Same retry note applies. |
| Kimi K2.6 | `moonshotai/Kimi-K2.6` | Verified with `@mux/ai`, despite not being badged as a vision model in the catalog. |
| Kimi K2.7 Code | `moonshotai/Kimi-K2.7-Code` | Verified with `@mux/ai`, despite not being badged as a vision model in the catalog. |

Other Model APIs models (DeepSeek V4, GLM 4.7/5.2, Nemotron, `gpt-oss-120b`) are text-only — no good for the image-based workflows, but perfectly usable with transcript-only workflows like `generateChapters`, `translateCaptions`, and `editCaptions`.

For dedicated Baseten deployments, vision support depends entirely on the model you deployed — any of the models below served behind a `/sync/v1` endpoint should work. You can also fine-tune your own: [Fine-tuning a multimodal model for video intelligence](https://www.mux.com/blog/fine-tuning-a-multi-modal-model-for-video-intelligence) walks through LoRA fine-tuning Mistral Small 3.1 on `@mux/ai` workflow outputs with Baseten's training SDK and consuming the dedicated deployment through the `baseten` provider.

## Likely works: Mistral (hosted or self-hosted)

We haven't tested these with `@mux/ai` — they're listed because Mistral documents image input over the OpenAI-compatible API. Run [the verification script](#verifying-a-model) before relying on one. Point `OPENAI_COMPATIBLE_BASE_URL` at `https://api.mistral.ai/v1` (or self-host via vLLM).

| Model | Notes |
| --- | --- |
| Mistral Small 4 | Multimodal MoE; merged the former Pixtral line. Configurable reasoning effort. |
| Mistral Medium 3.5 | Dense 128B multimodal, 256K context. |
| Mistral Large 3 (`mistral-large-2512`) | Flagship, vision-capable. |
| Mistral Small 3.2 / Ministral 3 family | Smaller vision-capable options. |

Pixtral 12B and Pixtral Large are deprecated by Mistral — use the models above instead.

## Likely works: self-hosted open weights (vLLM, SGLang, Ollama)

Also untested with `@mux/ai`. These model families document image input support via OpenAI-compatible serving — verify with [the script](#verifying-a-model) against your own deployment.

| Model family | Notes |
| --- | --- |
| Qwen3-VL (30B-A3B, 235B-A22B) | Purpose-built VLM; strongest open-weights option for OCR and document-heavy content. vLLM ≥ 0.11. |
| Llama 4 (Scout, Maverick) | Natively multimodal. |
| InternVL3 | Strong image understanding, MIT license. |
| GLM-4.6V | Vision with multimodal tool use. |
| Gemma 3 (4B/12B/27B) | Vision-capable at 4B and up; check the Gemma license for commercial use. |
| Phi-4 multimodal | Efficient small option. |

Ollama caveat: Ollama's OpenAI-compatible endpoint historically accepts base64 images but does not fetch remote URLs — use `imageSubmissionMode: "base64"` there.

## Verifying a model

`scripts/verify-vision-models.ts` checks both requirements (image by URL, `json_schema` output) against live endpoints, using the same provider factory the workflows use. With no arguments it verifies the Baseten Model APIs table above:

```bash
npx tsx scripts/verify-vision-models.ts
npx tsx scripts/verify-vision-models.ts -m "moonshotai/Kimi-K3"
npx tsx scripts/verify-vision-models.ts -p openai-compatible -m "<your-model>"
```

For a full-workflow check against a real asset, use the summarization example instead:

```bash
npm run example:summarization -- <asset-id> -p baseten -m "moonshotai/Kimi-K3"
```

Failure modes to expect from a non-vision model: an explicit provider error about image content, or low-quality output that ignores the storyboard (the model answers from the transcript alone). If you see `No output generated` persistently after retries, the model likely can't satisfy the JSON schema constraint.

Model catalogs move quickly — the Baseten Model APIs table was last verified with `verify-vision-models.ts` in August 2026; the "likely works" sections are curated from vendor documentation only. To promote a model out of "likely works" (or add a new one), run the script against it first.
