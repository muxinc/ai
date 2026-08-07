# Overview

Makes OpenAI thumbnail moderation resilient when the provider cannot fetch a newly available Mux thumbnail URL, while preventing very short duration snapshots from producing duplicate samples.

# What was changed

- Preserve sub-second thumbnail timestamps and deduplicate normalized sampling times.
- Detect OpenAI `image_url_unavailable` responses, download the affected thumbnail with bounded exponential backoff, and resubmit it as base64.
- Allow callers to opt specific transient 4xx statuses into image-download retries while keeping unrelated client errors fail-fast.
- Isolate base64 downloads per thumbnail so one unavailable image still permits partial moderation results.
- Add regression coverage and document the readiness fallback and retry controls.

# Suggested review order

1. `src/workflows/moderation.ts` for the URL-to-base64 fallback and per-thumbnail isolation.
2. `src/lib/image-download.ts` for retry policy configuration.
3. `src/primitives/thumbnails.ts` for timestamp precision and deduplication.
4. Unit tests, followed by `docs/API.md`.
