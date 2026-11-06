# Agent notes for @mux/ai

Read [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, testing and code style. This is a public repository: keep code, commits and PR text free of references to private systems.

## Errors

Before raising, changing or classifying an error, read [docs/ERRORS.md](./docs/ERRORS.md). In short:

- Classify a remote call's failure where the call is made, with `dependencyError()` or `dependencyErrorFrom()`.
- Raise a classified `MuxAiError` with its `type` and `source` (and `dependency` for an `upstream` failure), plus a `code` from `MUX_AI_ERROR_CATALOG` when one fits; the compiler checks a code's type, source and dependency against its catalog entry. Use `internalError()` / `assertNever()` for this code's own failures.
- Put what varies in `facts` (JSON-safe; provider text through `errorDetailFact()`; never credentials, signed URLs or raw model output). `message` is for developers and is never shown to end users.
- Add a code only when a consumer would act on or word the condition differently; name the condition, never the vendor. Describe it in a TSDoc comment on its `MUX_AI_ERROR_CODES` entry and run `npm run docs:errors` (a test checks the generated tables). Types, sources and dependencies are documented the same way.
- Make a code public only through `MUX_AI_ERROR_PUBLIC_MAPPINGS`, allowing only facts that are safe to show.
- Modules not yet on the model raise legacy errors (`LegacyMuxAiError`, `legacyWrapError()`), whose message is end-user text. Don't add new legacy sites. When moving a module, keep what end users see (a public code where a legacy message told them something), and add it to `CLASSIFIED_ERROR_MODULES` in `eslint.config.mjs`.
