/**
 * Escape text before it is interpolated into an HTML string.
 *
 * The preview panel renders a `srcdoc` document built from workspace values. A
 * workspace name is user input, so `My <script>alert(1)</script> box` would
 * otherwise execute inside the preview frame. Nothing here is trusted.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
