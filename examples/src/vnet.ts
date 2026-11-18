import {
    type Address,
    type Chain,
    createPublicClient,
    createWalletClient,
    defineChain,
    formatEther,
    http
} from "viem"
import {
    entryPoint07Address,
    entryPoint08Address
} from "viem/account-abstraction"
import * as chains from "viem/chains"

export const env = (name: string, fallback?: string): string => {
    const value = process.env[name] || fallback
    if (!value) throw new Error(`${name} is not set (see ../.env)`)
    return value
}

export const PUBLIC_RPC_URL = env("TENDERLY_PUBLIC_RPC_URL")
export const BUNDLER_URL = env(
    "BUNDLER_URL",
    `http://localhost:${process.env.ALTO_PORT || 4337}`
)
export const MOCK_PAYMASTER_URL = env(
    "MOCK_PAYMASTER_URL",
    `http://localhost:${process.env.MOCK_PAYMASTER_PORT || 3000}`
)
export const POLICY_PAYMASTER_URL = env(
    "POLICY_PAYMASTER_URL",
    `http://localhost:${process.env.POLICY_PAYMASTER_PORT || 3100}`
)

export const RECIPIENT: Address = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"

export const ENTRYPOINTS = {
    "0.7": { address: entryPoint07Address, version: "0.7" },
    "0.8": { address: entryPoint08Address, version: "0.8" }
} as const

export const entryPoint =
    ENTRYPOINTS[(process.env.ENTRYPOINT_VERSION as "0.7" | "0.8") || "0.7"]

// If the Virtual Environment keeps its parent network's chain ID, reuse viem's
// definition of that network (it carries chain-specific formatters such as
// OP-stack deposit transactions). With a custom chain ID, define a plain chain.
const getChain = async (): Promise<Chain> => {
    const id = await createPublicClient({
        transport: http(PUBLIC_RPC_URL)
    }).getChainId()
    const parent =
        Object.values(chains).find((chain) => chain.id === id) ??
        defineChain({
            id,
            name: `Virtual Environment ${id}`,
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: { default: { http: [PUBLIC_RPC_URL] } }
        })
    return { ...parent, rpcUrls: { default: { http: [PUBLIC_RPC_URL] } } }
}

export const chain = await getChain()

export const publicClient = createPublicClient({
    chain,
    transport: http(PUBLIC_RPC_URL)
})

// A wallet client for one of the Virtual Environment's pre-funded accounts.
// viem sends plain eth_sendTransaction for JSON-RPC accounts, and the Admin
// RPC accepts those unsigned, so no balance cheatcodes are needed.
export const getUnlockedWallet = async () => {
    const transport = http(env("TENDERLY_ADMIN_RPC_URL"))
    const [account] = await createWalletClient({ chain, transport }).getAddresses()
    if (!account) throw new Error("eth_accounts returned no pre-funded accounts")
    return createWalletClient({ account, chain, transport })
}

export const faucet = async (to: Address, value: bigint) => {
    const wallet = await getUnlockedWallet()
    const hash = await wallet.sendTransaction({ to, value })
    await publicClient.waitForTransactionReceipt({ hash })
    console.log(`Faucet: sent ${formatEther(value)} ETH to ${to}`)
}

export const logReceipt = (receipt: {
    success: boolean
    userOpHash: string
    actualGasCost: bigint
    receipt: { transactionHash: string; blockNumber: bigint }
}) => {
    console.log(`UserOp ${receipt.userOpHash}`)
    console.log(`  success:       ${receipt.success}`)
    console.log(`  bundle tx:     ${receipt.receipt.transactionHash}`)
    console.log(`  block:         ${receipt.receipt.blockNumber}`)
    console.log(`  gas cost:      ${formatEther(receipt.actualGasCost)} ETH`)
    if (!receipt.success) process.exitCode = 1
}
