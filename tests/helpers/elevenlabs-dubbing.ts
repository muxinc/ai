export function dubbingProject(overrides: Record<string, unknown> = {}) {
  return {
    project_id: "proj_1",
    status: "ready",
    model_id: "dubbing_v1",
    language_ids: ["lang_1"],
    revision: 0,
    created_at: "2026-10-31T00:00:00Z",
    updated_at: "2026-10-31T00:00:00Z",
    ...overrides,
  };
}

export function dubbingLanguage(overrides: Record<string, unknown> = {}) {
  return {
    ...dubbingProject(),
    language_id: "lang_1",
    target_language: "es",
    status: "completed",
    outputs: {
      lossless_audio: "https://storage.example.test/audio/output.flac",
      subtitles: "https://storage.example.test/transcripts/output.vtt",
    },
    ...overrides,
  };
}
