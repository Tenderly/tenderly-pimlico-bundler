#!/usr/bin/env bash
# Runs every example against the running stack and prints a summary.
#
#   docker compose --profile mock --profile policy up -d
#   ./scripts/smoke-test.sh
set -uo pipefail
cd "$(dirname "$0")/../examples"

results=()
run() {
    local name="$1"; shift
    if output=$(env "$@" 2>&1); then
        results+=("PASS  $name")
    else
        results+=("FAIL  $name")
        echo "---- $name"; echo "$output" | grep -vE "^\s+at " | tail -15
    fi
}

for ep in 0.7 0.8; do
    run "bundler-only  EP $ep" ENTRYPOINT_VERSION=$ep npm run -s bundler
    run "sponsored     EP $ep" ENTRYPOINT_VERSION=$ep npm run -s sponsored
    run "erc20         EP $ep" ENTRYPOINT_VERSION=$ep npm run -s erc20
    run "policy        EP $ep" ENTRYPOINT_VERSION=$ep npm run -s policy
done
run "eip7702       EP 0.8" npm run -s 7702
run "snapshot      EP 0.7" npm run -s snapshot

printf '%s\n' "${results[@]}"
! printf '%s\n' "${results[@]}" | grep -q FAIL
