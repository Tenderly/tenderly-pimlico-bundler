import { type Address, decodeFunctionData, getAddress, parseAbi } from "viem"
import type { UserOperation } from "viem/account-abstraction"

export type Policy = {
    allowedSenders: Set<Address>
    allowedTargets: Set<Address>
    maxSpendPerSender: bigint
}

// Call encodings of the accounts used in the examples. Extend this list for
// other account implementations (Safe, Kernel, ...).
const accountAbi = parseAbi([
    "function execute(address target, uint256 value, bytes data)",
    // SimpleAccount (EntryPoint 0.7)
    "function executeBatch(address[] dest, uint256[] value, bytes[] func)",
    // SimpleAccount (EntryPoint 0.8) and Simple7702Account
    "function executeBatch((address target, uint256 value, bytes data)[] calls)"
])

const getTargets = (callData: `0x${string}`): Address[] | undefined => {
    try {
        const { functionName, args } = decodeFunctionData({
            abi: accountAbi,
            data: callData
        })
        if (functionName === "execute") return [args[0]]
        const [first] = args
        return first.map((item) =>
            typeof item === "string" ? item : item.target
        )
    } catch {
        return undefined
    }
}

// Worst case the paymaster can be charged for this UserOperation.
export const getMaxCost = (userOp: UserOperation<"0.7" | "0.8">) =>
    (userOp.preVerificationGas +
        userOp.verificationGasLimit +
        userOp.callGasLimit +
        (userOp.paymasterVerificationGasLimit ?? 0n) +
        (userOp.paymasterPostOpGasLimit ?? 0n)) *
    userOp.maxFeePerGas

// Returns why the UserOperation is rejected, or undefined if it is allowed.
export const checkPolicy = ({
    policy,
    userOp,
    spent
}: {
    policy: Policy
    userOp: UserOperation<"0.7" | "0.8">
    spent?: bigint
}): string | undefined => {
    const sender = getAddress(userOp.sender)

    if (policy.allowedSenders.size > 0 && !policy.allowedSenders.has(sender)) {
        return `sender ${sender} is not allowlisted`
    }

    if (policy.allowedTargets.size > 0) {
        const targets = getTargets(userOp.callData)
        if (!targets) return "callData format is not recognised"
        const denied = targets
            .map((target) => getAddress(target))
            .find((target) => !policy.allowedTargets.has(target))
        if (denied) return `target ${denied} is not allowlisted`
    }

    if (
        spent !== undefined &&
        spent + getMaxCost(userOp) > policy.maxSpendPerSender
    ) {
        return `sender ${sender} would exceed its sponsorship cap`
    }

    return undefined
}
