// Where this app is reachable from OUTSIDE itself.
//
// `location.origin` answers that correctly only when the app is served from its own
// public origin — true once published, and true in the Daytona sandbox. It is NOT
// true in the Studio WebContainer preview: that origin
// (`…--3000--….webcontainer-api.io`) is served by a service worker living inside ONE
// browser tab, so a link built from it 404s for everybody else — including the person
// it was sent to.
//
// So the platform injects the real answer when it knows better, and this reads it.
// There is nothing to configure: the injection exists only in the preview, and every
// other environment falls through to `location.origin`, which is right there.

declare global {
  interface Window {
    /** Injected by the Studio preview bridge; absent in every other environment. */
    __TEAMILY_PUBLIC_BASE__?: string;
  }
}

/**
 * An absolute, shareable URL for an in-app path (`/s/abc`).
 *
 * Use this — never `location.origin` — for any link the app hands to a HUMAN: a
 * "copy public link" button, a URL in an email, a QR code. Links the app only
 * follows itself (router navigation, fetches) need nothing from here.
 *
 * In the Studio preview the result is a platform share link that re-opens this app in
 * the recipient's own preview and lands them on `path`. Its audience is the same as
 * the preview's own — people with access to this project — which is exactly the
 * audience a preview-stage link should have. Once published, it is the app's real
 * public URL, custom domain included.
 */
export function publicUrl(path: string): string {
  const base = window.__TEAMILY_PUBLIC_BASE__;
  if (typeof base === "string" && base.length > 0) {
    return base + encodeURIComponent(path);
  }
  return `${window.location.origin}${path}`;
}
