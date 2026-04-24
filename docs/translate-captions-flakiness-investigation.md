# translate-captions Anthropic flakiness investigation

Writeup of an investigation into intermittent Anthropic failures that
drew attention on the translate-captions workflow during PR 181's
iteration. The investigation happened on branch
`experiment/test-root-cause-anthropic-translate-captions` (PR 184) and
is captured here so the conclusions don't vanish with the branch.

> Scope note: what looked like one failure pattern is actually
> multiple distinct failure modes that co-occurred during PR 181 and
> got conflated in memory. The "Failure shape taxonomy" section below
> breaks them apart before the theory discussion, so read that first
> if you're coming in cold.

## TL;DR

"translate-captions flakiness during PR 181" turned out to be **two
distinct failure modes that were conflated** because they co-occurred
during PR 181's iteration:

1. **Missing / wrapped `WEBVTT` header — content-driven and
   PR-181-specific, then fixed within PR 181.** PR 181 added a
   `<security>` XML block to the translate-captions system prompts.
   That block primed Claude to emit its translated VTT without the
   `WEBVTT` header (or wrapped in `<code>…</code>`), which failed an
   `expect(result.translatedVtt).toContain("WEBVTT")` assertion in
   `Integration Tests (Workflow DevKit)`. The fix — commit `a8c9346`
   adding `normalizeTranslatedVtt` — landed inside PR 181 before
   merge, and is why this mode doesn't reproduce now.
2. **Timeouts / "No output generated" — provider-side, not
   PR-181-caused.** Long-running eval tests time out (10 min) when a
   provider call hangs or returns an unparseable response. These
   failures correlate with **US business hours (18:00–22:59 UTC)**
   and with **workflows whose calls generate the most output tokens**
   (both translation evals lead the distribution). The best
   explanation is peak-hour contention on a shared provider
   concurrency budget — the org's API key services CI, Claude Code,
   production workflows, and interactive dev use, so during business
   hours CI jobs compete for request slots. Long-output calls hold a
   slot longer, so they accumulate tail-queue wait faster than short-
   output calls, and some queue past the CI test timeout. This mode
   also happens on branches that pre-date PR 181 and on an empty-
   commit control branch (`pc/main-test`).

Neither mode is caused by the PR 181 prompt *content* (the security
language itself) on an inference-correctness basis — the A/B harness
showed no bias between permutations off-peak. Mode 1 was a specific
output-shape quirk triggered by the XML tag structure and squashed by
an output normalizer; mode 2 is upstream.

## Failure shape taxonomy

Pulling the actual error signatures from every failing Evalite / Workflow
DevKit run in the last 100 CI invocations yields this distribution:

| Shape                                     | Count | Where seen                                                                                                                                |
|-------------------------------------------|-------|-------------------------------------------------------------------------------------------------------------------------------------------|
| `Test timed out in 600000ms` (10 min)     | 2     | PR 181 `translate-captions.eval.ts`; `pc/main-test` `translate-captions.eval.ts`                                                          |
| Google `"No output generated"`            | 3     | main `summarization-translation.eval.ts`; main `summarization.eval.ts`; feat/mux-ai-error `summarization-translation.eval.ts`             |
| Anthropic `"No object generated: response did not match schema"` | 1 | wf/0.18.0 `summarization-translation.eval.ts` |
| OpenAI `AI_APICallError: could not parse JSON` | 1 | vb/ask-questions-audio-only-support `chapters.eval.ts` |
| `AssertionError: expected … to contain 'WEBVTT'` | 1 | PR 181 `Integration Tests (Workflow DevKit)` |

The "translate-captions flakiness" story was actually at least **three
different mechanisms**:

- **Timeouts** hit translate-captions eval twice (both peak-hour).
  Best fit: peak-hour provider-concurrency contention.
- **Google "No output generated"** is a non-Anthropic, non-translate-
  captions pattern with its own causes (Gemini quirks or provider-side
  empty responses) and isn't covered by anything specific to this
  investigation. Mentioned here so future readers don't re-conflate.
- **Missing `WEBVTT` header** is the one PR 181 *did* cause — but the
  fix landed inside PR 181, so it's gone now.

Everything in the "Current theory" section below applies to the
**timeout mode** specifically. The missing-WEBVTT mode has its own
mechanism, documented separately below it.

## Current theory (for the timeout mode)

Providers (most notably Anthropic here, but the same logic applies to
any shared-concurrency backend) enforce a per-organization concurrent-
request cap separate from the per-minute rate limits visible in
response headers. Exceeding the rate limit returns 429; exceeding the
concurrency cap can result in a request sitting in a server-side queue
(no 429) waiting for a slot. During US business hours, Mux's aggregate
Anthropic usage — CI + Claude Code + production workflows + any
developer tooling — comes close to the org's cap. Individual requests
that land at the queue head are served promptly; tail requests can
wait long enough to trip a CI test timeout (10 min for Evalite, varies
for integration).

### Why translation workflows are the most exposed

Residence time on an Anthropic inference slot is dominated by **output
token generation** — tokens are emitted serially, one at a time. Input
token processing contributes less (inputs are batched) and prompt
content contributes effectively nothing. So per-workflow exposure to
tail-queueing scales with typical output length.

| Workflow                        | Typical output shape                              |
|---------------------------------|---------------------------------------------------|
| moderation                      | A handful of scores (very short)                  |
| ask-questions                   | Short answers per question                        |
| burned-in-captions              | Boolean + short reasoning                         |
| chapters                        | List of chapter entries (moderate)                |
| summarization                   | One paragraph (moderate)                          |
| **summarization-translation**   | **Paragraph + its translation (longer)**          |
| **translate-captions**          | **Full per-cue translated text (longest)**        |

Under Little's Law with a fixed concurrency cap, long-output calls
both occupy a slot longer *per call* (raising any given call's chance
of sitting in the queue) and contribute to slower drain of the queue
for everyone *during* the call. Short-output calls pop in and out of a
slot before the queue has time to grow around them; long-output
translation calls sit in a slot long enough to notice when the pool
is nearly full. Same org-wide pressure, much more exposure for
translation-shaped work.

This also explains a detail we initially misread — that the failures
were "translate-captions-specific." They're not. They're concentrated
on the two translation evals, which happen to be the two workflows
with the longest average output. Because PR 181 was touching
translate-captions, the `translate-captions.eval.ts` failures got
attention; the `summarization-translation.eval.ts` failures on `main`
and on earlier feature branches didn't.

### How prompt size may contribute (second-order)

PR 181 added a `<security>` XML block (~2500 chars, ~600 input tokens)
to the translate-captions system prompts. Input tokens contribute less
to residence time than output tokens, but they do lengthen each call
(~100–300ms at Anthropic-side input-processing rates). Uniformly
applied across every call, that shifts the queue equilibrium slightly
toward "full": a workload that was previously *just under* the cap
with some tail headroom moves closer to *at* the cap, and the tails
grow. This is a plausible aggravator, not a root cause — the same
time-of-day clustering of failures exists on branches that pre-date
PR 181, and the A/B harness with and without the security block in
off-peak conditions shows no first-order latency difference.

## The missing-WEBVTT mode (separate mechanism, PR 181 specific)

One `Integration Tests (Workflow DevKit)` run on PR 181 (SHA
`5cd660fc8`, 2026-04-22T18:05:34Z) failed with:

```
AssertionError: expected '1\n00:00:01.050 --> 00:00:01.850\nAïe…' to contain 'WEBVTT'
```

The model returned a correct French translation but emitted cues
without the `WEBVTT` header. This is not a timeout or a concurrency
symptom — it's a response-shape regression. Root cause:

- The test asset's VTT produces `cueBlocks.length (14) !== cues.length (13)`
  (a known-harmless quirk). `buildTranslationChunkRequests` logs
  "`Falling back to full-VTT caption translation because cue block
  count (14) does not match parsed cue count (13).`" and returns
  `null`, routing the test through the whole-VTT path (`SYSTEM_PROMPT`)
  rather than the chunked path.
- The whole-VTT path expects the model to emit a full VTT string with
  the `WEBVTT` header intact. PR 181 added a `<security>` XML block
  to `SYSTEM_PROMPT`. The XML-structured system prompt primed Claude
  to emit its output in a similar "structured" shape — dropping the
  plain-text `WEBVTT` header, and in other observed instances wrapping
  the whole body in `<code>…</code>` or a markdown fence.
- At SHA `5cd660fc8` the code just returned the model output verbatim.
  Git archaeology: `normalizeTranslatedVtt` does not exist in
  `src/workflows/translate-captions.ts` at that commit
  (`git cat-file -p 7ef0265b14 | grep normalizeTranslatedVtt` → empty).
- Commit `a8c9346` *later in the same PR* added
  `normalizeTranslatedVtt`, which strips code-fence / `<code>` /
  `<pre>` wrappers, uppercases a lowercase header, and prepends
  `WEBVTT\n\n` if absent. With the normalizer in place, the same
  model output shape passes the assertion.

So for this one failure mode:

- **Cause:** PR 181's `<security>` XML block in `SYSTEM_PROMPT`.
- **Fix:** PR 181's own `normalizeTranslatedVtt` (commit `a8c9346`).
- **Observable only during PR 181 iteration**, between the two
  commits. Not on main before PR 181 (no XML block), not on main
  after PR 181 (normalizer in place).
- **Path-specific** to the whole-VTT code path. The chunked path
  returns a structured JSON object (`{translations: [...]}`) which
  doesn't need a `WEBVTT` header, so it's unaffected by this quirk.
  The test asset happens to hit the whole-VTT path because of the
  cue-block-count divergence.

This is the PR-181-specific "translate-captions looked broken" signal.
It is a real regression that PR 181 introduced *and* fixed within the
same branch; readers looking for "what on earth was happening on PR 181"
should point here first.

## Evidence

### Time-of-day clustering of Evalite CI failures (last 100 runs, all branches)

| UTC window       | Runs | Failures | Rate |
|------------------|------|----------|------|
| 00:00–17:59      | 49   | 0        | 0%   |
| 18:00–22:59      | 48   | 9        | 19%  |
| 21:00 alone      | 19   | 6        | 32%  |
| 23:00            | 3    | 0        | 0%   |

All 9 observed failures across 100 runs fall inside the 5-hour US
business-day window. Zero failures before 18:00 UTC across 49 runs.

### Failure-by-file distribution (non-cascade, last 100 Evalite runs)

Two `ja/baseten-provider` runs had 8 eval files each failing together
(a branch-specific infra cascade, unrelated to this investigation).
Excluding those, the 7 remaining failures are:

| Eval file                              | Failures | Branches                                        |
|----------------------------------------|----------|-------------------------------------------------|
| `summarization-translation.eval.ts`    | **3**    | main, feat/mux-ai-error, wf/0.18.0              |
| `translate-captions.eval.ts`           | **2**    | pc/more-advanced-protection, pc/main-test       |
| `summarization.eval.ts`                | 1        | main                                            |
| `chapters.eval.ts`                     | 1        | vb/ask-questions-audio-only-support             |

The two top-failing files are both translation workflows, and the
gap from 3→2→1→1 suggests a real per-workflow skew rather than
noise. This contradicts the initial framing of "translate-captions
specifically" and supports the residence-time argument in the theory
section.

### `pc/main-test` reproduced the failure on unmodified main

- `pc/main-test` HEAD = `10400a0 "Commit to triger build"` — an empty
  commit on top of `6179215` (0.17.1 release). No file changes, not
  reachable from PR 181's HEAD.
- Its Evalite run on 2026-04-22T18:26:22Z timed out the same way as the
  PR 181 run three hours later. Both during US business hours.
- This falsifies "PR 181 introduced the regression."

### Integration Tests workflow (where `translate-captions.test.ts` lives) was 9/9 green on PR 181

- Plain `Integration Tests`: 9 runs, 0 failures.
- `Integration Tests (Workflow DevKit)`: 9 runs, 1 failure.
- `Evalite CI`: 9 runs, 1 failure.

The plain integration test runs its 3 providers sequentially via
`it.each` — peak concurrent Anthropic calls per file ≈ 1. The two
failing workflows are the ones with higher in-flight Anthropic counts
per run.

### Off-peak stress probe at N=20 passed cleanly

Fired 20 identical Anthropic calls in parallel from one process on one
API key at 02:40 UTC (far off-peak). All 20 succeeded; latencies
3645–5261ms (1.6s spread, 5.3s wall-clock for all 20). Unimodal — no
bimodal "some queued, some not" pattern that would indicate
concurrency queueing under our own load alone. Off-peak we had the
org's concurrency budget to ourselves.

### Rate limits are not the mechanism

Response headers from the same run showed
`anthropic-ratelimit-requests-remaining: 19999/20000` and
`anthropic-ratelimit-input-tokens-remaining: 1999000/2000000` — rate
limit headroom is essentially untouched even at 20 concurrent calls.
429 would be the signal for rate-limit exhaustion; we never saw one.
The queueing cap is a separate thing and not exposed in response
headers.

## Prior theories we've downgraded or ruled out

- **Prompt content (the `<security>` XML block) drove per-call
  unreliability.** A/B ran 6 permutations (baseline-pre181,
  full-current as-shipped, pure-length-padding, only-canary,
  non-disclosure-only, untrusted-input-only). In one run where
  `non-disclosure-only` hung, `full-current` — which *contains*
  `non-disclosure-only` content plus more — succeeded. Superset passing
  while subset fails falsifies content-as-driver. Subsequent runs were
  all clean.
- **Prompt length drove per-call unreliability.** Same A/B:
  `pure-length-padding` at 3005 chars was the *longest* prompt and
  succeeded; `baseline-pre181` at 455 chars was not systematically
  faster than 3000-char prompts in successful runs.
- **`minItems > 1` schema rejection was the bug.** An early A/B run
  hit `output_format.schema: For 'array' type, 'minItems' values other
  than 0 or 1 are not supported (got: [6, ∞])`. That was a harness bug
  — Anthropic's structured-output API caps `minItems` at 0 or 1, and
  `z.array(...).length(cues.length)` in the harness produced a larger
  value. Production uses the same constraint in
  `src/workflows/translate-captions.ts:697`; if this were the actual
  flakiness, every Anthropic call in production would fail
  deterministically, which is not what we observe. Harness was
  corrected to a loose schema with JS-side length assertion.
- **ai-sdk was retrying silently and the "hangs" were multi-attempt
  stacks.** Instrumented the harness with `maxRetries: 0` and a custom
  `fetch` wrapper logging every HTTP request. Each test sends exactly
  one request to Anthropic. Not a retry loop.
- **TCP / network issue on our side.** `server-timing:
  x-originResponse;dur=…` from successful runs closely matches our
  measured elapsed time — the time is spent at Anthropic's origin, not
  in transport. Cloudflare edge (`cf-ray` / `-SJC`) serves all
  requests consistently. On hung requests, the request log shows
  `HTTP →` but no `HTTP ←`, indicating nothing came back from the
  server, which matches a backend-side stall.
- **Per-call concurrency of 20 is the trigger.** Stress probe at N=20
  off-peak passed in 5.3s wall-clock total with no queueing visible.
  Either our concurrency cap is well above 20 or peak-hour conditions
  matter independently of our own concurrency level.
- **Call-count amplification is the sole explanation for Evalite vs
  integration failure skew.** Partially true — Evalite does fan out
  more — but the strongest predictors are time-of-day and per-call
  residence time, not raw call count.
- **Failures are specific to translate-captions.** Not quite —
  `summarization-translation.eval.ts` fails more often than
  `translate-captions.eval.ts` across all branches. The cluster (for
  the timeout mode) is "long-output-token workflows," not "the
  translate-captions code path." translate-captions stood out earlier
  because PR 181 was editing it *and* PR 181 did introduce a
  translate-captions-specific content regression (missing WEBVTT) at
  the same time — the two got conflated.
- **All failures were timeouts.** No — the actual distribution is
  mixed: 2 timeouts, 3 Google "No output generated", 1 Anthropic
  schema-mismatch, 1 OpenAI JSON parse error, 1 missing-WEBVTT
  AssertionError. The taxonomy is documented in a dedicated section
  above; different modes have different causes.
- **PR 181 introduced all of the flakiness.** Partially correct:
  PR 181 *did* introduce the missing-WEBVTT mode (via the `<security>`
  XML block shifting Claude's output shape) and *did* fix it within
  the same PR (`normalizeTranslatedVtt` in commit `a8c9346`). PR 181
  did *not* introduce the timeout mode — `pc/main-test` reproduced
  it on unmodified main, and the time-of-day clustering extends back
  to earlier branches (2026-04-08, 2026-04-10, 2026-04-20 all had
  Evalite failures in the same UTC window, none related to PR 181).
  Nor did PR 181 introduce the Google "No output" or OpenAI JSON-parse
  modes (different providers, different branches).

## What we still can't rule out

- **Exact concurrency cap.** We haven't saturated the cap at off-peak.
  A peak-hour stress probe (21:00 UTC) at N=20 would either produce
  the bimodal queueing pattern (confirming theory) or not (in which
  case the mechanism is upstream platform-wide pressure, not our
  org's cap specifically).
- **Magnitude of the prompt-size second-order effect.** The math says
  it contributes; we don't have data good enough to isolate it from
  the first-order peak-hour effect.
- **Whether 2026-04-22 was a particularly bad day** for Anthropic
  capacity or typical peak-hour behavior. The cluster on that date is
  what drew attention, but the broader 18:00–23:00 UTC pattern spans
  weeks.

## Recommendations

For the timeout mode:

- **Harden the production `translateCaptions` path (both chunked and
  whole-VTT)** with a bounded per-call timeout and a retry-on-timeout.
  Users hitting the same upstream stall should see a second-chance
  outcome rather than a hung workflow. Independent of any root-cause
  confirmation.
- **Evaluate a dedicated CI Anthropic API key** (or workspace) with
  its own concurrency budget, so CI runs don't compete with
  interactive / production org usage for slots. This both confirms
  the theory (if CI flakes disappear) and removes the symptom.
- **If further confirmation is wanted**, schedule a cron CI run of
  the N=20 stress probe at ~21:00 UTC. Cheap (~$0.20/run in
  credits) and directly tests the peak-hour hypothesis.

For the missing-WEBVTT mode:

- **Already fixed** by `normalizeTranslatedVtt` (PR 181 commit
  `a8c9346`). The fix is in main. No action needed unless the
  normalizer is ever refactored away — in which case the failing
  assertion resurfaces.
- **Consider adding a unit test** that asserts `normalizeTranslatedVtt`
  handles the exact observed payload (`1\n00:00:01.050 --> …`)
  without the header. Prevents regression if the normalizer's
  "prepend WEBVTT when missing" branch is ever removed.

For the Google / OpenAI modes:

- Out of scope for this investigation, but flagged so they don't get
  re-attributed to this file or to translate-captions when they
  recur.

General:

- **Tear down the experiment branch** once findings are captured.
  The instrumented harness (`tests/integration/translate-captions-prompt-ab.test.ts`)
  and the narrowed CI configuration are not meant to ship.
