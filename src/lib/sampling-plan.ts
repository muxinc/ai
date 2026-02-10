export interface SamplingPlanOptionsV1 {
  duration_sec: number;
  min_candidates?: number;
  max_candidates?: number;
  trim_start_sec?: number;
  trim_end_sec?: number;
  fps?: number;
  base_cadence_hz?: number;
  anchor_percents?: number[];
  anchor_window_sec?: number;
}

const DEFAULT_FPS = 30;

export function roundToNearestFrameMs(tsMs: number, fps: number = DEFAULT_FPS): number {
  const frameMs = 1000 / fps;
  return Math.round(Math.round(tsMs / frameMs) * frameMs * 100) / 100;
}

/**
 * Compute a bounded, duration‑aware set of candidate timestamps (ms) for thumbnail extraction.
 *
 * High-level approach:
 * - Trim the ends of the video to avoid low‑information regions like fades or buffers.
 * - Pick a sampling cadence (Hz) based on duration, unless the caller specifies one.
 * - Evenly distribute a base set of timestamps across the usable span.
 * - If we still have headroom up to `maxCandidates`, sprinkle extra timestamps inside small
 *   windows around a few semantic anchors (percent positions like 20%, 50%, 80%) to
 *   increase diversity and catch likely interesting frames.
 * - Snap all timestamps to the nearest frame boundary and enforce bounds + uniqueness.
 *
 * Inputs (from `SamplingPlanOptions`):
 * - durationSec: total media duration in seconds
 * - minCandidates/maxCandidates: hard lower/upper bounds for candidate count
 * - trimStartSec/trimEndSec: seconds trimmed from the start/end when sampling
 * - fps: frames per second used to quantize timestamps to frame boundaries
 * - baseCadenceHz: optional explicit sampling cadence; overrides duration‑based default
 * - anchorPercents: list of normalized positions [0..1] to seed diversity windows
 * - anchorWindowSec: window size (seconds) centered around each anchor percent
 */
export function planSamplingTimestamps(options: SamplingPlanOptionsV1): number[] {
  const DEFAULT_MIN_CANDIDATES = 10;
  const DEFAULT_MAX_CANDIDATES = 30;
  const {
    duration_sec,
    min_candidates = DEFAULT_MIN_CANDIDATES,
    max_candidates = DEFAULT_MAX_CANDIDATES,
    trim_start_sec = 1.0,
    trim_end_sec = 1.0,
    fps = DEFAULT_FPS,
    base_cadence_hz,
    anchor_percents = [0.2, 0.5, 0.8],
    anchor_window_sec = 1.5,
  } = options;

  // The span of the video we consider eligible for sampling after trimming.
  const usableSec = Math.max(0, duration_sec - (trim_start_sec + trim_end_sec));
  if (usableSec <= 0)
    return [];

  // Determine sampling cadence (samples per second). Shorter videos get denser sampling
  // to ensure enough candidates; longer videos are sparser to respect API caps and cost.
  const cadenceHz =
    base_cadence_hz ??
    (duration_sec < 15 ? 3 : duration_sec < 60 ? 2 : duration_sec < 180 ? 1.5 : 1);

  // Target number of candidates = cadence * usable duration, clamped within bounds.
  let target = Math.round(usableSec * cadenceHz);
  target = Math.max(min_candidates, Math.min(max_candidates, target));

  // Evenly spread the base timestamps across the usable span by dividing it into
  // `target` segments and sampling near each segment's center to avoid boundary bias.
  const stepSec = usableSec / target;
  const t0 = trim_start_sec;
  const base: number[] = [];
  for (let i = 0; i < target; i++) {
    const tsSec = t0 + (i + 0.5) * stepSec; // center of each segment
    base.push(tsSec * 1000);
  }

  // If we still have budget up to `maxCandidates`, allocate extra samples around a few
  // anchor percent positions to capture likely compelling frames (e.g., intro, midpoint).
  const slack = Math.max(0, max_candidates - base.length);
  const extra: number[] = [];
  if (slack > 0 && anchor_percents.length > 0) {
    // Distribute remaining budget across anchors; at least one per anchor if any slack.
    // Cap per-anchor samples to avoid blowing up when max_candidates is very large
    // relative to the base count — a 1.5 s window only holds ~45 frames at 30 fps.
    const perAnchor = Math.max(1, Math.min(5, Math.floor(slack / anchor_percents.length)));
    for (const p of anchor_percents) {
      // Compute the window center in seconds, clamped within the usable span.
      // Note: 1e-3 = 0.001 seconds (1 ms). We use a tiny epsilon to avoid exact
      // boundary positions which can cause zero-width windows or duplicate frames
      // after frame-quantization due to floating-point rounding.
      const centerSec = Math.min(
        t0 + usableSec - 1e-3, // nudge just inside the end bound
        Math.max(t0 + 1e-3, duration_sec * p), // nudge just inside the start bound
      );
      // Define a small window around the center and split it into `perAnchor` slots.
      const startSec = Math.max(t0, centerSec - anchor_window_sec / 2);
      const endSec = Math.min(t0 + usableSec, centerSec + anchor_window_sec / 2);
      if (endSec <= startSec)
        continue;
      const wStep = (endSec - startSec) / perAnchor;
      for (let i = 0; i < perAnchor; i++) {
        const tsSec = startSec + (i + 0.5) * wStep;
        extra.push(tsSec * 1000);
      }
    }
  }

  // Combine base and anchor‑window samples, snap to frame boundaries, and hard‑enforce
  // trimmed bounds for safety. Rounding to frames ensures stable, cache‑friendly URLs.
  const all = base.concat(extra)
    .map(ms => roundToNearestFrameMs(ms, fps))
    .filter(ms => ms >= trim_start_sec * 1000 && ms <= (duration_sec - trim_end_sec) * 1000);

  // Remove duplicates introduced by frame rounding, sort chronologically, and enforce
  // the global cap again just in case.
  const uniqSorted = Array.from(new Set(all)).sort((a, b) => a - b);
  return uniqSorted.slice(0, max_candidates);
}
