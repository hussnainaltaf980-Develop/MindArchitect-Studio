/**
 * Best-effort unpartitioned-cookie grant for an embedded preview (iframe).
 * Must run inside the user gesture that triggered login / signup / logout —
 * do NOT await hasStorageAccess() first; that consumes the gesture.
 *
 * Failures are swallowed: the session cookie is CHIPS, which does not need
 * this permission. Top-level windows skip entirely.
 */
export async function requestStorageAccessIfEmbedded(): Promise<void> {
  try {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    if (window.top === window.self) return;
    if (typeof document.requestStorageAccess !== "function") return;
    await document.requestStorageAccess();
  } catch {
    // CHIPS is the main path.
  }
}
