<!--
  Partly generated. The tables between BEGIN/END GENERATED markers are written by
  `npm run docs:errors` (scripts/error-docs.ts) from src/lib/mux-ai-error.ts: the
  TSDoc on each value of MUX_AI_ERROR_TYPES, MUX_AI_ERROR_SOURCES,
  MUX_AI_ERROR_DEPENDENCIES and MUX_AI_ERROR_CODES, each code's classification in
  MUX_AI_ERROR_CATALOG, and MUX_AI_ERROR_PUBLIC_MAPPINGS (src/lib/public-error.ts).
  Edit those, not the tables; a test fails when a table is out of date. Everything
  else in this file is written by hand.
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

<!-- BEGIN GENERATED: error types. Don't edit by hand: run `npm run docs:errors`. -->

| Type | Meaning |
|---|---|
| `validation_error` | The request, the asset or the account can't be used as it is. |
| `processing_error` | The work was attempted and failed. |
| `timeout_error` | The work didn't finish in time. |
| `content_policy_error` | Content was refused by a content policy. |
| `capacity_error` | A service is rate limiting or over capacity. |
| `server_error` | A fault in this code or its configuration. |

<!-- END GENERATED: error types -->

### Sources

<!-- BEGIN GENERATED: error sources. Don't edit by hand: run `npm run docs:errors`. -->

| Source | Meaning |
|---|---|
| `request` | The caller's input, e.g. a scope past the end of the asset. |
| `asset` | The Mux asset's state, e.g. no caption track in the requested language. |
| `account` | The Mux account or environment, e.g. missing permissions. |
| `upstream` | A remote service failed, e.g. the dubbing provider reported a failed dub. |
| `internal` | This code, or the configuration of the service running it, e.g. missing signing keys. |

<!-- END GENERATED: error sources -->

`request`, `asset` and `account` failures are the caller's to fix; `upstream` and `internal` ones are not. A consumer may re-attribute a failure, e.g. treat the SDK's `request` as its own bug when it built that input itself.

### Dependencies

A remote service reached over the network. Libraries running in-process are never dependencies. A dependency names the service; a code never does.

<!-- BEGIN GENERATED: error dependencies. Don't edit by hand: run `npm run docs:errors`. -->

| Dependency | Meaning |
|---|---|
| `mux_video` | Mux Video: the API, stream and image delivery, and its static renditions and tracks. |
| `ai_provider` | A model or AI service provider, e.g. a language model API or the dubbing provider. |
| `storage` | Object storage the SDK writes to or reads from, e.g. an S3-compatible bucket. |

<!-- END GENERATED: error dependencies -->

### Codes

<!-- BEGIN GENERATED: error codes. Don't edit by hand: run `npm run docs:errors`. -->

| Code | Type | Source | Dependency | Public | Condition |
|---|---|---|---|---|---|
| `invalid_scope` | `validation_error` | `request` |  | yes | The requested time range is invalid, or has nothing to work with. Facts: `reason` (`invalid_start_time`, `invalid_end_time`, `exceeds_duration`, `empty_range`, `no_video`, `no_transcript`) and the bounds involved. |
| `track_replacement_blocked` | `validation_error` | `request` |  | yes | Existing tracks block writing the output track under the chosen replacement policy. Facts: `reason` (`policy_fail`, `not_generated`, `name_collision`, `primary_audio`), `conflictingTracks` and the target track. |
| `caption_track_not_found` | `validation_error` | `asset` |  | yes | No ready caption track matches the requested track or language. Facts: `trackId` or `languageCode`, and what is available. |
| `playback_id_not_found` | `validation_error` | `asset` |  | yes | The asset has no public or signed playback ID (DRM-only assets included). |
| `transcript_empty` | `validation_error` | `asset` |  | yes | The transcript has no usable content. |
| `audio_track_unsupported` | `validation_error` | `asset` |  | yes | Mux won't add an audio track to this asset. Facts: `reason` (`clip`, `live_stream`, `audio_only`). |
| `static_rendition_unsupported` | `validation_error` | `asset` |  | yes | The asset's existing static rendition can't be used as a source. Facts: `reason` (`unusable`, `too_large`) and the rendition's details. |
| `content_policy_blocked` | `content_policy_error` | `asset` | `ai_provider` | yes | The model provider refused the content. Facts: `reason` and `category`. |
| `static_rendition_failed` | `processing_error` | `upstream` | `mux_video` | yes | Mux reported the static rendition a workflow needs as errored. |
| `dubbing_language_unsupported` | `validation_error` | `request` | `ai_provider` | yes | The dubbing provider doesn't support the requested language. Facts: `language` and `which` (`target` or `source`). |
| `dubbing_failed` | `processing_error` | `upstream` | `ai_provider` | yes | The dubbing provider ran the dub and reported it failed. Facts: `providerError`, the provider's display text, when it gave one. |
| `signing_credentials_missing` | `server_error` | `internal` |  | no | Signed playback needs signing keys the service running the SDK didn't provide. |
| `storage_not_configured` | `server_error` | `internal` |  | no | Storage is needed but the service running the SDK didn't configure it. |
| `model_output_missing` | `processing_error` | `upstream` | `ai_provider` | no | The model returned no output, or a required field was empty. |
| `model_output_invalid` | `processing_error` | `upstream` | `ai_provider` | no | The model's output breaks the expected shape or constraints (counts, allowed values, limits). |
| `model_output_suppressed` | `processing_error` | `upstream` | `ai_provider` | no | The model's output was withheld by the SDK's output safety filter (a suspected prompt leak). |
| `model_output_incomplete` | `processing_error` | `upstream` | `ai_provider` | no | The model stopped early for a reason other than the length limit. |
| `model_output_truncated` | `processing_error` | `internal` | `ai_provider` | no | The model hit the output length limit. |

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

## Building your own errors on the same model

An application that adds its own failures can use the same model, so its errors and the SDK's share one retry policy, one serializer and one public view. `ClassifiedError` is the base `MuxAiError` is built on:

```ts
import type { ClassifiedErrorInit, ErrorCatalogEntry, SerializedClassification } from "@mux/ai";
import { classificationInit, ClassifiedError, createPublicErrorView, MUX_AI_ERROR_PUBLIC_MAPPINGS, MUX_AI_ERROR_SOURCES, MUX_AI_ERROR_TYPES, restoreClassification, serializeClassification } from "@mux/ai";

const APP_ERROR_TYPES = { ...MUX_AI_ERROR_TYPES, CONFLICT: "conflict" } as const;
const APP_ERROR_CODES = { JOB_ALREADY_RUNNING: "job_already_running" } as const;
const APP_ERROR_CATALOG = {
  [APP_ERROR_CODES.JOB_ALREADY_RUNNING]: { type: APP_ERROR_TYPES.CONFLICT, source: MUX_AI_ERROR_SOURCES.REQUEST },
} as const satisfies Record<AppErrorCode, ErrorCatalogEntry<AppErrorType>>;

class AppError extends ClassifiedError<AppErrorType, AppErrorCode> {
  constructor(message: string, init: ClassifiedErrorInit<AppErrorType, AppErrorCode, string>) {
    super(message, init, APP_ERROR_CATALOG);
  }
  // For Workflow DevKit, add static WORKFLOW_SERIALIZE / WORKFLOW_DESERIALIZE hooks
  // built from serializeClassification(), classificationInit() and restoreClassification().
}

const toPublic = createPublicErrorView<string, string>({
  mappings: { ...MUX_AI_ERROR_PUBLIC_MAPPINGS, [APP_ERROR_CODES.JOB_ALREADY_RUNNING]: { message: "A job with these parameters is already running." } },
  genericMessage: error => /* your generic wording, by source then type */ "The job failed.",
});
```

- **Types:** extend `MUX_AI_ERROR_TYPES` rather than redefining it, and keep every type safe to show end users.
- **Sources** are shared as they are; **dependencies** are yours to extend with the services you call.
- **One view for both:** pass the SDK's public mappings along with yours, so SDK failures keep their public wording.

## Raising errors

### Choose the classification

1. **Whose problem is it?** Pick the `source`. If a remote service answered with something the caller can fix (a missing track, a 404 for their asset), it's still `asset` or `request`; if it failed, it's `upstream`; if it's our bug or the service's configuration, it's `internal`.
2. **Was a remote service involved?** Set `dependency`.
3. **Is there an existing code for this exact condition?** Use it: `{ code }` alone implies the type, source and dependency, so the site can't contradict them.
4. **Otherwise,** pass `type` and `source` explicitly, and consider whether the condition deserves a code (below).
5. **Record what varies as facts:** IDs, languages, limits, statuses, the call that failed. Keep values JSON-safe. Pass provider free text through `errorDetailFact()`, which strips URL tokens, suppresses prompt leaks and caps the length. Never put credentials, signed URLs or raw model output in facts.
6. **Write `message` for a developer reading a log.** It can be specific; it is never shown to end users.

Helpers:

- **Remote calls:** classify where the call is made, while the status is still in hand. `dependencyError()` (in `dependency-error.ts`) turns a status into a source and retry policy: no response, 408, 425, 429 and 5xx are `upstream` and transient; 401/403 and 404 take the source the caller chooses (`authSource`, `notFoundSource`); other 4xx are `internal`, a request we built. It records `call`, `status` and `requestId`, and takes `idempotent: false` for calls that may have taken effect (a create), so a no-response or 5xx failure isn't step-retried. The Mux, storage and ElevenLabs helpers build on it.
- **Model calls:** the content-policy helpers in `content-policy-error.ts` take a `{ call, provider, model }` context and classify provider failures, unparseable or empty output, early stops and content-policy blocks once retries are exhausted.
- **This code's own failures:** `internalError()` and `assertNever()`. A lint rule bans `throw new Error` in `src/`.
- **Passing errors up:** `wrapError()` passes a classified error through, merging facts, and turns anything unclassified into an `internal` failure.

Override `retryable` or `transient` only with a one-line comment saying why, and prefer a fact that explains it (`status: 200` for a dependency that answered with a failure makes it non-transient by rule).

### When to add a code

Add one when a consumer would act on the condition, or word it for end users, differently from its neighbours. Good signals: end users can fix it, it recurs and needs tracking, or generic wording would lose something end users see today.

Don't add one for differences that facts already carry: the vendor (`dependency`), the call that failed (`call`), a status, or a value. One `audio_track_unsupported` with a `reason` fact beats three codes.

- **Name the condition, never the vendor:** `dubbing_failed`, not `elevenlabs_error`.
- **snake_case, specific, and stable.** Codes are only ever added. Renaming or removing one is a breaking change, and a removed name is never reused.
- **Add it to `MUX_AI_ERROR_CATALOG`** with its type, source and dependency, and a retry override only if the rule gets it wrong for every occurrence.
- **Describe it in a TSDoc comment on its `MUX_AI_ERROR_CODES` entry** (the condition, and the facts it carries), then run `npm run docs:errors` to regenerate this guide's tables. A test fails while a table is out of date.

### When to make a code public

Map a code in `MUX_AI_ERROR_PUBLIC_MAPPINGS` when end users can act on it or need to know it. Allow only facts that are safe to show and useful to them, and write wording that doesn't name SDK options, internal calls or vendors' internals. Internal codes still reach end users through the generic wording, so leaving a code internal never hides that a failure happened.
