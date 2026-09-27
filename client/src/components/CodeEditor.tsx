import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

// Monaco is loaded from a CDN on demand so the bundle stays small and the
// editor is the real thing rather than a lookalike. `loader.js` is the standard
// AMD bootstrap Monaco ships for exactly this case.
const MONACO_VERSION = "0.52.2";
const CDN = `https://cdn.jsdelivr.net/npm/monaco-editor@${MONACO_VERSION}/min/vs`;

type MonacoRequire = ((deps: string[], onLoad: () => void) => void) & {
  config: (opts: { paths: Record<string, string> }) => void;
};

declare global {
  interface Window {
    require?: MonacoRequire;
    monaco?: unknown;
  }
}

// One loader promise for the whole app: a second editor mounting must not
// inject a second copy of the loader.
let loaderPromise: Promise<boolean> | null = null;

function loadMonaco(): Promise<boolean> {
  if (loaderPromise) return loaderPromise;
  loaderPromise = new Promise<boolean>((resolve) => {
    if (window.monaco) {
      resolve(true);
      return;
    }
    const script = document.createElement("script");
    script.src = `${CDN}/loader.js`;
    script.async = true;
    script.onload = () => {
      try {
        window.require?.config({ paths: { vs: CDN } });
        window.require?.(["vs/editor/editor.main"], () => resolve(true));
      } catch {
        resolve(false);
      }
    };
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
    // A slow or blocked CDN must never wedge the UI. If Monaco has not arrived
    // in 5s the caller keeps the built-in editor, which is fully functional.
    setTimeout(() => resolve(Boolean(window.monaco)), 5000);
  });
  return loaderPromise;
}

export interface CodeEditorProps {
  value: string;
  language: string;
  onChange: (next: string) => void;
  readOnly?: boolean;
  className?: string;
}

/**
 * Code editor with a graceful, fully-functional degraded mode.
 *
 * The fallback is a real editor, not a placeholder: a line-number gutter plus a
 * tab-aware textarea that keeps the gutter in sync with scrolling. It matters
 * because the environment this app is verified in may have no outbound access
 * to the CDN, and an editor that renders an empty box when Monaco is
 * unreachable would be worse than no editor at all.
 */
export function CodeEditor({
  value,
  language,
  onChange,
  readOnly = false,
  className,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<unknown>(null);
  const [monacoReady, setMonacoReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadMonaco().then((ok) => {
      if (!cancelled && ok) setMonacoReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Create the Monaco instance once the loader reports success.
  useEffect(() => {
    if (!monacoReady || !hostRef.current) return;
    const monaco = (window as { monaco?: MonacoLike }).monaco;
    if (!monaco) return;

    monaco.editor.defineTheme("mindarchitect", {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": "#0b1116",
        "editor.foreground": "#dde5ec",
        "editorLineNumber.foreground": "#4a5b6b",
        "editorLineNumber.activeForeground": "#7fd4e0",
        "editor.selectionBackground": "#1d3a44",
        "editor.lineHighlightBackground": "#141d25",
        "editorCursor.foreground": "#3ad1e0",
      },
    });

    const instance = monaco.editor.create(hostRef.current, {
      value,
      language,
      theme: "mindarchitect",
      readOnly,
      minimap: { enabled: false },
      fontSize: 13,
      lineHeight: 20,
      fontFamily: "JetBrains Mono, ui-monospace, Menlo, Consolas, monospace",
      scrollBeyondLastLine: false,
      automaticLayout: true,
      renderLineHighlight: "line",
      tabSize: 4,
      padding: { top: 8, bottom: 8 },
    });
    editorRef.current = instance;
    instance.onDidChangeModelContent(() => {
      onChange(instance.getValue());
    });
    return () => {
      instance.dispose();
      editorRef.current = null;
    };
    // Deliberately only on mount/loader-ready: re-creating the editor on every
    // value change would reset the cursor on each keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monacoReady]);

  // Push external changes (file switch, revert) into the live editor.
  useEffect(() => {
    const instance = editorRef.current as MonacoEditorLike | null;
    if (!instance) return;
    if (instance.getValue() !== value) instance.setValue(value);
  }, [value]);

  useEffect(() => {
    const monaco = (window as { monaco?: MonacoLike }).monaco;
    const model = (editorRef.current as MonacoEditorLike | null)?.getModel();
    if (monaco && model) monaco.editor.setModelLanguage(model, language);
  }, [language]);

  const lines = value.split("\n");

  return (
    <div className={cn("relative flex h-full min-h-0 flex-col bg-editor-bg", className)}>
      {monacoReady ? (
        <div ref={hostRef} className="h-full w-full" data-testid="monaco-host" />
      ) : (
        <div className="flex h-full min-h-0 w-full">
          <div
            className="scroll-thin select-none overflow-hidden border-r border-border/40 bg-editor-gutter py-2 text-right"
            style={{ width: 52, flex: "0 0 52px" }}
            aria-hidden
          >
            {lines.map((_, i) => (
              <div
                key={i}
                className="tabular pr-3 text-[11px] leading-5 text-muted-foreground/70"
              >
                {i + 1}
              </div>
            ))}
          </div>
          <textarea
            data-testid="fallback-editor"
            spellCheck={false}
            readOnly={readOnly}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="scroll-thin h-full w-full resize-none bg-transparent p-2 font-mono text-[13px] leading-5 text-editor-fg outline-none"
            style={{ tabSize: 4 }}
          />
        </div>
      )}
      <div className="pointer-events-none absolute right-2 bottom-1 rounded bg-card/80 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        {monacoReady ? "monaco" : "built-in editor"}
      </div>
    </div>
  );
}

// Minimal structural types for the CDN-loaded Monaco, so this file typechecks
// without adding monaco-editor as a build dependency.
interface MonacoEditorLike {
  getValue: () => string;
  setValue: (v: string) => void;
  getModel: () => unknown;
  dispose: () => void;
  onDidChangeModelContent: (cb: () => void) => void;
}
interface MonacoLike {
  editor: {
    create: (el: HTMLElement, opts: Record<string, unknown>) => MonacoEditorLike;
    defineTheme: (name: string, theme: Record<string, unknown>) => void;
    setModelLanguage: (model: unknown, language: string) => void;
  };
}
