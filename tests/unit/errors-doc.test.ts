import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ERRORS_DOC_PATH, withGeneratedErrorTables } from "../../scripts/error-docs.ts";

describe("docs/ERRORS.md", () => {
  it("has its tables generated from the source (run `npm run docs:errors`)", () => {
    const doc = readFileSync(ERRORS_DOC_PATH, "utf8");

    expect(doc).toBe(withGeneratedErrorTables(doc));
  });
});
