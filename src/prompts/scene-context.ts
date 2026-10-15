/**
 * Compact, provider-independent scene context shared by prompt consumers.
 *
 * Timestamps are absolute offsets from the beginning of the asset. The
 * context intentionally excludes source windows, cues, images, shot details,
 * and scored concepts so callers can pass it between workflows without
 * coupling them to scene-generation internals.
 */
export interface SceneContextItemV1 {
  /** Stable zero-based position in the ordered scene sequence. */
  scene_index: number;
  /** Absolute scene start time in milliseconds. */
  start_ms: number;
  /** Absolute scene end time in milliseconds. */
  end_ms: number;
  /** Short human-readable scene title. */
  title: string;
  /** Compact summary of the scene's spoken content, when available. */
  audible_narrative?: string;
  /** Compact summary of the scene's visual content, when available. */
  visual_narrative?: string;
  /** Combined audible and visual narrative, when both signals are available. */
  blended_narrative?: string;
  /** Important spoken concepts represented as compact phrases. */
  notable_audible_concepts?: string[];
  /** Important visual concepts represented as compact phrases. */
  notable_visual_concepts?: string[];
  /** Number of shots or visual beats that make up the scene. */
  shot_count?: number;
}
