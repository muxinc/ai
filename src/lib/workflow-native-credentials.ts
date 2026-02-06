import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";

const WORKFLOW_CLASS_REGISTRY = Symbol.for("workflow-class-registry");
const WORKFLOW_NATIVE_CREDENTIALS_CLASS_ID = "mux.ai.workflow-native-credentials";

type AnyObject = Record<PropertyKey, unknown>;

function registerWorkflowNativeCredentialsClass(): void {
  const globalRegistry = globalThis as AnyObject;
  const existingRegistry = globalRegistry[WORKFLOW_CLASS_REGISTRY] as Map<string, unknown> | undefined;
  const registry = existingRegistry ?? new Map<string, unknown>();

  if (!existingRegistry) {
    globalRegistry[WORKFLOW_CLASS_REGISTRY] = registry as unknown;
  }

  registry.set(WORKFLOW_NATIVE_CREDENTIALS_CLASS_ID, WorkflowNativeCredentials);

  const ctor = WorkflowNativeCredentials as unknown as { classId?: string };
  if (ctor.classId !== WORKFLOW_NATIVE_CREDENTIALS_CLASS_ID) {
    Object.defineProperty(WorkflowNativeCredentials, "classId", {
      value: WORKFLOW_NATIVE_CREDENTIALS_CLASS_ID,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
}

/**
 * Workflow-native credentials container.
 *
 * This uses Workflow DevKit class serialization hooks instead of manual app-level
 * encryption payloads, while keeping compatibility with the existing credentials flow.
 */
export class WorkflowNativeCredentials<T = unknown> {
  constructor(private readonly data: T) {}

  unwrap(): T {
    return this.data;
  }

  static [WORKFLOW_SERIALIZE](instance: WorkflowNativeCredentials): AnyObject {
    return instance.unwrap() as AnyObject;
  }

  static [WORKFLOW_DESERIALIZE](value: AnyObject): WorkflowNativeCredentials {
    return new WorkflowNativeCredentials(value);
  }
}

registerWorkflowNativeCredentialsClass();

export function nativeEncryptForWorkflow<T>(value: T): WorkflowNativeCredentials<T> {
  return new WorkflowNativeCredentials(value);
}

export function isWorkflowNativeCredentials(value: unknown): value is WorkflowNativeCredentials<AnyObject> {
  return value instanceof WorkflowNativeCredentials;
}
