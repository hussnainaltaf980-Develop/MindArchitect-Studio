// Studio state. Ported from the project's own stores/studio-store.ts: the same
// views, the same conversation/message shapes, the same streaming lifecycle and
// the same zustand persist setup. Kept dependency-light (no cognitive-type
// imports) so it runs against this app's API surface.
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { uid } from "@/lib/id";
import { DEFAULT_CHAT_MODEL } from "@/lib/models";

// The engine vocabulary lives with the transport that observes it, and is
// re-exported here so every existing `import { ... } from "@/stores/studio-store"`
// keeps working. It is no longer defined in two places, which is how the old
// "live" vs "gateway" drift happened in the first place.
export type { EnginePlane, ReplyStyle } from "@/lib/studio-api";
import type { EnginePlane, ReplyStyle } from "@/lib/studio-api";

export type StudioView =
  | "chat"
  | "agents"
  | "documents"
  | "memory"
  | "models"
  | "lab"
  | "apikeys"
  | "settings";

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  mode: "chat" | "cognitive";
  runId?: string;
  model?: string;
  engine?: EnginePlane;
  /** Why the gateway did not answer, when `engine` is "local". */
  engineReason?: string;
};

export type Conversation = {
  id: string;
  title: string;
  updatedAt: string;
  messages: ChatMessage[];
};

export type DocumentRecord = {
  id: string;
  filename: string;
  sizeBytes: number;
  text: string;
  chunkCount: number;
  createdAt: string;
};

export type RunTrace = {
  run_id: string;
  status: string;
  engine: string;
  total_ms: number;
  answer: string | null;
  steps: { id: string; label: string; status: string; detail?: string }[];
};

export type StudioSettings = {
  style: ReplyStyle;
  temperature: number;
  maxTokens: number;
  deepDefault: boolean;
  showTraceRail: boolean;
};

const DEFAULT_SETTINGS: StudioSettings = {
  style: "balanced",
  temperature: 0.4,
  maxTokens: 1400,
  deepDefault: false,
  showTraceRail: true,
};

type StudioState = {
  view: StudioView;
  conversations: Conversation[];
  activeId: string | null;
  deepReasoning: boolean;
  selectedModel: string;
  isProcessing: boolean;
  streamBuffer: string;
  streamEngine: EnginePlane | null;
  streamEngineReason: string | null;
  error: string | null;
  activeRunId: string | null;
  traces: Record<string, RunTrace>;
  documents: DocumentRecord[];
  sidebarOpen: boolean;
  settings: StudioSettings;

  setView: (view: StudioView) => void;
  setDeepReasoning: (on: boolean) => void;
  setSelectedModel: (id: string) => void;
  setSidebarOpen: (open: boolean) => void;
  patchSettings: (p: Partial<StudioSettings>) => void;
  newConversation: () => string;
  selectConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  clearConversations: () => void;
  addUserMessage: (content: string, mode: ChatMessage["mode"]) => void;
  addAssistantMessage: (content: string, extra?: Partial<ChatMessage>) => void;
  beginStream: () => void;
  setStreamEngine: (e: EnginePlane | null, reason?: string) => void;
  appendStream: (token: string) => void;
  commitStream: () => void;
  discardStream: () => void;
  setProcessing: (v: boolean) => void;
  setError: (e: string | null) => void;
  putTrace: (run: RunTrace) => void;
  setActiveRun: (id: string | null) => void;
  addDocument: (doc: DocumentRecord) => void;
  removeDocument: (id: string) => void;
};

function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 48 ? `${t.slice(0, 48)}…` : t || "New conversation";
}

export const useStudio = create<StudioState>()(
  persist(
    (set, get) => ({
      view: "chat",
      conversations: [],
      activeId: null,
      deepReasoning: false,
      selectedModel: DEFAULT_CHAT_MODEL,
      isProcessing: false,
      streamBuffer: "",
      streamEngine: null,
      streamEngineReason: null,
      error: null,
      activeRunId: null,
      traces: {},
      documents: [],
      sidebarOpen: false,
      settings: DEFAULT_SETTINGS,

      setView: (view) => set({ view }),
      setDeepReasoning: (on) => set({ deepReasoning: on }),
      setSelectedModel: (id) => set({ selectedModel: id }),
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      patchSettings: (p) => set((s) => ({ settings: { ...s.settings, ...p } })),

      newConversation: () => {
        const id = uid("conv");
        const conv: Conversation = {
          id,
          title: "New conversation",
          updatedAt: new Date().toISOString(),
          messages: [],
        };
        set((s) => ({
          conversations: [conv, ...s.conversations],
          activeId: id,
          error: null,
          streamBuffer: "",
          activeRunId: null,
        }));
        return id;
      },

      selectConversation: (id) => set({ activeId: id, error: null, streamBuffer: "" }),

      deleteConversation: (id) =>
        set((s) => {
          const conversations = s.conversations.filter((c) => c.id !== id);
          return {
            conversations,
            activeId: s.activeId === id ? (conversations[0]?.id ?? null) : s.activeId,
          };
        }),

      clearConversations: () =>
        set({
          conversations: [],
          activeId: null,
          traces: {},
          activeRunId: null,
          streamBuffer: "",
        }),

      addUserMessage: (content, mode) => {
        let { activeId, conversations } = get();
        if (!activeId) {
          activeId = get().newConversation();
          conversations = get().conversations;
        }
        const msg: ChatMessage = {
          id: uid("msg"),
          role: "user",
          content,
          createdAt: new Date().toISOString(),
          mode,
        };
        set({
          conversations: conversations.map((c) =>
            c.id === activeId
              ? {
                  ...c,
                  title: c.messages.length === 0 ? titleFrom(content) : c.title,
                  updatedAt: msg.createdAt,
                  messages: [...c.messages, msg],
                }
              : c,
          ),
        });
      },

      addAssistantMessage: (content, extra) => {
        const { activeId, conversations } = get();
        if (!activeId) return;
        const msg: ChatMessage = {
          id: uid("msg"),
          role: "assistant",
          content,
          createdAt: new Date().toISOString(),
          mode: extra?.mode ?? "chat",
          ...extra,
        };
        set({
          conversations: conversations.map((c) =>
            c.id === activeId
              ? { ...c, updatedAt: msg.createdAt, messages: [...c.messages, msg] }
              : c,
          ),
        });
      },

      beginStream: () => set({ streamBuffer: "", isProcessing: true, streamEngine: null, streamEngineReason: null }),
      setStreamEngine: (e, reason) =>
        set({ streamEngine: e, streamEngineReason: e ? (reason ?? "ok") : null }),
      appendStream: (token) => set((s) => ({ streamBuffer: s.streamBuffer + token })),
      commitStream: () => {
        const { streamBuffer, streamEngine, streamEngineReason, selectedModel } = get();
        if (streamBuffer) {
          get().addAssistantMessage(streamBuffer, {
            mode: "chat",
            model: selectedModel,
            // Unlabelled means the server never told us which plane answered;
            // "gateway" is the conservative default because it is the claim that
            // would be wrong to make falsely — a local reply mislabelled as
            // hosted is the failure this whole change exists to prevent.
            engine: streamEngine ?? "gateway",
            engineReason: streamEngineReason ?? "ok",
          });
        }
        set({ streamBuffer: "", isProcessing: false, streamEngine: null, streamEngineReason: null });
      },
      discardStream: () =>
        set({ streamBuffer: "", isProcessing: false, streamEngine: null, streamEngineReason: null }),
      setProcessing: (v) => set({ isProcessing: v }),
      setError: (e) => set({ error: e }),
      putTrace: (run) =>
        set((s) => ({ traces: { ...s.traces, [run.run_id]: run }, activeRunId: run.run_id })),
      setActiveRun: (id) => set({ activeRunId: id }),
      addDocument: (doc) => set((s) => ({ documents: [doc, ...s.documents] })),
      removeDocument: (id) =>
        set((s) => ({ documents: s.documents.filter((d) => d.id !== id) })),
    }),
    {
      // Bumped from v5: the engine vocabulary changed ("live" → "gateway"), and
      // rehydrating a v5 store would bring back messages whose engine label no
      // longer means anything. A new key starts clean rather than mislabelling
      // old replies.
      name: "ma.studio.v6",
      skipHydration: true,
      partialize: (s) => ({
        conversations: s.conversations,
        activeId: s.activeId,
        deepReasoning: s.deepReasoning,
        selectedModel: s.selectedModel,
        traces: s.traces,
        documents: s.documents,
        settings: s.settings,
      }),
    },
  ),
);
