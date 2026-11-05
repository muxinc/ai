<!--
  Partly generated. The code table between the BEGIN/END GENERATED markers is
  written by `npm run docs:errors` (scripts/error-docs.ts) from each code's TSDoc
  comment in src/lib/mux-ai-error.ts, its classification in MUX_AI_ERROR_CATALOG,
  and MUX_AI_ERROR_PUBLIC_MAPPINGS. Edit those, not the table; a test fails when
  the table is out of date. Everything else in this file is written by hand.
-->

# Errors

Every failure `@mux/ai` raises on purpose is a `MuxAiError` that says what kind of failure it is, whose problem it is, and, when it can, exactly which condition it was. This guide is for two audiences:

- **Consumers** handling failures: what the fields mean, how retries work, and what to show end users.
- **Contributors**, people and coding agents alike, raising failures: how to classify one, and when a new code is worth adding.

## The model

| Field | Answers | Example |
|---|---|---|
| `type` | What kind of failure, coarsely. Always safe to show end users | `validation_error` |
| `source` | Whose problem it is, from the SDK caller's side | `asset` |
| `dependency` | Which remote service was involved, if any | `ai_provider` |
| `code` | Exactly which condition, when it's precise enough to name | `dubbing_language_unsupported` |
| `facts` | Details of this occurrence, JSON-safe | `{ language: "ur", which: "target" }` |
| `retryable` | Whether submitting the same work again, unchanged, may succeed | `false` |
| `transient` | Whether the Workflow step runner should retry the step now | `false` |
| `message` | Internal detail for developers and logs. **Never end-user text** | `Audio dubbing does not support the target language "ur".` |

Types are generic and codes are specific: many codes share a type, and a code always implies its type, source and dependency. Facts carry what varies from one occurrence to the next, so codes can stay few and stable.

```ts
import { MUX_AI_ERROR_CODES, MuxAiError, toPublicError } from "@mux/ai";

try {
  await translateAudio(assetId, "ur");
}
catch (error) {
  if (!MuxAiError.is(error)) {
    throw error;
  }
  if (error.code === MUX_AI_ERROR_CODES.DUBBING_LANGUAGE_UNSUPPORTED) {
    // React to the exact condition; `error.facts.language` says which.
  }
  log.warn({ type: error.type, source: error.source, code: error.code, facts: error.facts }, error.message);
  showToEndUser(toPublicError(error));
}
```

Use `MuxAiError.is()`, not `instanceof`: errors revived across a Workflow step boundary or from another bundle copy fail `instanceof`.

### Types

Types are public: every value is safe to show any end user, and a new type must be too. Treat `type` as an open string, so a new value is not a breaking change.

| Type | Meaning |
|---|---|
| `validation_error` | The request, the asset or the account can't be used as it is |
| `processing_error` | The work was attempted and failed |
| `timeout_error` | The work didn't finish in time |
| `content_policy_error` | Content was refused by a content policy |
| `capacity_error` | A service is rate limiting or over capacity |
| `server_error` | A fault in this code or its configuration |

### Sources

| Source | Whose problem | Example |
|---|---|---|
| `request` | The caller's input | A scope past the end of the asset |
| `asset` | The Mux asset's state | No caption track in the requested language |
| `account` | The Mux account or environment | Missing permissions |
| `upstream` | A remote service failed | The dubbing provider reported a failed dub |
| `internal` | This code, or the configuration of the service running it | Missing signing keys |

`request`, `asset` and `account` failures are the caller's to fix; `upstream` and `internal` ones are not. A consumer may re-attribute a failure, e.g. treat the SDK's `request` as its own bug when it built that input itself.

### Dependencies

`mux_video`, `ai_provider` or `storage`: a remote service reached over the network. Libraries running in-process are never dependencies. A dependency names the service; a code never does.

### Codes

<!-- BEGIN GENERATED: error codes. Don't edit by hand: generated from the TSDoc on MUX_AI_ERROR_CODES by `npm run docs:errors`. -->

| Code | Type | Source | Dependency | Public | Condition |
|---|---|---|---|---|---|
| `invalid_scope` | `validation_error` | `request` |  | yes | The requested time range is invalid, or has nothing to work with. Facts: `reason` (`invalid_start_time`, `invalid_end_time`, `exceeds_duration`, `empty_range`, `no_video`, `no_transcript`) and the bounds involved. |
| `track_replacement_blocked` | `validation_error` | `request` |  | yes | Existing tracks block writing the output track under the chosen replacement policy. Facts: `reason` (`policy_fail`, `not_generated`, `name_collision`, `primary_audio`), `conflictingTracks` and the target track. |
| `caption_track_not_found` | `validation_error` | `asset` |  | yes | No ready caption track matches the requested track or language. Facts: `trackId` or `languageCode`, and what is available. |
| `playback_id_not_found` | `validation_error` | `asset` |  | yes | The asset has no public or signed playback ID (DRM-only assets included). |
| `transcript_empty` | `validation_error` | `asset` |  | yes | The transcript has no usable content. |
| `audio_track_unsupported` | `validation_error` | `asset` |  | yes | Mux won't add an audio track to this asset. Facts: `reason` (`clip`, `live_stream`, `audio_only`). |
| `static_rendition_unsupported` | `validation_error` | `asset` |  | yes | The asset's existing static rendition can't be used as a source. Facts: `reason` (`unusable`, `too_large`) and the rendition's details. |
| `signing_credentials_missing` | `server_error` | `internal` |  | no | Signed playback needs signing keys the service running the SDK didn't provide. |
| `storage_not_configured` | `server_error` | `internal` |  | no | Storage is needed but the service running the SDK didn't configure it. |
| `content_policy_blocked` | `content_policy_error` | `asset` | `ai_provider` | yes | The model provider refused the content. Facts: `reason` and `category`. |
| `model_output_missing` | `processing_error` | `upstream` | `ai_provider` | no | The model returned no output, or a required field was empty. |
| `model_output_invalid` | `processing_error` | `upstream` | `ai_provider` | no | The model's output breaks the expected shape or constraints (counts, allowed values, limits). |
| `model_output_suppressed` | `processing_error` | `upstream` | `ai_provider` | no | The model's output was withheld by the SDK's output safety filter (a suspected prompt leak). |
| `model_output_incomplete` | `processing_error` | `upstream` | `ai_provider` | no | The model stopped early for a reason other than the length limit. |
| `model_output_truncated` | `processing_error` | `internal` | `ai_provider` | no | The model hit the output length limit. |
| `static_rendition_failed` | `processing_error` | `upstream` | `mux_video` | yes | Mux reported the static rendition a workflow needs as errored. |
| `dubbing_language_unsupported` | `validation_error` | `request` | `ai_provider` | yes | The dubbing provider doesn't support the requested language. Facts: `language` and `which` (`target` or `source`). |
| `dubbing_failed` | `processing_error` | `upstream` | `ai_provider` | yes | The dubbing provider ran the dub and reported it failed. Facts: `providerError`, the provider's display text, when it gave one. |

<!-- END GENERATED: error codes -->

A failure without a code still has a type and source; that's normal for conditions not yet worth naming.

## Retries

"Retry" means three different things, and each has its own signal:

| Question | Signal |
|---|---|
| Should the runtime retry this step right now? | `transient` |
| May submitting the same work again, unchanged, succeed? | `retryable` |
| Can the caller fix something and then succeed? | `source` (`request`, `asset`, `account`) plus `code` |

Both flags are policies decided from the classification, not by hand: the site's explicit value wins, then the code's catalog entry, then the rule.

- **`transient`:** `upstream` with no response, or a 408, 425, 429 or 5xx status. A 409 is not transient.
- **`retryable`:** true when transient, for a timeout or a capacity error, or otherwise for `upstream`; false for `request`, `asset`, `account` and `internal` failures and for validation and content-policy errors.
- **Transient implies retryable.** If retrying the step may succeed, so may resubmitting.
- Only non-transient errors are named `FatalError`, which tells Workflow DevKit not to retry the step.

## Showing errors to end users

`message` is internal: it may name options, call names, statuses and other detail meant for developers. Never show it to end users. `toPublicError(error)` returns what end users may see, `{ type, code?, message, retryable, facts? }`, using a ladder:

1. **The code has a public mapping** (`MUX_AI_ERROR_PUBLIC_MAPPINGS`): the code, the mapping's allowed facts, and its wording, built only from those facts.
2. **Otherwise, by source:** generic wording for `request`, `asset` and `account` failures.
3. **Otherwise, by type:** generic wording for timeouts, capacity, content policy, and other failures (worded "try again" when retryable).

Codes, facts and messages are internal by default; only an explicit mapping makes a code and some of its facts public. `MUX_AI_ERROR_GENERIC_MESSAGES` holds the generic wording. Consumers with their own vocabulary (e.g. API parameter names) can override the message per public code and keep the rest of the view.

## Raising errors

### Choose the classification

1. **Whose problem is it?** Pick the `source`. If a remote service answered with something the caller can fix (a missing track, a 404 for their asset), it's still `asset` or `request`; if it failed, it's `upstream`; if it's our bug or the service's configuration, it's `internal`.
2. **Was a remote service involved?** Set `dependency`.
3. **Is there an existing code for this exact condition?** Use it: `{ code }` alone implies the type, source and dependency, so the site can't contradict them.
4. **Otherwise,** pass `type` and `source` explicitly, and consider whether the condition deserves a code (below).
5. **Record what varies as facts:** IDs, languages, limits, statuses, the call that failed. Keep values JSON-safe. Pass provider free text through `errorDetailFact()`, which strips URL tokens, suppresses prompt leaks and caps the length. Never put credentials, signed URLs or raw model output in facts.
6. **Write `message` for a developer reading a log.** It can be specific; it is never shown to end users.

Helpers: `internalError()` and `assertNever()` for this code's own failures (`throw new Error` loses the classification), `wrapError()` to add facts to a classified error as it passes through, and the content-policy helpers in `content-policy-error.ts` for model calls.

Override `retryable` or `transient` only with a one-line comment saying why, and prefer a fact that explains it (`status: 200` for a dependency that answered with a failure makes it non-transient by rule).

### When to add a code

Add one when a consumer would act on the condition, or word it for end users, differently from its neighbours. Good signals: end users can fix it, it recurs and needs tracking, or generic wording would lose something end users see today.

Don't add one for differences that facts already carry: the vendor (`dependency`), the call that failed (`call`), a status, or a value. One `audio_track_unsupported` with a `reason` fact beats three codes.

- **Name the condition, never the vendor:** `dubbing_failed`, not `elevenlabs_error`.
- **snake_case, specific, and stable.** Codes are only ever added. Renaming or removing one is a breaking change, and a removed name is never reused.
- **Add it to `MUX_AI_ERROR_CATALOG`** with its type, source and dependency, and a retry override only if the rule gets it wrong for every occurrence.
- **Describe it in a TSDoc comment on its `MUX_AI_ERROR_CODES` entry** (the condition, and the facts it carries), then run `npm run docs:errors` to regenerate this guide's table. A test fails while the table is out of date.

### When to make a code public

Map a code in `MUX_AI_ERROR_PUBLIC_MAPPINGS` when end users can act on it or need to know it. Allow only facts that are safe to show and useful to them, and write wording that doesn't name SDK options, internal calls or vendors' internals. Internal codes still reach end users through the generic wording, so leaving a code internal never hides that a failure happened.
