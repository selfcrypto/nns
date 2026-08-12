# syntax=docker/dockerfile:1
#
# The indexer image. Built from the **repository root** as context, because the
# package is a workspace member: it needs `pnpm-workspace.yaml` for the catalog,
# the lockfile, and `@nns/core`, which is where every protocol rule lives.
#
#   docker compose build indexer          # from the repo root
#
# Deliberately not a "copy everything and run tsx" image: the container runs
# compiled `dist/`, the same artifact `pnpm build` produces locally, so what is
# tested and what is deployed are the same bytes.

FROM node:24-alpine AS build

# Corepack's future is uncertain across Node majors; a pinned global install is
# the version-stable way to get the pnpm the lockfile was written by.
RUN npm install -g pnpm@11.21.0

WORKDIR /app

# Manifests first, so a source-only change does not re-resolve the dependency
# graph. The catalog lives in pnpm-workspace.yaml, so it is part of the input.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/indexer/package.json packages/indexer/

# `--filter @nns/indexer...` — the package and its dependencies, which is core
# and nothing else. The other six packages are not fetched at all.
RUN pnpm install --frozen-lockfile --filter @nns/indexer...

COPY packages/core packages/core
COPY packages/indexer packages/indexer

RUN pnpm --filter @nns/core build && pnpm --filter @nns/indexer build

# Prune the build-only dependencies (typescript, vitest) in place. Re-running
# install rather than deleting keeps pnpm's symlink layout coherent, which is
# what the runtime stage copies wholesale.
RUN pnpm install --frozen-lockfile --prod --filter @nns/indexer...


FROM node:24-alpine AS runtime

# One JSON object per line on stdout, which is what the log driver collects.
ENV NODE_ENV=production

WORKDIR /app

# The whole tree: pnpm's `node_modules` is a symlink farm into `.pnpm`, and
# `@nns/core` is itself a link into `packages/core`. Copying the parts
# separately would break both.
COPY --from=build --chown=node:node /app /app

USER node

# The migrations are read from disk at startup, relative to `dist/`.
WORKDIR /app/packages/indexer

# No `--env-file`: in a container the environment comes from compose. `exec`
# form, so SIGTERM reaches node and the scan loop stops between batches.
CMD ["node", "dist/main.js"]
