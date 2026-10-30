import { describe, expect, it } from "vitest";

import {
  getLanguageName,
  isUndeterminedLanguageCode,
  toISO639_1,
  toISO639_3,
} from "../../src/lib/language-codes";

// ─────────────────────────────────────────────────────────────────────────────
// isUndeterminedLanguageCode
// ─────────────────────────────────────────────────────────────────────────────

describe("isUndeterminedLanguageCode", () => {
  it.each(["und", "mul", "mis", "zxx"])("returns true for special code '%s'", (code) => {
    expect(isUndeterminedLanguageCode(code)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isUndeterminedLanguageCode("UND")).toBe(true);
    expect(isUndeterminedLanguageCode("Und")).toBe(true);
  });

  it("trims whitespace", () => {
    expect(isUndeterminedLanguageCode(" und ")).toBe(true);
  });

  it.each(["en", "nn", "fr", "de", "ja"])("returns false for real language code '%s'", (code) => {
    expect(isUndeterminedLanguageCode(code)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isUndeterminedLanguageCode("")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getLanguageName
// ─────────────────────────────────────────────────────────────────────────────

describe("getLanguageName", () => {
  it("returns undefined for undetermined language code", () => {
    expect(getLanguageName("und")).toBeUndefined();
  });

  it("returns undefined for all special codes", () => {
    expect(getLanguageName("mul")).toBeUndefined();
    expect(getLanguageName("mis")).toBeUndefined();
    expect(getLanguageName("zxx")).toBeUndefined();
  });

  it("returns the correct name for English", () => {
    expect(getLanguageName("en")).toBe("English");
  });

  it("returns the correct name for Norwegian Nynorsk", () => {
    // nn is a real language code — the upstream fix converts bad detections to "und"
    expect(getLanguageName("nn")).toBe("Norwegian Nynorsk");
  });

  it("returns human-readable names for common languages", () => {
    expect(getLanguageName("fr")).toBe("French");
    expect(getLanguageName("es")).toBe("Spanish");
    expect(getLanguageName("ja")).toBe("Japanese");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// toISO639_3 / toISO639_1
// ─────────────────────────────────────────────────────────────────────────────

describe("toISO639_3", () => {
  it.each([
    ["en", "eng"],
    ["eng", "eng"],
    [" FR ", "fra"],
  ])("converts '%s' to '%s'", (code, expected) => {
    expect(toISO639_3(code)).toBe(expected);
  });

  it.each([
    ["pt-BR", "por"],
    ["mr-in", "mar"],
    ["zh_Hans", "zho"],
    ["por-BR", "por"],
  ])("drops the subtag from '%s' and converts to '%s'", (code, expected) => {
    expect(toISO639_3(code)).toBe(expected);
  });

  it("returns the primary subtag for an unknown language", () => {
    expect(toISO639_3("xx-YY")).toBe("xx");
  });
});

describe("toISO639_1", () => {
  it.each([
    ["eng", "en"],
    ["en", "en"],
    [" FRA ", "fr"],
  ])("converts '%s' to '%s'", (code, expected) => {
    expect(toISO639_1(code)).toBe(expected);
  });

  it.each([
    ["pt-BR", "pt"],
    ["por-BR", "pt"],
    ["mr_IN", "mr"],
  ])("drops the subtag from '%s' and converts to '%s'", (code, expected) => {
    expect(toISO639_1(code)).toBe(expected);
  });
});
