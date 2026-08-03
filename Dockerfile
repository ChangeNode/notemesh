# Build stage
# trixie (not bookworm): better-sqlite3 v13's linux prebuilds need glibc >= 2.38.
FROM node:22-trixie-slim AS build
WORKDIR /app
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# Runtime stage
FROM node:22-trixie-slim
WORKDIR /app
# The ob CLI is spawned as a child process (not bundled by the server build),
# so install it globally in the runtime image. Keep the version pinned in
# lockstep with package.json.
# git + git-lfs are for the git sync backend. LFS matters even though ob-sync
# never writes binaries: cloning an LFS-backed vault without it yields ~130-byte
# pointer files in place of every attachment, which contain no NUL bytes and so
# read as text — the server would hand those to a model as if they were images.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git git-lfs ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && git lfs install --system
RUN npm install -g obsidian-headless@0.0.14
COPY --from=build /app/.output ./.output
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
