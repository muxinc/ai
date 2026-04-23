# translate-captions Anthropic flakiness investigation

Writeup of an investigation into intermittent Anthropic failures on the
translate-captions workflow that appeared during PR 181's iteration. The
investigation happened on branch `experiment/test-root-cause-anthropic-translate-captions`
(PR 184) and is captured here so the conclusions don't vanish with the branch.

## TL;DR

The translate-captions flakiness is **not caused by PR 181** and **not
caused by prompt content or size on a per-call basis**. The failures
correlate almost perfectly with **US business hours (18:00–22:59 UTC)**
and are best explained by **peak-hour contention on a shared Anthropic
concurrency budget** — the same API key services CI, Claude Code
sessions, production workflows, and other interactive org usage, so
during business hours CI jobs compete with the rest of the org for
concurrent request slots. Requests that lose that race queue on
Anthropic's side and, for some tails, queue past the CI test timeout.

## Current theory

Anthropic enforces a per-organization concurrent-request cap separate
from the per-minute rate limits visible in response headers. Exceeding
the rate limit returns 429; exceeding the concurrency cap can result in
a request sitting in a server-side queue (no 429) waiting for a slot.
During US business hours, Mux's aggregate Anthropic usage — CI + Claude
Code + production workflows + any developer tooling — comes close to or
crosses that cap. Individual requests that land at the queue head are
served promptly; tail requests can wait long enough to trip a CI test
timeout (10 min for Evalite, varies for integration).

The translate-captions eval surfaces this more readily than other
workflows because it fans out (3 target languages × 3 providers = 9
evalite cases per run) and runs all of them in parallel within a single
`evalite(...)` call. More in-flight Anthropic requests on the org's
shared budget per test run → higher tail-latency exposure.

### How prompt size may contribute (second-order)

PR 181 added a `<security>` XML block (~2500 chars, ~600 input tokens)
to the translate-captions system prompts. That increase is small per
call (a few hundred ms of additional input-processing time at most),
but under Little's Law the equilibrium queue depth for a fixed
concurrency cap scales with per-call residence time. A uniformly longer
inference time across all org-wide Anthropic traffic lowers effective
throughput against a fixed slot count, pushing a workload that was
previously *just under* the cap closer to *at* the cap, and making tail
queueing more visible. This is a plausible aggravator, not the root
cause — the same time-of-day clustering of failures exists on branches
that pre-date PR 181.

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
  more — but the strongest predictor is time-of-day, not call count.
- **PR 181 introduced the bug.** Falsified by `pc/main-test` and by
  the time-of-day clustering extending back to earlier branches
  (2026-04-08, 2026-04-10, 2026-04-20 all had evalite failures in the
  same UTC window, none related to PR 181).

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

- **Harden the production `translateCaptions` chunk path** with a
  bounded per-call timeout and a retry-on-timeout. Users hitting the
  same upstream stall should see a second-chance outcome rather than
  a hung workflow. Independent of any root-cause confirmation.
- **Evaluate a dedicated CI Anthropic API key** (or workspace) with
  its own concurrency budget, so CI runs don't compete with
  interactive / production org usage for slots. This both confirms
  the theory (if CI flakes disappear) and removes the symptom.
- **If further confirmation is wanted**, schedule a cron CI run of
  the N=20 stress probe at ~21:00 UTC. Cheap (~$0.20/run in
  credits) and directly tests the peak-hour hypothesis.
- **Tear down the experiment branch** once findings are captured.
  The instrumented harness (`tests/integration/translate-captions-prompt-ab.test.ts`)
  and the narrowed CI configuration are not meant to ship.
