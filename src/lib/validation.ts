import { MuxAiError } from "./mux-ai-error.ts";

const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const KEY_MAX_CHARS = 64;
const LANGUAGE_TAG_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;
const LANGUAGE_TAG_MAX_CHARS = 35;

export interface IntegerRange {
  min: number;
  max: number;
}

export function validationError(message: string): MuxAiError {
  return new MuxAiError(message, { type: "validation_error" });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Asserts a non-empty string of at most `max` characters after trimming, and returns it trimmed. */
export function assertBoundedText(value: unknown, max: number, label: string): string {
  if (typeof value !== "string") {
    throw validationError(`${label} must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) {
    throw validationError(`${label} must be 1-${max} characters.`);
  }
  return trimmed;
}

export function assertIntegerInRange(value: unknown, range: IntegerRange, label: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < range.min || value > range.max) {
    throw validationError(`${label} must be an integer between ${range.min} and ${range.max} (received ${String(value)}).`);
  }
}

export function assertOneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw validationError(`Invalid ${label} "${String(value)}". Valid values are: ${allowed.join(", ")}.`);
  }
}

export function assertLanguageTag(value: unknown, label: string): void {
  if (typeof value !== "string" || value.length > LANGUAGE_TAG_MAX_CHARS || !LANGUAGE_TAG_PATTERN.test(value)) {
    throw validationError(`${label} must be a BCP 47 language tag such as "en" or "pt-BR".`);
  }
}

/**
 * Asserts a non-empty, bounded array of objects with unique lowercase
 * snake_case `key` values and optional bounded `instructions`.
 */
export function assertKeyedItems(
  items: unknown,
  options: { noun: string; max: number; maxInstructionsChars: number },
): asserts items is Array<{ key: string; instructions?: string }> {
  const { noun, max, maxInstructionsChars } = options;
  if (!Array.isArray(items) || items.length === 0) {
    throw validationError(`At least one ${noun} is required.`);
  }
  if (items.length > max) {
    throw validationError(`At most ${max} ${noun}s are supported (received ${items.length}).`);
  }
  const seen = new Set<string>();
  for (const item of items) {
    if (!isRecord(item)) {
      throw validationError(`Each ${noun} must be an object.`);
    }
    const key = item.key;
    if (typeof key !== "string" || !KEY_PATTERN.test(key) || key.length > KEY_MAX_CHARS) {
      throw validationError(
        `${noun} key "${String(key)}" must be lowercase snake_case beginning with a letter, up to ${KEY_MAX_CHARS} characters.`,
      );
    }
    if (seen.has(key)) {
      throw validationError(`Duplicate ${noun} key "${key}".`);
    }
    seen.add(key);
    if (item.instructions !== undefined) {
      assertBoundedText(item.instructions, maxInstructionsChars, `${noun} "${key}" instructions`);
    }
  }
}
