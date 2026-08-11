# Two stages so the runtime image is a base image plus one bundled file.
#
# The build stage installs dev dependencies (esbuild, TypeScript) and emits
# dist/server/index.mjs with every runtime dependency inlined, so the runtime
# stage needs no node_modules at all and no production install step.
#
# Pinned by digest so a rebuild of the same commit produces the same image.
#
# Built for linux/arm64: Fargate charges less for ARM and nothing here is
# architecture-sensitive. Build with `docker buildx build --platform
# linux/arm64` from an x86 machine.

FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS build

WORKDIR /app

# Copied first so a source-only change reuses the cached install layer.
COPY package.json ./
RUN npm install --no-audit --no-fund

# No tsconfig.json: esbuild is given its target and format explicitly, and
# the workspace base config it extends lives outside this build context.
COPY build.mjs ./
COPY src ./src
RUN node build.mjs


FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS runtime

WORKDIR /app

ENV NODE_ENV=production

# node:20-alpine ships an unprivileged `node` user; nothing here needs root.
USER node

COPY --from=build --chown=node:node /app/dist/server/index.mjs ./index.mjs

# Matches the ALB target group and the convention the genesis service on this
# cluster already uses. Overridable via PORT.
EXPOSE 5174

CMD ["node", "index.mjs"]
