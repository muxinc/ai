import { describe, expect, it } from "vitest";

import { normalizeMarkdownDescription } from "../../src/lib/markdown-normalization";

describe("normalizeMarkdownDescription", () => {
  it("converts literal escaped line breaks to real newlines", () => {
    const description = "Overview.\\n\\n**Target groups:** core\\n\\n**Technique:**\\n* Brace\\n* Stand tall";

    expect(normalizeMarkdownDescription(description)).toBe(
      "Overview.\n\n**Target groups:** core\n\n**Technique:**\n* Brace\n* Stand tall",
    );
  });

  it("restores obvious inline markdown bullet boundaries", () => {
    const description = "Overview sentence.  * Target areas: shoulders and core. * Technique:  - Brace the torso. - Move smoothly. * Common mistakes: - Rushing reps.";

    expect(normalizeMarkdownDescription(description)).toBe(
      "Overview sentence.\n* Target areas: shoulders and core.\n* Technique:\n- Brace the torso.\n- Move smoothly.\n* Common mistakes:\n- Rushing reps.",
    );
  });

  it("leaves ordinary prose and single-space hyphenated phrases alone", () => {
    const description = "A low - impact movement with steady pacing. Equipment is optional.";

    expect(normalizeMarkdownDescription(description)).toBe(description);
  });
});
