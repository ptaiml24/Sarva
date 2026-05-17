/** Typed loose JSON on `Project.deliveryPolicy` — merge updates immutably. */
export function deliveryPolicyRecord(policy: unknown): Record<string, unknown> {
  if (policy && typeof policy === "object" && !Array.isArray(policy)) {
    return { ...(policy as Record<string, unknown>) };
  }
  return {};
}
