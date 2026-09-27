import { useEffect, useState, type ReactNode } from "react";
import { Redirect, Route, Switch } from "wouter";
import { useAuth } from "./_core/useAuth";
import { Logo } from "@/lib/brand";
import Studio from "./pages/Studio";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import Dashboard from "./pages/Dashboard";
import Workspaces from "./pages/Workspaces";
import Ide from "./pages/Ide";

// Auth is REQUIRED: every product surface sits behind the session, so the studio
// is a per-account workspace rather than a public page.
//
// The guard waits a BOUNDED moment for the session query to settle, then
// redirects. Without that grace period a 401 the client keeps treating as
// "still loading" leaves this rendering its loading state indefinitely and a
// protected route looks broken instead of bouncing to the sign-in form.
function Protected({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();
  const [graceElapsed, setGraceElapsed] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setGraceElapsed(true), 1200);
    return () => clearTimeout(t);
  }, []);

  if (isLoading && !graceElapsed) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-bg">
        <Logo variant="mark" height={34} className="ma-pulse" />
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-subtle">
          Opening studio
        </p>
      </div>
    );
  }

  if (!user) return <Redirect to="/login" />;
  return <>{children}</>;
}

// `/` is the Studio — the project's own frontend, and what the preview URL must
// serve. The workspace routes below are the sandbox/IDE surfaces; they stay
// registered so no existing navigation dead-ends.
export default function App() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/signup" component={Signup} />
      <Route path="/">
        <Protected>
          <Studio />
        </Protected>
      </Route>
      <Route path="/dashboard">
        <Protected>
          <Dashboard />
        </Protected>
      </Route>
      <Route path="/workspaces">
        <Protected>
          <Workspaces />
        </Protected>
      </Route>
      {/* Declared AFTER /workspaces, or wouter's literal match loses to the
          parameterised one and the list page becomes unreachable. */}
      <Route path="/workspaces/:id">
        <Protected>
          <Ide />
        </Protected>
      </Route>
      <Route>
        {() => (
          <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-bg">
            <Logo variant="mark" height={30} />
            <p className="text-sm text-muted">That route does not exist.</p>
            <a href="/" className="text-xs text-signal underline-offset-4 hover:underline">
              Back to the studio
            </a>
          </div>
        )}
      </Route>
    </Switch>
  );
}
