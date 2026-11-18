// Policy paymaster: an ERC-7677 paymaster service that signs for Pimlico's
// SingletonPaymaster with your own key, and only sponsors UserOperations the
// policy allows (API key, sender and target allowlists, per-sender cap).
//
// Reference implementation for Virtual Environments: spend is tracked in memory
// and resets on restart.
import { type IncomingMessage, createServer } from "node:http"
import {
    type Address,
    type Hex,
    createPublicClient,
    createWalletClient,
    formatEther,
    getAddress,
    hexToBigInt,
    http,
    parseEther,
    toHex
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import type { UserOperation } from "viem/account-abstraction"
import { type Policy, checkPolicy, getMaxCost } from "./policy.ts"
import {
    ENTRYPOINT_VERSIONS,
    deployPaymaster,
    getSignedData,
    getStubData
} from "./singleton-paymaster.ts"

const env = (name: string, fallback?: string): string => {
    const value = process.env[name] || fallback
    if (!value) throw new Error(`${name} is not set`)
    return value
}

const list = (value?: string) =>
    (value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)

const rpcUrl = env("RPC_URL")
const port = Number(env("PORT", "3100"))
const apiKeys = new Set(list(env("API_KEYS")))
const deposit = parseEther(env("DEPOSIT_ETH", "1"))
const validForSeconds = Number(env("VALID_FOR_SECONDS", "600"))
const policy: Policy = {
    allowedSenders: new Set(list(process.env.ALLOWED_SENDERS).map(getAddress)),
    allowedTargets: new Set(list(process.env.ALLOWED_TARGETS).map(getAddress)),
    maxSpendPerSender: parseEther(env("MAX_SPEND_PER_SENDER_ETH", "0.01"))
}

const signer = privateKeyToAccount(env("SIGNER_PRIVATE_KEY") as Hex)
// A generous timeout: a slow response while deploying on startup should not
// take the service down.
const transport = http(rpcUrl, { timeout: 60_000 })
const publicClient = createPublicClient({ transport })
const wallet = createWalletClient({ account: signer, transport })

// The signer pays for deploying the paymasters and for their deposits. The
// policy-funder job in docker-compose.yml funds it before this service starts.
const entryPoints = Object.keys(ENTRYPOINT_VERSIONS) as Address[]
const paymasters: Record<Address, Address> = {}
for (const entryPoint of entryPoints) {
    paymasters[entryPoint] = await deployPaymaster({
        publicClient,
        wallet,
        entryPoint,
        deposit
    })
}

// Cumulative worst-case cost signed for, per sender.
const spent = new Map<Address, bigint>()

class RpcError extends Error {
    code: number
    constructor(message: string, code: number) {
        super(message)
        this.code = code
    }
}

type RawUserOp = Record<string, Hex | null | undefined>

const toUserOp = (raw: RawUserOp): UserOperation<"0.7" | "0.8"> => {
    const big = (value?: Hex | null) => (value ? hexToBigInt(value) : 0n)
    return {
        sender: getAddress(raw.sender as Hex),
        nonce: big(raw.nonce),
        factory: (raw.factory ?? undefined) as Address | undefined,
        factoryData: raw.factoryData ?? undefined,
        callData: raw.callData as Hex,
        callGasLimit: big(raw.callGasLimit),
        verificationGasLimit: big(raw.verificationGasLimit),
        preVerificationGas: big(raw.preVerificationGas),
        maxFeePerGas: big(raw.maxFeePerGas),
        maxPriorityFeePerGas: big(raw.maxPriorityFeePerGas),
        paymasterVerificationGasLimit: big(raw.paymasterVerificationGasLimit),
        paymasterPostOpGasLimit: big(raw.paymasterPostOpGasLimit),
        signature: (raw.signature ?? "0x") as Hex
    }
}

// ERC-7677 params: [userOp, entryPoint, chainId, context]
const parseParams = (params: unknown) => {
    const [rawUserOp, rawEntryPoint] = (params ?? []) as [RawUserOp, Address]
    if (!rawUserOp?.sender || !rawEntryPoint) {
        throw new RpcError("expected [userOperation, entryPoint, chainId, context]", -32602)
    }
    const entryPoint = getAddress(rawEntryPoint)
    const paymaster = paymasters[entryPoint]
    if (!paymaster) throw new RpcError(`EntryPoint ${entryPoint} not supported`, -32602)
    return { userOp: toUserOp(rawUserOp), paymaster }
}

const reject = (userOp: UserOperation, reason: string): never => {
    console.log(`rejected ${userOp.sender}: ${reason}`)
    throw new RpcError(`Sponsorship denied: ${reason}`, -32003)
}

const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
    // Called before gas estimation; gas fields are not final yet, so only the
    // allowlists are checked.
    pm_getPaymasterStubData: async (params) => {
        const { userOp, paymaster } = parseParams(params)
        const reason = checkPolicy({ policy, userOp })
        if (reason) reject(userOp, reason)
        return { ...getStubData(paymaster), sponsor: { name: "Policy paymaster" }, isFinal: false }
    },

    // Called with final gas fields: check the cap, reserve the worst-case cost
    // and sign.
    pm_getPaymasterData: async (params) => {
        const { userOp, paymaster } = parseParams(params)
        const sender = userOp.sender
        const reason = checkPolicy({ policy, userOp, spent: spent.get(sender) ?? 0n })
        if (reason) reject(userOp, reason)

        // The EntryPoint checks validUntil against chain time; Alto checks it
        // against the wall clock. On a Virtual Environment the two drift apart: chain time
        // runs ahead after evm_increaseTime and behind after evm_revert (the
        // clock resumes from the snapshot). Sign from the later of the two.
        const { timestamp } = await publicClient.getBlock()
        const now = Math.max(Number(timestamp), Math.floor(Date.now() / 1000))
        const data = await getSignedData({
            publicClient,
            signer,
            paymaster,
            userOp,
            validUntil: now + validForSeconds
        })

        const total = (spent.get(sender) ?? 0n) + getMaxCost(userOp)
        spent.set(sender, total)
        console.log(
            `sponsored ${sender}: reserved ${formatEther(getMaxCost(userOp))} ETH, total ${formatEther(total)} / ${formatEther(policy.maxSpendPerSender)} ETH`
        )
        return data
    }
}

const isAuthorized = (req: IncomingMessage) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    const key = url.searchParams.get("apikey") ?? req.headers["x-api-key"]
    return typeof key === "string" && apiKeys.has(key)
}

const readBody = async (req: IncomingMessage) => {
    let body = ""
    for await (const chunk of req) body += chunk
    return JSON.parse(body)
}

createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200).end("ok")
        return
    }

    let id: unknown = null
    let response: object
    try {
        const request = await readBody(req)
        id = request.id ?? null
        if (!isAuthorized(req)) throw new RpcError("Missing or invalid API key", -32001)
        const handler = handlers[request.method]
        if (!handler) throw new RpcError(`Method ${request.method} not supported`, -32601)
        response = { jsonrpc: "2.0", id, result: await handler(request.params) }
    } catch (error) {
        const { message, code } =
            error instanceof RpcError ? error : { message: String(error), code: -32603 }
        response = { jsonrpc: "2.0", id, error: { code, message } }
    }

    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify(response, (_, value) => (typeof value === "bigint" ? toHex(value) : value)))
}).listen(port, "0.0.0.0", () => {
    console.log(`policy paymaster on :${port}, signer ${signer.address}`)
})
