// Sponsored: the mock verifying paymaster pays for gas. The account never
// holds ETH.
//
//   docker compose --profile mock up -d
//   ENTRYPOINT_VERSION=0.8 npm run sponsored   # default 0.7
import { createSmartAccountClient } from "permissionless"
import { toSimpleSmartAccount } from "permissionless/accounts"
import { createPimlicoClient } from "permissionless/clients/pimlico"
import { http } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import {
    BUNDLER_URL,
    MOCK_PAYMASTER_URL,
    RECIPIENT,
    chain,
    entryPoint,
    logReceipt,
    publicClient
} from "./vnet.ts"

const account = await toSimpleSmartAccount({
    client: publicClient,
    owner: privateKeyToAccount(generatePrivateKey()),
    entryPoint
})
console.log(`Chain ${chain.id}, EntryPoint ${entryPoint.version}`)
console.log(`Smart account: ${account.address} (0 ETH)`)

// ERC-7677: pm_getPaymasterStubData during estimation, pm_getPaymasterData
// for the final signature.
const paymaster = createPimlicoClient({
    chain,
    transport: http(MOCK_PAYMASTER_URL),
    entryPoint
})
const bundler = createPimlicoClient({
    chain,
    transport: http(BUNDLER_URL),
    entryPoint
})

const smartAccountClient = createSmartAccountClient({
    account,
    chain,
    bundlerTransport: http(BUNDLER_URL),
    paymaster,
    userOperation: {
        estimateFeesPerGas: async () =>
            (await bundler.getUserOperationGasPrice()).fast
    }
})

const userOpHash = await smartAccountClient.sendUserOperation({
    calls: [{ to: RECIPIENT, value: 0n, data: "0x1234" }]
})
const receipt = await smartAccountClient.waitForUserOperationReceipt({
    hash: userOpHash
})
logReceipt(receipt)
console.log(`  paymaster:     ${receipt.paymaster}`)

const balance = await publicClient.getBalance({ address: account.address })
console.log(`Account balance after: ${balance} wei`)
