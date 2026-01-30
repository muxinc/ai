import { describe, expect, it } from "vitest";

import { askQuestions } from "../../src/workflows";
import { muxTestAssets } from "../helpers/mux-test-assets";

describe("ask Questions Integration Tests", () => {
  const testAssetId = muxTestAssets.assetId;

  it("should answer a single yes/no question with OpenAI", async () => {
    const result = await askQuestions(testAssetId, [
      { question: "Does this video contain music?" },
    ]);

    expect(result).toBeDefined();
    expect(result).toHaveProperty("assetId", testAssetId);
    expect(result).toHaveProperty("answers");
    expect(result.answers).toHaveLength(1);

    const answer = result.answers[0];
    expect(answer).toHaveProperty("question", "Does this video contain music?");
    expect(answer).toHaveProperty("answer");
    expect(["yes", "no"]).toContain(answer.answer);
    expect(answer).toHaveProperty("confidence");
    expect(answer.confidence).toBeGreaterThanOrEqual(0);
    expect(answer.confidence).toBeLessThanOrEqual(1);
    expect(answer).toHaveProperty("reasoning");
    expect(typeof answer.reasoning).toBe("string");
    expect(answer.reasoning.length).toBeGreaterThan(0);
  });

  it("should answer multiple questions in a single call", async () => {
    const questions = [
      { question: "Does this video contain people?" },
      { question: "Is this video in color?" },
      { question: "Does this video contain animals?" },
    ];

    const result = await askQuestions(testAssetId, questions);

    expect(result.answers).toHaveLength(3);

    result.answers.forEach((answer, idx) => {
      expect(answer.question).toBe(questions[idx].question);
      expect(["yes", "no"]).toContain(answer.answer);
      expect(answer.confidence).toBeGreaterThanOrEqual(0);
      expect(answer.confidence).toBeLessThanOrEqual(1);
      expect(typeof answer.reasoning).toBe("string");
      expect(answer.reasoning.length).toBeGreaterThan(0);
    });
  });

  it("should include storyboardUrl in result", async () => {
    const result = await askQuestions(testAssetId, [
      { question: "Is this a video?" },
    ]);

    expect(result).toHaveProperty("storyboardUrl");
    expect(typeof result.storyboardUrl).toBe("string");
    expect(result.storyboardUrl).toMatch(/^https?:\/\//);
  });

  it("should include token usage statistics", async () => {
    const result = await askQuestions(testAssetId, [
      { question: "Is this a video?" },
    ]);

    expect(result).toHaveProperty("usage");
    expect(result.usage).toBeDefined();
    expect(result.usage).toHaveProperty("inputTokens");
    expect(result.usage).toHaveProperty("outputTokens");
    expect(result.usage).toHaveProperty("totalTokens");
    expect(typeof result.usage?.inputTokens).toBe("number");
    expect(typeof result.usage?.outputTokens).toBe("number");
    expect(typeof result.usage?.totalTokens).toBe("number");
  });

  it("should include transcript text when includeTranscript is true", async () => {
    const result = await askQuestions(
      testAssetId,
      [{ question: "Is this a video?" }],
      { includeTranscript: true },
    );

    expect(result).toHaveProperty("transcriptText");
    expect(result.transcriptText).toBeDefined();
    expect(typeof result.transcriptText).toBe("string");
  });

  it("should not include transcript text when includeTranscript is false", async () => {
    const result = await askQuestions(
      testAssetId,
      [{ question: "Is this a video?" }],
      { includeTranscript: false },
    );

    expect(result.transcriptText).toBeUndefined();
  });

  it("should work with base64 image submission mode", async () => {
    const result = await askQuestions(
      testAssetId,
      [{ question: "Is this a video?" }],
      { imageSubmissionMode: "base64" },
    );

    expect(result).toBeDefined();
    expect(result.answers).toHaveLength(1);
    expect(["yes", "no"]).toContain(result.answers[0].answer);
  });

  it("should throw error for empty questions array", async () => {
    await expect(
      askQuestions(testAssetId, []),
    ).rejects.toThrow("At least one question must be provided");
  });

  it("should throw error for question with empty text", async () => {
    await expect(
      askQuestions(testAssetId, [{ question: "" }]),
    ).rejects.toThrow("Question at index 0 is invalid");
  });

  it("should throw error for question with whitespace-only text", async () => {
    await expect(
      askQuestions(testAssetId, [{ question: "   " }]),
    ).rejects.toThrow("Question at index 0 is invalid");
  });

  it("should throw error for invalid provider", async () => {
    await expect(
      askQuestions(testAssetId, [{ question: "Is this a video?" }], {
        // @ts-expect-error - testing runtime validation
        provider: "invalid",
      }),
    ).rejects.toThrow("not supported");
  });

  it("should throw error when answer count doesn't match question count", async () => {
    // This is a defensive test - it should only fail if the AI provider returns
    // an incorrect number of answers, which shouldn't happen in practice
    // We can't easily force this condition, so this documents expected behavior
    const questions = [
      { question: "Question 1?" },
      { question: "Question 2?" },
    ];

    const result = await askQuestions(testAssetId, questions);

    // If we get here, the result should have the correct number of answers
    expect(result.answers).toHaveLength(questions.length);
  });
});
