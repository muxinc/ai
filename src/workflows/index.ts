export type { TextLengthLimit } from "../lib/text-length.ts";
export { createTextRepairGenerator, repairText } from "../lib/text-repair-model.ts";
export type { TextRepairModelOptions } from "../lib/text-repair-model.ts";
// Shared paragraph repair: usable by workflow callers such as Robots.
export { applyTextRepair, planTextRepair, repairJsonSchema, runTextRepairLoop } from "../lib/text-repair.ts";
export type { RepairAttempt, RepairCall, RepairOptions, RepairPlan, RepairResult, RepairSpan } from "../lib/text-repair.ts";
export * from "./ask-questions.ts";
export * from "./burned-in-captions.ts";
export * from "./chapters.ts";
export * from "./edit-captions.ts";
export * from "./embeddings.ts";
export * from "./engagement-insights.ts";

export * from "./generate-text.ts";
export * from "./moderation.ts";
export * from "./summarization.ts";
export * from "./translate-audio.ts";
export * from "./translate-captions.ts";
