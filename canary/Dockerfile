# Multi-stage build: compile TypeScript in a builder image, then copy the
# compiled JS + production node_modules into a slim runtime image.
#
# Runtime: node:20-alpine (smallest well-supported LTS). If you need native
# addons later (unlikely here), switch to node:20-bookworm-slim.

FROM node:20-alpine AS builder
WORKDIR /app

# Enable pnpm via corepack (no global install) so lockfiles stay reproducible.
RUN corepack enable

# Workspace root — copy just enough to install before the full source tree
# so Docker layer caching can reuse deps on source-only changes.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json turbo.json ./
COPY scripts/package.json ./scripts/package.json
COPY canary/package.json ./canary/package.json

RUN pnpm install --frozen-lockfile

# Now pull in actual source.
COPY scripts ./scripts
COPY canary ./canary

# Build both workspaces (scripts first because canary depends on it).
RUN pnpm --filter @glooai/scripts build \
 && pnpm --filter @glooai/canary build

# Prune devDependencies for the runtime image. `--legacy` is required on
# pnpm v10+ when workspace deps aren't injected (we use workspace:* links,
# not injected deps).
RUN pnpm --filter @glooai/canary deploy --prod --legacy /runtime

# ---

FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Copy the pruned workspace bundle. `pnpm deploy` flattens workspace deps so
# node_modules resolves without needing the full monorepo at runtime.
COPY --from=builder /runtime ./

# Cloud Run Jobs doesn't use PORT — this is a one-shot batch process.
# CANARY_MODE is injected per-job by Terraform (probe vs digest).
CMD ["node", "dist/index.js"]
