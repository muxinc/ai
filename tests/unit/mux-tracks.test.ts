import { describe, expect, it } from "vitest";

import {
  buildMuxAiTrackPassthrough,
  findNameCollisionTextTracks,
  findSameLanguageTextTracks,
  isDuplicateTrackNameError,
  MUX_TRACK_PASSTHROUGH_MAX_CHARS,
  normalizeTrackLanguageCode,
  normalizeTrackName,
  planTextTrackReplacement,
  validateTrackPassthrough,
} from "../../src/lib/mux-tracks";
import type { AssetTextTrack, MuxAsset } from "../../src/types";

function track(overrides: Partial<AssetTextTrack> & { id: string }): AssetTextTrack {
  return {
    type: "text",
    text_type: "subtitles",
    status: "ready",
    text_source: "uploaded",
    ...overrides,
  } as AssetTextTrack;
}

function asset(tracks: AssetTextTrack[]): MuxAsset {
  return { id: "asset-1", tracks } as MuxAsset;
}

const TARGET = { languageCode: "en", name: "English" };

describe("normalizeTrackLanguageCode", () => {
  it("lowercases, trims, and keeps only the primary subtag", () => {
    expect(normalizeTrackLanguageCode(" EN-US ")).toBe("en");
    expect(normalizeTrackLanguageCode("en_GB")).toBe("en");
    expect(normalizeTrackLanguageCode("es")).toBe("es");
  });

  it("maps ISO 639-3 to 639-1", () => {
    expect(normalizeTrackLanguageCode("eng")).toBe("en");
    expect(normalizeTrackLanguageCode("spa-419")).toBe("es");
  });

  it("never matches undetermined or auto codes", () => {
    for (const code of ["auto", "und", "mul", "mis", "zxx", "", undefined]) {
      expect(normalizeTrackLanguageCode(code)).toBeUndefined();
    }
  });
});

describe("normalizeTrackName", () => {
  it("trims and lowercases like Mux's uniqueness check", () => {
    expect(normalizeTrackName("  Alpha ")).toBe("alpha");
    expect(normalizeTrackName("ALPHA")).toBe("alpha");
  });

  it("treats empty names as absent", () => {
    expect(normalizeTrackName("   ")).toBeUndefined();
    expect(normalizeTrackName(undefined)).toBeUndefined();
  });
});

describe("findSameLanguageTextTracks", () => {
  it("matches subtitles tracks across region and 639-3 variants in any live status", () => {
    const tracks = [
      track({ id: "a", language_code: "en", name: "One" }),
      track({ id: "b", language_code: "en-US", name: "Two", status: "preparing" }),
      track({ id: "c", language_code: "eng", name: "Three", status: "errored" }),
      track({ id: "d", language_code: "en", name: "Gone", status: "deleted" }),
      track({ id: "e", language_code: "es", name: "Spanish" }),
      track({ id: "f", language_code: "en", name: "Audio", type: "audio", text_type: undefined }),
    ];
    expect(findSameLanguageTextTracks(asset(tracks), TARGET).map(t => t.id)).toEqual(["a", "b", "c"]);
  });

  it("matches nothing for an undetermined target language", () => {
    const tracks = [track({ id: "a", language_code: "und", name: "Unknown" })];
    expect(findSameLanguageTextTracks(asset(tracks), { languageCode: "und", name: "X" })).toEqual([]);
  });
});

describe("findNameCollisionTextTracks", () => {
  it("matches case-insensitively and trimmed, across languages, ignoring audio tracks", () => {
    const tracks = [
      track({ id: "a", language_code: "es", name: "english" }),
      track({ id: "b", language_code: "fr", name: " English " }),
      track({ id: "c", language_code: "en", name: "English CC" }),
      track({ id: "d", language_code: "en", name: "English", type: "audio", text_type: undefined }),
    ];
    expect(findNameCollisionTextTracks(asset(tracks), TARGET).map(t => t.id)).toEqual(["a", "b"]);
  });
});

describe("planTextTrackReplacement", () => {
  it("is clear when nothing shares the language or name", () => {
    const plan = planTextTrackReplacement(asset([track({ id: "a", language_code: "es", name: "Spanish" })]), TARGET, "fail");
    expect(plan).toEqual({ kind: "clear" });
  });

  it("blocks under fail on a same-language track with a different name", () => {
    const plan = planTextTrackReplacement(asset([track({ id: "a", language_code: "en", name: "English CC", text_source: "generated_vod" })]), TARGET, "fail");
    expect(plan.kind).toBe("blocked");
    if (plan.kind === "blocked") {
      expect(plan.tracks.map(t => t.id)).toEqual(["a"]);
      expect(plan.reason).toContain("English CC");
    }
  });

  it("blocks under fail on a same-name track in another language", () => {
    const plan = planTextTrackReplacement(asset([track({ id: "a", language_code: "es", name: "english" })]), TARGET, "fail");
    expect(plan.kind).toBe("blocked");
  });

  it("deletes the union of both sets under replace_all, without duplicates", () => {
    const tracks = [
      track({ id: "a", language_code: "en", name: "English" }),
      track({ id: "b", language_code: "en", name: "English CC", text_source: "generated_vod" }),
      track({ id: "c", language_code: "es", name: "English" }),
      track({ id: "d", language_code: "en", name: "Stale", status: "errored" }),
      track({ id: "e", language_code: "es", name: "Spanish" }),
    ];
    const plan = planTextTrackReplacement(asset(tracks), TARGET, "replace_all");
    expect(plan.kind).toBe("replace");
    if (plan.kind === "replace") {
      expect(plan.toDelete.map(t => t.id)).toEqual(["a", "b", "d", "c"]);
      expect(plan.toDelete[1]).toEqual({
        id: "b",
        type: "text",
        name: "English CC",
        languageCode: "en",
        status: "ready",
        textSource: "generated_vod",
        passthrough: undefined,
      });
    }
  });

  it("deletes only Mux-generated tracks under replace_generated", () => {
    const tracks = [
      track({ id: "a", language_code: "en", name: "English CC", text_source: "generated_vod" }),
      track({ id: "b", language_code: "en", name: "Live", text_source: "generated_live_final" }),
    ];
    const plan = planTextTrackReplacement(asset(tracks), TARGET, "replace_generated");
    expect(plan).toEqual({ kind: "replace", toDelete: expect.arrayContaining([expect.objectContaining({ id: "a" }), expect.objectContaining({ id: "b" })]) });
  });

  it("blocks under replace_generated when an uploaded or embedded track is in the way", () => {
    const tracks = [
      track({ id: "a", language_code: "en", name: "English CC", text_source: "generated_vod" }),
      track({ id: "b", language_code: "en", name: "EN (Generated)", text_source: "uploaded" }),
      track({ id: "c", language_code: "en", name: "CC1", text_source: "embedded" }),
    ];
    const plan = planTextTrackReplacement(asset(tracks), TARGET, "replace_generated");
    expect(plan.kind).toBe("blocked");
    if (plan.kind === "blocked") {
      expect(plan.tracks.map(t => t.id)).toEqual(["b", "c"]);
      expect(plan.reason).toContain("replace_all");
    }
  });

  it("handles two tracks sharing a name (the generate_subtitles bypass case)", () => {
    const tracks = [
      track({ id: "a", language_code: "en", name: "Beta" }),
      track({ id: "b", language_code: "es", name: "Beta", text_source: "generated_vod" }),
    ];
    const plan = planTextTrackReplacement(asset(tracks), { languageCode: "fr", name: "beta" }, "replace_all");
    expect(plan.kind).toBe("replace");
    if (plan.kind === "replace") {
      expect(plan.toDelete.map(t => t.id)).toEqual(["a", "b"]);
    }
  });

  it("never treats kept tracks as conflicts", () => {
    const tracks = [
      track({ id: "source", language_code: "en", name: "English" }),
      track({ id: "other", language_code: "en", name: "English CC" }),
    ];
    expect(planTextTrackReplacement(asset(tracks), { languageCode: "en", name: "English (clean)" }, "fail", { keepTrackIds: ["source"] }).kind).toBe("blocked");
    expect(planTextTrackReplacement(asset([tracks[0]]), { languageCode: "en", name: "English (clean)" }, "fail", { keepTrackIds: ["source"] })).toEqual({ kind: "clear" });
  });

  describe("audio targets", () => {
    const AUDIO_TARGET = { type: "audio" as const, languageCode: "es", name: "Spanish (Auto-dubbed)" };
    const primaryAudio = track({ id: "primary", type: "audio", text_type: undefined, text_source: undefined, status: undefined, language_code: "en", name: "English", primary: true });
    const dubbedEs = track({ id: "dub-es", type: "audio", text_type: undefined, text_source: undefined, status: undefined, language_code: "es", name: "Spanish (Auto-dubbed)" });
    const textEs = track({ id: "text-es", language_code: "es", name: "Spanish (Auto-dubbed)" });

    it("matches only audio tracks, so a same-named text track is not a conflict and vice versa", () => {
      expect(planTextTrackReplacement(asset([textEs]), AUDIO_TARGET, "fail")).toEqual({ kind: "clear" });
      expect(planTextTrackReplacement(asset([dubbedEs]), { ...AUDIO_TARGET, type: "text" }, "fail")).toEqual({ kind: "clear" });
    });

    it("replaces a previous dub under replace_all and reports its type", () => {
      const plan = planTextTrackReplacement(asset([primaryAudio, dubbedEs]), AUDIO_TARGET, "replace_all");
      expect(plan).toEqual({ kind: "replace", toDelete: [expect.objectContaining({ id: "dub-es", type: "audio", primary: false })] });
    });

    it("never deletes the primary audio track, under any policy", () => {
      for (const policy of ["replace_all", "replace_generated"] as const) {
        const plan = planTextTrackReplacement(asset([primaryAudio]), { type: "audio", languageCode: "en", name: "Other" }, policy);
        expect(plan.kind).toBe("blocked");
        if (plan.kind === "blocked") {
          expect(plan.reason).toContain("primary audio");
          expect(plan.tracks).toEqual([expect.objectContaining({ id: "primary", primary: true })]);
        }
      }
    });

    it("blocks under replace_generated because audio tracks are never Mux-generated", () => {
      const plan = planTextTrackReplacement(asset([dubbedEs]), AUDIO_TARGET, "replace_generated");
      expect(plan.kind).toBe("blocked");
      if (plan.kind === "blocked") {
        expect(plan.reason).toContain("Audio track(s) that are not Mux-generated");
      }
    });
  });

  it("ignores tracks without an id", () => {
    const plan = planTextTrackReplacement(asset([{ type: "text", text_type: "subtitles", language_code: "en", name: "English" } as AssetTextTrack]), TARGET, "fail");
    expect(plan).toEqual({ kind: "clear" });
  });
});

describe("isDuplicateTrackNameError", () => {
  it("recognizes Mux's not-unique 400 by nested messages or message", () => {
    expect(isDuplicateTrackNameError({
      status: 400,
      error: { type: "invalid_parameters", messages: ["Track name 'Alpha' is not unique, please choose a different track name and try again"] },
    })).toBe(true);
    expect(isDuplicateTrackNameError({ status: 400, message: "400 Track name 'Alpha' is not unique" })).toBe(true);
  });

  it("rejects other statuses and other 400s", () => {
    expect(isDuplicateTrackNameError({ status: 404, error: { messages: ["is not unique"] } })).toBe(false);
    expect(isDuplicateTrackNameError({ status: 400, error: { messages: ["url is invalid"] } })).toBe(false);
    expect(isDuplicateTrackNameError(new Error("is not unique"))).toBe(false);
    expect(isDuplicateTrackNameError(null)).toBe(false);
  });
});

describe("track passthrough", () => {
  it("builds a JSON audit tag", () => {
    expect(JSON.parse(buildMuxAiTrackPassthrough("translate-captions"))).toEqual({ mux_ai: { workflow: "translate-captions" } });
  });

  it("accepts values up to the Mux limit and rejects longer ones", () => {
    const max = "x".repeat(MUX_TRACK_PASSTHROUGH_MAX_CHARS);
    expect(validateTrackPassthrough(max)).toBe(max);
    expect(validateTrackPassthrough(undefined)).toBeUndefined();
    expect(() => validateTrackPassthrough(`${max}x`)).toThrow(/255 characters/);
  });
});
