import { cn } from "@/lib/utils";

export interface DeviceBadgeProps {
  runtime: string;
  gpuName?: string | null;
  cpuCount?: number | null;
  memoryCapMb?: number | null;
  className?: string;
  showDetail?: boolean;
}

/**
 * Runtime badge.
 *
 * A GPU workspace label is the easiest thing in a tool like this to assert
 * falsely, so this badge shows only what the server's probe actually detected —
 * and for CPU fallback it says so in words, in the same visual weight as a GPU
 * label would get. A silently degraded workspace that LOOKS accelerated is the
 * failure mode this avoids.
 */
export function DeviceBadge({
  runtime,
  gpuName,
  cpuCount,
  memoryCapMb,
  className,
  showDetail = false,
}: DeviceBadgeProps) {
  const isGpu = runtime === "cuda" || runtime === "mps";
  const label = isGpu
    ? runtime === "cuda"
      ? (gpuName ?? "CUDA")
      : "Apple MPS"
    : "CPU fallback";

  const detail = isGpu
    ? "accelerator available"
    : [
        cpuCount ? `${cpuCount} vCPU` : null,
        memoryCapMb ? `${(memoryCapMb / 1024).toFixed(1)} GiB cap` : null,
      ]
        .filter(Boolean)
        .join(" · ");

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium tracking-wide",
        isGpu
          ? "border-success/40 bg-success/10 text-success"
          : "border-warning/40 bg-warning/10 text-warning",
        className,
      )}
      title={
        isGpu
          ? `Accelerator detected: ${gpuName ?? runtime}`
          : "No CUDA device detected — runs execute on the CPU. The CUDA image is provided for a GPU host."
      }
    >
      <span
        className={cn("h-1.5 w-1.5 rounded-full", isGpu ? "bg-success" : "bg-warning")}
        aria-hidden
      />
      {label}
      {showDetail && detail ? (
        <span className="tabular text-muted-foreground">· {detail}</span>
      ) : null}
    </span>
  );
}
