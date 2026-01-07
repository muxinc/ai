import env from "../../src/env";

/**
 * Mux assets used by integration tests.
 *
 * Defaults point at Mux-owned demo assets, but you can override them to run tests
 * against your own Mux environment by setting env vars in `.env.test`:
 *
 * - MUX_TEST_ASSET_ID
 * - MUX_TEST_ASSET_ID_VIOLENT
 * - MUX_TEST_ASSET_ID_BURNED_IN_CAPTIONS
 * - MUX_TEST_ASSET_ID_BURNED_IN_CAPTIONS_2
 * - MUX_TEST_ASSET_ID_WITHOUT_BURNED_IN_CAPTIONS
 */
export const muxTestAssets = {
  /**
   * General purpose asset used by most workflows.
   * Recommended: an asset with an English transcript/captions track.
   */
  assetId: env.MUX_TEST_ASSET_ID ?? "88Lb01qNUqFJrOFMITk00Ck201F00Qmcbpc5qgopNV4fCOk",

  /** Recommended: an asset likely to score above violence threshold. */
  violentAssetId: env.MUX_TEST_ASSET_ID_VIOLENT ?? "zYHICEOEbVJIdEfbZZ0048501iJjg9T4SgY00oPVWOaHNU",

  /** Recommended: an asset with clearly visible burned-in captions. */
  burnedInCaptionsAssetId: env.MUX_TEST_ASSET_ID_BURNED_IN_CAPTIONS ?? "atuutlT45YbyucKU15u0100p45fG2CoXfJOd02VWMg4m004",
  burnedInCaptionsAssetId2: env.MUX_TEST_ASSET_ID_BURNED_IN_CAPTIONS_2 ?? "gEvCHSJRioaSMHtsJxT4DA02ee3xbgVL02sDGZJuqt01vs",
  /** Recommended: an asset without burned-in captions. */
  withoutBurnedInCaptionsAssetId: env.MUX_TEST_ASSET_ID_WITHOUT_BURNED_IN_CAPTIONS ?? "gIRjPqMSRcdk200kIKvsUo2K4JQr6UjNg7qKZc02egCcM",
} as const;
