import { describe, expect, it } from "vitest";

import {
  HIVE_HATE_CATEGORIES,
  HIVE_ILLICIT_CATEGORIES,
  HIVE_SELF_HARM_CATEGORIES,
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
    ]);
  });

  it("the HIVE_HATE_CATEGORIES has not changed — If you change these, remember to check that these are accurate categories in Hive!", () => {
    expect(HIVE_HATE_CATEGORIES).toEqual([
      "yes_nazi",
      "yes_terrorist",
      "yes_kkk",
      "yes_confederate",
    ]);
  });

  it("the HIVE_SELF_HARM_CATEGORIES has not changed — If you change these, remember to check that these are accurate categories in Hive!", () => {
    expect(HIVE_SELF_HARM_CATEGORIES).toEqual([
      "yes_self_harm",
      "yes_emaciated_body",
    ]);
  });

  it("the HIVE_ILLICIT_CATEGORIES has not changed — If you change these, remember to check that these are accurate categories in Hive!", () => {
    expect(HIVE_ILLICIT_CATEGORIES).toEqual([
      "yes_pills",
      "illicit_injectables",
      "yes_marijuana",
    ]);
  });
});
