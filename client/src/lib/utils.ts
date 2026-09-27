import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// The shadcn/ui class helper. Every component under components/ui imports it as
// `@/lib/utils` (see components.json "aliases.utils"), so it is part of the
// scaffold's load-bearing surface — deleting it breaks typecheck AND vite build.
// clsx resolves conditional/array class input; twMerge then drops earlier
// Tailwind classes that a later one overrides, so `cn("p-2", "p-4")` → "p-4".
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
