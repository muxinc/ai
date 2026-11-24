/*
 * Keeps an error's payload serializable across a Workflow DevKit step boundary. Workflow DevKit
 * serializes with devalue, which throws on a value it can't represent; when that happens while
 * recording a step's failure, the failure is never recorded, the step runs again, and the
 * original error is lost. So the error codecs pass their open-ended fields (facts, diagnostics)
 * through here, which never throws.
 */

/** Values devalue writes as they are (besides primitives, arrays, plain objects, maps and sets). */
const DEVALUE_TAGS: ReadonlySet<string> = new Set([
  "Date",
  "URL",
  "URLSearchParams",
  "RegExp",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Float16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "DataView",
  "ArrayBuffer",
]);

/** How deep {@link toSerializableValue} follows nested values before cutting them short. */
const MAX_DEPTH = 10;

/**
 * `value` in a form devalue can serialize, without throwing. Primitives (including `bigint` and
 * `undefined`), arrays, plain objects, maps, sets and the built-ins devalue supports keep their
 * shape, recursively. Anything else becomes a string: an `Error` its `name: message`, another
 * class instance its `String()`. Functions and symbols become `undefined`, symbol keys and
 * `__proto__` keys are dropped, a reference back to an enclosing value becomes `"[Circular]"`,
 * nesting past {@link MAX_DEPTH} levels becomes `"[Truncated]"`, and a value whose inspection
 * throws (a proxy's trap, a throwing getter) becomes `"[Unserializable]"`.
 */
export function toSerializableValue(value: unknown): unknown {
  return toValue(value, new Set(), 0);
}

function toValue(value: unknown, ancestors: Set<object>, depth: number): unknown {
  try {
    return convert(value, ancestors, depth);
  } catch {
    // Inspecting it threw (e.g. a proxy's trap or a throwing getter).
    return "[Unserializable]";
  }
}

function convert(value: unknown, ancestors: Set<object>, depth: number): unknown {
  if (value === null || typeof value !== "object") {
    return typeof value === "function" || typeof value === "symbol" ? undefined : value;
  }
  if (ancestors.has(value)) {
    return "[Circular]";
  }
  if (depth >= MAX_DEPTH) {
    return "[Truncated]";
  }
  const tag = tagOf(value);
  if (DEVALUE_TAGS.has(tag) || tag.startsWith("Temporal.")) {
    return value;
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map(item => toValue(item, ancestors, depth + 1));
    }
    if (value instanceof Map) {
      return new Map(Array.from(value, ([key, item]) => [toValue(key, ancestors, depth + 1), toValue(item, ancestors, depth + 1)]));
    }
    if (value instanceof Set) {
      return new Set(Array.from(value, item => toValue(item, ancestors, depth + 1)));
    }
    if (isPlainObject(value)) {
      const copy: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        if (key !== "__proto__") {
          copy[key] = toValue((value as Record<string, unknown>)[key], ancestors, depth + 1);
        }
      }
      return copy;
    }
    return describe(value);
  } finally {
    ancestors.delete(value);
  }
}

function tagOf(value: object): string {
  try {
    // As devalue reads it, e.g. "Date" or "Temporal.Instant".
    return Object.prototype.toString.call(value).slice(8, -1);
  } catch {
    return "Object";
  }
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  // A plain object from another realm (a step's VM) has that realm's Object.prototype.
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

function describe(value: object): string {
  try {
    if (value instanceof Error || (typeof (value as { message?: unknown }).message === "string" && typeof (value as { name?: unknown }).name === "string")) {
      const { name, message } = value as { name: string; message: string };
      return `${name}: ${message}`;
    }
    return String(value);
  } catch {
    return "[Unserializable]";
  }
}
