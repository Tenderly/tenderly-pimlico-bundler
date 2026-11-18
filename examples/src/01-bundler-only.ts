// Bundler only: a SimpleAccount pays for its own gas.
//
//   ENTRYPOINT_VERSION=0.8 npm run bundler   # default 0.7
import { createSmartAccountClient } from "permissionless"
import { toSimpleSmartAccount } from "permissionless/accounts"
import { createPimlicoClient } from "permissionless/clients/pimlico"
import { formatEther, http, parseEther } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import {
    BUNDLER_URL,
    RECIPIENT,
    chain,
    entryPoint,
    faucet,
    logReceipt,
    publicClient
} from "./vnet.ts"

const account = await toSimpleSmartAccount({
    client: publicClient,
    owner: privateKeyToAccount(generatePrivateKey()),
    entryPoint
})
console.log(`Chain ${chain.id}, EntryPoint ${entryPoint.version}`)
console.log(`Smart account: ${account.address}`)

// The account is counterfactual; fund its address so it can pay for its
// deployment and the call.
await faucet(account.address, parseEther("0.01"))

const bundler = createPimlicoClient({
    chain,
    transport: http(BUNDLER_URL),
    entryPoint
})

const smartAccountClient = createSmartAccountClient({
    account,
    chain,
    bundlerTransport: http(BUNDLER_URL),
    userOperation: {
        estimateFeesPerGas: async () =>
            (await bundler.getUserOperationGasPrice()).fast
    }
})

const userOpHash = await smartAccountClient.sendUserOperation({
    calls: [{ to: RECIPIENT, value: parseEther("0.001") }]
})
logReceipt(
    await smartAccountClient.waitForUserOperationReceipt({ hash: userOpHash })
)

const balance = await publicClient.getBalance({ address: account.address })
console.log(`Account balance after: ${formatEther(balance)} ETH`)
