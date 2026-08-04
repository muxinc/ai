import { describe, expect, it } from "vitest";

import {
  normalizeOptionalInsight,
  WorkflowInsightSchema,
} from "../../scripts/evalite-insight-contract";

describe("workflow insight schema", () => {
  it("accepts non-empty insight text and nullable optional insights", () => {
    expect(WorkflowInsightSchema.parse({
      summaryMarkdown: "  Summary  ",
      tldr: null,
      caveat: "  Small sample size.  ",
    })).toEqual({
      summaryMarkdown: "Summary",
      tldr: null,
      caveat: "Small sample size.",
    });
  });

  it.each(["", "   "])("rejects an empty summary (%j)", (summaryMarkdown) => {
    expect(WorkflowInsightSchema.safeParse({
      summaryMarkdown,
      tldr: null,
      caveat: null,
    }).success).toBe(false);
  });

  it.each(["", "   "])("rejects an empty optional insight (%j)", (emptyInsight) => {
    expect(WorkflowInsightSchema.safeParse({
      summaryMarkdown: "Summary",
      tldr: emptyInsight,
      caveat: null,
    }).success).toBe(false);
  });
});

describe("normalizeOptionalInsight", () => {
  it.each([null, undefined, "", "   "])("omits an absent insight (%j)", (value) => {
    expect(normalizeOptionalInsight(value)).toBeUndefined();
  });

  it("trims a present insight", () => {
    expect(normalizeOptionalInsight("  Small sample size.  ")).toBe("Small sample size.");
  });
});
