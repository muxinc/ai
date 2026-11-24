/*
 * Keeps an error's payload serializable across a Workflow DevKit step boundary. Workflow DevKit
 * serializes with devalue, which throws on a value it can't represent; when that happens while
 * recording a step's failure, the failure is never recorded, the step runs again, and the
 * original error is lost. So the error codecs pass their open-ended fields (facts, diagnostics)
 * through here, which never throws.
 */

/**
 * Built-ins devalue writes as they are, each with a brand check: devalue picks how to write a
 * value from its `Symbol.toStringTag`, which any object can fake, so a value is kept only when
 * it really is that built-in.
 */
const TYPED_ARRAY_TAGS: ReadonlySet<string> = new Set([
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
]);

function getter(prototype: object, key: string): ((this: unknown) => unknown) | undefined {
  return Object.getOwnPropertyDescriptor(prototype, key)?.get as ((this: unknown) => unknown) | undefined;
}

/** Calls a method or getter that throws unless `value` is that built-in. */
function hasBrand(value: object, check: ((this: unknown) => unknown) | undefined): boolean {
  if (!check) {
    return false;
  }
  try {
    check.call(value);
    return true;
  } catch {
    return false;
  }
}

function isDevalueBuiltIn(value: object, tag: string): boolean {
  switch (tag) {
    case "Date":
      return hasBrand(value, Date.prototype.getTime);
    case "RegExp":
      return hasBrand(value, getter(RegExp.prototype, "source"));
    case "URL":
      return typeof URL !== "undefined" && hasBrand(value, getter(URL.prototype, "href"));
    case "URLSearchParams":
      return typeof URLSearchParams !== "undefined" && hasBrand(value, URLSearchParams.prototype.toString);
    case "ArrayBuffer":
      return hasBrand(value, getter(ArrayBuffer.prototype, "byteLength"));
    default:
      return TYPED_ARRAY_TAGS.has(tag) && ArrayBuffer.isView(value);
  }
}

/** A boxed primitive's value (devalue writes them, but a fact is plain JSON), if it is one. */
function unboxed(value: object, tag: string): { primitive: unknown } | undefined {
  const valueOfs: Record<string, (this: unknown) => unknown> = {
    Number: Number.prototype.valueOf,
    String: String.prototype.valueOf,
    Boolean: Boolean.prototype.valueOf,
    BigInt: BigInt.prototype.valueOf,
  };
  const valueOf = valueOfs[tag];
  if (!valueOf) {
    return undefined;
  }
  try {
    return { primitive: valueOf.call(value) };
  } catch {
    return undefined;
  }
}

/** How deep {@link toSerializableValue} follows nested values before cutting them short. */
const MAX_DEPTH = 10;

/**
 * `value` in a form devalue can serialize, without throwing, for fields whose contract is plain
 * JSON (an error's facts and diagnostics). Primitives (including `bigint` and `undefined`),
 * arrays, plain objects, maps and sets keep their shape, recursively, and so do dates, URLs,
 * `URLSearchParams`, regular expressions, typed arrays and array buffers, when they really are
 * those built-ins. A boxed primitive becomes its primitive. Anything else becomes a string, even
 * where Workflow DevKit could have serialized it (an `Error` becomes its `name: message`; another
 * class instance, a `Temporal` value or one with its own serialization hooks, its `String()`).
 * Functions and symbols become `undefined`, symbol keys and `__proto__` keys are dropped, a
 * reference back to an enclosing value becomes `"[Circular]"`, nesting past {@link MAX_DEPTH}
 * levels becomes `"[Truncated]"`, and a value whose inspection throws (a proxy's trap, a
 * throwing getter) becomes `"[Unserializable]"`.
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
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map(item => toValue(item, ancestors, depth + 1));
    }
    // Before the tag, so a plain object that fakes one (`Symbol.toStringTag`) is copied as a
    // plain object, which drops its symbol keys, rather than passed on as a built-in.
    if (isPlainObject(value)) {
      const copy: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        if (key !== "__proto__") {
          copy[key] = toValue((value as Record<string, unknown>)[key], ancestors, depth + 1);
        }
      }
      return copy;
    }
    const tag = tagOf(value);
    if (isDevalueBuiltIn(value, tag)) {
      return value;
    }
    const boxed = unboxed(value, tag);
    if (boxed) {
      return boxed.primitive;
    }
    if (value instanceof Map) {
      return new Map(Array.from(value, ([key, item]) => [toValue(key, ancestors, depth + 1), toValue(item, ancestors, depth + 1)]));
    }
    if (value instanceof Set) {
      return new Set(Array.from(value, item => toValue(item, ancestors, depth + 1)));
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

/**
 * A plain object: no prototype, or one whose own prototype is `null` (`Object.prototype` from
 * any realm, e.g. a Workflow DevKit step's VM, or a null-prototype object), as devalue decides.
 */
function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
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
