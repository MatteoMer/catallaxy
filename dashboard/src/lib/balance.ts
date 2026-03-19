import { createClient, http, parseAbi, type Address } from "viem";
import { tempoAndantino } from "viem/chains";

const PATHUSD = "0x20c0000000000000000000000000000000000000" as Address;

const erc20Abi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

const client = createClient({ chain: tempoAndantino, transport: http() });

let cachedDecimals: number | null = null;

async function getDecimals(): Promise<number> {
  if (cachedDecimals !== null) return cachedDecimals;
  const { readContract } = await import("viem/actions");
  cachedDecimals = await readContract(client, {
    address: PATHUSD,
    abi: erc20Abi,
    functionName: "decimals",
  });
  return cachedDecimals;
}

export async function fetchBalance(walletAddress: string): Promise<string> {
  const { readContract } = await import("viem/actions");
  const [balance, decimals] = await Promise.all([
    readContract(client, {
      address: PATHUSD,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [walletAddress as Address],
    }),
    getDecimals(),
  ]);
  const human = Number(balance) / 10 ** decimals;
  return human.toFixed(2);
}

export async function fetchAllBalances(
  addresses: Record<string, string>
): Promise<Record<string, string>> {
  const entries = Object.entries(addresses);
  const results = await Promise.all(
    entries.map(async ([id, addr]) => {
      try {
        const bal = await fetchBalance(addr);
        return [id, bal] as const;
      } catch {
        return [id, "—"] as const;
      }
    })
  );
  return Object.fromEntries(results);
}
