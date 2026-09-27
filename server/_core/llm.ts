// Platform-mediated LLM access (DESIGN §5.1.2 / §8.5).
//
// Routed through the platform so usage is metered to the owner's account and
// rate-limited per app — a public app calling an LLM on every anonymous request
// would otherwise burn the platform's keys without bound. App code never holds
// a raw provider key.
//
// M1 ships the SIGNATURE; the platform LLM endpoint (→ core/services/llm.py)
// is wired in a later milestone (§8.5).
export interface LlmInput {
  system?: string;
  prompt: string;
  maxTokens?: number;
}

export async function complete(_input: LlmInput): Promise<string> {
  throw new Error("llm.complete: platform LLM endpoint not wired yet (DESIGN §8.5).");
}
