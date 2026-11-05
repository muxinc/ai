import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ERRORS_DOC_PATH, renderErrorCodeTable, withErrorCodeTable } from "../../scripts/error-docs.ts";

describe("docs/ERRORS.md", () => {
  it("has the code table generated from the source (run `npm run docs:errors`)", () => {
    const doc = readFileSync(ERRORS_DOC_PATH, "utf8");

    expect(doc).toBe(withErrorCodeTable(doc, renderErrorCodeTable()));
  });
});
