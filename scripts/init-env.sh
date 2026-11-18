#!/usr/bin/env sh
# Creates .env with fresh throwaway keys.
#
#   ./scripts/init-env.sh <PUBLIC_RPC_URL> <ADMIN_RPC_URL> [chain-type]
#
# chain-type: default | op-stack (Base, Optimism). Use default on Arbitrum,
# see README.
set -eu
cd "$(dirname "$0")/.."

if [ -f .env ]; then
    echo ".env already exists, delete it first" >&2
    exit 1
fi

key() { echo "0x$(openssl rand -hex 32)"; }

cat > .env <<EOF
# Tenderly Virtual Environment (Dashboard > Virtual Environments > your environment)
TENDERLY_PUBLIC_RPC_URL=${1:-}
TENDERLY_ADMIN_RPC_URL=${2:-}

# Alto bundler. Throwaway keys, funded on start by the funder service.
ALTO_UTILITY_PRIVATE_KEY=$(key)
ALTO_EXECUTOR_PRIVATE_KEYS=$(key),$(key)
ALTO_CHAIN_TYPE=${3:-default}

# Policy paymaster (docker compose --profile policy)
POLICY_SIGNER_PRIVATE_KEY=$(key)
POLICY_API_KEYS=dev-$(openssl rand -hex 8)
# Only sponsor calls to these targets (empty = any). Example 05 uses this one.
POLICY_ALLOWED_TARGETS=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
POLICY_ALLOWED_SENDERS=
POLICY_MAX_SPEND_PER_SENDER_ETH=0.01
EOF

echo "Wrote .env"
