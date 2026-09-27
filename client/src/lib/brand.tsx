// Brand marks. Carried over from the project's own components/brand/logo.tsx so
// the Studio renders the real MindArchitect lockup, not a placeholder.
//
// The wordmark renders "MindArchitect Studio". The "Studio" suffix is part of the
// mark, not decoration: it is what appears in the sidebar, on the auth screens and
// in the page title, so every surface a user sees names the same product. The
// `<img>` marks are the project's own art and carry the name already, so they are
// left exactly as the project drew them.
type LogoProps = {
  variant?: "mark" | "lockup" | "wordmark";
  height?: number;
  className?: string;
};

export function Logo({ variant = "mark", height = 32, className }: LogoProps) {
  if (variant === "wordmark") {
    return (
      <span
        className={className}
        style={{ fontFamily: "var(--font-display)", lineHeight: 1.05, whiteSpace: "nowrap" }}
      >
        <span className="font-light tracking-tight text-fg">Mind</span>
        <span className="font-bold tracking-tight text-fg">Architect</span>
        <span className="ml-1.5 font-light tracking-tight text-muted">Studio</span>
      </span>
    );
  }

  const src = variant === "lockup" ? "/brand/lockup.png" : "/brand/mark.png";

  return (
    <img
      src={src}
      alt="MindArchitect Studio"
      height={height}
      className={className}
      style={{ height, width: "auto", objectFit: "contain" }}
      draggable={false}
    />
  );
}
