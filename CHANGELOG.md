# Changelog

## [0.68.0](https://github.com/muxinc/ai/compare/v0.67.0...v0.68.0) (2026-11-20)


### Features

* **errors:** classify generate-text ([#334](https://github.com/muxinc/ai/issues/334)) ([a0494aa](https://github.com/muxinc/ai/commit/a0494aa8ea0143288175d054462236cace2f2a97))
* **errors:** Google model-call rules, and modelCallError for your own calls ([#335](https://github.com/muxinc/ai/issues/335)) ([b31dcf2](https://github.com/muxinc/ai/commit/b31dcf2747d278d714947c518ac6bfe99dbcb667))

## [0.67.0](https://github.com/muxinc/ai/compare/v0.66.0...v0.67.0) (2026-11-18)


### Features

* **errors:** classify burned-in-captions ([#331](https://github.com/muxinc/ai/issues/331)) ([60e94ba](https://github.com/muxinc/ai/commit/60e94ba8be0c95474790221ec15e140b05ffafed))
* **errors:** classify moderate ([#326](https://github.com/muxinc/ai/issues/326)) ([f118ef6](https://github.com/muxinc/ai/commit/f118ef6447586b11214c177779819e4ac8f2dac7))

## [0.66.0](https://github.com/muxinc/ai/compare/v0.65.0...v0.66.0) (2026-11-17)


### Features

* **errors:** code every dependency failure, per dependency first ([#330](https://github.com/muxinc/ai/issues/330)) ([31f36dd](https://github.com/muxinc/ai/commit/31f36dde4db095cbffd677a1eecabb94331b5940))

## [0.65.0](https://github.com/muxinc/ai/compare/v0.64.0...v0.65.0) (2026-11-16)


### Features

* **errors:** classify ask-questions ([#324](https://github.com/muxinc/ai/issues/324)) ([cd5f473](https://github.com/muxinc/ai/commit/cd5f4730a5ac6060ff0c3d35c357ac958f93b693))

## [0.64.0](https://github.com/muxinc/ai/compare/v0.63.1...v0.64.0) (2026-11-16)


### Features

* **errors:** classify summarize ([#323](https://github.com/muxinc/ai/issues/323)) ([42cac15](https://github.com/muxinc/ai/commit/42cac1573d7ffda9bd77d19ca6cea2d8d0c93fa9))

## [0.63.1](https://github.com/muxinc/ai/compare/v0.63.0...v0.63.1) (2026-11-16)


### Bug Fixes

* **errors:** step-retry OpenAI's intermittent prompt flag ([#327](https://github.com/muxinc/ai/issues/327)) ([0f9f6af](https://github.com/muxinc/ai/commit/0f9f6afd56d2af4618597c060d31d371a8ef61da))

## [0.63.0](https://github.com/muxinc/ai/compare/v0.62.0...v0.63.0) (2026-11-13)


### Features

* **errors:** classify generate-chapters ([#321](https://github.com/muxinc/ai/issues/321)) ([990d7c2](https://github.com/muxinc/ai/commit/990d7c246846aa6c5974500fb4c8eedc1bd93c36))

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
