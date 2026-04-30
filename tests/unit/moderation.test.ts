import { describe, expect, it } from "vitest";

import {
  GOOGLE_VISION_LIKELIHOOD_TO_SCORE,
  HIVE_SEXUAL_CATEGORIES,
  HIVE_VIOLENCE_CATEGORIES,
} from "../../src/workflows/moderation";

describe("hive moderation categories", () => {
  it("the HIVE_SEXUAL_CATEGORIES has not changed — If you change these, remember to check that these are accurate categories in Hive!", () => {
    expect(HIVE_SEXUAL_CATEGORIES).toEqual([
      "general_nsfw",
      "yes_sexual_activity",
      "yes_sex_toy",
      "yes_female_nudity",
      "yes_male_nudity",
    ]);
  });

  it("the HIVE_VIOLENCE_CATEGORIES has not changed — If you change these, remember to check that these are accurate categories in Hive!", () => {
    expect(HIVE_VIOLENCE_CATEGORIES).toEqual([
      "gun_in_hand",
      "gun_not_in_hand",
      "knife_in_hand",
      "very_bloody",
      "other_blood",
      "hanging",
      "noose",
      "human_corpse",
      "yes_emaciated_body",
      "yes_self_harm",
      "garm_death_injury_or_military_conflict",
    ]);
  });
});

describe("google vision moderation likelihood mapping", () => {
  it("the GOOGLE_VISION_LIKELIHOOD_TO_SCORE mapping has not changed — If you change these, double-check that thresholds still behave as expected!", () => {
    expect(GOOGLE_VISION_LIKELIHOOD_TO_SCORE).toEqual({
      UNKNOWN: 0,
      VERY_UNLIKELY: 0.2,
      UNLIKELY: 0.4,
      POSSIBLE: 0.6,
      LIKELY: 0.8,
      VERY_LIKELY: 1,
    });
  });
});
