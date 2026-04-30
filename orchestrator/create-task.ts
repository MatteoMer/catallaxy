/**
 * create-task — write a task file and its private reservation in one go.
 *
 * Usage:
 *   bun orchestrator/create-task.ts \
 *     --desc "Add a Python is_palindrome function..." \
 *     --repo /Users/matteo/projects/catallaxy/repos/playground \
 *     --reservation 50000 \
 *     [--id task-002] \
 *     [--base main] \
 *     [--fee 2000] \
 *     [--deadline-min 5] \
 *     [--subjective "..."] \
 *     [--check "python3 -m unittest discover tests"] \
 *     [--posted-by operator]
 *
 * --check may be repeated for multiple deterministic command checks.
 * --id is auto-assigned (task-NNN) if omitted.
 */

import { readdir } from "node:fs/promises";
import { TaskSchema } from "./schemas";

const MARKET = process.env.MARKET_DIR ?? "./market";
const RESERVATIONS_PATH = process.env.RESERVATIONS_PATH ?? "./orchestrator/private/reservations.json";

interface Args {
  id?: string;
  desc?: string;
  repo?: string;
  base?: string;
  fee?: number;
  reservation?: number;
  subjective?: string;
  postedBy?: string;
  checks: string[];
  deadlineMin?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { checks: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    switch (flag) {
      case "--id": args.id = next; i++; break;
      case "--desc": args.desc = next; i++; break;
      case "--repo": args.repo = next; i++; break;
      case "--base": args.base = next; i++; break;
      case "--fee": args.fee = Number(next); i++; break;
      case "--reservation": args.reservation = Number(next); i++; break;
      case "--subjective": args.subjective = next; i++; break;
      case "--check": args.checks.push(next); i++; break;
      case "--deadline-min": args.deadlineMin = Number(next); i++; break;
      case "--posted-by": args.postedBy = next; i++; break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`Usage: bun orchestrator/create-task.ts --desc "..." --repo PATH --reservation N

Required:
  --desc TEXT          Task description shown to agents
  --repo PATH          Repo path or URL agents will clone/work in
  --reservation N      Buyer's max payment (private; never shown to agents)

Optional:
  --id ID              Task id (default: auto-numbered task-NNN)
  --base BRANCH        Base branch name (default: main)
  --fee N              Review fee in tokens (default: 2000)
  --deadline-min N     Minutes from now until auction settles (default: 5)
  --subjective TEXT    Subjective acceptance criteria
  --check CMD          Add a deterministic check command (repeatable)
  --posted-by NAME     Who posted the task (default: operator)`);
}

async function nextTaskId(): Promise<string> {
  let files: string[] = [];
  try {
    files = await readdir(`${MARKET}/tasks`);
  } catch {}
  let max = 0;
  for (const f of files) {
    const m = f.match(/^task-(\d+)\.json$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `task-${String(max + 1).padStart(3, "0")}`;
}

async function loadReservations(): Promise<Record<string, number>> {
  try {
    return await Bun.file(RESERVATIONS_PATH).json();
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.desc) {
    console.error("error: --desc is required");
    printHelp();
    process.exit(1);
  }
  if (!args.repo) {
    console.error("error: --repo is required");
    printHelp();
    process.exit(1);
  }
  if (args.reservation === undefined || Number.isNaN(args.reservation)) {
    console.error("error: --reservation is required (number of tokens)");
    printHelp();
    process.exit(1);
  }

  const id = args.id ?? (await nextTaskId());
  const now = new Date();
  const deadlineMin = args.deadlineMin ?? 5;
  const deadline = new Date(now.getTime() + deadlineMin * 60_000);

  const task = TaskSchema.parse({
    id,
    description: args.desc,
    repo: args.repo,
    base_branch: args.base ?? "main",
    review_fee: args.fee ?? 2000,
    deterministic_checks: args.checks.map((cmd) => ({
      type: "command" as const,
      cmd,
      must_pass: true,
    })),
    subjective_criteria: args.subjective,
    status: "open" as const,
    posted_by: args.postedBy ?? "operator",
    posted_at: now.toISOString(),
    deadline_at: deadline.toISOString(),
  });

  await Bun.write(`${MARKET}/tasks/${id}.json`, JSON.stringify(task, null, 2));

  const reservations = await loadReservations();
  reservations[id] = args.reservation;
  await Bun.write(RESERVATIONS_PATH, JSON.stringify(reservations, null, 2));

  console.log(
    `Created ${id} — deadline ${deadline.toISOString()} (${deadlineMin}min), reservation ${args.reservation}`
  );
}

if (import.meta.main) await main();
