// EIP-7702: a plain EOA delegates to Simple7702Account and sends a sponsored
// UserOperation through EntryPoint 0.8. The EOA never holds ETH.
//
//   docker compose --profile mock up -d
//   npm run 7702
import { createSmartAccountClient } from "permissionless"
import { to7702SimpleSmartAccount } from "permissionless/accounts"
import { createPimlicoClient } from "permissionless/clients/pimlico"
import { type Address, http } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import {
    BUNDLER_URL,
    ENTRYPOINTS,
    MOCK_PAYMASTER_URL,
    RECIPIENT,
    chain,
    logReceipt,
    publicClient
} from "./vnet.ts"

// Simple7702Account implementation, deployed at the same address on every
// chain that has EntryPoint 0.8 (and therefore on forks of them).
const SIMPLE_7702_ACCOUNT: Address = "0xe6Cae83BdE06E4c305530e199D7217f42808555B"
const entryPoint = ENTRYPOINTS["0.8"]

const owner = privateKeyToAccount(generatePrivateKey())
const account = await to7702SimpleSmartAccount({ client: publicClient, owner })
console.log(`Chain ${chain.id}, EntryPoint ${entryPoint.version}`)
console.log(`EOA / smart account: ${account.address} (0 ETH)`)

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

// The first UserOperation carries the EIP-7702 authorization; Alto includes it
// in a type-4 bundle transaction.
const authorization = await owner.signAuthorization({
    address: SIMPLE_7702_ACCOUNT,
    chainId: chain.id,
    nonce: await publicClient.getTransactionCount({ address: owner.address })
})

const first = await smartAccountClient.sendUserOperation({
    calls: [{ to: RECIPIENT, value: 0n, data: "0x1234" }],
    authorization
})
const receipt = await smartAccountClient.waitForUserOperationReceipt({
    hash: first
})
logReceipt(receipt)

const bundleTx = await publicClient.getTransaction({
    hash: receipt.receipt.transactionHash
})
console.log(`  bundle tx type: ${bundleTx.type}`)

const code = await publicClient.getCode({ address: owner.address })
console.log(`EOA code: ${code} (0xef0100 + delegate)`)

// Once delegated, later UserOperations need no authorization.
const second = await smartAccountClient.sendUserOperation({
    calls: [{ to: RECIPIENT, value: 0n, data: "0x5678" }]
})
logReceipt(await smartAccountClient.waitForUserOperationReceipt({ hash: second }))
