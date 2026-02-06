import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";

type AnyObject = Record<PropertyKey, unknown>;

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

  static [WORKFLOW_DESERIALIZE](this: typeof WorkflowNativeCredentials, value: AnyObject): WorkflowNativeCredentials {
    return new this(value);
  }
}
// @workflow/core extracts WORKFLOW_DESERIALIZE and calls it standalone (without `this`).
// Bind it to the class so `new this(...)` resolves correctly at runtime.
(WorkflowNativeCredentials as any)[WORKFLOW_DESERIALIZE] = WorkflowNativeCredentials[WORKFLOW_DESERIALIZE].bind(WorkflowNativeCredentials);

export function serializeForWorkflow<T>(value: T): WorkflowNativeCredentials<T> {
  return new WorkflowNativeCredentials(value);
}

export function isWorkflowNativeCredentials(value: unknown): value is WorkflowNativeCredentials<AnyObject> {
  return value instanceof WorkflowNativeCredentials;
}
