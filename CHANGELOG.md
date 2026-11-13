# Changelog

## [0.62.0](https://github.com/muxinc/ai/compare/v0.61.0...v0.62.0) (2026-11-13)


### Features

* **errors:** classify translate-audio and ElevenLabs failures ([#318](https://github.com/muxinc/ai/issues/318)) ([c0fb1b3](https://github.com/muxinc/ai/commit/c0fb1b3f15972da254c32d27e7a4423dd777c051))

## [0.61.0](https://github.com/muxinc/ai/compare/v0.60.0...v0.61.0) (2026-11-12)


### Features

* **errors:** classify edit-captions ([#317](https://github.com/muxinc/ai/issues/317)) ([09906af](https://github.com/muxinc/ai/commit/09906af27e9c5cbe04384547b0c4fe3d57357830))

## [0.60.0](https://github.com/muxinc/ai/compare/v0.59.0...v0.60.0) (2026-11-11)


### Features

* **errors:** classify translate-captions, with opt-in classified errors in shared helpers ([#314](https://github.com/muxinc/ai/issues/314)) ([30dc010](https://github.com/muxinc/ai/commit/30dc0106ead952f21976cdfc528cde24030eed6a))

## [0.59.0](https://github.com/muxinc/ai/compare/v0.58.0...v0.59.0) (2026-11-09)


### ⚠ BREAKING CHANGES

* **errors:** MuxAiError's constructor takes (message, init), where init is a code or an explicit type and source. MuxAiError no longer declares publicType or publicMessage (legacy errors still carry them at runtime), and MuxAiError.is() checks the __mux_ai_error brand. wrapError() turns an unclassified error into an internal MuxAiError instead of a plain Error. Engagement insights failures are classified errors without the legacy fields.

### Features

* **errors:** classified error model, with engagement insights moved onto it ([#304](https://github.com/muxinc/ai/issues/304)) ([d07c988](https://github.com/muxinc/ai/commit/d07c98842860170867068579fc216873371e7fe3))
