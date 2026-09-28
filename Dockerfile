# syntax = docker/dockerfile:1

# Builds client/ (Vite) and server/ (Express) and assembles a minimal
# production tree: server/dist + its production node_modules (via
# `pnpm deploy`), client/dist served as static files, and README.md for
# /readme/ (spec/README.md says what's checked). The app serves HTTP on
# 0.0.0.0:$PORT (fly.toml sets PORT).

FROM node:24-alpine AS base
RUN corepack enable

FROM base AS build
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY client/package.json client/package.json
COPY server/package.json server/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter client run build
RUN pnpm --filter server run build
RUN pnpm --filter server deploy --prod --legacy /out/server
RUN mkdir -p /out/client && cp -r client/dist /out/client/dist
RUN cp README.md /out/README.md

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out/server ./server
COPY --from=build /out/client ./client
COPY --from=build /out/README.md ./README.md
EXPOSE 8080
ENV PORT=8080
# The only path that survives a restart or redeploy is the Fly volume at
# /data (see fly.toml); CI stands in a throwaway tmpfs at the same path.
ENV DATABASE_PATH=/data/echo-room.sqlite
CMD ["node", "server/dist/index.js"]
