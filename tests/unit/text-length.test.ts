import { afterEach, describe, expect, it, vi } from "vitest";

const RealSegmenter = (Intl as any).Segmenter;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("shared text length measurement", () => {
  it("reuses segmentation while counting Markdown words, non-spaced scripts and Unicode characters", async () => {
    vi.resetModules();
    const constructed = vi.fn();
    class Segmenter extends RealSegmenter {
      constructor(locale: string, options: { granularity: "word" }) {
        super(locale, options);
        constructed();
      }
    }
    vi.stubGlobal("Intl", { Segmenter });
    const { measureGenerateTextLength: measure } = await import("../../src/lib/text-length.ts");
    expect(measure("**hello** world", "words")).toBe(2);
    expect(measure("你好世界", "words")).toBe(2);
    expect(measure("😀😀", "characters")).toBe(2);
    expect(measure("   ", "words")).toBe(0);
    expect(constructed).toHaveBeenCalledTimes(1);
  });

  it("retains whitespace fallback when Intl.Segmenter is unavailable", async () => {
    vi.resetModules();
    vi.stubGlobal("Intl", { Segmenter: undefined });
    const { measureGenerateTextLength: measure } = await import("../../src/lib/text-length.ts");
    expect(measure(" one\n two\tthree ", "words")).toBe(3);
    expect(measure("你好世界", "words")).toBe(1);
    expect(measure("😀😀", "characters")).toBe(2);
    expect(measure("  ", "words")).toBe(0);
  });
});
