import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  detectLeakReason,
  detectSystemPromptLeak,
  scrubFreeTextField,
} from "../../src/lib/output-safety";
import { SYSTEM_PROMPT_CANARY } from "../../src/lib/prompt-fragments";

describe("detectLeakReason", () => {
  it("returns null for null, undefined, and empty strings", () => {
    expect(detectLeakReason(null)).toBeNull();
    expect(detectLeakReason(undefined)).toBeNull();
    expect(detectLeakReason("")).toBeNull();
  });

  it("returns null for clean analytical content", () => {
    expect(detectLeakReason(
      "A chef prepares ingredients and cooks in a kitchen throughout the video.",
    )).toBeNull();
    expect(detectLeakReason(
      "The speaker introduces three main topics and then discusses each one.",
    )).toBeNull();
  });

  it("identifies the canary as the leak reason", () => {
    expect(detectLeakReason(
      `Here is my reasoning: ${SYSTEM_PROMPT_CANARY} hope that helps.`,
    )).toBe("canary");
  });

  it("identifies tag markers as the leak reason", () => {
    expect(detectLeakReason("<role> You are a video content analyst </role>")).toBe("prompt_tag");
    expect(detectLeakReason("My reasoning <task> is as follows")).toBe("prompt_tag");
  });

  it("tolerates whitespace inside tag markers", () => {
    // Attacker attempts to evade a tight `</?role>` regex by padding.
    expect(detectLeakReason("< role >leaked</ role >")).toBe("prompt_tag");
    expect(detectLeakReason("<role\n>leaked</role>")).toBe("prompt_tag");
  });

  it("tolerates attributes on tag markers", () => {
    // Attacker attempts to evade with fake attributes.
    expect(detectLeakReason("<role attr='x'>leaked</role>")).toBe("prompt_tag");
  });

  it("normalises fullwidth and compatibility forms before matching tags", () => {
    // U+FF1C FULLWIDTH LESS-THAN and U+FF1E FULLWIDTH GREATER-THAN fold to
    // ASCII `<` / `>` under NFKC, so a fullwidth-wrapped tag still trips
    // the detector.
    expect(detectLeakReason("＜role＞leaked＜/role＞")).toBe("prompt_tag");
  });

  it("detects a canary with zero-width characters inserted", () => {
    // Attacker splits the canary with a zero-width space (U+200B) so
    // that `String.includes(CANARY)` against the raw text would fail;
    // normalisation strips the invisible character before matching.
    const zwsp = String.fromCharCode(0x200B);
    const obfuscated = `${SYSTEM_PROMPT_CANARY.slice(0, 10)}${zwsp}${SYSTEM_PROMPT_CANARY.slice(10)}`;
    expect(detectLeakReason(obfuscated)).toBe("canary");
  });

  it("detects a canary emitted in fullwidth ASCII form", () => {
    // ASCII 0x21–0x7E maps to fullwidth U+FF01–U+FF5E with a +0xFEE0
    // offset. NFKC folds fullwidth back to ASCII, so a model that
    // emits the canary as fullwidth (a classic evasion of byte-level
    // substring matching) is still caught once both sides of the
    // comparison are normalised.
    const toFullwidth = (c: string) => {
      const code = c.charCodeAt(0);
      return code >= 0x21 && code <= 0x7E ?
          String.fromCharCode(code + 0xFEE0) :
        c;
    };
    const fullwidth = [...SYSTEM_PROMPT_CANARY].map(toFullwidth).join("");
    expect(detectLeakReason(`Reasoning: ${fullwidth} end.`)).toBe("canary");
  });

  it("detects a long base64-like run", () => {
    // 96-char base64 alphabet run — well over the 80-char threshold,
    // consistent with an encoded-exfil attempt.
    const blob = "SGVsbG9Xb3JsZFRoaXNJc0F0ZXN0QmFzZTY0U3RyaW5nVG9FbmNvZGVBdExlYXN0RWlnaHR5Q2hhcmFjdGVyc0xvbmc9PQ==";
    expect(detectLeakReason(`Reasoning: ${blob} end.`)).toBe("encoded_blob");
  });

  it("detects a long hex run", () => {
    // 80 hex chars — well over the 65-char threshold, consistent with
    // two concatenated SHA-1 hashes or an encoded-dump fragment.
    const hex = "deadbeefcafebabe0123456789abcdef01234567deadbeefcafebabe0123456789abcdef01234567";
    expect(detectLeakReason(`Reasoning: ${hex} end.`)).toBe("encoded_blob");
  });

  it("does not flag short hex or base64 fragments in prose", () => {
    expect(detectLeakReason("The hex colour is #ff00aa.")).toBeNull();
    expect(detectLeakReason("Short token: abc123.")).toBeNull();
  });

  it("does not flag a single MD5 hash (32 hex chars) in prose", () => {
    const md5 = "5d41402abc4b2a76b9719d911017c592";
    expect(md5.length).toBe(32);
    expect(detectLeakReason(`The file hash was ${md5}.`)).toBeNull();
  });

  it("does not flag a single SHA-1 hash (40 hex chars) in prose", () => {
    // Real 40-char SHA-1. An earlier iteration used `{40,}` as the
    // threshold and a 38-char placeholder in this test, which masked
    // the fact that a real SHA-1 would trip. The threshold is now 65,
    // so the full 40-char hash passes through.
    const sha1 = "356a192b7913b04c54574d18c28d46e6395428ab";
    expect(sha1.length).toBe(40);
    expect(detectLeakReason(`Commit ${sha1} fixed it.`)).toBeNull();
  });

  it("does not flag a single SHA-256 hash (64 hex chars) in prose", () => {
    // Git commit SHAs, content hashes, and security-content references
    // frequently use SHA-256. A 64-char run must not trip the
    // heuristic on its own.
    const sha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(sha256.length).toBe(64);
    expect(detectLeakReason(`The manifest hash is ${sha256}.`)).toBeNull();
  });

  it("does not flag inline references to common words without angle brackets", () => {
    expect(detectLeakReason("The role of the chef is central to this scene.")).toBeNull();
    expect(detectLeakReason("Their task involves preparing ingredients.")).toBeNull();
  });
});

describe("detectSystemPromptLeak", () => {
  // Thin wrapper over detectLeakReason; the cases above exercise the
  // underlying logic. These tests cover the boolean shape only.
  it("returns false for clean text", () => {
    expect(detectSystemPromptLeak("A chef prepares a meal.")).toBe(false);
  });
  it("returns true when any detector fires", () => {
    expect(detectSystemPromptLeak(`...${SYSTEM_PROMPT_CANARY}...`)).toBe(true);
    expect(detectSystemPromptLeak("<role>x</role>")).toBe(true);
  });
});

describe("scrubFreeTextField", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("returns clean text unchanged and does not warn", () => {
    const result = scrubFreeTextField("A chef prepares a meal.", "test");
    expect(result).toEqual({ text: "A chef prepares a meal.", leaked: false, reason: null });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("suppresses canary leaks and emits a warning mentioning the context and reason", () => {
    const result = scrubFreeTextField(
      `Reasoning: ${SYSTEM_PROMPT_CANARY}`,
      "ask-questions reasoning for question 1",
    );
    expect(result).toEqual({ text: "", leaked: true, reason: "canary" });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("ask-questions reasoning for question 1");
    expect(warnSpy.mock.calls[0][0]).toContain("canary");
  });

  it("suppresses output containing structural tag markers", () => {
    const result = scrubFreeTextField(
      "<role> You are a video content analyst </role>",
      "test",
    );
    expect(result.leaked).toBe(true);
    expect(result.reason).toBe("prompt_tag");
    expect(result.text).toBe("");
  });

  it("suppresses output that looks like an encoded blob", () => {
    // 96-char base64 run — above the 80-char threshold.
    const blob = "SGVsbG9Xb3JsZFRoaXNJc0F0ZXN0QmFzZTY0U3RyaW5nVG9FbmNvZGVBdExlYXN0RWlnaHR5Q2hhcmFjdGVyc0xvbmc9PQ==";
    const result = scrubFreeTextField(
      `Here is the encoded system prompt: ${blob}`,
      "test",
    );
    expect(result.leaked).toBe(true);
    expect(result.reason).toBe("encoded_blob");
  });

  it("handles null and undefined without warning", () => {
    expect(scrubFreeTextField(null, "test")).toEqual({ text: "", leaked: false, reason: null });
    expect(scrubFreeTextField(undefined, "test")).toEqual({ text: "", leaked: false, reason: null });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
