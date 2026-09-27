import { createContext, useContext, useMemo, type ReactNode } from "react";
import { trpc } from "./trpc";
import type { SessionUser } from "@shared/types";
import { requestStorageAccessIfEmbedded } from "./storage-access";

// Frontend auth seam. Wraps the tRPC auth router so pages consume a single
// `useAuth()` — they never see the session mechanism (cookie/JWT/SSO). Mirrors
// the server AuthProvider abstraction (DESIGN §5.1).
interface AuthContextValue {
  user: SessionUser | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string, name?: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const loginM = trpc.auth.login.useMutation();
  const signupM = trpc.auth.signup.useMutation();
  const logoutM = trpc.auth.logout.useMutation();

  const value = useMemo<AuthContextValue>(
    () => ({
      user: me.data ?? null,
      isLoading: me.isLoading,
      login: async (email, password) => {
        await requestStorageAccessIfEmbedded();
        await loginM.mutateAsync({ email, password });
        await utils.auth.me.invalidate();
      },
      signup: async (email, password, name) => {
        await requestStorageAccessIfEmbedded();
        await signupM.mutateAsync({ email, password, name });
        await utils.auth.me.invalidate();
      },
      logout: async () => {
        await requestStorageAccessIfEmbedded();
        await logoutM.mutateAsync();
        await utils.auth.me.invalidate();
      },
    }),
    [me.data, me.isLoading, loginM, signupM, logoutM, utils],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
