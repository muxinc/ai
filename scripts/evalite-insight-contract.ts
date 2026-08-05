import { z } from "zod";

export const WorkflowInsightSchema = z.object({
  summaryMarkdown: z.string().trim().min(1),
  tldr: z.string().trim().min(1).nullable(),
  caveat: z.string().trim().min(1).nullable(),
});

export function normalizeOptionalInsight(value: string | null | undefined): string | undefined {
  return value?.trim() || undefined;
}
