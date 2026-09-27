// Guards the wouter route table in App.tsx against the two ways a generated app
// silently ships a dead link. Both produce the SAME symptom — the catch-all
// renders "Not found" — so neither is distinguishable from a typo'd URL, and
// neither is visible in a screenshot of the home page.
//
// Observed in a published app (todo-app, 2026-08): the agent changed
// Login.tsx's post-login `navigate("/dashboard")` to `navigate("/todos")` and
// never added a `/todos` <Route>. Logging in "succeeded" and dropped the user on
// a blank page. AGENT.md says in two places that App.tsx is where routes get
// wired; the instruction was not the problem, the absence of a check was.
//
// Static analysis on purpose: vitest runs `environment: "node"` here and jsdom is
// deliberately not a dependency (see vitest.config.ts), so this reads source text
// rather than rendering. What that cannot see is listed at the bottom of this
// file — read it before trusting a green run.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const CLIENT_SRC = path.resolve(import.meta.dirname);
const APP_TSX = path.join(CLIENT_SRC, "App.tsx");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

/** Paths declared as `<Route path="...">`, in source order. */
function registeredPaths(appSrc: string): string[] {
  return [...appSrc.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]);
}

/**
 * A `<Route>` with no `path` matches EVERYTHING in wouter, and `<Switch>` renders
 * the first match — so anything after it is unreachable. Returns the character
 * offset of that bare Route, or -1 when there is none.
 */
function bareRouteOffset(appSrc: string): number {
  return appSrc.search(/<Route(?![^>]*\bpath=)[\s>]/);
}

/** Compile a wouter path pattern to a regex: `/todos/:id` accepts `/todos/42`. */
function patternToRegex(pattern: string): RegExp {
  const body = pattern
    .split("/")
    .map((seg) => {
      if (seg.startsWith(":")) return seg.endsWith("?") ? "[^/]*" : "[^/]+";
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return new RegExp(`^${body}/?$`);
}

type NavTarget = { file: string; line: number; target: string };

/**
 * In-app navigation written as a string literal. Covers every form the template
 * itself uses — `navigate("/x")`, `setLocation("/x")`, `<Link to="/x">`,
 * `<Redirect to="/x">`. Targets built from a variable or template literal are
 * returned separately by `dynamicNavigations`, never silently dropped.
 */
function literalNavigations(files: string[]): NavTarget[] {
  const pattern =
    /(?:navigate|setLocation)\(\s*"([^"]*)"|<(?:Link|Redirect)\b[^>]*?\bto="([^"]*)"/g;
  const found: NavTarget[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf-8");
    for (const m of src.matchAll(pattern)) {
      const target = m[1] ?? m[2];
      if (!target.startsWith("/")) continue; // external URL, mailto:, #anchor
      found.push({
        file: path.relative(CLIENT_SRC, file),
        line: src.slice(0, m.index).split("\n").length,
        // compare the path only — a query string or hash is not part of routing
        target: target.split(/[?#]/)[0],
      });
    }
  }
  return found;
}

/** Navigation whose destination is not a literal, so this file cannot check it. */
function dynamicNavigations(files: string[]): NavTarget[] {
  const pattern = /(?:navigate|setLocation)\(\s*(`[^`]*`|[A-Za-z_$][\w$]*)/g;
  const found: NavTarget[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf-8");
    for (const m of src.matchAll(pattern)) {
      found.push({
        file: path.relative(CLIENT_SRC, file),
        line: src.slice(0, m.index).split("\n").length,
        target: m[1],
      });
    }
  }
  return found;
}

describe("App.tsx route wiring", () => {
  const appSrc = readFileSync(APP_TSX, "utf-8");
  const files = sourceFiles(CLIENT_SRC);

  it("registers a <Route> for every path the app navigates to", () => {
    const patterns = registeredPaths(appSrc).map(patternToRegex);
    const unmatched = literalNavigations(files).filter(
      (nav) => !patterns.some((re) => re.test(nav.target)),
    );

    const skipped = dynamicNavigations(files);
    const skippedNote = skipped.length
      ? `\n\nNot checked (destination is not a literal — verify these by hand):\n` +
        skipped.map((s) => `  ${s.file}:${s.line} → ${s.target}`).join("\n")
      : "";

    expect(
      unmatched,
      `These navigations lead to a path no <Route> matches, so they land on the ` +
        `catch-all "Not found" instead of a page. Add the <Route> in App.tsx ` +
        `(before the catch-all), or change the destination.\n` +
        unmatched.map((u) => `  ${u.file}:${u.line} → ${u.target}`).join("\n") +
        `\n\nRegistered: ${registeredPaths(appSrc).join(" ")}` +
        skippedNote,
    ).toEqual([]);
  });

  it("keeps the catch-all <Route> last, so no route below it is dead", () => {
    const bare = bareRouteOffset(appSrc);
    if (bare === -1) return; // no catch-all: nothing can hide behind it

    const afterBare = appSrc.slice(bare + 1);
    const shadowed = [...afterBare.matchAll(/<Route\s+path="([^"]+)"/g)].map(
      (m) => m[1],
    );

    expect(
      shadowed,
      `A <Route> with no path matches everything in wouter, and <Switch> renders ` +
        `the FIRST match — so these routes are unreachable and their pages will ` +
        `never render. Move them above the catch-all.\n` +
        shadowed.map((p) => `  ${p}`).join("\n"),
    ).toEqual([]);
  });
});

// KNOWN BLIND SPOTS — a green run here does NOT mean routing works:
//   * destinations built at runtime (`navigate(`/todos/${id}`)`, `navigate(v)`)
//     are reported, not verified;
//   * a route that IS registered but whose page component throws or renders
//     nothing still looks fine here;
//   * `Protected` applied wrongly (or not at all) is invisible;
//   * server-side deep-link fallback (`mountClient` in server/_core/serve.ts)
//     is not exercised at all;
//   * a page that renders but whose tRPC procedure is missing looks identical to
//     one that works.
// Those need the app actually running — which is what the delivery gate's
// browser pass over EVERY registered route is for.
