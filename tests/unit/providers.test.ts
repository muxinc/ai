import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  calculateModelCost,
  DEFAULT_LANGUAGE_MODELS,
  getLanguageModelDeprecation,
  LANGUAGE_MODELS,
  MODEL_PRICING,
  resetLanguageModelDeprecationWarningsForTests,
  resolveLanguageModelConfig,
} from "../../src/lib/providers";

describe("language model deprecations", () => {
  beforeEach(() => {
    resetLanguageModelDeprecationWarningsForTests();
    vi.restoreAllMocks();
  });

  it("exposes deprecation metadata for deprecated models", () => {
    const openaiDeprecation = getLanguageModelDeprecation("openai", "gpt-5.1");
    expect(openaiDeprecation).toMatchObject({
      provider: "openai",
      modelId: "gpt-5.1",
      replacementModelId: "gpt-5.6-luna",
      phase: "warn",
      deprecatedOn: "2026-08-01",
      sunsetOn: "2026-10-01",
    });

    const deprecation = getLanguageModelDeprecation("google", "gemini-2.5-flash");
    expect(deprecation).toMatchObject({
      provider: "google",
      modelId: "gemini-2.5-flash",
      replacementModelId: "gemini-3.1-flash-lite",
      phase: "warn",
    });
  });

  it("uses GPT-5.6 Luna as the OpenAI default while retaining GPT-5.1 during its grace period", () => {
    expect(DEFAULT_LANGUAGE_MODELS.openai).toBe("gpt-5.6-luna");
    expect(LANGUAGE_MODELS.openai).toEqual(["gpt-5.6-luna", "gpt-5.1", "gpt-5-mini"]);
  });

  it("warns GPT-5.1 callers to migrate to GPT-5.6 Luna before the sunset date", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    resolveLanguageModelConfig({ provider: "openai", model: "gpt-5.1" });

    expect(warnSpy).toHaveBeenCalledOnce();
    const warning = String(warnSpy.mock.calls[0]?.[0]);
    expect(warning).toContain("model=\"gpt-5.1\"");
    expect(warning).toContain("model=\"gpt-5.6-luna\"");
    expect(warning).toContain("2026-10-01");
  });

  it("warns once per deprecated model during grace period", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    resolveLanguageModelConfig({
      provider: "google",
      model: "gemini-2.5-flash",
    });
    resolveLanguageModelConfig({
      provider: "google",
      model: "gemini-2.5-flash",
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const firstWarning = String(warnSpy.mock.calls[0]?.[0]);
    expect(firstWarning).toContain("provider=\"google\" model=\"gemini-2.5-flash\"");
    expect(firstWarning).toContain("provider=\"google\" model=\"gemini-3.1-flash-lite\"");
    expect(firstWarning).toContain("Planned removal date");
  });

  it("does not warn for non-deprecated models", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    resolveLanguageModelConfig({
      provider: "google",
      model: "gemini-3.1-flash-lite",
    });

    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("model pricing", () => {
  it("tracks official GPT-5.6 Luna standard and long-context rates", () => {
    expect(MODEL_PRICING["gpt-5.6-luna"]).toMatchObject({
      inputPerMillion: 0.20,
      cachedInputPerMillion: 0.02,
      cacheWritePerMillion: 0.25,
      outputPerMillion: 1.20,
      longContext: {
        inputTokenThreshold: 272_000,
        inputPerMillion: 0.40,
        cachedInputPerMillion: 0.04,
        cacheWritePerMillion: 0.50,
        outputPerMillion: 1.80,
      },
    });
  });

  it("uses GPT-5.6 Luna long-context rates only above 272K input tokens", () => {
    expect(calculateModelCost("gpt-5.6-luna", 272_000, 10_000, 20_000, 10_000)).toBeCloseTo(0.0633, 10);
    expect(calculateModelCost("gpt-5.6-luna", 272_001, 10_000, 20_000, 10_000)).toBeCloseTo(0.1206004, 10);
  });
});

describe("model config resolution", () => {
  it("falls back to the provider default when model is an empty string", () => {
    expect(resolveLanguageModelConfig({ provider: "openai", model: "" })).toEqual({
      provider: "openai",
      modelId: DEFAULT_LANGUAGE_MODELS.openai,
    });
  });
});
