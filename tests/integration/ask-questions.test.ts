import { describe, expect, it } from "vitest";

import type { SupportedProvider } from "../../src/lib/providers";
import { askQuestions } from "../../src/workflows";
import { muxTestAssets } from "../helpers/mux-test-assets";

describe("ask Questions Integration Tests", () => {
  // Use glasses video for clear, consistent answers across all providers
  const testAssetId = "gIRjPqMSRcdk200kIKvsUo2K4JQr6UjNg7qKZc02egCcM";
  const audioOnlyAssetId = muxTestAssets.audioOnlyAssetId;
  const providers: SupportedProvider[] = ["openai", "anthropic", "google"];

  it.each(providers)("should return valid result for %s provider", async (provider) => {
    const result = await askQuestions(testAssetId, [
      { question: "Is this video about glasses?" },
    ], { provider });

    expect(result).toBeDefined();
    expect(result).toHaveProperty("assetId", testAssetId);
    expect(result).toHaveProperty("answers");
    expect(result.answers).toHaveLength(1);
    expect(["yes", "no"]).toContain(result.answers[0].answer);
    expect(result.answers[0].answer).toBe("yes"); // Should be yes for glasses video
  });

  it("should answer a single yes/no question with OpenAI", async () => {
    const result = await askQuestions(testAssetId, [
      { question: "Is this video about glasses?" },
    ]);

    expect(result).toBeDefined();
    expect(result).toHaveProperty("assetId", testAssetId);
    expect(result).toHaveProperty("answers");
    expect(result.answers).toHaveLength(1);

    const answer = result.answers[0];
    expect(answer).toHaveProperty("question", "Is this video about glasses?");
    expect(answer).toHaveProperty("answer");
    expect(["yes", "no"]).toContain(answer.answer);
    expect(answer.answer).toBe("yes"); // Should be yes for glasses video
    expect(answer).toHaveProperty("confidence");
    expect(answer.confidence).toBeGreaterThanOrEqual(0);
    expect(answer.confidence).toBeLessThanOrEqual(1);
    expect(answer).toHaveProperty("reasoning");
    expect(typeof answer.reasoning).toBe("string");
    expect(answer.reasoning.length).toBeGreaterThan(0);
  });

  it("should answer multiple questions in a single call", async () => {
    const questions = [
      { question: "Is this video about glasses?" },
      { question: "Is this video about contact lenses?" },
      { question: "Is this video in color?" },
    ];

    const result = await askQuestions(testAssetId, questions);

    expect(result.answers).toHaveLength(3);

    // Verify structure and specific expected answers
    expect(result.answers[0].question).toBe(questions[0].question);
    expect(result.answers[0].answer).toBe("yes"); // glasses
    expect(result.answers[1].question).toBe(questions[1].question);
    expect(result.answers[1].answer).toBe("no"); // contact lenses

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
    // Use default test asset which has a transcript
    const assetWithTranscript = muxTestAssets.assetId;
    const result = await askQuestions(
      assetWithTranscript,
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

  it("should support per-question answer options", async () => {
    const questions = [
      { question: "Is this video in color?" }, // answer options default to yes/no
      {
        question: "What is the primary subject of this video?",
        answerOptions: ["glasses", "watches", "shoes", "hats"],
      },
    ];

    const result = await askQuestions(testAssetId, questions);

    expect(result.answers).toHaveLength(2);
    expect(["yes", "no"]).toContain(result.answers[0].answer);
    expect(["glasses", "watches", "shoes", "hats"]).toContain(result.answers[1].answer);
    expect(result.answers[1].answer).toBe("glasses");
  });

  it("should not skip content-relevant questions with custom answerOptions", async () => {
    const result = await askQuestions(testAssetId, [
      {
        question: "What is the primary subject of this video?",
        answerOptions: ["glasses", "watches", "shoes", "hats"],
      },
    ]);

    expect(result.answers).toHaveLength(1);

    const answer = result.answers[0];
    expect(answer.skipped).toBe(false);
    expect(answer.answer).not.toBeNull();
    expect(["glasses", "watches", "shoes", "hats"]).toContain(answer.answer);
    expect(answer.answer).toBe("glasses");
    expect(answer.confidence).toBeGreaterThan(0);
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

  it("should skip irrelevant questions with reasoning explaining why", async () => {
    const result = await askQuestions(testAssetId, [
      { question: "What is the square root of 144?" },
    ]);

    expect(result.answers).toHaveLength(1);

    const answer = result.answers[0];
    expect(answer.skipped).toBe(true);
    expect(answer.answer).toBeNull();
    expect(answer.confidence).toBe(0);
    expect(typeof answer.reasoning).toBe("string");
    expect(answer.reasoning.length).toBeGreaterThan(0);
  });

  it("should handle a mix of relevant and irrelevant questions", async () => {
    const questions = [
      { question: "Is this video about glasses?" },
      { question: "What is the capital of France?" },
      { question: "Is this video in color?" },
    ];

    const result = await askQuestions(testAssetId, questions);

    expect(result.answers).toHaveLength(3);

    // Relevant questions should not be skipped
    expect(result.answers[0].skipped).toBe(false);
    expect(["yes", "no"]).toContain(result.answers[0].answer);
    expect(result.answers[0].answer).toBe("yes");

    // Irrelevant question should be skipped
    expect(result.answers[1].skipped).toBe(true);
    expect(result.answers[1].answer).toBeNull();
    expect(result.answers[1].confidence).toBe(0);
    expect(result.answers[1].reasoning.length).toBeGreaterThan(0);

    // Relevant question should not be skipped
    expect(result.answers[2].skipped).toBe(false);
    expect(["yes", "no"]).toContain(result.answers[2].answer);
  });

  it("should mark relevant questions with skipped false", async () => {
    const result = await askQuestions(testAssetId, [
      { question: "Is this video about glasses?" },
    ]);

    const answer = result.answers[0];
    expect(answer.skipped).toBe(false);
    expect(answer.answer).toBe("yes");
  });

  describe("free-form replies (experimental)", () => {
    it("should answer a single free-form question with evidence-grounded prose", async () => {
      const result = await askQuestions(testAssetId, [
        {
          question: "What is the primary subject of this video?",
          freeFormReply: true,
        },
      ]);

      expect(result.answers).toHaveLength(1);
      const answer = result.answers[0];
      expect(answer.skipped).toBe(false);
      expect(typeof answer.answer).toBe("string");
      expect((answer.answer ?? "").length).toBeGreaterThan(0);
      // Free-form answers are length-capped (default 500).
      expect((answer.answer ?? "").length).toBeLessThanOrEqual(500);
      // Glasses video — answer should reference glasses.
      expect((answer.answer ?? "").toLowerCase()).toContain("glass");
      expect(answer.confidence).toBeGreaterThan(0);
      expect(answer.confidence).toBeLessThanOrEqual(1);
      expect(typeof answer.reasoning).toBe("string");
      expect(answer.reasoning.length).toBeGreaterThan(0);
    });

    it("should mix free-form and constrained questions in a single call", async () => {
      const questions = [
        { question: "Is this video about glasses?" }, // constrained yes/no
        {
          question: "Describe the primary subject of the video in one sentence.",
          freeFormReply: true,
        },
        {
          question: "What is the primary subject?",
          answerOptions: ["glasses", "watches", "shoes", "hats"],
        }, // constrained enum
      ];

      const result = await askQuestions(testAssetId, questions);

      expect(result.answers).toHaveLength(3);

      // Constrained yes/no — must be in the allowed set.
      expect(["yes", "no"]).toContain(result.answers[0].answer);
      expect(result.answers[0].answer).toBe("yes");

      // Free-form — arbitrary prose, content-relevant.
      expect(result.answers[1].skipped).toBe(false);
      expect(typeof result.answers[1].answer).toBe("string");
      expect((result.answers[1].answer ?? "").length).toBeGreaterThan(0);

      // Constrained enum — must be in the allowed set.
      expect(["glasses", "watches", "shoes", "hats"]).toContain(result.answers[2].answer);
      expect(result.answers[2].answer).toBe("glasses");
    });

    it("should skip irrelevant free-form questions", async () => {
      const result = await askQuestions(testAssetId, [
        {
          question: "Describe the personal life of the author of this code.",
          freeFormReply: true,
        },
      ]);

      expect(result.answers).toHaveLength(1);
      const answer = result.answers[0];
      expect(answer.skipped).toBe(true);
      expect(answer.answer).toBeNull();
      expect(answer.confidence).toBe(0);
      expect(answer.reasoning.length).toBeGreaterThan(0);
    });

    it("should respect a tighter maxFreeFormAnswerLength", async () => {
      const result = await askQuestions(
        testAssetId,
        [
          {
            question: "Describe the primary subject of the video.",
            freeFormReply: true,
          },
        ],
        { maxFreeFormAnswerLength: 120 },
      );

      expect(result.answers).toHaveLength(1);
      const answer = result.answers[0];
      expect(answer.skipped).toBe(false);
      expect((answer.answer ?? "").length).toBeLessThanOrEqual(120);
    });

    it("should throw error for invalid maxFreeFormAnswerLength", async () => {
      await expect(
        askQuestions(
          testAssetId,
          [{ question: "Describe the video.", freeFormReply: true }],
          { maxFreeFormAnswerLength: 0 },
        ),
      ).rejects.toThrow("maxFreeFormAnswerLength must be a positive number");
    });

    it("should throw error when answerOptions and freeFormReply are both set", async () => {
      await expect(
        askQuestions(testAssetId, [
          {
            question: "Describe the video.",
            answerOptions: ["a", "b"],
            freeFormReply: true,
          },
        ]),
      ).rejects.toThrow("mutually exclusive");
    });
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

  describe("audio-only assets", () => {
    it.each(providers)("should answer questions for audio-only asset with %s provider", async (provider) => {
      const result = await askQuestions(audioOnlyAssetId, [
        { question: "Is there spoken dialogue in this content?" },
      ], { provider });

      expect(result).toBeDefined();
      expect(result).toHaveProperty("assetId", audioOnlyAssetId);
      expect(result.answers).toHaveLength(1);
      expect(result.answers[0].skipped).toBe(false);
      expect(["yes", "no"]).toContain(result.answers[0].answer);
      expect(typeof result.answers[0].reasoning).toBe("string");
      expect(result.answers[0].reasoning.length).toBeGreaterThan(0);
    });

    it("should return undefined storyboardUrl for audio-only asset", async () => {
      const provider = providers[0];
      const result = await askQuestions(audioOnlyAssetId, [
        { question: "Is there spoken dialogue in this content?" },
      ], { provider });

      expect(result.storyboardUrl).toBeUndefined();
    });

    it("should include transcript text for audio-only asset", async () => {
      const provider = providers[0];
      const result = await askQuestions(audioOnlyAssetId, [
        { question: "Is there spoken dialogue in this content?" },
      ], {
        provider,
        includeTranscript: true,
      });

      expect(result.transcriptText).toBeDefined();
      expect(typeof result.transcriptText).toBe("string");
      expect((result.transcriptText ?? "").length).toBeGreaterThan(0);
    });

    it("should throw error if includeTranscript is false for audio-only asset", async () => {
      const provider = providers[0];

      await expect(
        askQuestions(audioOnlyAssetId, [
          { question: "Is there spoken dialogue in this content?" },
        ], {
          provider,
          includeTranscript: false,
        }),
      ).rejects.toThrow("Audio-only assets require a transcript");
    });
  });
});
