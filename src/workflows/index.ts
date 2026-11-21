export type { TextLengthLimit } from "../lib/text-length.ts";
export { createTextRepairGenerator, repairText } from "../lib/text-repair-model.ts";
export type { TextRepairModelOptions } from "../lib/text-repair-model.ts";
// Shared paragraph repair for SDK workflow consumers.
export { applyTextRepair, planTextRepair, repairJsonSchema, runTextRepairLoop } from "../lib/text-repair.ts";
export type { RepairAttempt, RepairCall, RepairFailureOutcome, RepairOptions, RepairPlan, RepairRejectionCode, RepairResult, RepairSpan } from "../lib/text-repair.ts";
export * from "./ask-questions.ts";
export * from "./burned-in-captions.ts";
export * from "./chapters.ts";
export * from "./edit-captions.ts";
export * from "./embeddings.ts";
export * from "./engagement-insights.ts";

// generateContextualText, moderate and summarize alias SDK workflows under their Mux Robots
// workflow names. See docs/WORKFLOWS.md#mux-robots-workflow-names.
export * from "./generate-text.ts";
export { generateText as generateContextualText } from "./generate-text.ts";
export * from "./moderation.ts";
export { getModerationScores as moderate } from "./moderation.ts";
export * from "./summarization.ts";
export { getSummaryAndTags as summarize } from "./summarization.ts";
export * from "./translate-audio.ts";
export * from "./translate-captions.ts";
