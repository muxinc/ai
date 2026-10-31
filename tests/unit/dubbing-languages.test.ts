import { describe, expect, it } from "vitest";

import { getDubbingLanguageCodePair, normalizeDubbingLanguageCode, normalizeDubbingSourceLanguageCode } from "../../src/lib/dubbing-languages.ts";

describe("dubbing v1 languages", () => {
  it.each([
    [" FRA ", "fr", "fra"],
    ["es", "es", "spa"],
    ["hye", "hy", "hye"],
    ["yue", "yue", "yue"],
    ["fil", "fil", "fil"],
    ["tgl", "tl", "tgl"],
    ["ast", "ast", "ast"],
    ["urd", "ur", "urd"],
  ])("normalizes %s without requiring a two-letter code", (input, tag, iso3) => {
    expect(normalizeDubbingLanguageCode(input)).toBe(tag);
    expect(getDubbingLanguageCodePair(input)).toEqual({ iso639_1: tag, iso639_3: iso3 });
  });

  it.each(["es-MX", "", "not-a-language", "constructor", "toString", "eu"])("rejects %s before paid work", (code) => {
    expect(() => normalizeDubbingLanguageCode(code)).toThrow(expect.objectContaining({ publicType: "validation_error" }));
  });
});

it("keeps source auto-detection and source-only languages while normalizing ISO aliases", () => {
  expect(normalizeDubbingSourceLanguageCode(" AUTO ")).toBeUndefined();
  expect(normalizeDubbingSourceLanguageCode("hye")).toBe("hy");
  expect(normalizeDubbingSourceLanguageCode("ak")).toBe("ak");
});
