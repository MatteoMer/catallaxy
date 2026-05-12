import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { bold, dim, red } from "./log";

const ROOT = process.cwd();
const AGENTS_DIR = process.env.AGENTS_DIR ?? `${ROOT}/agents`;
const DEFAULT_MAX_BYTES = 64 * 1024;

type Args = {
  all: boolean;
  agent?: string;
  key?: string;
  list: boolean;
  json: boolean;
  maxBytes: number;
};

type MemoryItem = { key: string; path: string; bytes: number; updated_at: string };
type MemoryFile = {
  key: string;
  bytes: number;
  updated_at: string;
  content?: string;
  returned_bytes?: number;
  truncated?: boolean;
};

type AgentMemory = { agent: string; memory_dir: string; files: MemoryFile[] };

function usage(): never {
  console.error(`Usage: bun orchestrator/memory.ts [agent] [key] [--all] [--list] [--json] [--max-bytes N]

Without an agent, shows memory for every agent.

Examples:
  bun orchestrator/memory.ts
  bun orchestrator/memory.ts --all --list
  bun orchestrator/memory.ts alice
  bun orchestrator/memory.ts alice core.md
  bun orchestrator/memory.ts alice --list
  bun run memory`);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let all = false;
  let list = false;
  let json = false;
  let maxBytes = DEFAULT_MAX_BYTES;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage();
    else if (arg === "--all" || arg === "-a") all = true;
    else if (arg === "--list" || arg === "-l") list = true;
    else if (arg === "--json") json = true;
    else if (arg === "--max-bytes") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 1) throw new Error("--max-bytes requires a positive number");
      maxBytes = Math.floor(n);
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (all) {
    if (positional.length > 1) throw new Error("--all accepts at most one memory key");
    return { all: true, key: positional[0], list, json, maxBytes };
  }

  if (positional.length === 0) return { all: true, list, json, maxBytes };
  if (positional.length > 2) throw new Error(`unexpected argument: ${positional[2]}`);
  return { all: false, agent: positional[0], key: positional[1], list, json, maxBytes };
}

function validKey(key: string): boolean {
  if (!key || key.startsWith("/") || key.includes("\\")) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(key)) return false;
  return !key.split("/").some((p) => !p || p === "." || p === "..");
}

async function listAgents(): Promise<string[]> {
  try {
    return (await readdir(AGENTS_DIR, { withFileTypes: true }))
      .filter((ent) => ent.isDirectory() && !ent.name.startsWith("_"))
      .map((ent) => ent.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

async function assertKnownAgent(agent: string): Promise<void> {
  const agentDir = join(AGENTS_DIR, agent);
  try {
    const st = await lstat(agentDir);
    if (st.isDirectory()) return;
  } catch {}
  throw new Error(`unknown agent: ${agent}`);
}

async function listMemory(root: string, dir = root, prefix = ""): Promise<MemoryItem[]> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }

  const out: MemoryItem[] = [];
  for (const ent of entries) {
    const key = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (!validKey(key)) continue;
    const path = join(dir, ent.name);
    let st;
    try { st = await lstat(path); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) out.push(...await listMemory(root, path, key));
    else if (st.isFile()) out.push({ key, path, bytes: st.size, updated_at: st.mtime.toISOString() });
  }
  out.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

function resolveKey(root: string, key: string): string {
  if (!validKey(key)) throw new Error("invalid memory key");
  const path = join(root, key);
  const rel = relative(root, path);
  if (!rel || rel.startsWith("..")) throw new Error("invalid memory key");
  return path;
}

async function readText(path: string, maxBytes: number): Promise<{ text: string; bytes: number; returned_bytes: number; truncated: boolean }> {
  const buf = await readFile(path);
  const sliced = buf.byteLength > maxBytes ? buf.subarray(0, maxBytes) : buf;
  return {
    text: sliced.toString("utf-8"),
    bytes: buf.byteLength,
    returned_bytes: sliced.byteLength,
    truncated: sliced.byteLength < buf.byteLength,
  };
}

function memoryRoot(agent: string): string {
  return join(AGENTS_DIR, agent, "sandbox", "memory");
}

async function memoryItems(agent: string, key?: string): Promise<{ root: string; items: MemoryItem[] }> {
  const root = memoryRoot(agent);
  const items = key
    ? [{ key, path: resolveKey(root, key), bytes: 0, updated_at: "" } as MemoryItem]
    : await listMemory(root);
  return { root, items };
}

async function collectAgentMemory(agent: string, args: Args): Promise<AgentMemory> {
  const { root, items } = await memoryItems(agent, args.key);
  const files: MemoryFile[] = [];

  for (const item of items) {
    try {
      const st = await lstat(item.path);
      if (st.isSymbolicLink() || !st.isFile()) continue;
      const content = args.list ? undefined : await readText(item.path, args.maxBytes);
      files.push({
        key: item.key,
        bytes: st.size,
        updated_at: st.mtime.toISOString(),
        ...(content ? { content: content.text, returned_bytes: content.returned_bytes, truncated: content.truncated } : {}),
      });
    } catch {}
  }

  return { agent, memory_dir: root, files };
}

async function printAgentMemory(agent: string, args: Args): Promise<void> {
  const { root, items } = await memoryItems(agent, args.key);

  console.log(bold(`${agent} memory`));
  console.log(dim(root));

  if (!items.length) {
    console.log(dim("  empty"));
    return;
  }

  for (const item of items) {
    let st;
    try { st = await lstat(item.path); } catch {
      console.log(red(`\n## ${item.key} (missing)`));
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile()) continue;
    console.log(`\n${bold(`## ${item.key}`)} ${dim(`${st.size} bytes, updated ${st.mtime.toISOString()}`)}`);
    if (args.list) continue;
    const content = await readText(item.path, args.maxBytes);
    process.stdout.write(content.text.endsWith("\n") ? content.text : `${content.text}\n`);
    if (content.truncated) {
      console.log(dim(`[truncated: returned ${content.returned_bytes}/${content.bytes} bytes; use --max-bytes to increase]`));
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.all) {
    const agents = await listAgents();
    if (args.json) {
      const memories: AgentMemory[] = [];
      for (const agent of agents) memories.push(await collectAgentMemory(agent, args));
      console.log(JSON.stringify({ agents: memories }, null, 2));
      return;
    }

    if (!agents.length) {
      console.log(bold("Agent memory"));
      console.log(dim("  no agents"));
      return;
    }

    let first = true;
    for (const agent of agents) {
      if (!first) console.log();
      await printAgentMemory(agent, args);
      first = false;
    }
    return;
  }

  await assertKnownAgent(args.agent!);

  if (args.json) {
    const memory = await collectAgentMemory(args.agent!, args);
    console.log(JSON.stringify(memory, null, 2));
    return;
  }

  await printAgentMemory(args.agent!, args);
}

main().catch((e) => {
  console.error(red(e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
