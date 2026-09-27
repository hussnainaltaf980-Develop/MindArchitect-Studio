import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { trpc, makeTrpcClient } from "./_core/trpc";
import { AuthProvider } from "./_core/useAuth";
import App from "./App";
import "./index.css";

function Root() {
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(() => makeTrpcClient());
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
