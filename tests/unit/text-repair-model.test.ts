import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTextRepairGenerator } from "../../src/lib/text-repair-model.ts";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: vi.fn() };
});

const plan = { spans: [{ id: "p_0", text: "Long draft.", budgets: [{ unit: "characters" as const, value: 8 }] }], protectedTerms: [] };

beforeEach(() => {
  vi.mocked(generateText).mockReset();
  vi.mocked(generateText).mockResolvedValue({ finishReason: "stop", output: { p_0: "Short." }, usage: { totalTokens: 12 } } as any);
});

describe("repair model configuration and defensive output handling", () => {
  it.each(["gpt-6-luna", "gpt-6-sol", "gpt-5.6-luna", "gpt-5.1"])("uses known capabilities for %s in the reusable adapter", async (modelId) => {
    await createTextRepairGenerator({ model: createOpenAI({ apiKey: "test" }).responses(modelId) })(plan);
    expect(vi.mocked(generateText).mock.calls[0][0]).toMatchObject({
      maxRetries: 0,
      providerOptions: { openai: { reasoningEffort: "none", store: false } },
    });
  });

  it.each(["gpt-6-astra", "gpt-5-mini", "gpt-9-new", "custom-model"])("keeps provider defaults for %s", async (modelId) => {
    await createTextRepairGenerator({ model: createOpenAI({ apiKey: "test" }).responses(modelId) })(plan);
    expect(vi.mocked(generateText).mock.calls[0][0].providerOptions).toBeUndefined();
  });

  it("preserves explicit caller configuration", async () => {
    const providerOptions = { openai: { reasoningEffort: "low", store: true } };
    await createTextRepairGenerator({ model: createOpenAI({ apiKey: "test" }).responses("gpt-6-luna"), providerOptions })(plan);
    expect(vi.mocked(generateText).mock.calls[0][0].providerOptions).toEqual(providerOptions);
  });

  it("does not infer OpenAI capabilities for another provider or a gateway string", async () => {
    for (const model of [{ provider: "openai-compatible.chat", modelId: "gpt-6-luna" }, "openai/gpt-6-luna"]) {
      await createTextRepairGenerator({ model: model as any })(plan);
      expect(vi.mocked(generateText).mock.calls.at(-1)![0].providerOptions).toBeUndefined();
    }
  });

  it("retains the defensive missing-output guard and call usage", async () => {
    vi.mocked(generateText).mockResolvedValueOnce({ finishReason: "stop", output: undefined, usage: { totalTokens: 12 } } as any);
    const result = await createTextRepairGenerator({ model: "custom/model" })(plan);
    expect(result).toMatchObject({ error: "Repair output missing", usage: { totalTokens: 12 } });
    expect(result).not.toHaveProperty("replacements");
  });
});
