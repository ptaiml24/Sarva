/** Labels `implementation_status` strings for dense lists (underscores → spaces). */
export function formatProjectImplementationStatus(st: string | undefined): string {
  if (!st || st === "draft") return "draft";
  return st.replace(/_/g, " ");
}
