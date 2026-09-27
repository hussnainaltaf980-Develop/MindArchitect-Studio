// ── AGENT-OWNED: device capability probe ────────────────────────────────────
// Reports what the environment ACTUALLY has, with the evidence it used.
//
// This exists because "GPU-supported" is the easiest thing in a training
// workspace to assert and the hardest to verify from a screenshot. A workspace
// that claims a GPU it does not have fails at the first real run, at the worst
// possible moment — after the dataset is loaded and the queue is waiting.
//
// So the probe returns EVIDENCE alongside the verdict, and the UI shows both.
// When there is no accelerator it says so plainly and labels the workspace
// "CPU fallback" rather than degrading silently.
import { readFileSync, existsSync, readdirSync } from "node:fs";

export type Runtime = "cuda" | "mps" | "cpu";

export interface DeviceInfo {
  runtime: Runtime;
  gpuName: string | null;
  vramGb: number | null;
  cpuCount: number | null;
  memoryCapMb: number | null;
  /** Where the verdict came from — every fact the probe actually observed. */
  evidence: string[];
  /** True when a CUDA device is present AND torch can use it. */
  cudaReady: boolean;
  /** One-line, user-facing statement of what this environment can do. */
  summary: string;
}

function readIfPresent(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8").trim() : null;
  } catch {
    return null;
  }
}

/**
 * Read the cgroup memory limit — the CONSTRAINT THAT ACTUALLY BINDS.
 *
 * A sandbox can report hundreds of GB from `free` while its cgroup caps the
 * process at 2 GB, so a workspace that sized itself from `free` would plan runs
 * it cannot finish. The cgroup file is the honest number.
 */
function cgroupMemoryCapMb(): number | null {
  for (const p of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    const raw = readIfPresent(p);
    if (!raw || raw === "max") continue;
    const bytes = Number(raw);
    // ignore the sentinel "unlimited" values the v1 file uses
    if (Number.isFinite(bytes) && bytes > 0 && bytes < 1e15) {
      return Math.round(bytes / 1024 / 1024);
    }
  }
  return null;
}

function countCpus(): number | null {
  try {
    const stat = readIfPresent("/proc/stat");
    if (stat) {
      const n = stat.split("\n").filter((l) => /^cpu\d+\s/.test(l)).length;
      if (n > 0) return n;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** NVIDIA driver version file — present on a real driver install, absent here. */
function nvidiaDriver(): string | null {
  const v = readIfPresent("/proc/driver/nvidia/version");
  if (!v) return null;
  const m = v.match(/Kernel Module\s+([\d.]+)/);
  return m ? m[1] : v.split("\n")[0];
}

function nvidiaDeviceNodes(): string[] {
  try {
    return readdirSync("/dev").filter((f) => f.startsWith("nvidia"));
  } catch {
    return [];
  }
}

export function probeDevice(): DeviceInfo {
  const evidence: string[] = [];

  // 1. An explicit override wins, so a real GPU box can be pinned by env
  //    without the probe having to guess.
  const declared = (process.env.MINDARCHITECT_DEVICE ?? "").toLowerCase();
  if (declared === "cuda" || declared === "mps" || declared === "cpu") {
    evidence.push(`MINDARCHITECT_DEVICE=${declared} (declared by environment)`);
  }

  // 2. The NVIDIA driver, the device nodes, and the CUDA toolkit are three
  //    INDEPENDENT signals. A container can bind-mount one without the others,
  //    which is why the verdict requires a device node and not just a version
  //    string.
  const driver = nvidiaDriver();
  const nodes = nvidiaDeviceNodes();
  const nvcc = readIfPresent("/usr/local/cuda/version.json") ? "cuda toolkit present" : null;

  if (driver) evidence.push(`NVIDIA driver ${driver} (from /proc/driver/nvidia/version)`);
  if (nodes.length) evidence.push(`CUDA device nodes: ${nodes.slice(0, 4).join(", ")}`);
  if (nvcc) evidence.push(nvcc);

  const gpuName =
    process.env.MINDARCHITECT_GPU_NAME ??
    (driver ? `NVIDIA (driver ${driver})` : null);
  const vramGb = process.env.MINDARCHITECT_VRAM_GB ? Number(process.env.MINDARCHITECT_VRAM_GB) : null;

  const cudaReady = nodes.length > 0 && (Boolean(driver) || declared === "cuda");
  const mps = process.platform === "darwin" && process.arch === "arm64";

  let runtime: Runtime = "cpu";
  if (cudaReady) runtime = "cuda";
  else if (mps) runtime = "mps";

  const cpuCount = countCpus();
  const memoryCapMb = cgroupMemoryCapMb();

  if (cpuCount) evidence.push(`${cpuCount} logical CPUs (from /proc/stat)`);
  if (memoryCapMb) {
    evidence.push(
      `memory cap ${memoryCapMb} MB (from cgroup — note this, not /proc/meminfo, is the limit that binds)`,
    );
  }
  if (!driver && !nodes.length) {
    evidence.push("no /proc/driver/nvidia/version and no /dev/nvidia* device node");
  }

  const summary =
    runtime === "cuda"
      ? `CUDA available${gpuName ? ` — ${gpuName}` : ""}. Training runs on the GPU.`
      : runtime === "mps"
        ? "Apple MPS available. Training runs on the integrated GPU."
        : "No CUDA device detected. The workspace is CUDA-READY but is running in " +
          "CPU-fallback mode: training and inference execute on the CPU, and the " +
          "Dockerfile.gpu / CUDA image build is provided for a GPU host.";

  return {
    runtime,
    gpuName: runtime === "cuda" ? gpuName : null,
    vramGb,
    cpuCount,
    memoryCapMb,
    evidence,
    cudaReady,
    summary,
  };
}
