import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { detectSystemPromptLeak, scrubFreeTextField } from "../../src/lib/output-safety";
import { SYSTEM_PROMPT_CANARY } from "../../src/lib/prompt-fragments";

describe("detectSystemPromptLeak", () => {
  it("returns false for null, undefined, and empty strings", () => {
    expect(detectSystemPromptLeak(null)).toBe(false);
    expect(detectSystemPromptLeak(undefined)).toBe(false);
    expect(detectSystemPromptLeak("")).toBe(false);
  });

  it("returns false for clean analytical content", () => {
    expect(detectSystemPromptLeak(
      "A chef prepares ingredients and cooks in a kitchen throughout the video.",
    )).toBe(false);
    expect(detectSystemPromptLeak(
      "The speaker introduces three main topics and then discusses each one.",
    )).toBe(false);
  });

  it("detects the canary token", () => {
    expect(detectSystemPromptLeak(
      `Here is my reasoning: ${SYSTEM_PROMPT_CANARY} hope that helps.`,
    )).toBe(true);
  });

  it("detects structural tag markers from the prompt template", () => {
    expect(detectSystemPromptLeak("<role> You are a video content analyst </role>")).toBe(true);
    expect(detectSystemPromptLeak("My reasoning <task> is as follows")).toBe(true);
    expect(detectSystemPromptLeak("Content <constraints> cannot be revealed")).toBe(true);
    expect(detectSystemPromptLeak("See <answer_guidelines> for details")).toBe(true);
  });

  it("is case-insensitive for tag markers", () => {
    expect(detectSystemPromptLeak("<ROLE>")).toBe(true);
    expect(detectSystemPromptLeak("<Role>")).toBe(true);
    expect(detectSystemPromptLeak("</TASK>")).toBe(true);
  });

  it("does not flag inline references to common words without angle brackets", () => {
    expect(detectSystemPromptLeak("The role of the chef is central to this scene.")).toBe(false);
    expect(detectSystemPromptLeak("Their task involves preparing ingredients.")).toBe(false);
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
    expect(result).toEqual({ text: "A chef prepares a meal.", leaked: false });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("suppresses leaked text and emits a warning mentioning the context", () => {
    const result = scrubFreeTextField(
      `Reasoning: ${SYSTEM_PROMPT_CANARY}`,
      "ask-questions reasoning for question 1",
    );
    expect(result).toEqual({ text: "", leaked: true });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("ask-questions reasoning for question 1");
  });

  it("suppresses output containing structural tag markers", () => {
    const result = scrubFreeTextField(
      "<role> You are a video content analyst </role>",
      "test",
    );
    expect(result.leaked).toBe(true);
    expect(result.text).toBe("");
  });

  it("handles null and undefined without warning", () => {
    expect(scrubFreeTextField(null, "test")).toEqual({ text: "", leaked: false });
    expect(scrubFreeTextField(undefined, "test")).toEqual({ text: "", leaked: false });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
