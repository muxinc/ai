import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getLanguageModelDeprecation,
  resetLanguageModelDeprecationWarningsForTests,
  resolveLanguageModelConfig,
} from "../../src/lib/providers";

describe("language model deprecations", () => {
  beforeEach(() => {
    resetLanguageModelDeprecationWarningsForTests();
    vi.restoreAllMocks();
  });

  it("exposes deprecation metadata for deprecated models", () => {
    const deprecation = getLanguageModelDeprecation("google", "gemini-2.5-flash");
    expect(deprecation).toMatchObject({
      provider: "google",
      modelId: "gemini-2.5-flash",
      replacementModelId: "gemini-3.1-flash-lite-preview",
      phase: "warn",
    });
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
    expect(firstWarning).toContain("google:gemini-2.5-flash");
    expect(firstWarning).toContain("google:gemini-3.1-flash-lite-preview");
    expect(firstWarning).toContain("Planned removal date");
  });

  it("does not warn for non-deprecated models", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    resolveLanguageModelConfig({
      provider: "google",
      model: "gemini-3.1-flash-lite-preview",
    });

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
