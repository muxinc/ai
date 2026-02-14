/**
 * Shared latency scoring for evals.
 *
 * Shape:
 * - <= good threshold: 1.0
 * - good..acceptable: linearly degrades to 0.5
 * - acceptable..(2x acceptable): linearly degrades to 0.0
 * - > 2x acceptable: 0.0
 *
 * Example with good=5000 and acceptable=10000:
 * - 5000ms => 1.0
 * - 7500ms => 0.75
 * - 10000ms => 0.5
 * - 15000ms => 0.25
 * - 20000ms => 0.0
 */
export function scoreLatencyPerformance(
  latencyMs: number,
  goodThresholdMs: number,
  acceptableThresholdMs: number,
): number {
  // Fast path: full credit for meeting the "good" target.
  if (latencyMs <= goodThresholdMs) {
    return 1;
  }

  // Between good and acceptable, degrade linearly from 1.0 to 0.5.
  if (latencyMs <= acceptableThresholdMs) {
    return 1 - 0.5 * ((latencyMs - goodThresholdMs) / (acceptableThresholdMs - goodThresholdMs));
  }

  // Beyond acceptable, continue degrading from 0.5 to 0.0 until 2x acceptable.
  // Clamp at 0 to avoid negative scores for very high latency.
  return Math.max(0, 0.5 * (1 - (latencyMs - acceptableThresholdMs) / acceptableThresholdMs));
}

export function getLatencyPerformanceDescription(
  goodThresholdMs: number,
  acceptableThresholdMs: number,
): string {
  return `Scores latency: 1.0 for <=${goodThresholdMs}ms, linearly to 0.5 at ${acceptableThresholdMs}ms, then to 0 at ${acceptableThresholdMs * 2}ms.`;
}
