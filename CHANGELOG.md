# Changelog

## [0.59.0](https://github.com/muxinc/ai/compare/v0.58.0...v0.59.0) (2026-11-09)


### ⚠ BREAKING CHANGES

* **errors:** MuxAiError's constructor takes (message, init), where init is a code or an explicit type and source. MuxAiError no longer declares publicType or publicMessage (legacy errors still carry them at runtime), and MuxAiError.is() checks the __mux_ai_error brand. wrapError() turns an unclassified error into an internal MuxAiError instead of a plain Error. Engagement insights failures are classified errors without the legacy fields.

### Features

* **errors:** classified error model, with engagement insights moved onto it ([#304](https://github.com/muxinc/ai/issues/304)) ([d07c988](https://github.com/muxinc/ai/commit/d07c98842860170867068579fc216873371e7fe3))
