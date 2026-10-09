import { describe, expect, it, vi } from "vitest";

import type { RepairPlan } from "../../src/workflows/index.ts";
import { applyTextRepair, planTextRepair, repairJsonSchema, runTextRepairLoop } from "../../src/workflows/index.ts";

describe("bounded text repair", () => {
  it("does not call a model for content already within the cap", async () => {
    const generate = vi.fn();
    const result = await runTextRepairLoop({ content: "Fits.", limits: [{ unit: "characters", value: 5 }], generate });
    expect(result.status).toBe("valid");
    expect(generate).not.toHaveBeenCalled();
  });

  it("does not accept an empty draft merely because its length fits", async () => {
    const generate = vi.fn();
    expect((await runTextRepairLoop({ content: "  ", limits: [{ unit: "characters", value: 100 }], generate })).status).toBe("failed");
    expect(generate).not.toHaveBeenCalled();
  });

  it("preserves untouched text and exact blank-line separators", () => {
    const content = `Keep.\r\n \r\n${"Long text ".repeat(20)}`;
    const plan = planTextRepair(content, [{ unit: "characters", value: 170 }])!;
    expect(plan.spans).toHaveLength(1);
    expect(applyTextRepair(content, plan, { [plan.spans[0].id]: "Short." })).toEqual({ accepted: true, content: "Keep.\r\n \r\nShort." });
  });

  it("spreads cuts when one paragraph would require extreme compression", () => {
    const content = `${"a ".repeat(50)}\n\n${"b ".repeat(50)}\n\n${"c ".repeat(50)}`;
    const plan = planTextRepair(content, [{ unit: "words", value: 120 }])!;
    expect(plan.spans).toHaveLength(3);
    expect(plan.spans.every(span => span.budgets[0].value >= 35)).toBe(true);
  });

  it.each([
    { content: `${"long ".repeat(100)}\n\nEnd.`, limits: [{ unit: "words" as const, value: 10 }] },
    { content: `${"x".repeat(1000)}\n\nY`, limits: [{ unit: "characters" as const, value: 100 }] },
    { content: `${"long ".repeat(100)}\n\n😀`, limits: [{ unit: "words" as const, value: 10 }, { unit: "characters" as const, value: 100 }] },
  ])("repairs large overshoots with short or zero-word sibling paragraphs ($limits)", async ({ content, limits }) => {
    const generate = vi.fn(async (_plan: RepairPlan) => ({ replacements: { p_0: "Brief.", p_2: content.split("\n\n")[1] }, elapsedMs: 1 }));
    const result = await runTextRepairLoop({ content, limits, generate });
    expect(result.status).toBe("valid");
    expect(generate).toHaveBeenCalledTimes(1);
    const plan = generate.mock.calls[0][0];
    expect(plan.spans).toHaveLength(2);
    expect(plan.spans.every(span => span.budgets.every(budget => budget.value >= 1))).toBe(true);
    for (const [index, limit] of limits.entries())
      expect(plan.spans.reduce((sum, span) => sum + span.budgets[index].value, 0)).toBeLessThanOrEqual(limit.value);
  });

  it("uses SDK word segmentation for hyphenated text and code points for emoji", async () => {
    const noCall = vi.fn();
    expect((await runTextRepairLoop({ content: "😀😀", limits: [{ unit: "characters", value: 2 }], generate: noCall })).status).toBe("valid");
    expect(noCall).not.toHaveBeenCalled();
    expect(planTextRepair("state-of-the-art video workflow", [{ unit: "words", value: 5 }])).not.toBeNull();
  });

  it("repairs emoji-only text under simultaneous word and character caps", async () => {
    const result = await runTextRepairLoop({
      content: "😀".repeat(20),
      limits: [{ unit: "words", value: 5 }, { unit: "characters", value: 10 }],
      generate: async () => ({ replacements: { p_0: "😀".repeat(5) }, elapsedMs: 1 }),
    });
    expect(result.status).toBe("valid");
    if (result.status === "valid")
      expect(result.content).toBe("😀".repeat(5));
  });

  it("restricts edit fields without forcing truncated prose through a character pattern", () => {
    const plan = planTextRepair("Long content ".repeat(30), [{ unit: "characters", value: 280 }])!;
    const schema = repairJsonSchema(plan);
    expect(schema.required).toEqual(["p_0"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.p_0).toEqual({ type: "string" });
    expect(plan.spans[0].budgets).toEqual([{ unit: "characters", value: 270 }]);
  });

  it("rejects unexpected IDs, stale plans, blank text and escaped or new paragraphs", () => {
    const content = "Long content ".repeat(30);
    const plan = planTextRepair(content, [{ unit: "characters", value: 280 }])!;
    for (const replacements of [{}, { p_0: "short", other: "extra" }, { p_0: "" }, { p_0: "x\\ny" }, { p_0: "x\n\ny" }]) {
      expect(applyTextRepair(content, plan, replacements).accepted).toBe(false);
    }
    expect(applyTextRepair("Changed.", plan, { p_0: "Short." }).accepted).toBe(false);
  });

  it("checks protected terms in edited spans even when they occur elsewhere", () => {
    const content = `Mux.\n\nMux ${"long ".repeat(30)}`;
    const plan = planTextRepair(content, [{ unit: "characters", value: 150 }], ["Mux", "absent"])!;
    expect(plan.protectedTerms).toEqual(["Mux"]);
    expect(applyTextRepair(content, plan, { [plan.spans[0].id]: "Short." }).accepted).toBe(false);
  });

  it("validates both limits before returning an assembled output", async () => {
    const generate = vi.fn(async () => ({ replacements: { p_0: "state-of-the-art video workflow" }, elapsedMs: 1 }));
    const result = await runTextRepairLoop({ content: "long ".repeat(30), limits: [{ unit: "words", value: 5 }, { unit: "characters", value: 100 }], generate });
    expect(result.status).toBe("failed");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(result).not.toHaveProperty("content");
  });

  it.each([
    { content: "x".repeat(200), replacement: "Short words.", limits: [{ unit: "words" as const, value: 5 }, { unit: "characters" as const, value: 100 }] },
    { content: "a b c d e f", replacement: "One longer replacement.", limits: [{ unit: "words" as const, value: 5 }, { unit: "characters" as const, value: 100 }] },
  ])("accepts a repair meeting every cap even when the other unit grows ($replacement)", async ({ content, replacement, limits }) => {
    const generate = vi.fn(async () => ({ replacements: { p_0: replacement }, usage: { tokens: 12 }, elapsedMs: 1 }));
    const result = await runTextRepairLoop({ content, limits, generate, maxAttempts: 1 });
    expect(result.status).toBe("valid");
    expect(result.content).toBe(replacement);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.attempts[0].call.usage).toEqual({ tokens: 12 });
  });

  it("replans a smaller candidate and retains usage for each bounded attempt", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ replacements: { p_0: "x".repeat(110) }, usage: { tokens: 20 }, elapsedMs: 1 })
      .mockResolvedValueOnce({ replacements: { p_0: "Short." }, usage: { tokens: 10 }, elapsedMs: 1 });
    const result = await runTextRepairLoop({ content: "x".repeat(200), limits: [{ unit: "characters", value: 100 }], generate });
    expect(result.status).toBe("valid");
    expect(result.content).toBe("Short.");
    expect(result.attempts.map(attempt => attempt.call.usage)).toEqual([{ tokens: 20 }, { tokens: 10 }]);
    expect(generate.mock.calls[1][0].spans[0].text).toHaveLength(110);
  });

  it("stops after provider errors and retains reported failed-call usage", async () => {
    const generate = vi.fn(async () => ({ error: "refusal", usage: { tokens: 12 }, elapsedMs: 1 }));
    const result = await runTextRepairLoop({ content: "x".repeat(200), limits: [{ unit: "characters", value: 100 }], generate });
    expect(result.status).toBe("failed");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.attempts[0].call.usage).toEqual({ tokens: 12 });
  });

  it("rejects unbounded retries and reports impossible budgets without calling a model", async () => {
    const generate = vi.fn();
    await expect(runTextRepairLoop({ content: "x", limits: [{ unit: "characters", value: 1 }], generate, maxAttempts: 3 })).rejects.toThrow("one or two");
    const result = await runTextRepairLoop({ content: "long\n\ntext", limits: [{ unit: "characters", value: 1 }], generate });
    expect(result.status).toBe("failed");
    expect(generate).not.toHaveBeenCalled();
  });
});
