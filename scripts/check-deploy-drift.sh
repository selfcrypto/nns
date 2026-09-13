#!/usr/bin/env bash
# deploy/collaborator duplicates four service definitions verbatim from
# deploy/resolver and deploy/delegate — deliberately, because compose
# `include:` resolves paths and `.env` against the *included* file's directory,
# the opposite of the one-directory-one-.env rule that deploy/README.md is built
# on. Duplication needs a leash: this renders both sides with
# `config --no-interpolate` (so no .env is needed) and demands byte equality per
# service. Editing a copied service in its source role means re-copying it here
# in the same change; this is what makes forgetting impossible rather than
# merely inadvisable.
#
#   bash scripts/check-deploy-drift.sh      # exits 1 and prints the diff
set -uo pipefail

deploy=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../deploy" && pwd)

block() { # block <compose-file> <service>
  docker compose -f "$1" config --no-interpolate 2>/dev/null |
    awk -v svc="$2" '
      $0 == "services:"             { inside = 1; next }
      inside && $0 ~ "^  " svc ":$" { grab = 1; next }
      grab && $0 ~ /^  [^ ]/        { exit }
      grab && $0 ~ /^[^ ]/          { exit }
      grab                          { print }'
}

fail=0
while read -r svc copy src; do
  [ -n "$svc" ] || continue
  if ! diff -u <(block "$deploy/$src" "$svc") <(block "$deploy/$copy" "$svc") >/dev/null; then
    echo "DRIFT: $copy service '$svc' no longer matches $src" >&2
    diff -u <(block "$deploy/$src" "$svc") <(block "$deploy/$copy" "$svc") | sed -n '4,14p' >&2
    fail=1
  fi
done <<'PAIRS'
postgres collaborator/docker-compose.yml resolver/docker-compose.yml
indexer collaborator/docker-compose.yml resolver/docker-compose.yml
api collaborator/docker-compose.yml resolver/docker-compose.yml
delegate collaborator/docker-compose.yml delegate/docker-compose.yml
PAIRS

if [ "$fail" -ne 0 ]; then
  echo 'collaborator has drifted from its source roles — re-copy the service, or change the source too' >&2
  exit 1
fi
echo 'deploy/collaborator matches its source roles.'
