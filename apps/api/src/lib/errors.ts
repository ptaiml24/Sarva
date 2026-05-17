export const TASK_CLAIM_CONFLICT = "TASK_CLAIM_CONFLICT" as const;
export const TASK_PHASE_GATE = "TASK_PHASE_GATE" as const;
export const TASK_DEPENDENCY_GATE = "TASK_DEPENDENCY_GATE" as const;
export const TASK_REVIEW_MAX_REVISIONS = "TASK_REVIEW_MAX_REVISIONS" as const;

export function jsonError(code: string, message: string, details?: Record<string, unknown>) {
  return {
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  };
}
