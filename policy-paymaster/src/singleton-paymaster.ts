import {
    type Address,
    type Hex,
    type Account,
    type Chain,
    type LocalAccount,
    type PublicClient,
    type Transport,
    type WalletClient,
    concat,
    encodeAbiParameters,
    encodePacked,
    formatEther,
    getCreate2Address,
    parseAbi,
    parseAbiParameters,
    toHex
} from "viem"
import {
    type UserOperation,
    entryPoint07Address,
    entryPoint08Address,
    toPackedUserOperation
} from "viem/account-abstraction"
import { singletonPaymasterCreationCode } from "./singleton-paymaster-bytecode.ts"

export const ENTRYPOINT_VERSIONS: Record<Address, "0.7" | "0.8"> = {
    [entryPoint07Address]: "0.7",
    [entryPoint08Address]: "0.8"
}

const DETERMINISTIC_DEPLOYER: Address = "0x4e59b44847b379578588920ca78fbf26c0b4956c"
const SALT: Hex = `0x${"00".repeat(32)}`
// Mode byte: (mode << 1) | allowAllBundlers, with mode 0 = verifying.
const VERIFYING_MODE_ALL_BUNDLERS = 1
// Any well-formed 65-byte signature; only used during gas estimation.
const DUMMY_SIGNATURE: Hex =
    "0xcd91f19f0f19ce862d7bec7b7d9b95457145afc6f639c28fd0360f488937bfa41e6eedcd3a46054fd95fcd0e3ef6b0bc0a615c4d975eef55c8a3517257904d5b1c"

const paymasterAbi = parseAbi([
    "function deposit() payable",
    "function getDeposit() view returns (uint256)",
    "function getHash(uint8 mode, (address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) userOp) view returns (bytes32)"
])

// The signer key is also owner and manager of the paymaster contract. Fine
// for a Virtual Environment; in production keep the owner key offline.
const getInitCode = (entryPoint: Address, signer: Address) =>
    concat([
        singletonPaymasterCreationCode[ENTRYPOINT_VERSIONS[entryPoint]],
        encodeAbiParameters(
            parseAbiParameters(
                "address entryPoint, address owner, address manager, address[] signers"
            ),
            [entryPoint, signer, signer, [signer]]
        )
    ])

export const getPaymasterAddress = (entryPoint: Address, signer: Address) =>
    getCreate2Address({
        from: DETERMINISTIC_DEPLOYER,
        salt: SALT,
        bytecode: getInitCode(entryPoint, signer)
    })

// Deploys the paymaster for an EntryPoint (if missing) and tops up its
// EntryPoint deposit. Paid for by the signer key's wallet.
export const deployPaymaster = async ({
    publicClient,
    wallet,
    entryPoint,
    deposit
}: {
    publicClient: PublicClient
    wallet: WalletClient<Transport, Chain | undefined, Account>
    entryPoint: Address
    deposit: bigint
}) => {
    const signer = wallet.account.address
    const paymaster = getPaymasterAddress(entryPoint, signer)

    if (!(await publicClient.getCode({ address: paymaster }))) {
        const hash = await wallet.sendTransaction({
            chain: null,
            to: DETERMINISTIC_DEPLOYER,
            data: concat([SALT, getInitCode(entryPoint, signer)])
        })
        await publicClient.waitForTransactionReceipt({ hash })
    }

    const current = await publicClient.readContract({
        address: paymaster,
        abi: paymasterAbi,
        functionName: "getDeposit"
    })
    if (current < deposit) {
        const hash = await wallet.writeContract({
            chain: null,
            address: paymaster,
            abi: paymasterAbi,
            functionName: "deposit",
            value: deposit - current
        })
        await publicClient.waitForTransactionReceipt({ hash })
    }

    console.log(
        `paymaster ${ENTRYPOINT_VERSIONS[entryPoint]} ${paymaster} deposit ${formatEther(deposit > current ? deposit : current)} ETH`
    )
    return paymaster
}

export const getStubData = (paymaster: Address) => ({
    paymaster,
    paymasterData: encodePacked(
        ["uint8", "uint48", "uint48", "bytes"],
        [VERIFYING_MODE_ALL_BUNDLERS, 0, 0, DUMMY_SIGNATURE]
    ),
    paymasterVerificationGasLimit: toHex(50_000n),
    paymasterPostOpGasLimit: toHex(100_000n)
})

export const getSignedData = async ({
    publicClient,
    signer,
    paymaster,
    userOp,
    validUntil
}: {
    publicClient: PublicClient
    signer: LocalAccount
    paymaster: Address
    userOp: UserOperation<"0.7" | "0.8">
    validUntil: number
}) => {
    const paymasterData = encodePacked(
        ["uint8", "uint48", "uint48"],
        [VERIFYING_MODE_ALL_BUNDLERS, validUntil, 0]
    )

    // The paymaster signs over the packed UserOperation including its own
    // address and paymasterData (without the signature).
    const hash = await publicClient.readContract({
        address: paymaster,
        abi: paymasterAbi,
        functionName: "getHash",
        args: [0, toPackedUserOperation({ ...userOp, paymaster, paymasterData })]
    })
    const signature = await signer.signMessage({ message: { raw: hash } })

    return { paymaster, paymasterData: concat([paymasterData, signature]) }
}
