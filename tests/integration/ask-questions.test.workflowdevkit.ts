import { describe, expect, it } from "vitest";
import { start } from "workflow/api";

import type { SupportedProvider } from "../../src/lib/providers";
import { askQuestions } from "../../src/workflows";

describe("Ask Questions Integration Tests for Workflow DevKit", () => {
  // Use glasses video for clear, consistent answers across all providers
  const assetId = "gIRjPqMSRcdk200kIKvsUo2K4JQr6UjNg7qKZc02egCcM";
  const providers: SupportedProvider[] = ["openai", "anthropic", "google"];

  it.each(providers)("should answer questions with %s provider in Workflow DevKit", async (provider) => {
    const questions = [
      { question: "Is this video about glasses?" },
    ];

    const run = await start(askQuestions, [assetId, questions, { provider }]);
    expect(run.runId).toMatch(/^wrun_/);

    const result = await run.returnValue;

    expect(result).toBeDefined();
    expect(result).toHaveProperty("assetId", assetId);
    expect(result).toHaveProperty("answers");
    expect(result.answers).toHaveLength(1);
    expect(["yes", "no"]).toContain(result.answers[0].answer);
    expect(result.answers[0].answer).toBe("yes"); // Should be yes for glasses video
  }, 120000);

  it("should answer questions using OpenAI provider in Workflow DevKit", async () => {
    const questions = [
      { question: "Is this video about glasses?" },
      { question: "Is this video about contact lenses?" },
    ];

    const run = await start(askQuestions, [assetId, questions, { provider: "openai" }]);
    expect(run.runId).toMatch(/^wrun_/);

    const result = await run.returnValue;

    // Assert that the result exists
    expect(result).toBeDefined();

    // Verify structure
    expect(result).toHaveProperty("assetId");
    expect(result).toHaveProperty("answers");
    expect(result).toHaveProperty("storyboardUrl");
    expect(result).toHaveProperty("usage");

    // Verify asset ID matches
    expect(result.assetId).toBe(assetId);

    // Verify answers array
    expect(Array.isArray(result.answers)).toBe(true);
    expect(result.answers).toHaveLength(questions.length);

    // Verify specific expected answers
    expect(result.answers[0].answer).toBe("yes"); // glasses
    expect(result.answers[1].answer).toBe("no"); // contact lenses

    // Verify each answer structure
    result.answers.forEach((answer, idx) => {
      expect(answer).toHaveProperty("question", questions[idx].question);
      expect(answer).toHaveProperty("answer");
      expect(["yes", "no"]).toContain(answer.answer);
      expect(answer).toHaveProperty("confidence");
      expect(typeof answer.confidence).toBe("number");
      expect(answer.confidence).toBeGreaterThanOrEqual(0);
      expect(answer.confidence).toBeLessThanOrEqual(1);
      expect(answer).toHaveProperty("reasoning");
      expect(typeof answer.reasoning).toBe("string");
      expect(answer.reasoning.length).toBeGreaterThan(0);
    });

    // Verify storyboardUrl is a valid URL
    expect(typeof result.storyboardUrl).toBe("string");
    expect(result.storyboardUrl).toContain("image.mux.com");

    // Verify usage stats
    expect(result.usage).toBeDefined();
    expect(result.usage?.inputTokens).toBeGreaterThan(0);
    expect(result.usage?.outputTokens).toBeGreaterThan(0);
    expect(result.usage?.totalTokens).toBeGreaterThan(0);
  }, 120000); // 2 minute timeout for AI processing

  it("should handle transcript inclusion in Workflow DevKit", async () => {
    const questions = [{ question: "Is this a video?" }];

    const run = await start(askQuestions, [assetId, questions, {
      provider: "openai",
      includeTranscript: true,
    }]);

    const result = await run.returnValue;

    expect(result).toHaveProperty("transcriptText");
    expect(result.transcriptText).toBeDefined();
    expect(typeof result.transcriptText).toBe("string");
  }, 120000);

  it("should handle validation errors in Workflow DevKit", async () => {
    const run = await start(askQuestions, [assetId, [], { provider: "openai" }]);

    await expect(run.returnValue).rejects.toThrow("At least one question must be provided");
  }, 120000);
});
