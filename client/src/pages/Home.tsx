import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/_core/useAuth";

// Example landing page. Replace with the app's real home.
export default function Home() {
  const { user } = useAuth();
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-6 p-8 text-center">
      <h1 className="text-4xl font-bold tracking-tight">Your app starts here</h1>
      <p className="text-muted-foreground">
        A full-stack scaffold: React + tRPC + Drizzle, with auth, DB and file
        uploads wired. Edit <code className="rounded bg-muted px-1">client/src/pages</code> to begin.
      </p>
      <div className="flex gap-3">
        {user ? (
          <Button asChild>
            <Link to="/workspaces">Open a workspace</Link>
          </Button>
        ) : (
          <>
            <Button asChild>
              <Link to="/signup">Get started</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/login">Log in</Link>
            </Button>
          </>
        )}
      </div>
    </main>
  );
}
