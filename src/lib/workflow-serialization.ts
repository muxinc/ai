interface SerializableClass {
  classId?: string;
}

interface SerializableClassConstructor {
  new (...args: never[]): unknown;
  classId?: string;
}

type Registry = Map<string, SerializableClassConstructor>;

const WORKFLOW_CLASS_REGISTRY = Symbol.for("workflow-class-registry");

/**
 * Registers a class in Workflow's global serialization registry.
 *
 * This mirrors Workflow DevKit's internal `registerSerializationClass` behavior
 * without requiring consumers to import private workflow internals.
 */
export function registerWorkflowSerializationClass(classId: string, cls: SerializableClassConstructor): void {
  const globalObject = globalThis as typeof globalThis & {
    [WORKFLOW_CLASS_REGISTRY]?: Registry;
  };

  let registry = globalObject[WORKFLOW_CLASS_REGISTRY];
  if (!registry) {
    registry = new Map<string, SerializableClassConstructor>();
    globalObject[WORKFLOW_CLASS_REGISTRY] = registry;
  }

  registry.set(classId, cls);

  const serializableClass = cls as SerializableClass;
  if (serializableClass.classId !== classId) {
    Object.defineProperty(cls, "classId", {
      value: classId,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
}
