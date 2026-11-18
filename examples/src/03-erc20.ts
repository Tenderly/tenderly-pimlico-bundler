// ERC-20 gas payment: the account pays the mock paymaster in a test token
// instead of ETH.
//
//   docker compose --profile mock up -d
//   ENTRYPOINT_VERSION=0.8 npm run erc20   # default 0.7
import { createSmartAccountClient } from "permissionless"
import { toSimpleSmartAccount } from "permissionless/accounts"
import { createPimlicoClient } from "permissionless/clients/pimlico"
import { prepareUserOperationForErc20Paymaster } from "permissionless/experimental/pimlico"
import { type Address, erc20Abi, formatEther, http, parseAbi, parseEther } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import {
    BUNDLER_URL,
    MOCK_PAYMASTER_URL,
    RECIPIENT,
    chain,
    entryPoint,
    getUnlockedWallet,
    logReceipt,
    publicClient
} from "./vnet.ts"

// TestERC20 that the mock paymaster deploys with CREATE2 on boot. It is the
// only token the mock paymaster quotes, and anyone can mint it.
const TOKEN: Address = "0x68e13372AE8FAaDDaf32cC08ee44C5ef5A002c69"
// Where the mock paymaster's postOp sends the collected tokens.
const TREASURY: Address = "0xD8Baa107006C93a030d1455A2eF43261b384F21c"
const sudoMintAbi = parseAbi(["function sudoMint(address to, uint256 amount)"])

if (!(await publicClient.getCode({ address: TOKEN }))) {
    throw new Error("Test token not found. Start the mock paymaster first.")
}

const tokenBalance = (owner: Address) =>
    publicClient.readContract({
        address: TOKEN,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner]
    })

const wallet = await getUnlockedWallet()
const mint = async (to: Address, amount: bigint) =>
    publicClient.waitForTransactionReceipt({
        hash: await wallet.writeContract({
            address: TOKEN,
            abi: sudoMintAbi,
            functionName: "sudoMint",
            args: [to, amount]
        })
    })

// Alto measures postOp gas with 1 wei fees, where the token charge rounds to
// zero. With real fees the charge is non-zero, and the first transfer into an
// empty treasury costs about 22,600 gas more than the zero-value transfer
// Alto measured, mostly for initializing the treasury's balance slot. postOp
// runs out of gas (AA50, TransferFromFailed). Once the treasury holds a
// balance the difference is about 5,700 gas, which fits in Alto's margin.
if ((await tokenBalance(TREASURY)) === 0n) {
    await mint(TREASURY, 1n)
}

const account = await toSimpleSmartAccount({
    client: publicClient,
    owner: privateKeyToAccount(generatePrivateKey()),
    entryPoint
})
console.log(`Chain ${chain.id}, EntryPoint ${entryPoint.version}`)
console.log(`Smart account: ${account.address} (0 ETH)`)

// Mint test tokens to the counterfactual account from a pre-funded account.
await mint(account.address, parseEther("100"))
const before = await tokenBalance(account.address)
console.log(`Token balance before: ${formatEther(before)}`)

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
            (await bundler.getUserOperationGasPrice()).fast,
        // Fetches pimlico_getTokenQuotes and prepends the token approve() call.
        prepareUserOperation: prepareUserOperationForErc20Paymaster(paymaster)
    }
})

const userOpHash = await smartAccountClient.sendUserOperation({
    calls: [{ to: RECIPIENT, value: 0n, data: "0x1234" }],
    paymasterContext: { token: TOKEN }
})
logReceipt(
    await smartAccountClient.waitForUserOperationReceipt({ hash: userOpHash })
)

const after = await tokenBalance(account.address)
const eth = await publicClient.getBalance({ address: account.address })
console.log(`Token balance after:  ${formatEther(after)} (paid ${formatEther(before - after)})`)
console.log(`ETH balance after:    ${eth} wei`)
