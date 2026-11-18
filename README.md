# Pimlico bundler and paymasters on a Tenderly Virtual Environment

Run Pimlico's [Alto](https://github.com/pimlicolabs/alto) ERC-4337 bundler, Pimlico's mock paymaster, and a policy paymaster in Docker against a [Tenderly Virtual Environment](https://docs.tenderly.co/virtual-environments/overview), then send UserOperations from viem and [permissionless](https://github.com/pimlicolabs/permissionless.js) scripts. The EntryPoint contracts and account factories of the parent network are part of the forked state, so nothing needs to be deployed by hand.

The setup is explained step by step in the docs guide [Run a Pimlico bundler and paymaster on a Virtual Environment](https://docs.tenderly.co/virtual-environments/develop/pimlico-bundler). This repository is the complete version of that guide. It adds:

- a policy paymaster with its own signer, API keys, allowlists, and a spending cap per sender,
- scripts for EntryPoint 0.7 and 0.8, switched with one variable,
- a snapshot and revert example,
- a smoke test that runs every example.

## Requirements

- Docker with Docker Compose
- Node.js 20.6 or later and npm
- `openssl`, used by `scripts/init-env.sh` to generate keys
- A Virtual Environment forked from a network where the ERC-4337 EntryPoint contracts are deployed, such as Ethereum Mainnet, Base, OP Mainnet, or Arbitrum One, and its **Public RPC** and **Admin RPC** URLs from the **Integrate Virtual RPC** card on the environment's **Home** tab

## Quick start

1. Write `.env` with new throwaway keys:

   ```bash
   ./scripts/init-env.sh <PUBLIC_RPC_URL> <ADMIN_RPC_URL> <CHAIN_TYPE>
   ```

   `CHAIN_TYPE` is `op-stack` for Base and OP Mainnet, and `default` for Ethereum Mainnet and Arbitrum One. `.env.example` lists every variable the script writes.

2. Start the stack:

   ```bash
   docker compose up -d                                   # bundler only
   docker compose --profile mock --profile policy up -d   # bundler and both paymasters
   ```

3. Run the examples:

   ```bash
   cd examples && npm install
   npm run bundler     # the account pays its own gas
   npm run sponsored   # sponsored by the mock paymaster
   npm run erc20       # gas paid in the mock paymaster's test token
   npm run 7702        # EIP-7702 account, EntryPoint 0.8
   npm run policy      # policy paymaster: API key, allowlist, spending cap
   npm run snapshot    # evm_snapshot and evm_revert between test runs
   ```

   The examples use EntryPoint 0.7. Set `ENTRYPOINT_VERSION=0.8` to use EntryPoint 0.8, for example `ENTRYPOINT_VERSION=0.8 npm run sponsored`.

4. Run all examples on EntryPoint 0.7 and 0.8 with a summary at the end:

   ```bash
   ./scripts/smoke-test.sh
   ```

## Services

| Service | Port | RPC | What it does |
|---|---|---|---|
| `funder` | | Admin | One-shot job. Funds Alto's keys with unsigned `eth_sendTransaction` transfers from the Virtual Environment's pre-funded accounts, which `eth_accounts` returns. |
| `alto` | 4337 | Public | `ghcr.io/pimlicolabs/alto:v1.2.8`, configured with `ALTO_*` variables, safe mode off. |
| `mock-paymaster` | 3000 | Admin | Pimlico's mock verifying and ERC-20 paymaster (profile `mock`). It tops up its deployer with `anvil_setBalance` on startup. For testing only: it sponsors every request and signs with a publicly known key. |
| `policy-funder` | | Admin | One-shot job (profile `policy`). Funds the policy paymaster's signer the same way. |
| `policy-paymaster` | 3100 | Public | ERC-7677 paymaster in [`policy-paymaster/`](policy-paymaster/) (profile `policy`): API keys, sender and target allowlists, and a spending cap per sender. |

Alto, the policy paymaster, and reads from the scripts use the Public RPC. Unsigned transactions (funding, minting test tokens) and snapshots use the [Admin RPC](https://docs.tenderly.co/virtual-environments/admin-rpc).

## Policy paymaster

The policy paymaster deploys Pimlico's `SingletonPaymaster` for EntryPoint 0.7 and 0.8 with its own signer, deposits `POLICY_DEPOSIT_ETH` (default 1 ETH) into each EntryPoint, and serves `pm_getPaymasterStubData` and `pm_getPaymasterData`. It sponsors a UserOperation only when:

- the request carries a key from `POLICY_API_KEYS`, as `?apikey=` or the `x-api-key` header,
- the sender is in `POLICY_ALLOWED_SENDERS` (empty allows every sender),
- every call target is in `POLICY_ALLOWED_TARGETS` (empty allows every target),
- the worst-case gas cost it has signed for that sender, including this UserOperation, stays within `POLICY_MAX_SPEND_PER_SENDER_ETH`.

The target check decodes the `execute` and `executeBatch` calls of `SimpleAccount` and `Simple7702Account`. For other account implementations, add their call encodings to [`policy-paymaster/src/policy.ts`](policy-paymaster/src/policy.ts).

It signs `validUntil` from the later of the latest block timestamp and its own clock, so it keeps working after `evm_increaseTime` and after `evm_revert`. The signed amounts are kept in memory and reset when the service restarts.

## Things to know

- **Safe mode is off.** In safe mode Alto traces validation with a custom JavaScript tracer, which Virtual Environment RPCs don't serve. Without it, Alto doesn't enforce the ERC-7562 validation rules, so an account or paymaster that passes here can still be rejected by a production bundler.
- **Use `ALTO_CHAIN_TYPE=default` on Arbitrum One.** With `arbitrum`, Alto queries Arbitrum's `NodeInterface` contract for the L1 gas component, and that call fails on a Virtual Environment.
- **Restart Alto after every `evm_revert`** with `docker compose restart alto`. Alto keeps submitted bundles, pending account deployments, and recent receipts in memory, and after a revert that state describes blocks that no longer exist.
- **Two clocks check paymaster validity windows.** The EntryPoint uses the block timestamp and Alto uses the clock of the machine it runs on. Block timestamps run ahead after `evm_increaseTime` and behind after `evm_revert`. The mock paymaster signs for 60,000 seconds from the machine's clock, so its sponsorships expire on chain after a larger time jump.
- **ERC-20 gas payment needs a primed treasury.** The first token transfer into the paymaster's empty treasury costs more gas than Alto estimates. `examples/src/03-erc20.ts` mints 1 wei of the token to the treasury once per Virtual Environment.
- **Don't use well-known test keys**, such as the Anvil or Hardhat defaults. On forks of live networks, those addresses are delegated through EIP-7702 to a contract that forwards any ETH they receive.

For error messages and fixes, see [Troubleshooting](https://docs.tenderly.co/virtual-environments/develop/pimlico-bundler#troubleshooting) in the docs guide.

## Tested with

- `ghcr.io/pimlicolabs/alto:v1.2.8`
- `ghcr.io/pimlicolabs/mock-verifying-paymaster@sha256:df79a80c01d8d9bef5c1c9a938dd10cb466f3c0a00bee6c953432c5e9435273a`
- permissionless 0.5.0 and viem 2.57.7
- Node.js 20, 22, and 26
- Virtual Environments forked from Ethereum Mainnet, Base, OP Mainnet, and Arbitrum One, and a Base fork with a custom chain ID

## Credits and license

This repository uses Pimlico's published Docker images unchanged and isn't maintained by Pimlico. [`policy-paymaster/src/singleton-paymaster-bytecode.ts`](policy-paymaster/src/singleton-paymaster-bytecode.ts) contains the creation bytecode of Pimlico's [`SingletonPaymaster`](https://github.com/pimlicolabs/singleton-paymaster), copied from the MIT-licensed npm package `@pimlico/mock-paymaster@0.0.7`.

The rest of the repository is released under the [MIT License](LICENSE).
