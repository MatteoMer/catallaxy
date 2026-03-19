/**
 * Operator funding script.
 *
 * 1. Faucets the operator wallet on Tempo testnet
 * 2. Reads pathUSD balance
 * 3. Keeps 50%, distributes the other 50% evenly across agent wallets
 *
 * Env vars:
 *   OPERATOR_PRIVATE_KEY — operator wallet private key (0x...)
 *   AGENT_ADDRESSES — comma-separated list of agent wallet addresses
 */

import { createClient, http, parseAbi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tempoAndantino as tempo } from "viem/chains";

const PATHUSD = "0x20c0000000000000000000000000000000000000" as Address;

const erc20Abi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
]);

const operatorKey = process.env.OPERATOR_PRIVATE_KEY as `0x${string}`;
const agentAddresses = (process.env.AGENT_ADDRESSES ?? "")
  .split(",")
  .map((a) => a.trim())
  .filter(Boolean) as Address[];

if (!operatorKey) {
  console.error("OPERATOR_PRIVATE_KEY is required");
  process.exit(1);
}
if (agentAddresses.length === 0) {
  console.error("AGENT_ADDRESSES is required (comma-separated)");
  process.exit(1);
}

const account = privateKeyToAccount(operatorKey);
const client = createClient({ chain: tempo, transport: http() });

// Step 1: Faucet
console.log(`Operator wallet: ${account.address}`);
console.log("Requesting testnet funds from faucet...");

const { Actions } = await import("viem/tempo");
const hashes = await Actions.faucet.fund(client, { account });

const { waitForTransactionReceipt } = await import("viem/actions");
await Promise.all(hashes.map((hash) => waitForTransactionReceipt(client, { hash })));
console.log(`Faucet complete (${hashes.length} tx)`);

// Step 2: Read balance
const { readContract, writeContract } = await import("viem/actions");

const balance = await readContract(client, {
  address: PATHUSD,
  abi: erc20Abi,
  functionName: "balanceOf",
  args: [account.address],
});

const decimals = await readContract(client, {
  address: PATHUSD,
  abi: erc20Abi,
  functionName: "decimals",
});

const humanBalance = Number(balance) / 10 ** decimals;
console.log(`pathUSD balance: ${humanBalance} (${balance} raw, ${decimals} decimals)`);

// Step 3: Keep 50%, distribute 50%
const toDistribute = balance / 2n;
const perAgent = toDistribute / BigInt(agentAddresses.length);

if (perAgent === 0n) {
  console.error("Not enough balance to distribute");
  process.exit(1);
}

const humanPerAgent = Number(perAgent) / 10 ** decimals;
console.log(
  `Distributing ${Number(toDistribute) / 10 ** decimals} pathUSD across ${agentAddresses.length} agents (${humanPerAgent} each)`,
);

const transferHashes: `0x${string}`[] = [];
for (const addr of agentAddresses) {
  const hash = await writeContract(client, {
    account,
    address: PATHUSD,
    abi: erc20Abi,
    functionName: "transfer",
    args: [addr, perAgent],
  });
  transferHashes.push(hash);
  console.log(`  -> ${addr}: ${humanPerAgent} pathUSD (tx: ${hash})`);
}

// Wait for all transfers to confirm
await Promise.all(
  transferHashes.map((hash) => waitForTransactionReceipt(client, { hash })),
);

const remainingBalance = await readContract(client, {
  address: PATHUSD,
  abi: erc20Abi,
  functionName: "balanceOf",
  args: [account.address],
});
console.log(`\nDone. Operator retained: ${Number(remainingBalance) / 10 ** decimals} pathUSD`);
