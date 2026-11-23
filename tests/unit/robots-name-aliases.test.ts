import { describe, expect, it } from "vitest";

import * as workflows from "../../src/workflows/index";

describe("mux Robots workflow name aliases", () => {
  it.each([
    ["generateContextualText", "generateText"],
    ["moderate", "getModerationScores"],
    ["summarize", "getSummaryAndTags"],
  ] as const)("exports %s as the same function as %s", (alias, original) => {
    expect(workflows[alias]).toBe(workflows[original]);
  });
});
