import { describe, expect, it } from "vitest";

import {
  applyOverrideLists,
  applyReplacements,
  buildReplacementRegex,
  censorVttContent,
  createReplacer,
  transformCueText,
} from "../../src/workflows/edit-captions";

// ─────────────────────────────────────────────────────────────────────────────
// transformCueText
// ─────────────────────────────────────────────────────────────────────────────

describe("transformCueText", () => {
  it("transforms cue text lines only", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:04.000",
      "Hello world",
      "",
      "00:00:05.000 --> 00:00:08.000",
      "Goodbye world",
      "",
    ].join("\n");
    const result = transformCueText(vtt, line => line.toUpperCase());
    expect(result).toContain("HELLO WORLD");
    expect(result).toContain("GOODBYE WORLD");
    expect(result).toContain("WEBVTT");
    expect(result).toContain("00:00:01.000 --> 00:00:04.000");
  });

  it("does not transform the WEBVTT header", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:04.000",
      "Some text",
    ].join("\n");
    const result = transformCueText(vtt, () => "REPLACED");
    const lines = result.split("\n");
    expect(lines[0]).toBe("WEBVTT");
    expect(lines[3]).toBe("REPLACED");
  });

  it("does not transform timestamp lines", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:04.000",
      "Text here",
    ].join("\n");
    const result = transformCueText(vtt, () => "REPLACED");
    expect(result).toContain("00:00:01.000 --> 00:00:04.000");
  });

  it("does not transform cue identifiers", () => {
    const vtt = [
      "WEBVTT",
      "",
      "cue-1",
      "00:00:01.000 --> 00:00:04.000",
      "Text here",
    ].join("\n");
    const result = transformCueText(vtt, () => "REPLACED");
    expect(result).toContain("cue-1");
    expect(result).toContain("REPLACED");
  });

  it("handles multi-line cue text", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:04.000",
      "Line one",
      "Line two",
      "",
    ].join("\n");
    const result = transformCueText(vtt, line => line.toUpperCase());
    expect(result).toContain("LINE ONE");
    expect(result).toContain("LINE TWO");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildReplacementRegex
// ─────────────────────────────────────────────────────────────────────────────

describe("buildReplacementRegex", () => {
  it("returns null for empty array", () => {
    expect(buildReplacementRegex([])).toBeNull();
  });

  it("matches exact words with word boundaries", () => {
    const regex = buildReplacementRegex(["damn"])!;
    expect("damn".match(regex)).toBeTruthy();
    expect("damn!".match(regex)).toBeTruthy();
    expect("oh damn.".match(regex)).toBeTruthy();
  });

  it("does not match substrings of other words", () => {
    const regex = buildReplacementRegex(["damn"])!;
    expect("damage".match(regex)).toBeNull();
    expect("goddamn".match(regex)).toBeNull();
  });

  it("is case insensitive", () => {
    const regex = buildReplacementRegex(["fuck"])!;
    expect("Fuck".match(regex)).toBeTruthy();
    expect("FUCK".match(regex)).toBeTruthy();
    expect("fUcK".match(regex)).toBeTruthy();
  });

  it("sorts longest-first so multi-word phrases match before individual words", () => {
    const regex = buildReplacementRegex(["shit", "holy shit"])!;
    const result = "holy shit that was bad".replace(regex, "[CENSORED]");
    expect(result).toBe("[CENSORED] that was bad");
  });

  it("escapes regex special characters in words", () => {
    const regex = buildReplacementRegex(["f.ck"])!;
    expect("f.ck".match(regex)).toBeTruthy();
    expect("fuck".match(regex)).toBeNull();
  });

  it("matches multiple different words globally", () => {
    const regex = buildReplacementRegex(["damn", "shit"])!;
    const matches = "damn and shit and damn again".match(regex);
    expect(matches).toHaveLength(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createReplacer
// ─────────────────────────────────────────────────────────────────────────────

describe("createReplacer", () => {
  it("blank mode: replaces with bracketed underscores matching length", () => {
    const replacer = createReplacer("blank");
    expect(replacer("fuck")).toBe("[____]");
    expect(replacer("shit")).toBe("[____]");
    expect(replacer("ass")).toBe("[___]");
  });

  it("remove mode: replaces with empty string", () => {
    const replacer = createReplacer("remove");
    expect(replacer("fuck")).toBe("");
    expect(replacer("anything")).toBe("");
  });

  it("mask mode: replaces with question marks matching length", () => {
    const replacer = createReplacer("mask");
    expect(replacer("fuck")).toBe("????");
    expect(replacer("shit")).toBe("????");
    expect(replacer("ass")).toBe("???");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// censorVttContent
// ─────────────────────────────────────────────────────────────────────────────

describe("censorVttContent", () => {
  const sampleVtt = [
    "WEBVTT",
    "",
    "00:00:01.000 --> 00:00:04.000",
    "What the fuck is going on?",
    "",
    "00:00:05.000 --> 00:00:08.000",
    "This is some shit right here.",
    "",
    "00:00:09.000 --> 00:00:12.000",
    "Damn, that was close.",
    "",
  ].join("\n");

  it("censors profanity with blank mode", () => {
    const { censoredVtt, replacementCount } = censorVttContent(
      sampleVtt,
      ["fuck", "shit", "damn"],
      "blank",
    );
    expect(censoredVtt).toContain("[____]");
    expect(censoredVtt).not.toContain("fuck");
    expect(censoredVtt).not.toContain("shit");
    expect(censoredVtt).not.toContain("Damn");
    expect(replacementCount).toBe(3);
  });

  it("censors profanity with mask mode", () => {
    const { censoredVtt, replacementCount } = censorVttContent(
      sampleVtt,
      ["fuck"],
      "mask",
    );
    expect(censoredVtt).toContain("What the ???? is going on?");
    expect(replacementCount).toBe(1);
  });

  it("censors profanity with remove mode", () => {
    const { censoredVtt, replacementCount } = censorVttContent(
      sampleVtt,
      ["fuck"],
      "remove",
    );
    expect(censoredVtt).toContain("What the  is going on?");
    expect(replacementCount).toBe(1);
  });

  it("preserves VTT timestamps and structure", () => {
    const { censoredVtt } = censorVttContent(sampleVtt, ["fuck"], "blank");
    expect(censoredVtt).toContain("WEBVTT");
    expect(censoredVtt).toContain("00:00:01.000 --> 00:00:04.000");
    expect(censoredVtt).toContain("00:00:05.000 --> 00:00:08.000");
    expect(censoredVtt).toContain("00:00:09.000 --> 00:00:12.000");
  });

  it("does not censor words in cue identifiers or headers", () => {
    const vtt = [
      "WEBVTT",
      "",
      "fuck-cue-id",
      "00:00:01.000 --> 00:00:04.000",
      "What the fuck is this?",
    ].join("\n");
    const { censoredVtt, replacementCount } = censorVttContent(vtt, ["fuck"], "blank");
    expect(censoredVtt).toContain("fuck-cue-id");
    expect(censoredVtt).toContain("[____]");
    expect(replacementCount).toBe(1);
  });

  it("returns original VTT unchanged when no profanity provided", () => {
    const { censoredVtt, replacementCount } = censorVttContent(sampleVtt, [], "blank");
    expect(censoredVtt).toBe(sampleVtt);
    expect(replacementCount).toBe(0);
  });

  it("returns original VTT unchanged when profanity not found in text", () => {
    const cleanVtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:04.000",
      "This is a clean sentence.",
    ].join("\n");
    const { censoredVtt, replacementCount } = censorVttContent(cleanVtt, ["fuck"], "blank");
    expect(censoredVtt).toBe(cleanVtt);
    expect(replacementCount).toBe(0);
  });

  it("handles the same word appearing multiple times", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:04.000",
      "Shit shit shit!",
    ].join("\n");
    const { replacementCount } = censorVttContent(vtt, ["shit"], "blank");
    expect(replacementCount).toBe(3);
  });

  it("handles case-insensitive matching", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:04.000",
      "FUCK Fuck fuck",
    ].join("\n");
    const { censoredVtt, replacementCount } = censorVttContent(vtt, ["fuck"], "blank");
    expect(censoredVtt).not.toMatch(/fuck/i);
    expect(replacementCount).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// applyOverrideLists
// ─────────────────────────────────────────────────────────────────────────────

describe("applyOverrideLists", () => {
  it("returns detected words unchanged when no overrides provided", () => {
    const result = applyOverrideLists(["fuck", "shit"], [], []);
    expect(result).toEqual(["fuck", "shit"]);
  });

  it("adds alwaysCensor words to the list", () => {
    const result = applyOverrideLists(["fuck"], ["crap"], []);
    expect(result).toContain("fuck");
    expect(result).toContain("crap");
  });

  it("does not duplicate words from alwaysCensor that are already detected", () => {
    const result = applyOverrideLists(["fuck", "shit"], ["fuck"], []);
    expect(result).toEqual(["fuck", "shit"]);
  });

  it("deduplication is case-insensitive", () => {
    const result = applyOverrideLists(["Fuck"], ["fuck"], []);
    expect(result).toEqual(["Fuck"]);
  });

  it("removes neverCensor words from the list", () => {
    const result = applyOverrideLists(["fuck", "damn", "hell"], [], ["damn", "hell"]);
    expect(result).toEqual(["fuck"]);
  });

  it("neverCensor is case-insensitive", () => {
    const result = applyOverrideLists(["Damn", "HELL"], [], ["damn", "hell"]);
    expect(result).toEqual([]);
  });

  it("neverCensor takes precedence over alwaysCensor", () => {
    const result = applyOverrideLists([], ["damn"], ["damn"]);
    expect(result).toEqual([]);
  });

  it("handles both overrides together", () => {
    const result = applyOverrideLists(
      ["fuck", "shit", "damn"],
      ["crap", "bollocks"],
      ["damn"],
    );
    expect(result).toContain("fuck");
    expect(result).toContain("shit");
    expect(result).toContain("crap");
    expect(result).toContain("bollocks");
    expect(result).not.toContain("damn");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// applyReplacements
// ─────────────────────────────────────────────────────────────────────────────

describe("applyReplacements", () => {
  const sampleVtt = [
    "WEBVTT",
    "",
    "00:00:01.000 --> 00:00:04.000",
    "Welcome to Mucks streaming platform.",
    "",
    "00:00:05.000 --> 00:00:08.000",
    "We're gonna show you how it works.",
    "",
  ].join("\n");

  it("applies a basic find/replace", () => {
    const { editedVtt, replacementCount } = applyReplacements(sampleVtt, [
      { find: "Mucks", replace: "Mux" },
    ]);
    expect(editedVtt).toContain("Welcome to Mux streaming platform.");
    expect(editedVtt).not.toContain("Mucks");
    expect(replacementCount).toBe(1);
  });

  it("applies multiple replacements", () => {
    const { editedVtt, replacementCount } = applyReplacements(sampleVtt, [
      { find: "Mucks", replace: "Mux" },
      { find: "gonna", replace: "going to" },
    ]);
    expect(editedVtt).toContain("Mux");
    expect(editedVtt).toContain("going to");
    expect(replacementCount).toBe(2);
  });

  it("is case-sensitive", () => {
    const { editedVtt, replacementCount } = applyReplacements(sampleVtt, [
      { find: "mucks", replace: "Mux" },
    ]);
    expect(editedVtt).toContain("Mucks");
    expect(replacementCount).toBe(0);
  });

  it("respects word boundaries", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:04.000",
      "The cat is categorical about categories.",
    ].join("\n");
    const { editedVtt, replacementCount } = applyReplacements(vtt, [
      { find: "cat", replace: "dog" },
    ]);
    expect(editedVtt).toContain("The dog is categorical about categories.");
    expect(replacementCount).toBe(1);
  });

  it("returns original when no replacements match", () => {
    const { editedVtt, replacementCount } = applyReplacements(sampleVtt, [
      { find: "nonexistent", replace: "something" },
    ]);
    expect(editedVtt).toBe(sampleVtt);
    expect(replacementCount).toBe(0);
  });

  it("returns original when replacements array is empty", () => {
    const { editedVtt, replacementCount } = applyReplacements(sampleVtt, []);
    expect(editedVtt).toBe(sampleVtt);
    expect(replacementCount).toBe(0);
  });

  it("handles multiple occurrences of the same word", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:04.000",
      "Mucks and Mucks and Mucks again.",
    ].join("\n");
    const { editedVtt, replacementCount } = applyReplacements(vtt, [
      { find: "Mucks", replace: "Mux" },
    ]);
    expect(editedVtt).toContain("Mux and Mux and Mux again.");
    expect(replacementCount).toBe(3);
  });

  it("preserves VTT timestamps and structure", () => {
    const { editedVtt } = applyReplacements(sampleVtt, [
      { find: "Mucks", replace: "Mux" },
    ]);
    expect(editedVtt).toContain("WEBVTT");
    expect(editedVtt).toContain("00:00:01.000 --> 00:00:04.000");
    expect(editedVtt).toContain("00:00:05.000 --> 00:00:08.000");
  });

  it("does not replace words in cue identifiers or headers", () => {
    const vtt = [
      "WEBVTT",
      "",
      "Mucks-cue-id",
      "00:00:01.000 --> 00:00:04.000",
      "Welcome to Mucks streaming.",
    ].join("\n");
    const { editedVtt, replacementCount } = applyReplacements(vtt, [
      { find: "Mucks", replace: "Mux" },
    ]);
    expect(editedVtt).toContain("Mucks-cue-id");
    expect(editedVtt).toContain("Welcome to Mux streaming.");
    expect(replacementCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// editCaptions validation
// ─────────────────────────────────────────────────────────────────────────────

describe("editCaptions validation", () => {
  it("requires at least one operation", async () => {
    // We import the function dynamically to test validation without needing
    // Mux credentials or network access
    const { editCaptions } = await import("../../src/workflows/edit-captions");
    await expect(
      editCaptions("asset-id", "track-id", {} as any),
    ).rejects.toThrow("At least one of autoCensorProfanity or replacements must be provided.");
  });

  it("requires provider when autoCensorProfanity is set", async () => {
    const { editCaptions } = await import("../../src/workflows/edit-captions");
    await expect(
      editCaptions("asset-id", "track-id", {
        autoCensorProfanity: { mode: "blank" },
      } as any),
    ).rejects.toThrow("provider is required when using autoCensorProfanity.");
  });
});
