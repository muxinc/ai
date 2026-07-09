import { describe, expect, it, vi } from "vitest";

import { MuxAiError, wrapError } from "../../src/lib/mux-ai-error";
import { SYSTEM_PROMPT_CANARY } from "../../src/lib/prompt-fragments";

describe("wrapError", () => {
  it("re-throws MuxAiError instances unchanged to preserve the brand", () => {
    const original = new MuxAiError("Failed to fetch audio file from Mux: HTTP 403 Forbidden", {
      retryable: false,
    });

    try {
      wrapError(original, "Failed to fetch audio from Mux");
      throw new Error("wrapError should have thrown");
    } catch (error) {
      expect(error).toBe(original);
      expect((error as MuxAiError).__robots_error).toBe(true);
      expect((error as MuxAiError).publicMessage).toContain("HTTP 403 Forbidden");
    }
  });

  it("includes the message from a plain Error", () => {
    expect(() => wrapError(new Error("socket hang up"), "Failed to fetch audio from Mux"))
      .toThrow("Failed to fetch audio from Mux: socket hang up");
  });

  it("produces a useful detail (not 'Unknown error') for a thrown string", () => {
    try {
      wrapError("ECONNRESET", "Failed to fetch audio from Mux");
      throw new Error("wrapError should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("ECONNRESET");
      expect(message).not.toContain("Unknown error");
    }
  });

  it("extracts name/code/message from an undici-shaped error object", () => {
    const undiciLike = { name: "TypeError", code: "UND_ERR_CONNECT_TIMEOUT", message: "Connect Timeout Error" };

    try {
      wrapError(undiciLike, "Failed to fetch audio from Mux");
      throw new Error("wrapError should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("UND_ERR_CONNECT_TIMEOUT");
      expect(message).not.toContain("Unknown error");
    }
  });

  it("still falls back to 'Unknown error' only for values with no usable detail", () => {
    expect(() => wrapError({}, "Failed to fetch audio from Mux"))
      .toThrow("Failed to fetch audio from Mux: Unknown error");
  });

  it("suppresses high-confidence prompt leaks in the detail", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => wrapError(new Error(`leaked ${SYSTEM_PROMPT_CANARY}`), "context"))
        .toThrow("Upstream error details suppressed by safety filter");
    } finally {
      warn.mockRestore();
    }
  });
});
