import { describe, expect, it } from "vitest";
import { start } from "workflow/api";

import { askQuestions } from "../../src/workflows";
import { muxTestAssets } from "../helpers/mux-test-assets";

describe("Ask Questions Integration Tests for Workflow DevKit", () => {
  const assetId = muxTestAssets.assetId;

  it("should answer questions using OpenAI provider in Workflow DevKit", async () => {
    const questions = [
      { question: "Does this video contain music?" },
      { question: "Are there people visible in this video?" },
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
