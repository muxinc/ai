import type { EvalModelConfig } from "../../src/lib/providers";
import { resolveEvalModelConfigsFromEnv } from "../../src/lib/providers";

/**
 * Flattened list of (provider, modelId) pairs for evaluation iteration.
 * Resolved from env so eval runs can target default models, all models, or an explicit list.
 * Lives with the evals, not in `src/`, so a bad eval env var can't break importing the library.
 */
export const EVAL_MODEL_CONFIGS: EvalModelConfig[] = resolveEvalModelConfigsFromEnv();
