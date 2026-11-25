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

Modules are moving onto this model one at a time. Until a module has moved, its failures are [legacy errors](#legacy-errors), which keep their previous behaviour.

## The model

| Field | Answers | Example |
|---|---|---|
| `type` | What kind of failure, coarsely. Always safe to show end users | `processing_error` |
| `source` | Whose problem it is, from the SDK caller's side | `upstream` |
| `dependency` | Which remote service was involved, if any | `ai_provider` |
| `code` | Exactly which condition, when it's precise enough to name | `model_output_invalid` |
| `facts` | Details of this occurrence, JSON-safe | `{ call: "generate_engagement_insights", returnedCount: 3 }` |
| `retryable` | Whether submitting the same work again, unchanged, may succeed | `false` |
| `transient` | Whether the Workflow step runner should retry the step now | `false` |
| `message` | Internal detail for developers and logs. **Never end-user text** | `Failed to generate valid insights for asset abc123.` |

Types are generic and codes are specific: many codes share a type, and a code always has one type, source and dependency (its catalog entry). Every site states its type and source, and the compiler only accepts the ones a code's catalog entry gives it, so a site reads on its own and can't contradict the catalog. Facts carry what varies from one occurrence to the next, so codes can stay few and stable.

```ts
import { MUX_AI_ERROR_CODES, MuxAiError, toPublicError } from "@mux/ai";

try {
  await generateEngagementInsights(assetId);
}
catch (error) {
  if (!MuxAiError.is(error)) {
    throw error;
  }
  if (error.code === MUX_AI_ERROR_CODES.MODEL_OUTPUT_INVALID) {
    // React to the exact condition; `error.facts` says which call and model.
  }
  log.warn({ type: error.type, source: error.source, code: error.code, facts: error.facts, causes: error.causes }, error.message);
  showToEndUser(toPublicError(error));
}
```

Use `MuxAiError.is()`, not `instanceof`: errors revived across a Workflow step boundary or from another bundle copy fail `instanceof`. `ClassifiedError.isClassified()` matches any error on this model, including [your own](#building-your-own-errors-on-the-same-model). Both check brand fields (`__mux_ai_error`, `__classified_error`), so they work across copies of the SDK.

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
| `mux_data` | Mux Data: its API, e.g. engagement data (heatmaps and hotspots). |
| `ai_provider` | A model or AI service provider, e.g. a language model API or the dubbing provider. |
| `storage` | Object storage the SDK writes to or reads from, e.g. an S3-compatible bucket. |

<!-- END GENERATED: error dependencies -->

### Codes

<!-- BEGIN GENERATED: error codes. Don't edit by hand: run `npm run docs:errors`. -->

| Code | Type | Source | Dependency | Public | Condition |
|---|---|---|---|---|---|
| `invalid_scope` | `validation_error` | `request` |  | yes | The requested time range is invalid, or has nothing to work with. Facts: `reason` (`invalid_start_time`, `invalid_end_time`, `exceeds_duration`, `empty_range`, `no_video`, `no_transcript`, `no_scenes`) and the bounds involved (`videoEndTime` for `no_video`). |
| `track_replacement_blocked` | `validation_error` | `request` |  | yes | Existing tracks block writing the output track under the chosen replacement policy. Facts: `reason` (`policy_fail`, `not_generated`, `name_collision`, `primary_audio`), `conflictingTracks` and the target track, plus `sourceRestored` and `restoredTrackId` when a source track was deleted first. |
| `invalid_parameter` | `validation_error` | `request` |  | yes | An option's value can't be used. Facts: `parameter` (the caller's option name), `reason` (`too_many`, `empty`, `too_long`, `disallowed_characters`, `not_normalized`, `multiline`, `required_with`, `conflicts_with`, `not_allowed`, `one_of_required`, `audio_only`, `not_positive`, `invalid_format`, `duplicate`) and the values the reason names: `count` and `max`, `index` (0-based entry), `length` and `maxLength`, `characters`, `with` and `withValue` (the other option), `allowed` and `value`, `parameters` (the options to choose from), `format` (what the value must look like). `duplicate` is a list of keyed entries that repeats a key (`value`). |
| `parameter_out_of_range` | `validation_error` | `request` |  | yes | A numeric option is outside its allowed range. Facts: `parameter` (the caller's option name), `value`, `min`, `max`, `integer` when it must be a whole number, and `unit` when the bounds have one. The public wording names the bound that was crossed. |
| `caption_track_not_found` | `validation_error` | `asset` |  | yes | No ready caption track matches the requested track or language. Facts: `trackId` or `languageCode`, and what is available. |
| `caption_track_language_missing` | `validation_error` | `asset` |  | yes | The caption track has no language, so its source language can't be determined. Facts: `trackId`. |
| `playback_id_not_found` | `validation_error` | `asset` |  | yes | The asset has no public or signed playback ID (DRM-only assets included). |
| `asset_not_found` | `validation_error` | `request` | `mux_video` | yes | Mux has no asset with the requested ID in this environment. Facts: `assetId`. |
| `transcript_empty` | `validation_error` | `asset` |  | yes | The transcript has no usable content. |
| `asset_duration_unavailable` | `validation_error` | `asset` |  | yes | The asset has no valid duration, so work that depends on it can't run. Facts: `assetId`. |
| `audio_track_unsupported` | `validation_error` | `asset` |  | yes | Mux won't add an audio track to this asset. Facts: `reason` (`clip`, `live_stream`, `audio_only`). |
| `static_rendition_unsupported` | `validation_error` | `asset` |  | yes | The asset's existing static rendition can't be used as a source. Facts: `reason` (`unusable`, `too_large`) and the rendition's details. |
| `content_policy_blocked` | `content_policy_error` | `asset` | `ai_provider` | yes | The model provider refused the content. Facts: `reason` and `category`. `reason` `PROMPT_FLAGGED` is OpenAI's intermittent up-front prompt flag: step-retried, unlike every other reason. |
| `model_output_missing` | `processing_error` | `upstream` | `ai_provider` | yes | The model returned no output, or a required field was empty. Facts: `call`, `provider`, `model`, and `assetId` when there is one. |
| `model_output_invalid` | `processing_error` | `upstream` | `ai_provider` | yes | The model's output breaks the expected shape or constraints (counts, allowed values, limits). Facts: `call`, `provider`, `model`, and `assetId` when there is one. |
| `static_rendition_failed` | `processing_error` | `upstream` | `mux_video` | yes | Mux reported the static rendition a workflow needs as errored. |
| `dubbing_language_unsupported` | `validation_error` | `request` | `ai_provider` | yes | The dubbing provider doesn't support the requested language. Facts: `language` and `which` (`target` or `source`). |
| `dubbing_failed` | `processing_error` | `upstream` | `ai_provider` | yes | The dubbing provider ran the dub and reported it failed. Facts: `providerError`, the provider's display text, when it gave one. |
| `dubbing_timeout` | `timeout_error` | `upstream` | `ai_provider` | yes | The dubbing provider didn't finish the dub within the polling budget. Facts: `dubbingId`, `timeoutSeconds`, `lastStatus`. |
| `audio_track_missing` | `validation_error` | `asset` |  | yes | The asset has no audio track, so there is no audio to work with. Facts: `assetId`. |
| `primary_audio_track_conflict` | `validation_error` | `asset` |  | yes | Writing an audio track would replace the asset's primary audio track, which can't be replaced. Facts: `languageCode`, `conflictingTracks`. |
| `static_rendition_changed` | `processing_error` | `asset` |  | yes | The asset's static rendition settings changed while waiting for its rendition. A new job uses the new settings. Facts: `assetId`. |
| `static_rendition_timeout` | `timeout_error` | `upstream` | `mux_video` | yes | Mux didn't finish the static rendition within the polling budget. Facts: `assetId`, `attempts`, `pollIntervalMs`, `lastStatus`. |
| `audio_unprocessable` | `validation_error` | `asset` | named by the site | yes | The provider can't process the asset's audio. The site names the dependency. Facts: `call`, `status`, `providerCode`, `reason` (`corrupt`, `unsupported_format`, `too_long`, `too_short`). |
| `image_unprocessable` | `validation_error` | `asset` | named by the site | yes | The provider says it can't process an image taken from the asset (invalid or unreadable). The site names the dependency. Facts: `call`, `providerCode`. |
| `signing_credentials_missing` | `server_error` | `internal` |  | no | Signed playback needs signing keys the service running the SDK didn't provide. |
| `storage_not_configured` | `server_error` | `internal` |  | no | Storage is needed but the service running the SDK didn't configure it. |
| `provider_not_configured` | `server_error` | `internal` |  | no | The model provider the request uses isn't configured by the service running the SDK: no API key, no default model, or no usable endpoint URL. Facts: `provider`, `reason` (`api_key_missing`, `model_missing`, `base_url_missing`, `base_url_unsupported`), `settings` (the environment variables and workflow credential fields that configure it; names only, never values). |
| `model_unsupported` | `validation_error` | `request` |  | no | The requested model provider or model can't be used: the provider isn't one the SDK supports, or the model has been retired. Facts: `reason` (`provider_unsupported`, `model_retired`), `provider`, `model` for `model_retired`, `replacementModel` when there is one, and `inputs` (`provider` or `model`). |
| `track_write_unclassified` | `server_error` | `internal` |  | no | A track write failed, but the opted-in result carried no classified error: a bug in the SDK's track-write path. Facts: `reason`, the raw failure's message. |
| `track_id_missing` | `processing_error` | `upstream` | `mux_video` | no | Mux answered a track create without a track id. The track may exist, so it isn't step-retried. Facts: `call`, `assetId`. |
| `image_response_invalid` | `processing_error` | `upstream` | `mux_video` | no | Mux answered an image download with something other than a non-empty image. Facts: `call`, `reason` (`not_image`, `empty`), `contentType`. |
| `caption_track_id_missing` | `processing_error` | `upstream` | `mux_video` | no | The asset's ready caption track has no id, so its transcript can't be fetched. Facts: `assetId`, `languageCode`. |
| `asset_snapshot_mismatch` | `server_error` | `internal` |  | no | The asset snapshot the service running the SDK passed in is for a different asset than the one requested. Facts: `assetId`, `snapshotAssetId`. |
| `asset_id_mismatch` | `processing_error` | `upstream` | `mux_video` | no | Mux answered an asset fetch with a different asset than the one requested. Facts: `assetId`, `returnedAssetId`. |
| `translation_chunk_unsplittable` | `server_error` | `internal` |  | no | Translation needed to split a chunk of fewer than two cues: a bug in the SDK's chunking. Facts: `chunkId`, `cueCount`. |
| `model_output_suppressed` | `processing_error` | `upstream` | `ai_provider` | no | The model's output was withheld by the SDK's output safety filter (a suspected prompt leak). |
| `model_output_incomplete` | `processing_error` | `upstream` | `ai_provider` | no | The model stopped early for a reason other than the length limit. |
| `model_output_truncated` | `processing_error` | `internal` | `ai_provider` | no | The model hit the output length limit. |
| `provider_quota_exhausted` | `server_error` | `internal` | named by the site | no | The provider says the account the service running the SDK uses is out of credits or quota, or hit a spend or usage limit. Retrying won't help until someone changes the account. The site names the dependency. Facts: `call`, `status`, and `providerCode` when the provider gave one. |
| `provider_credentials_rejected` | `server_error` | `internal` | named by the site | no | The provider rejected the key the service running the SDK uses, or the key lacks permission for this model or feature. The site names the dependency. Facts: `call`, `status`, and `providerCode` when the provider gave one. |
| `provider_rate_limited` | `capacity_error` | `upstream` | named by the site | no | The provider says requests are over its rate or concurrency limit. The site names the dependency. Facts: `call`, `status`, and `providerCode` when the provider gave one. |
| `provider_unavailable` | `capacity_error` | `upstream` | named by the site | no | The provider says it's overloaded or down for maintenance. The site names the dependency. Facts: `call`, `status`, and `providerCode` when the provider gave one. |
| `account_credentials_rejected` | `validation_error` | `account` | named by the site | no | Mux rejected the caller's access token (401), or the token lacks permission for this call (403), e.g. Mux Data access. Facts: `call`, `status`, `inputs` (`credentials`). |
| `asset_resource_not_found` | `validation_error` | `asset` | named by the site | no | Mux answered 404 for something belonging to the asset (a track, a rendition, an image, its engagement data): gone, or not ready yet. A missing asset itself is `asset_not_found`. Facts: `call`, `status`. |
| `playback_access_denied` | `validation_error` | `account` | named by the site | no | Mux denied delivery of the asset's media (a transcript, a caption file, an image), e.g. a signing key or playback restriction in the Mux account rejected the request. Facts: `call`, `status`. |
| `dependency_no_response` | `processing_error` | `upstream` | named by the site | no | No response arrived, and the call didn't time out (e.g. a connection failure). Facts: `call`. |
| `dependency_timeout` | `timeout_error` | `upstream` | named by the site | no | The call timed out, or the dependency answered 408. Facts: `call`, `status`. |
| `dependency_rate_limited` | `capacity_error` | `upstream` | named by the site | no | The dependency answered 429. Facts: `call`, `status`. |
| `dependency_too_early` | `processing_error` | `upstream` | named by the site | no | The dependency answered 425. Facts: `call`, `status`. |
| `dependency_server_error` | `processing_error` | `upstream` | named by the site | no | The dependency answered with a 5xx status. Facts: `call`, `status`. |
| `dependency_auth_rejected` | `server_error` | `internal` | named by the site | no | The dependency answered 401 or 403 to a request made with the service's own credentials. Facts: `call`, `status`. |
| `dependency_not_found` | `server_error` | `internal` | named by the site | no | The dependency answered 404 to a request the SDK built. Facts: `call`, `status`. |
| `dependency_request_rejected` | `server_error` | `internal` | named by the site | no | The dependency answered with another 4xx status. Facts: `call`, `status`. |
| `dependency_other_status` | `server_error` | `internal` | named by the site | no | The dependency answered with a status that isn't an error (1xx-3xx) where a result was expected. Facts: `call`, `status`. |
| `dependency_response_failed` | `processing_error` | `upstream` | named by the site | no | The dependency answered without a failing status, but with an error of its own or a response that can't be used. Facts: `call`, `providerCode` when it gave one. |

<!-- END GENERATED: error codes -->

### Dependency failure codes

A failed remote call climbs as far as the information allows. A per-dependency rule that recognizes the response (a provider's own error code, say) gives it a specific code. So does a call site that knows whose the failure is: a Mux 404 on an asset's track is `asset_resource_not_found`, and a Mux 401 on an API call is `account_credentials_rejected`. A response nothing recognizes gets a fallback code for what was observed (the `dependency_*` codes above): its HTTP status, a timeout, no response, or an answer with an error of its own (`dependency_response_failed`). They name what happened, never a cause, since a status means different things to different dependencies. Like every code, each implies one type and source: the classification the status rules give it. A count of them shows which dependencies' responses still need rules.

A failure without a code still has a type and source; that's normal for conditions not yet worth naming. A module that hasn't moved onto the model yet raises its conditions as [legacy errors](#legacy-errors) rather than with these codes.

## Retries

"Retry" means three different things, and each has its own signal:

| Question | Signal |
|---|---|
| Should the runtime retry this step right now? | `transient` |
| May submitting the same work again, unchanged, succeed? | `retryable` |
| Can the caller fix something and then succeed? | `source` (`request`, `asset`, `account`) plus `code` |

Both flags are policies decided from the classification, not by hand: the site's explicit value wins, then the code's catalog entry, then the rule.

- **`transient`:** `upstream` with a 408, 425, 429 or 5xx status. A 409 is not transient, and neither is an `upstream` failure with no status: the dependency reported it, so a step retry would find it again. A call that got no response is transient too, which the dependency helpers set where the call is made.
- **`retryable`:** true when transient, for a timeout or a capacity error, or otherwise for `upstream`; false for `request`, `asset`, `account` and `internal` failures and for validation and content-policy errors.
- **Transient implies retryable.** If retrying the step may succeed, so may resubmitting.
- Only non-transient errors are named `FatalError`, which tells Workflow DevKit not to retry the step.

## What else an error carries

None of this is end-user data.

- **`cause`:** the raw error a site classified, passed as `cause` when raising (`dependencyError()` and `wrapError()` pass it for you). It stays on the instance only: it's non-enumerable, so it isn't in JSON or in logs of the error object, and it's never serialized.
- **`causes`:** a bounded summary of the `cause` chain that does cross step boundaries, for logs: up to three `{ name, message, status? }` entries, each message capped at 500 characters with URL queries and credentials stripped and high-confidence prompt leaks suppressed. A classified cause contributes its own `causes`. After a step boundary it's the only trace of the raw error. Like `cause`, it's non-enumerable, so error serializers and `JSON.stringify` skip it: log it explicitly, as in the example above.
- **`usage`:** model tokens spent before the failure, so a caller can still account for them. `wrapError()` carries it over from the error it wraps.
- **`diagnostics`:** for a failed model call, which phase failed and with what provider, model and output limit.

## Showing errors to end users

`message` is internal: it may name options, call names, statuses and other detail meant for developers. Never show it to end users. `toPublicError(error)` returns what end users may see, `{ type, code?, message, retryable, facts? }`, using a ladder:

1. **The code has a public mapping** (`MUX_AI_ERROR_PUBLIC_MAPPINGS`): the code, the mapping's allowed facts, and its wording, built only from those facts.
2. **Otherwise, by source:** generic wording for `request`, `asset` and `account` failures.
3. **Otherwise, by type:** generic wording for timeouts, capacity, content policy, and other failures (worded "try again" when retryable).

Codes, facts and messages are internal by default; only an explicit mapping makes a code and some of its facts public. `MUX_AI_ERROR_GENERIC_MESSAGES` holds the generic wording, and `genericPublicMessage()` picks it for an error (steps 2 and 3), for reuse in your own view. Consumers with their own vocabulary (e.g. API parameter names) can override the message per public code and keep the rest of the view.

A [legacy error](#legacy-errors) is the one exception: its message was written as end-user text, so the view shows it as it always has.

## Legacy errors

A module not yet on this model raises legacy errors: `MuxAiError`s whose message is end-user text. They keep everything consumers relied on before classification:

- the `__robots_error` brand, `publicType`, `publicMessage` (the same as `message`) and `retryable`
- the public view shows `publicMessage` verbatim with `publicType`
- they are never step-retried, and they cross step boundaries in their previous shape

They also have a `type` and an approximate `source`, but no `code` or `facts`. Code handling them by those older fields keeps working until its module moves; new code should use `type`, `source` and `code`, and `toPublicError()` for end-user text.

As each module moves, its failures become classified errors, and its plain `throw new Error(...)` failures become classified too. The legacy fields go away when the last module has moved.

### Shared helpers opt in per workflow

Modules move one workflow at a time. A helper several workflows share can't switch to classified errors for all of them at once without changing what the workflows that haven't moved raise, so its classified errors are opt-in:

- **Model calls** take a `ModelCallContext` (`call`, `provider`, `model`). With one, content-policy blocks, incomplete or unusable output, and provider API failures are classified where they happen, with those facts. Without one, they fail as before.
- **Other shared helpers** take `classifiedErrors: true` (`ClassifiedErrorsOption`), e.g. `fetchVttFromMux()` and `replaceAndCreateTextTrack()`. Without it, they fail as before. A helper that reports a failure as a result rather than a throw (e.g. a failed track write) classifies it inside the step and returns it as the result's `error`: a classified error crosses the step boundary intact, where the raw error would keep only its message.

An internal helper whose only callers have already moved (e.g. `createTextTrackOnMux()`, used only by `editCaptions()`) classifies its errors without an opt-in.

A workflow that moves passes the opt-in to every shared helper it calls. Once every caller has, the opt-in becomes the only behavior and goes away with the legacy fields.

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
  // Passing the catalog's type makes each code accept only its own type, source and
  // dependency (CodedClassification), so a site can't contradict the catalog.
  constructor(message: string, init: ClassifiedErrorInit<AppErrorType, AppErrorCode, string, typeof APP_ERROR_CATALOG>) {
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
- **Sources** are shared as they are; **dependencies** are yours to extend with the services you call. An `upstream` entry or site must name its dependency (`SourceAndDependency`).
- **One view for both:** pass the SDK's public mappings along with yours, so SDK failures keep their public wording.
- **Remote calls:** `classifyDependencyFailure()` gives the status-based classification `dependencyError()` uses (below) without building an error, so your own errors treat statuses the same way. `httpStatusOf()` and `requestIdOf()` read them off an HTTP client's error, and `isTransientStatus()` is the transient rule on its own.
- **Your own model calls:** `modelCallError(error, { call, provider, model })` classifies a failed AI SDK call you make yourself by the rules the workflows use: content-policy blocks, missing or unusable output, and each provider's own rules (e.g. Google's spent per-day quota vs. a per-minute rate limit), else the status. `provider` is the SDK's provider name (`google`, `openai`, `anthropic`) or the AI SDK model's own `provider` id (`google.generative-ai`, `openai.chat`), so `model.provider` can be passed as is. It always returns a `MuxAiError` with the call's facts and token usage.
- **The SDK's codes in your code:** when your code hits a condition the SDK has a code for, raise a `MuxAiError` with that code so it renders with the SDK's public wording, e.g. `trackReplacementBlockedError()` (with `trackTargetFacts()`) for a blocked track replacement.
- **Serialization:** give your class its own Workflow serializer hooks and put a version in the payload (as `MuxAiError` does with `v`). A run replays the events it already wrote, so a shape change must keep earlier versions readable.

## Serialization

`MuxAiError` keeps its classification across Workflow step boundaries through Workflow DevKit serializer hooks. Any other error crossing a boundary keeps only its message, stack and cause: an HTTP client's status, a provider's response headers and its class are gone, which is why remote failures are classified inside the step, where the call is made. When running the SDK in a workflow:

- **A step whose retries ran out is wrapped.** Once a transient error has failed a step's last attempt, Workflow DevKit doesn't hand the workflow that error: it throws a new `FatalError` ("Step … failed after N retries: …") with the step's error as `cause`. The classified error survives as that `cause`, with its code, facts and usage, but code that inspects the error directly sees an unclassified `FatalError`. Call `classifiedErrorOf(error)` before inspecting or recording a step's error in a workflow: it returns the classified error the error is, or the first one down its `cause` chain (so inside the wrapper), and `undefined` when there is none; use `classifiedErrorOf(error) ?? error` to keep the original otherwise. The SDK's workflows already do, through `wrapError()` and the error handling every workflow ends with, so their errors reach you classified, except `generateEmbeddings()` and `generateVideoEmbeddings()`, whose failures are replaced with a plain `Error`. Your own workflow code that catches a step's error needs it too. An error that fails a step on its first attempt (non-transient) reaches the workflow as itself.
- **Workflow DevKit's control flow passes through.** When a replay diverges, Workflow DevKit rejects a step's promise with a `ReplayDivergenceError` and expects it to leave the workflow function untouched, so the runtime can recover the run. `isWorkflowControlFlowError(error)` recognizes it (and `WorkflowSuspension`) by name. `wrapError()`, the SDK's workflows and their best-effort fallbacks rethrow it unchanged; a catch in your own workflow code should too, rather than wrap it, fall back or record it as a failure.
- **Reading a classified error back can't fail.** A deserializer that throws makes Workflow DevKit hand the workflow an unclassified error ("Failed to hydrate step error") instead of the real one. `MuxAiError`'s deserializer reads a stored error with `readSerializedClassification()`, which never throws: a record reads as written whatever its version, and a missing or malformed field gets a fallback (type `server_error`, source `internal`, empty facts and causes, not retryable). `classificationInit()` and `restoreClassification()` use it too, so your own classified error's codec gets the same guarantee when it builds on them, doesn't read the record's fields itself, and its constructor accepts that fallback type and source. This guarantee covers classified errors; the legacy error shape is frozen and slated for removal, and its codec is unchanged.
- **Payloads are versioned.** The hooks write a versioned shape and read every earlier one, so a run can always replay errors it wrote before.
- **Class IDs include the package version.** Workflow DevKit identifies a serialized class by an ID derived from the module that defines it, which for a package includes its entry point and version (e.g. `@mux/ai/workflows@1.2.3`). Worlds that pin each run to the deployment that started it replay with the same build, so upgrading `@mux/ai` is safe. Worlds that don't pin runs can fail to revive these errors in a run that spans an upgrade.

## Raising errors

### Choose the classification

1. **Whose problem is it?** Pick the `source`. If a remote service answered with something the caller can fix (a missing track, a 404 for their asset), it's still `asset` or `request`; if it failed, it's `upstream`; if it's our bug or the service's configuration, it's `internal`.
2. **Was a remote service involved?** Set `dependency`. An `upstream` failure always names it: the types require it, in a catalog entry and at a site.
3. **Is there an existing code for this exact condition?** Add it: `{ code, type, source }` (and `dependency` when its catalog entry has one). The compiler only accepts the type, source and dependency the code's catalog entry gives it. A code for a condition any remote service can report (`provider_rate_limited`, say) has `siteDependency` in its entry instead, and the site names the dependency.
4. **Otherwise,** pass `type` and `source` alone, and consider whether the condition deserves a code (below).
5. **Record what varies as facts:** IDs, languages, limits, statuses, the call that failed. A failure blamed on an input the caller passes records it in `inputs` (e.g. `["credentials"]`; a dependency's 401/403 takes them as `authInputs`), so a caller that sets that input itself, rather than passing on its end user's, can re-attribute the failure. Keep values JSON-safe. Pass provider free text through `errorDetailFact()`, which strips URL queries and credentials, suppresses prompt leaks and caps the length. Never put credentials, signed URLs or raw model output in facts.
6. **Write `message` for a developer reading a log.** It can be specific; it is never shown to end users.

Helpers:

- **Remote calls:** classify where the call is made, while the status is still in hand. `dependencyError()` (in `dependency-error.ts`) gives every failure a code, and the code sets the type and source. A per-dependency rule that recognized the response passes its `code`. Otherwise a 404 or 401/403 the caller attributed gets that source's code (`notFoundSource: "asset"` is `asset_resource_not_found`, `authSource: "account"` is `account_credentials_rejected`), and anything else the status's [fallback code](#dependency-failure-codes) (`dependencyFailureCode()`): no response, 408, 425, 429 and 5xx are `upstream` and transient; other statuses are `internal`, a request we built. The code's retry policy wins over the status rules, and the site's own `transient`/`retryable` win over both. It records `call`, `status` and `requestId`, and takes `idempotent: false` for calls that may have taken effect (a create), so a timeout, no-response or 5xx failure isn't step-retried, whatever the code. `dependencyErrorFrom()` does the same for an error thrown by an SDK client, reading its status.
- **Provider API failures:** each provider means different things by the same status (a 429 can be a short rate limit or a spent quota), so each gets its own classifier, keyed by the `ModelCallContext`'s provider: `google-errors.ts` for Google (rules from Google's error docs: a per-day quota or a 402 is `provider_quota_exhausted`, any other 429 `provider_rate_limited`, 401/403, or a 400 whose `ErrorInfo` reason names a bad or restricted API key, `provider_credentials_rejected`, 503 `provider_unavailable`, 504 a timeout) and `openai-errors.ts` for OpenAI, like `elevenlabs-errors.ts` for ElevenLabs, `hive-errors.ts` for Hive and `google-vision-errors.ts` for Google Vision. A call made with `fetch` instead of the AI SDK uses the module's `fetch` variant (e.g. `openAIFetchError()`). A workflow raises a dependency's errors through its module rather than keeping that dependency's rules itself; what stays in the workflow is what's specific to it, such as how moderation aggregates per-sample failures. Mux Video calls go through `mux-video-errors.ts`, which also keeps Mux's error type (`muxErrorType`). Keep what a dependency says as validated tokens in facts; its free text reaches the scrubbed `causes` through the error's message, never facts. A provider without one keeps its raw error until a workflow that uses it moves.
- **This code's own failures:** `internalError()` and `assertNever()`.
- **Passing errors up:** `wrapError()` passes a classified error through, merging facts, and turns anything unclassified into an `internal` failure. An unclassified error with a classified error down its `cause` chain counts as classified: `wrapError()` rethrows that inner error, with the site's facts merged in, rather than wrapping the outer one (see `classifiedErrorOf()` under [Serialization](#serialization)). Workflow DevKit's control-flow errors pass through untouched.

Override `retryable` or `transient` only with a one-line comment saying why, and prefer a fact that explains it (a transient `status` makes a failure transient by rule).

### Moving a module onto the model

1. Replace each `LegacyMuxAiError` and plain `throw new Error(...)` with a classified `MuxAiError`, and `legacyWrapError()` with `wrapError()`.
2. Keep what end users see: where a legacy message told them something they can act on, or carried a fact they could use, give the condition a public code whose wording carries the same information (see [When to make a code public](#when-to-make-a-code-public)).
3. Add the module to `CLASSIFIED_ERROR_MODULES` in `eslint.config.mjs`. There, a lint rule bans plain `throw new Error`, `LegacyMuxAiError` and `legacyWrapError()`.

### When to add a code

Add one when a consumer would act on the condition, or word it for end users, differently from its neighbours. Good signals: end users can fix it, it recurs and needs tracking, or generic wording would lose something end users see today.

Don't add one for differences that facts already carry: the vendor (`dependency`), the call that failed (`call`), a status, or a value. One code with a `reason` fact beats three codes.

- **Name the condition, never the vendor:** `model_output_invalid`, not `openai_bad_json`.
- **snake_case, specific, and stable.** Codes are only ever added. Renaming or removing one is a breaking change, and a removed name is never reused.
- **Add it to `MUX_AI_ERROR_CATALOG`** with its type, source and dependency, and a retry override only if the rule gets it wrong for every occurrence.
- **Describe it in a TSDoc comment on its `MUX_AI_ERROR_CODES` entry** (the condition, and the facts it carries), then run `npm run docs:errors` to regenerate this guide's tables. A test fails while a table is out of date.

### When to make a code public

Map a code in `MUX_AI_ERROR_PUBLIC_MAPPINGS` when end users can act on it or need to know it. Allow only facts that are safe to show and useful to them, and write wording that doesn't name internal calls or vendors' internals. Name an SDK option only when the option itself is the subject, as in `parameter_out_of_range`; a consumer that exposes its own names for options overrides that code's wording. Internal codes still reach end users through the generic wording, so leaving a code internal never hides that a failure happened.

**Don't drop facts end users could use.** When a failure's facts include details that are safe and useful for end users (the asset it was about, the limit that was exceeded, the language that isn't supported), the public view must carry them: give the condition a public code whose wording uses them, rather than letting generic wording drop them. Leave a code internal only when none of its facts are appropriate for end users (credentials, configuration names, provider or model names, raw provider text) or the condition can't reach them.
