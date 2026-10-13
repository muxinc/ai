import type { LanguageModel } from "ai";

// Explicit capabilities for models supported by this SDK. Unknown/custom models
// keep provider defaults; selecting a new model never guesses that none is valid.
const OPENAI_REPAIR_CAPABILITIES: Record<string, { supportsReasoningNone: boolean }> = {
  "gpt-5.1": { supportsReasoningNone: true },
  "gpt-5.6-luna": { supportsReasoningNone: true },
  "gpt-6-luna": { supportsReasoningNone: true },
  "gpt-6-sol": { supportsReasoningNone: true },
};

export function getTextRepairProviderOptions(model: LanguageModel) {
  if (typeof model !== "object" || !model.provider.startsWith("openai.") ||
    !OPENAI_REPAIR_CAPABILITIES[model.modelId]?.supportsReasoningNone) {
    return undefined;
  }
  return { openai: { reasoningEffort: "none", store: false } };
}
