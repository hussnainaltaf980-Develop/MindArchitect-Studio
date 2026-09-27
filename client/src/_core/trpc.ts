import { createTRPCReact } from "@trpc/react-query";
import { httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "../../../server/routers";

// Typed tRPC client. `AppRouter` is a TYPE-ONLY import from the server, so the
// whole API is end-to-end typed without shipping server code to the browser.
export const trpc = createTRPCReact<AppRouter>();

export function makeTrpcClient() {
  return trpc.createClient({
    links: [httpBatchLink({ url: "/trpc", transformer: superjson })],
  });
}
