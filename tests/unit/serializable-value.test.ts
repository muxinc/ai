import { describe, expect, it } from "vitest";

import { toSerializableValue } from "../../src/lib/serializable-value.ts";

class Client {
  toString() {
    return "Client(us-east-1)";
  }
}

describe("toSerializableValue", () => {
  it("keeps JSON values and the built-ins devalue supports as they are", () => {
    const date = new Date("2026-01-01T00:00:00Z");
    const url = new URL("https://example.com/a");
    const bytes = new Uint8Array([1, 2]);
    const value = { text: "a", count: 1, ok: true, none: null, missing: undefined, big: 10n, date, url, bytes, list: [1, "b"], nested: { deep: [{ x: 1 }] } };

    const result = toSerializableValue(value) as typeof value;

    expect(result).toEqual(value);
    expect(result.date).toBe(date);
    expect(result.url).toBe(url);
    expect(result.bytes).toBe(bytes);
  });

  it("keeps maps and sets, with their members made serializable", () => {
    const result = toSerializableValue({ map: new Map([["client", new Client()]]), set: new Set([() => 1, "a"]) }) as { map: Map<string, unknown>; set: Set<unknown> };

    expect(result.map).toEqual(new Map([["client", "Client(us-east-1)"]]));
    expect(result.set).toEqual(new Set([undefined, "a"]));
  });

  it("turns class instances and errors into strings, and functions and symbols into undefined", () => {
    expect(toSerializableValue({ client: new Client(), error: new TypeError("bad"), fn: () => 1, sym: Symbol("s"), list: [Symbol("t")] })).toEqual({
      client: "Client(us-east-1)",
      error: "TypeError: bad",
      fn: undefined,
      sym: undefined,
      list: [undefined],
    });
  });

  it("drops symbol and __proto__ keys, and keeps null-prototype objects", () => {
    const value = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1, [Symbol("s")]: 2 });
    Object.defineProperty(value, "__proto__", { value: { polluted: true }, enumerable: true });

    expect(toSerializableValue(value)).toEqual({ a: 1 });
  });

  it("cuts cycles and deep nesting short, but keeps repeated non-circular references", () => {
    const cyclic: Record<string, unknown> = { name: "a" };
    cyclic.self = cyclic;
    let deep: unknown = "bottom";
    for (let i = 0; i < 12; i += 1) {
      deep = { next: deep };
    }
    const shared = { x: 1 };

    expect(toSerializableValue(cyclic)).toEqual({ name: "a", self: "[Circular]" });
    expect(JSON.stringify(toSerializableValue(deep))).toContain("[Truncated]");
    expect(toSerializableValue({ a: shared, b: shared })).toEqual({ a: { x: 1 }, b: { x: 1 } });
  });

  it("never throws, even when inspecting a value does", () => {
    const hostile = new Proxy({}, { getPrototypeOf() {
      throw new Error("trap");
    } });

    expect(() => toSerializableValue({ hostile })).not.toThrow();
  });
});
