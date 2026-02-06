import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";

type AnyObject = Record<PropertyKey, unknown>;

/**
 * Workflow-native credentials container.
 *
 * This uses Workflow DevKit class serialization hooks instead of manual app-level
 * encryption payloads, while keeping compatibility with the existing credentials flow.
 */
export class WorkflowNativeCredentials<T = unknown> {
  private readonly data: T;

  constructor(data: T) {
    this.data = data;
  }

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

export function serializeForWorkflow<T>(value: T): WorkflowNativeCredentials<T> {
  return new WorkflowNativeCredentials(value);
}

export function isWorkflowNativeCredentials(value: unknown): value is WorkflowNativeCredentials<AnyObject> {
  return value instanceof WorkflowNativeCredentials;
}
