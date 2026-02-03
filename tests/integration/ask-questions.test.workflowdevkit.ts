import { describe, expect, it } from "vitest";
import { start } from "workflow/api";

import type { SupportedProvider } from "../../src/lib/providers";
import { askQuestions } from "../../src/workflows";
import { muxTestAssets } from "../helpers/mux-test-assets";

describe("Ask Questions Integration Tests for Workflow DevKit", () => {
  const testAssetId = muxTestAssets.assetId;
  const providers: SupportedProvider[] = ["openai", "anthropic", "google"];

  it.each(providers)("should return answers with %s provider", async (provider) => {
    const questions = [{ question: "Is this video about an API?" }];

    const run = await start(askQuestions, [testAssetId, questions, { provider }]);
    expect(run.runId).toMatch(/^wrun_/);

    const result = await run.returnValue;
    expect(result).toHaveProperty("assetId", testAssetId);
    expect(result).toHaveProperty("answers");
    expect(result).toHaveProperty("storyboardUrl");
    expect(result.answers).toHaveLength(questions.length);
    expect(result.answers[0]).toHaveProperty("question", questions[0].question);
    expect(["yes", "no"]).toContain(result.answers[0].answer);
  });
});
