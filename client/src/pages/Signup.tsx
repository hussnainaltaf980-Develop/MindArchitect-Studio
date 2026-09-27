import { useState, type FormEvent } from "react";
import { Link, Redirect } from "wouter";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { useAuth } from "@/_core/useAuth";
import { AuthLayout, Field, inputClass } from "./Login";

// Sign-up. Creates a real account through the tRPC auth router — bcrypt hash,
// UNIQUE email guard, signed session cookie — then lands in the studio.
export default function Signup() {
  const { signup, user } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signup(email.trim(), password, name.trim() || undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Account creation failed");
    } finally {
      setBusy(false);
    }
  }

  if (user) return <Redirect to="/" />;

  return (
    <AuthLayout
      title="Create your account"
      subtitle="A few seconds, and the studio is yours."
      footer={
        <>
          Already have an account?{" "}
          <Link to="/login" className="text-signal underline-offset-4 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Name" htmlFor="name">
          <input
            id="name"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
            placeholder="Ada Lovelace"
          />
        </Field>
        <Field label="Email" htmlFor="email">
          <input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className={inputClass}
            placeholder="you@example.com"
          />
        </Field>
        <Field label="Password" htmlFor="password" hint="At least 8 characters.">
          <input
            id="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
            className={inputClass}
            placeholder="••••••••"
          />
        </Field>
        {error ? (
          <p
            role="alert"
            className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
          >
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={busy}
          className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-chrome text-sm font-medium text-bg disabled:opacity-50"
        >
          {busy ? (
            <>
              <LoaderCircle className="size-4 animate-spin" /> Creating…
            </>
          ) : (
            <>
              Create account <ArrowRight className="size-4" />
            </>
          )}
        </button>
        <p className="text-center text-[11px] leading-relaxed text-subtle">
          Your account lives in this deployment's own database. Passwords are hashed with
          bcrypt; the session is a signed, http-only cookie.
        </p>
      </form>
    </AuthLayout>
  );
}
