// Tops up accounts with ETH from the Virtual Environment's pre-funded accounts.
//
// Every Tenderly Virtual Environment starts with funded accounts, which
// eth_accounts returns. The Admin RPC accepts unsigned eth_sendTransaction
// requests, so a plain transfer from one of them is all it takes.
//
//   RPC_URL            Admin RPC URL of the Virtual Environment
//   FUND_PRIVATE_KEYS  comma-separated private keys whose addresses get funded
//   FUND_ADDRESSES     comma-separated extra addresses (optional)
//   FUND_AMOUNT_ETH    balance each address is topped up to (default 10)
//
// Runs inside the Alto image to reuse the viem copy bundled there.
import { createPublicClient, formatEther, http, parseEther, toHex } from "viem"
import { privateKeyToAccount } from "viem/accounts"

const list = (value) =>
    (value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)

if (!process.env.RPC_URL) throw new Error("RPC_URL is not set")
const client = createPublicClient({ transport: http(process.env.RPC_URL, { timeout: 60_000 }) })
const amount = parseEther(process.env.FUND_AMOUNT_ETH || "10")
const targets = [
    ...list(process.env.FUND_PRIVATE_KEYS).map((key) => privateKeyToAccount(key).address),
    ...list(process.env.FUND_ADDRESSES)
]

// The pre-funded account that currently holds the most ETH.
const richestAccount = async () => {
    const accounts = await client.request({ method: "eth_accounts" })
    if (accounts.length === 0) throw new Error("eth_accounts returned no pre-funded accounts")
    const balances = await Promise.all(accounts.map((address) => client.getBalance({ address })))
    const index = balances.indexOf(balances.reduce((a, b) => (a > b ? a : b)))
    return { address: accounts[index], balance: balances[index] }
}

for (const to of targets) {
    const balance = await client.getBalance({ address: to })
    if (balance >= amount) {
        console.log(`ok      ${to} ${formatEther(balance)} ETH`)
        continue
    }

    const value = amount - balance
    const from = await richestAccount()
    if (from.balance < value) throw new Error(`No pre-funded account holds ${formatEther(value)} ETH`)

    const hash = await client.request({
        method: "eth_sendTransaction",
        params: [{ from: from.address, to, value: toHex(value) }]
    })
    const receipt = await client.waitForTransactionReceipt({ hash })
    if (receipt.status !== "success") throw new Error(`Funding ${to} reverted (${hash})`)
    console.log(`funded  ${to} ${formatEther(amount)} ETH (${hash})`)
}
