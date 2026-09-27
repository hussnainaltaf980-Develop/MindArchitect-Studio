import { StudioShell } from "@/components/studio/studio-shell";

// The studio itself. Every surface the original app exposed — Chat, Agents,
// Lab, Documents, Memory, Models, Settings — lives inside this shell.
export default function Studio() {
  return <StudioShell />;
}
