// Bundle the server via esbuild's JS API (not the CLI). The CLI's bin shim can
// break under some pnpm/Node combos (native binary invoked via node); the JS
// API is the portable, recommended path for build scripts.
import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["server/_core/index.ts"],
  bundle: true,
  platform: "node",
  packages: "external", // keep node_modules external; installed at runtime
  format: "esm",
  outfile: "dist/index.js",
  logLevel: "info",
});
