import { useState, type FormEvent } from "react";
import { Link, Redirect } from "wouter";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { useAuth } from "@/_core/useAuth";
import { Logo } from "@/lib/brand";

// Sign-in, in the project's own visual language rather than the scaffold's
// generic card. The panel states what the Studio is and which plane answers,
// so the first screen a visitor sees belongs to this product.
export default function Login() {
  const { login, user } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  }

  // Declarative redirect: wait until `user` actually exists. An imperative jump
  // right after the await races the auth query's cache update, and the guard
  // bounces a freshly-signed-in user straight back to this form.
  if (user) return <Redirect to="/" />;

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Sign in to the studio."
      footer={
        <>
          No account?{" "}
          <Link to="/signup" className="text-signal underline-offset-4 hover:underline">
            Create one
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
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
        <Field label="Password" htmlFor="password">
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
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
              <LoaderCircle className="size-4 animate-spin" /> Signing in…
            </>
          ) : (
            <>
              Sign in <ArrowRight className="size-4" />
            </>
          )}
        </button>
      </form>
    </AuthLayout>
  );
}

export const inputClass =
  "h-11 w-full rounded-md border border-line bg-inset px-3 text-sm text-fg outline-none placeholder:text-subtle focus:border-signal/50";

export function Field({
  label,
  htmlFor,
  children,
  hint,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-chrome">
        {label}
      </label>
      {children}
      {hint ? <p className="text-[11px] text-subtle">{hint}</p> : null}
    </div>
  );
}

/** Split layout: brand + product copy on one side, the form on the other. */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <main className="grid min-h-dvh lg:grid-cols-2">
      {/* Brand panel */}
      <section className="relative hidden flex-col justify-between border-r border-line bg-surface p-10 lg:flex">
        <div className="ma-shimmer pointer-events-none absolute inset-0 opacity-40" />
        <div className="relative flex items-center gap-2">
          <Logo variant="mark" height={30} />
          <Logo variant="wordmark" className="text-[15px]" />
        </div>
        <div className="relative max-w-md">
          <h2 className="font-display text-3xl font-light leading-tight tracking-tight text-fg">
            The sovereign
            <br />
            model hierarchy.
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-muted">
            One studio for the whole line — Forge for code and architecture, Apex for
            Tree-of-Thought reasoning, the Lab for dataset synthesis and SFT on the native
            decoder.
          </p>
          <dl className="mt-8 grid grid-cols-3 gap-4">
            <BrandStat label="Lines" value="7" />
            <BrandStat label="Vocab" value="32,004" />
            <BrandStat label="Tensors" value="57" />
          </dl>
        </div>
        <p className="relative font-mono text-[10px] uppercase tracking-[0.2em] text-subtle">
          Forge V-5.6 · Apex M-5.0 · Synapse V-5.0
        </p>
      </section>

      {/* Form panel */}
      <section className="flex items-center justify-center px-5 py-12">
        <div className="ma-rise w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2 lg:hidden">
            <Logo variant="mark" height={26} />
            <Logo variant="wordmark" className="text-sm" />
          </div>
          <h1 className="font-display text-2xl font-light tracking-tight text-fg">{title}</h1>
          <p className="mt-1.5 text-sm text-muted">{subtitle}</p>
          <div className="mt-7">{children}</div>
          <p className="mt-6 text-center text-xs text-muted">{footer}</p>
        </div>
      </section>
    </main>
  );
}

function BrandStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.14em] text-subtle">{label}</dt>
      <dd className="tabular mt-1 font-display text-lg text-fg">{value}</dd>
    </div>
  );
}
