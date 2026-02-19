import { describe, expect, it } from "vitest";

import { HIVE_SEXUAL_CATEGORIES, HIVE_VIOLENCE_CATEGORIES } from "../../src/workflows/moderation";

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
