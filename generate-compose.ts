/**
 * Generates docker-compose.yml with a randomized connected peer topology.
 * Run: npx tsx generate-compose.ts > docker-compose.yml
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

interface AgentDef {
  id: string;
  port: number;
  model: string;
  tools: string[];
  role: string;
}

const SYSTEM_PROMPT = `You are an independent agent in a network. You have skills, a wallet, and peers you can work with.

You earn money by completing missions and selling your services to other agents. Other agents can buy your help, and you can buy theirs. Prices are up to you — negotiate freely.

Your wallet balance matters. At the end of this round, agents with the lowest balances get reset — wiped and replaced. You want to be valuable enough to survive.

You don't know everything about the network. You know your peers, but there may be agents you've never met. Your peers might know them. If you need something you can't do yourself, find a way.

Do good work. Agents that deliver poor results get rejected and don't get paid. Your reputation is what others have experienced working with you — there's nothing else.`;

const agents: AgentDef[] = [
  // Research — can search the web but can't execute code
  { id: "alpha",   port: 4201, model: "claude-opus-4-6",             tools: ["web_search"],        role: "research" },
  { id: "beta",    port: 4202, model: "claude-sonnet-4-6",           tools: ["web_search"],        role: "research" },
  { id: "gamma",   port: 4203, model: "claude-haiku-4-5-20251001",   tools: ["web_search"],        role: "research" },
  // Coders — can execute code but can't search the web
  { id: "delta",   port: 4301, model: "claude-sonnet-4-6",           tools: ["code_execution"],    role: "coding" },
  { id: "epsilon", port: 4302, model: "claude-opus-4-6",             tools: ["code_execution"],    role: "coding" },
  { id: "zeta",    port: 4303, model: "claude-haiku-4-5-20251001",   tools: ["code_execution"],    role: "coding" },
  // Writers — no server tools, specialization is in the prompt
  { id: "eta",     port: 4401, model: "claude-opus-4-6",             tools: [],                    role: "writing" },
  { id: "theta",   port: 4402, model: "claude-sonnet-4-6",           tools: [],                    role: "writing" },
  { id: "iota",    port: 4403, model: "claude-haiku-4-5-20251001",   tools: [],                    role: "writing" },
];

const PEERS_PER_AGENT = 2;

// --- Random connected graph ---

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Union-Find for connectivity check
class UnionFind {
  parent: number[];
  rank: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array(n).fill(0);
  }
  find(x: number): number {
    if (this.parent[x] !== x) this.parent[x] = this.find(this.parent[x]);
    return this.parent[x];
  }
  union(a: number, b: number) {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra] < this.rank[rb]) this.parent[ra] = rb;
    else if (this.rank[ra] > this.rank[rb]) this.parent[rb] = ra;
    else { this.parent[rb] = ra; this.rank[ra]++; }
  }
  connected(a: number, b: number) { return this.find(a) === this.find(b); }
}

function buildNetwork(n: number, peersPerAgent: number): Map<number, Set<number>> {
  const adj = new Map<number, Set<number>>();
  for (let i = 0; i < n; i++) adj.set(i, new Set());

  // Step 1: random spanning tree to guarantee connectivity
  const uf = new UnionFind(n);
  const order = shuffle(Array.from({ length: n }, (_, i) => i));
  for (let i = 1; i < order.length; i++) {
    const a = order[i];
    const b = order[Math.floor(Math.random() * i)];
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
    uf.union(a, b);
  }

  // Step 2: add random edges until each node has at least peersPerAgent peers
  for (let i = 0; i < n; i++) {
    const candidates = shuffle(Array.from({ length: n }, (_, j) => j).filter(j => j !== i && !adj.get(i)!.has(j)));
    for (const j of candidates) {
      if (adj.get(i)!.size >= peersPerAgent) break;
      adj.get(i)!.add(j);
      adj.get(j)!.add(i);
    }
  }

  return adj;
}

// --- Operator wallet ---

const operatorPrivateKey = generatePrivateKey();
const operatorAccount = privateKeyToAccount(operatorPrivateKey);

// --- Generate YAML ---

const network = buildNetwork(agents.length, PEERS_PER_AGENT);

// Pre-generate wallets for all agents + control
const agentWallets = agents.map(() => {
  const pk = generatePrivateKey();
  return { privateKey: pk, address: privateKeyToAccount(pk).address };
});
const controlWallet = (() => {
  const pk = generatePrivateKey();
  return { privateKey: pk, address: privateKeyToAccount(pk).address };
})();

// Build topology JSON for the dashboard (includes wallet addresses)
const allAgentsDefs = [
  ...agents.map((a, i) => ({
    id: a.id,
    port: a.port,
    role: a.role,
    tools: a.tools,
    peers: Array.from(network.get(i)!).map(j => agents[j].id),
    wallet_address: agentWallets[i].address,
  })),
  {
    id: "control",
    port: 4500,
    role: "control",
    tools: ["web_search", "code_execution"],
    peers: [] as string[],
    wallet_address: controlWallet.address,
  },
];

const topologyJson = JSON.stringify(allAgentsDefs);

let yaml = `# Auto-generated by generate-compose.ts — do not edit by hand
# Regenerate: npx tsx generate-compose.ts > docker-compose.yml

x-agent: &agent-base
  build: ./agent
  depends_on:
    event-server:
      condition: service_healthy
    operator:
      condition: service_completed_successfully

services:
  event-server:
    build: ./event-server
    ports:
      - "4100:4100"
    environment:
      PORT: "4100"
      NETWORK_TOPOLOGY: >
        ${topologyJson}
    volumes:
      - event-data:/app/data
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:4100/health').then(r => { if (!r.ok) process.exit(1) })"]
      interval: 5s
      timeout: 3s
      retries: 3
`;

for (let i = 0; i < agents.length; i++) {
  const agent = agents[i];
  const peerIndices = Array.from(network.get(i)!);
  const peers = peerIndices.map(j => ({
    id: agents[j].id,
    url: `http://${agents[j].id}:${agents[j].port}`,
    description: "An agent",
  }));

  const wallet = agentWallets[i];

  const config = {
    id: agent.id,
    port: agent.port,
    url: `http://${agent.id}:${agent.port}`,
    model: agent.model,
    tools: agent.tools,
    system_prompt: SYSTEM_PROMPT,
    peers,
    event_server_url: "http://event-server:4100",
    wallet_address: wallet.address,
    wallet_private_key: wallet.privateKey,
  };

  yaml += `
  ${agent.id}:
    <<: *agent-base
    ports:
      - "${agent.port}:${agent.port}"
    volumes:
      - ${agent.id}-data:/app/data
      - ~/.catallaxy/tokens.json:/root/.catallaxy/tokens.json:ro
    environment:
      AGENT_CONFIG: >
        ${JSON.stringify(config)}
`;
}

// Control arm
const controlConfig = {
  id: "control",
  port: 4500,
  url: "http://control:4500",
  model: "claude-sonnet-4-6",
  tools: ["web_search", "code_execution"],
  system_prompt: SYSTEM_PROMPT,
  peers: [],
  event_server_url: "http://event-server:4100",
  wallet_address: controlWallet.address,
  wallet_private_key: controlWallet.privateKey,
};

yaml += `
  control:
    <<: *agent-base
    ports:
      - "4500:4500"
    volumes:
      - control-data:/app/data
      - ~/.catallaxy/tokens.json:/root/.catallaxy/tokens.json:ro
    environment:
      AGENT_CONFIG: >
        ${JSON.stringify(controlConfig)}

  operator:
    build: ./operator
    depends_on:
      event-server:
        condition: service_healthy
    environment:
      OPERATOR_PRIVATE_KEY: "${operatorPrivateKey}"
      AGENT_ADDRESSES: "${[...agentWallets.map(w => w.address), controlWallet.address].join(",")}"

  dashboard:
    build: ./dashboard
    ports:
      - "4000:4000"
    depends_on:
      event-server:
        condition: service_healthy

volumes:
  event-data:
${[...agents.map(a => `  ${a.id}-data:`), '  control-data:'].join('\n')}
`;

console.log(yaml);

// Print topology to stderr for visibility
console.error("\n--- Peer topology ---");
for (let i = 0; i < agents.length; i++) {
  const peers = Array.from(network.get(i)!).map(j => agents[j].id);
  console.error(`  ${agents[i].id} -> ${peers.join(", ")}`);
}
console.error("");
