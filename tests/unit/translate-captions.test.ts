import {
  APICallError,
  NoObjectGeneratedError,
  RetryError,
  TypeValidationError,
} from "ai";
import { describe, expect, it } from "vitest";

import { MuxAiError } from "../../src/lib/mux-ai-error";
import type { TokenUsage } from "../../src/types";
import {
  aggregateTokenUsage,
  normalizeTranslatedVtt,
  shouldSplitChunkTranslationError,
  validateNeverTranslateTerms,
  verifyNeverTranslateTerms,
} from "../../src/workflows/translate-captions";

describe("aggregateTokenUsage", () => {
  it("preserves undefined for token fields that were never reported", () => {
    const usages: TokenUsage[] = [
      {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
      {
        inputTokens: 4,
        outputTokens: 6,
        totalTokens: 10,
      },
    ];

    const result = aggregateTokenUsage(usages);

    expect(result).toEqual({
      inputTokens: 14,
      outputTokens: 11,
      totalTokens: 25,
    });
    expect(result.reasoningTokens).toBeUndefined();
    expect(result.cachedInputTokens).toBeUndefined();
  });

  it("sums optional token fields when at least one usage reports them", () => {
    const usages: TokenUsage[] = [
      {
        inputTokens: 10,
        reasoningTokens: 2,
      },
      {
        inputTokens: 6,
        cachedInputTokens: 3,
      },
    ];

    const result = aggregateTokenUsage(usages);

    expect(result).toEqual({
      inputTokens: 16,
      reasoningTokens: 2,
      cachedInputTokens: 3,
    });
  });
});

describe("shouldSplitChunkTranslationError", () => {
  it("fails fast for provider API errors like rate limits", () => {
    const apiCallError = new APICallError({
      message: "Rate limited",
      requestBodyValues: {},
      statusCode: 429,
      url: "https://api.example.test/v1/messages",
    });

    expect(shouldSplitChunkTranslationError(apiCallError)).toBe(false);
  });

  it("fails fast when retries still end in provider API errors", () => {
    const apiCallError = new APICallError({
      message: "Service unavailable",
      requestBodyValues: {},
      statusCode: 503,
      url: "https://api.example.test/v1/messages",
    });
    const retryError = new RetryError({
      message: "Retries exhausted",
      reason: "maxRetriesExceeded",
      errors: [apiCallError],
    });

    expect(shouldSplitChunkTranslationError(retryError)).toBe(false);
  });

  it("still allows splitting when object generation fails locally", () => {
    const error = new NoObjectGeneratedError({
      finishReason: "length",
      response: {
        id: "resp_123",
        modelId: "test-model",
        timestamp: new Date("2026-03-10T00:00:00.000Z"),
      },
      usage: {
        inputTokens: 50,
        inputTokenDetails: {
          noCacheTokens: 50,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokens: 10,
        outputTokenDetails: {
          textTokens: 10,
          reasoningTokens: undefined,
        },
        totalTokens: 60,
      },
    });

    expect(shouldSplitChunkTranslationError(error)).toBe(true);
  });

  it("does not split no-object errors caused by provider outages", () => {
    const error = new NoObjectGeneratedError({
      cause: new APICallError({
        message: "Gateway timeout",
        requestBodyValues: {},
        statusCode: 504,
        url: "https://api.example.test/v1/messages",
      }),
      finishReason: "error",
      response: {
        id: "resp_456",
        modelId: "test-model",
        timestamp: new Date("2026-03-10T00:00:00.000Z"),
      },
      usage: {
        inputTokens: 50,
        inputTokenDetails: {
          noCacheTokens: 50,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokens: 0,
        outputTokenDetails: {
          textTokens: 0,
          reasoningTokens: undefined,
        },
        totalTokens: 50,
      },
    });

    expect(shouldSplitChunkTranslationError(error)).toBe(false);
  });

  it("allows splitting for schema validation failures", () => {
    const error = new TypeValidationError({
      value: { translations: ["hola"] },
      cause: new Error("Expected array to contain 2 items"),
    });

    expect(shouldSplitChunkTranslationError(error)).toBe(true);
  });
});

describe("normalizeTranslatedVtt", () => {
  const body = "1\n00:00:01.000 --> 00:00:02.000\nHello\n";

  it("preserves an already-valid VTT's header and body", () => {
    // Trailing whitespace may be trimmed; the important invariant is
    // that the "WEBVTT" header is intact and the cue body is preserved.
    const input = `WEBVTT\n\n${body}`;
    const result = normalizeTranslatedVtt(input);
    expect(result.startsWith("WEBVTT\n\n")).toBe(true);
    expect(result).toContain("00:00:01.000 --> 00:00:02.000");
    expect(result).toContain("Hello");
  });

  it("prepends WEBVTT when the header is missing entirely", () => {
    const result = normalizeTranslatedVtt(body);
    expect(result.startsWith("WEBVTT\n\n")).toBe(true);
    expect(result).toContain("Hello");
  });

  it("uppercases a lowercased webvtt header", () => {
    const result = normalizeTranslatedVtt(`webvtt\n\n${body}`);
    expect(result.startsWith("WEBVTT\n\n")).toBe(true);
  });

  it("uppercases a mixed-case Webvtt header", () => {
    const result = normalizeTranslatedVtt(`Webvtt\n\n${body}`);
    expect(result.startsWith("WEBVTT\n\n")).toBe(true);
  });

  it("strips a surrounding markdown fence without a language hint", () => {
    const result = normalizeTranslatedVtt(`\`\`\`\nWEBVTT\n\n${body}\`\`\``);
    expect(result.startsWith("WEBVTT")).toBe(true);
    expect(result).not.toContain("```");
  });

  it("strips a surrounding markdown fence with a vtt hint", () => {
    const result = normalizeTranslatedVtt(`\`\`\`vtt\nWEBVTT\n\n${body}\`\`\``);
    expect(result.startsWith("WEBVTT")).toBe(true);
    expect(result).not.toContain("```");
  });

  it("strips a surrounding <code> wrapper and uppercases the header", () => {
    // This is the shape of the observed Anthropic failure: output
    // wrapped in <code> tags with a lowercase "webvtt" prefix.
    const result = normalizeTranslatedVtt(`<code>webvtt\n\n${body}</code>`);
    expect(result.startsWith("WEBVTT\n\n")).toBe(true);
    expect(result).not.toContain("<code>");
    expect(result).not.toContain("</code>");
  });

  it("strips a surrounding <pre> wrapper", () => {
    const result = normalizeTranslatedVtt(`<pre>WEBVTT\n\n${body}</pre>`);
    expect(result.startsWith("WEBVTT")).toBe(true);
    expect(result).not.toContain("<pre>");
  });

  it("returns an empty string unchanged", () => {
    expect(normalizeTranslatedVtt("")).toBe("");
  });
});

describe("validateNeverTranslateTerms", () => {
  it("trims terms and removes exact duplicates", () => {
    expect(validateNeverTranslateTerms([" Mux ", "Mux", "GIF"])).toEqual(["Mux", "GIF"]);
  });

  it("dedupes case variants, keeping the first casing", () => {
    expect(validateNeverTranslateTerms(["Mux", "MUX"])).toEqual(["Mux"]);
  });

  it("rejects terms containing angle brackets", () => {
    expect(() => validateNeverTranslateTerms(["<Mux"])).toThrow(MuxAiError);
    expect(() => validateNeverTranslateTerms(["Mux>"])).toThrow(MuxAiError);
  });

  it("accepts terms containing ampersands", () => {
    expect(validateNeverTranslateTerms(["AT&T"])).toEqual(["AT&T"]);
  });

  it("rejects more than 100 terms", () => {
    const terms = Array.from({ length: 101 }, (_, i) => `term-${i}`);
    expect(() => validateNeverTranslateTerms(terms)).toThrow(MuxAiError);
  });

  it("rejects empty and whitespace-only terms", () => {
    expect(() => validateNeverTranslateTerms([""])).toThrow(MuxAiError);
    expect(() => validateNeverTranslateTerms(["   "])).toThrow(MuxAiError);
  });

  it("rejects terms longer than 100 characters", () => {
    expect(() => validateNeverTranslateTerms(["x".repeat(101)])).toThrow(MuxAiError);
  });

  it("accepts a term of exactly 100 characters", () => {
    const term = "x".repeat(100);
    expect(validateNeverTranslateTerms([term])).toEqual([term]);
  });
});

describe("verifyNeverTranslateTerms", () => {
  const vtt = (...cueLines: string[]) =>
    `WEBVTT\n\n${cueLines.map((text, i) => `${i + 1}\n00:00:0${i}.000 --> 00:00:0${i + 1}.000\n${text}`).join("\n\n")}\n`;

  const sourceVtt = vtt("Video is fun with Mux.", "mux makes thumbnails easy.");

  it("passes when every occurrence survives verbatim, counting the source case-insensitively", () => {
    const translatedVtt = vtt("El video es divertido con Mux.", "Mux facilita las miniaturas.");
    expect(verifyNeverTranslateTerms(["Mux"], sourceVtt, translatedVtt)).toBe(true);
  });

  it("fails when verbatim occurrences drop, including case changes", () => {
    expect(verifyNeverTranslateTerms(["Mux"], sourceVtt, vtt("El video es divertido con Múx.", "Mux facilita las miniaturas."))).toBe(false);
    expect(verifyNeverTranslateTerms(["Mux"], sourceVtt, vtt("El video es divertido con MUX.", "MUX facilita las miniaturas."))).toBe(false);
  });

  it("ignores terms absent from the source and matches inside timestamps", () => {
    expect(verifyNeverTranslateTerms(["Jeff"], sourceVtt, vtt("Sin cambios.", "Nada."))).toBe(true);
    // "02" appears in both files' timestamps but only the source cue text;
    // the translated file's timestamps must not satisfy the count.
    const timestamped = (text: string) => `WEBVTT\n\n1\n00:00:02.000 --> 00:00:03.000\n${text}\n`;
    expect(verifyNeverTranslateTerms(["02"], timestamped("Room 02 is ready."), timestamped("La sala está lista."))).toBe(false);
  });

  it("normalizes terms into the same space as sanitized cue text", () => {
    // Cue text is NFKC-normalized at parse time ("①" becomes "1"); an
    // unnormalized term would count zero in the source and falsely pass.
    expect(verifyNeverTranslateTerms(["①"], vtt("Chapter ① begins."), vtt("Comienza el capítulo."))).toBe(false);
    expect(verifyNeverTranslateTerms(["①"], vtt("Chapter ① begins."), vtt("Comienza el capítulo 1."))).toBe(true);
  });
});
