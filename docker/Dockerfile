# syntax=docker/dockerfile:1
#
# One image recipe for every long-running Node service in the workspace.
# Parameterised by `PKG` — the directory under `packages/`:
#
#   docker compose build indexer
#   docker build --build-arg PKG=delegate -f docker/Dockerfile .
#
# Used by the development stack (`docker-compose.yml`, `indexer`) and by every
# deployment role in `deploy/` — `indexer` and `api` for a resolver operator,
# `delegate` for a delegate operator, `chat-index` for the optional NC chat
# index, `notify` for the optional notifier, and those plus `relay` for the
# service.
#
# Built from the **repository root** as context, because every service is a
# workspace member: it needs `pnpm-workspace.yaml` for the catalog, the
# lockfile, and its workspace dependencies — `@nimiqnames/core` for all of them, and
# `@nns/indexer` as well for `@nns/api`, which reads its log-level type from
# there.
#
# Deliberately not a "copy everything and run tsx" image: the container runs
# compiled `dist/`, the same artifact `pnpm build` produces locally, so what is
# tested and what is deployed are the same bytes.
#
# This replaced `packages/indexer/Dockerfile` (2026-08-17) when the operator
# kit gave the API, the delegate and the relay images of their own. Four copies
# of a build this shaped is four places to fix a pnpm flag.

# No default: an unset PKG would install the whole workspace and fail at run
# time with `Cannot find module '/app/packages/dist/main.js'`, one layer and
# several minutes away from the mistake.
ARG PKG

FROM node:24-alpine AS build
ARG PKG
RUN test -n "${PKG}" || { echo 'PKG build-arg is required: indexer | api | relay | delegate | settlement | anchor | chat-index | notify' >&2; exit 1; }

# Corepack's future is uncertain across Node majors; a pinned global install is
# the version-stable way to get the pnpm the lockfile was written by.
RUN npm install -g pnpm@11.21.0

WORKDIR /app

# Manifests first, so a source-only change does not re-resolve the dependency
# graph. The catalog lives in pnpm-workspace.yaml, so it is part of the input.
# Every member is copied — not just this service's subtree — because the
# lockfile describes all thirteen, and `--frozen-lockfile` should compare against
# the same workspace pnpm wrote it from.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/admin/package.json packages/admin/
COPY packages/anchor/package.json packages/anchor/
COPY packages/api/package.json packages/api/
COPY packages/app/package.json packages/app/
COPY packages/chat/package.json packages/chat/
COPY packages/chat-index/package.json packages/chat-index/
COPY packages/core/package.json packages/core/
COPY packages/delegate/package.json packages/delegate/
COPY packages/indexer/package.json packages/indexer/
COPY packages/notify/package.json packages/notify/
COPY packages/relay/package.json packages/relay/
COPY packages/resolver/package.json packages/resolver/
COPY packages/settlement/package.json packages/settlement/

# `--filter {./packages/<pkg>}...` — the package and its dependencies. Nothing
# else in the workspace is fetched. The filter is by **directory**, not by
# package name, because the three published packages carry a different scope
# from the nine that are not (`@nimiqnames/` vs `@nns/`, 2026-09-14) and `PKG`
# is a directory already. The braces are load-bearing: `./packages/anchor...`
# selects the package *without* its dependencies, and fails later at the build
# rather than here, where `{./packages/anchor}...` selects both.
RUN pnpm install --frozen-lockfile --filter "{./packages/${PKG}}..."

COPY packages packages

# Same filter, so the workspace dependencies build first, in topological order.
RUN pnpm --filter "{./packages/${PKG}}..." build

# Prune the build-only dependencies (typescript, vitest) in place. Re-running
# install rather than deleting keeps pnpm's symlink layout coherent, which is
# what the runtime stage copies wholesale.
#
# Going from a dev install to a `--prod` one changes the layout enough that pnpm
# rebuilds `node_modules` from scratch, and it will not remove a directory it
# did not create in this session without confirming — which it cannot do with no
# TTY, so it aborts (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY). `CI=true` is
# the documented answer. The refetch is free: pnpm's content-addressable store
# is in this stage already, so the reinstall is relinking, not downloading.
ENV CI=true
# `@nimiqnames/anchor` is the one exception, and it is a packaging fact rather than a
# deployment one: since the package is published to npm, `viem` and `solc` are
# **devDependencies** there — no module reachable from any of its three export
# subpaths imports either, only the three CLIs do, so a library consumer that
# had them installed would be carrying ~85 MB for code it can never call. But
# one of those CLIs *is* this role's entrypoint, so pruning here would leave
# the publisher unable to sign. It keeps its build tree; every other service
# runs on its production one.
RUN if [ "${PKG}" = "anchor" ]; then \
      echo 'anchor keeps its build tree: its CLIs are its runtime (viem, solc)'; \
    else \
      pnpm install --frozen-lockfile --prod --filter "{./packages/${PKG}}..."; \
    fi


FROM node:24-alpine AS runtime
ARG PKG

# One JSON object per line on stdout, which is what the log driver collects.
ENV NODE_ENV=production

WORKDIR /app

# The whole tree: pnpm's `node_modules` is a symlink farm into `.pnpm`, and
# `@nimiqnames/core` is itself a link into `packages/core`. Copying the parts
# separately would break both.
COPY --from=build --chown=node:node /app /app

USER node

# The indexer reads its migrations from disk at startup, relative to `dist/`;
# every service is run from its own package directory for the same reason.
WORKDIR /app/packages/${PKG}

# No `--env-file`: in a container the environment comes from compose. `exec`
# form, so SIGTERM reaches node — the indexer's scan loop stops between
# batches, and the HTTP services close their listener.
CMD ["node", "dist/main.js"]
