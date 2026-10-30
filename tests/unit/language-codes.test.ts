import { describe, expect, it } from "vitest";

import {
  getLanguageName,
  isUndeterminedLanguageCode,
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
