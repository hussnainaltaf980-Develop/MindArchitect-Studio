# syntax=docker/dockerfile:1
# Runtime image for a published webapp-fullstack app (DESIGN §5.7.2 / M10).
#
# Multi-stage: build the SPA (vite -> dist/public) and bundle the server
# (esbuild with packages:"external" -> dist/index.js), then a slim runtime that
# runs the single Hono process. Cloud Build builds this from the release source
# archive and pushes to Artifact Registry; Cloud Run runs it (scale-to-zero,
# container port 3000 — Cloud Run injects PORT, which the app reads via
# process.env.PORT). NODE_ENV=production makes _core/serve.ts mount the built
# SPA from ./dist/public (the one runtime fs read, resolved relative to cwd).

# ---- base: pin Node (engines >=20.19) + pnpm@11.15.1 via corepack ----
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# ---- build: full install (incl. dev deps) then produce dist/ ----
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build          # vite build -> dist/public ; esbuild -> dist/index.js

# ---- prod-deps: production-only node_modules (server bundle keeps deps external) ----
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ---- runtime: slim, non-root, single Hono process ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# package.json provides "type":"module" so the ESM dist/index.js resolves.
COPY --from=build /app/package.json ./package.json
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
# App listens on process.env.PORT (Cloud Run injects it); serve.ts reads
# ./dist/public relative to cwd (/app), so WORKDIR must be the app root.
CMD ["node", "dist/index.js"]
