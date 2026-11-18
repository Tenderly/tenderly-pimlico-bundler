// Policy paymaster: sponsorship only for what the policy allows.
//
//   docker compose --profile policy up -d
//   ENTRYPOINT_VERSION=0.8 npm run policy   # default 0.7
//
// Expects the defaults written by scripts/init-env.sh:
// POLICY_ALLOWED_TARGETS=<RECIPIENT> and POLICY_MAX_SPEND_PER_SENDER_ETH.
import { createSmartAccountClient } from "permissionless"
import { toSimpleSmartAccount } from "permissionless/accounts"
import { createPimlicoClient } from "permissionless/clients/pimlico"
import { type Address, BaseError, http, parseEther } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import {
    BUNDLER_URL,
    POLICY_PAYMASTER_URL,
    RECIPIENT,
    chain,
    entryPoint,
    env,
    logReceipt,
    publicClient
} from "./vnet.ts"

const apiKey = env("POLICY_API_KEYS").split(",")[0]
const cap = parseEther(env("POLICY_MAX_SPEND_PER_SENDER_ETH", "0.01"))
const OTHER_TARGET: Address = "0x000000000000000000000000000000000000dEaD"

const account = await toSimpleSmartAccount({
    client: publicClient,
    owner: privateKeyToAccount(generatePrivateKey()),
    entryPoint
})
console.log(`Chain ${chain.id}, EntryPoint ${entryPoint.version}`)
console.log(`Smart account: ${account.address} (0 ETH)`)

const bundler = createPimlicoClient({
    chain,
    transport: http(BUNDLER_URL),
    entryPoint
})

const clientWith = (key: string) =>
    createSmartAccountClient({
        account,
        chain,
        bundlerTransport: http(BUNDLER_URL),
        paymaster: createPimlicoClient({
            chain,
            transport: http(`${POLICY_PAYMASTER_URL}?apikey=${key}`),
            entryPoint
        }),
        userOperation: {
            estimateFeesPerGas: async () =>
                (await bundler.getUserOperationGasPrice()).fast
        }
    })

const expectRejection = async (label: string, send: () => Promise<unknown>) => {
    try {
        await send()
        console.log(`${label}: unexpectedly sponsored`)
        process.exitCode = 1
    } catch (error) {
        const message =
            error instanceof BaseError ? error.walk().message : String(error)
        console.log(`${label}: rejected -> ${message.split("\n")[0]}`)
    }
}

const client = clientWith(apiKey)

console.log("\n1. Call to an allowlisted target")
logReceipt(
    await client.waitForUserOperationReceipt({
        hash: await client.sendUserOperation({
            calls: [{ to: RECIPIENT, value: 0n, data: "0x1234" }]
        })
    })
)

console.log("\n2. Call to a target outside the allowlist")
await expectRejection("   result", () =>
    client.sendUserOperation({
        calls: [{ to: OTHER_TARGET, value: 0n, data: "0x" }]
    })
)

console.log("\n3. Wrong API key")
await expectRejection("   result", () =>
    clientWith("wrong-key").sendUserOperation({
        calls: [{ to: RECIPIENT, value: 0n, data: "0x1234" }]
    })
)

// The paymaster reserves gas limits x maxFeePerGas per UserOperation. A high
// fee cap (the bundle still pays the much lower effective price) makes each
// reservation a large share of the per-sender cap, so it is hit within a few
// operations.
console.log("\n4. Per-sender cap")
const { maxPriorityFeePerGas } = (await bundler.getUserOperationGasPrice()).fast
const maxFeePerGas = (cap * 2n) / 5n / 1_000_000n
for (let i = 1; i <= 10; i++) {
    try {
        const hash = await client.sendUserOperation({
            calls: [{ to: RECIPIENT, value: 0n, data: "0x1234" }],
            maxFeePerGas,
            maxPriorityFeePerGas
        })
        await client.waitForUserOperationReceipt({ hash })
        console.log(`   op ${i}: sponsored`)
    } catch (error) {
        const message =
            error instanceof BaseError ? error.walk().message : String(error)
        console.log(`   op ${i}: rejected -> ${message.split("\n")[0]}`)
        break
    }
}
