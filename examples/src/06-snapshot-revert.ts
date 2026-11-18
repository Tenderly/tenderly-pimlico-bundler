// Snapshot / revert: reset the Virtual Environment between test runs.
//
//   npm run snapshot        # evm_snapshot / evm_revert on the Admin RPC
//
// Alto tracks submitted bundles, pending account deployments and recent
// receipts (60 s cache) in memory. After evm_revert that state describes
// blocks that no longer exist, which shows up as AA10 "Another deployment
// operation for this sender is already being processed", UserOperations that
// never confirm, or receipts for reverted UserOperations.
// debug_bundler_clearState only clears the mempool, so restart Alto after
// every revert.
//
// The chain clock resumes from the snapshot's timestamp after evm_revert, so
// chain time falls behind the wall clock by the time each run took.
//
// Take snapshots after `docker compose up`: Alto's simulation contracts and
// the paymasters are deployed on startup and would disappear on revert.
import { execSync } from "node:child_process"
import { createSmartAccountClient } from "permissionless"
import { toSimpleSmartAccount } from "permissionless/accounts"
import { createPimlicoClient } from "permissionless/clients/pimlico"
import { type Hex, createClient, http, parseEther, rpcSchema } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import {
    BUNDLER_URL,
    RECIPIENT,
    chain,
    entryPoint,
    env,
    faucet,
    publicClient
} from "./vnet.ts"

const admin = createClient({
    transport: http(env("TENDERLY_ADMIN_RPC_URL")),
    rpcSchema: rpcSchema<
        [
            { Method: "evm_snapshot"; Parameters?: undefined; ReturnType: Hex },
            { Method: "evm_revert"; Parameters: [Hex]; ReturnType: boolean }
        ]
    >()
})
const bundler = createPimlicoClient({
    chain,
    transport: http(BUNDLER_URL),
    entryPoint
})

const snapshot = () => admin.request({ method: "evm_snapshot" })
const revert = (id: Hex) => admin.request({ method: "evm_revert", params: [id] })

// Restarts Alto in the Compose project of the repository root. `docker compose
// restart` does nothing when it finds no container, so check first.
const restartAlto = async () => {
    const container = execSync("docker compose ps -q alto", { cwd: "..", encoding: "utf8" }).trim()
    if (!container) {
        throw new Error(
            "No running alto container in this Compose project. If you started the stack with -p <name>, set COMPOSE_PROJECT_NAME=<name>."
        )
    }
    execSync("docker compose restart alto", { cwd: "..", stdio: "ignore" })
    for (let i = 0; i < 60; i++) {
        const ok = await fetch(`${BUNDLER_URL}/health`).then((r) => r.ok, () => false)
        if (ok) return
        await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    throw new Error("Alto did not come back")
}

// The same owner key, so every run uses the same counterfactual account.
const owner = privateKeyToAccount(generatePrivateKey())

const runTest = async () => {
    const account = await toSimpleSmartAccount({ client: publicClient, owner, entryPoint })
    const smartAccountClient = createSmartAccountClient({
        account,
        chain,
        bundlerTransport: http(BUNDLER_URL),
        userOperation: {
            estimateFeesPerGas: async () =>
                (await bundler.getUserOperationGasPrice()).fast
        }
    })

    await faucet(account.address, parseEther("0.01"))
    const hash = await smartAccountClient.sendUserOperation({
        calls: [{ to: RECIPIENT, value: parseEther("0.001") }]
    })
    const receipt = await smartAccountClient.waitForUserOperationReceipt({ hash })
    console.log(`   ${account.address} userOp ${hash.slice(0, 10)}… success ${receipt.success}, block ${receipt.receipt.blockNumber}`)
    return hash
}

let id = await snapshot()
console.log(`Snapshot at block ${await publicClient.getBlockNumber()}`)

for (let run = 1; run <= 3; run++) {
    console.log(`\nRun ${run}`)
    const hash = await runTest()

    await revert(id)
    id = await snapshot()
    await restartAlto()

    const stale = await bundler.getUserOperationReceipt({ hash }).catch(() => null)
    console.log(`   reverted to block ${await publicClient.getBlockNumber()}, Alto restarted, receipt for reverted op: ${stale === null ? "gone" : "still cached"}`)
}
