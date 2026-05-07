import { mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export interface DemandPlan {
  demandId?: string;
  title: string;
  goal: string;
  repo?: string;
  baseBranch?: string;
  filesToWrite: string[];
  testFiles: string[];
  deterministicChecks: string[];
  reviewerPrompt: string;
  implementationPrompt: string;
  reservation?: number;
  reviewFee?: number;
  deadlineMin?: number;
}

export interface DemandPlanRecord extends Required<Omit<DemandPlan, "demandId" | "repo" | "baseBranch" | "reservation" | "reviewFee" | "deadlineMin">> {
  demandId: string;
  /** Original user repo. Never mutated by the interface after approval. */
  originalRepo: string;
  /** Isolated test-base worktree handed to Catallaxy agents. */
  repo: string;
  baseBranch: string;
  reservation: number;
  reviewFee: number;
  deadlineMin: number;
  createdAt: string;
}

export interface LaunchResult {
  taskId: string;
  taskPath: string;
  reservationPath: string;
  demandId: string;
  repo: string;
  baseBranch: string;
}

export function catallaxyRoot(cwd: string): string {
  return resolve(process.env.CATALLAXY_ROOT ?? cwd);
}

export function userRepo(cwd: string): string {
  return resolve(process.env.CATALLAXY_USER_REPO ?? defaultRepo(cwd));
}

export function slug(input: string): string {
  const out = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return out || "demand";
}

function hashString(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function refSlug(input: string): string {
  return slug(input).replace(/\.+/g, "-").replace(/^-+|-+$/g, "") || "demand";
}

export function demandDir(root: string, demandId: string): string {
  return resolve(root, ".catallaxy", "demands", demandId);
}

export function defaultRepo(cwd: string): string {
  const playground = resolve(cwd, "repos", "playground");
  return existsSync(playground) ? playground : cwd;
}

export function worktreePath(root: string, originalRepo: string, demandId: string): string {
  const repoLabel = `${hashString(originalRepo)}-${slug(basename(originalRepo))}`;
  return resolve(root, "orchestrator", "private", "user-worktrees", repoLabel, demandId);
}

export function demandBranch(demandId: string): string {
  return `catallaxy/demand/${refSlug(demandId)}/tests`;
}

export function normalizePlan(root: string, plan: DemandPlan): DemandPlanRecord {
  const now = new Date().toISOString();
  const demandId = plan.demandId?.trim() || `${now.slice(0, 10)}-${slug(plan.title)}`;
  const originalRepo = resolve(plan.repo ? resolve(root, plan.repo) : userRepo(root));
  const filesToWrite = [...new Set(plan.filesToWrite.map((f) => f.trim()).filter(Boolean))];
  const testFiles = [...new Set(plan.testFiles.map((f) => f.trim()).filter(Boolean))];
  const deterministicChecks = [...new Set(plan.deterministicChecks.map((c) => c.trim()).filter(Boolean))];
  if (!plan.title.trim()) throw new Error("title is required");
  if (!plan.goal.trim()) throw new Error("goal is required");
  if (testFiles.length === 0) throw new Error("at least one test file is required");
  if (deterministicChecks.length === 0) throw new Error("at least one deterministic check is required");
  if (!plan.reviewerPrompt.trim()) throw new Error("reviewerPrompt is required");
  if (!plan.implementationPrompt.trim()) throw new Error("implementationPrompt is required");
  return {
    demandId,
    title: plan.title.trim(),
    goal: plan.goal.trim(),
    originalRepo,
    repo: worktreePath(root, originalRepo, demandId),
    baseBranch: plan.baseBranch ?? demandBranch(demandId),
    filesToWrite,
    testFiles,
    deterministicChecks,
    reviewerPrompt: plan.reviewerPrompt.trim(),
    implementationPrompt: plan.implementationPrompt.trim(),
    reservation: plan.reservation ?? 500_000,
    reviewFee: plan.reviewFee ?? 2_000,
    deadlineMin: plan.deadlineMin ?? 7,
    createdAt: now,
  };
}

async function git(args: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

async function requireGitRepo(path: string): Promise<string> {
  const r = await git(["rev-parse", "--show-toplevel"], path);
  if (r.code !== 0) throw new Error(`not a git repository: ${path}`);
  return r.out.trim();
}

async function requireCleanRepo(path: string): Promise<void> {
  const r = await git(["status", "--porcelain"], path);
  if (r.code !== 0) throw new Error(`git status failed in ${path}: ${r.err || r.out}`);
  if (r.out.trim()) throw new Error(`user repo has uncommitted changes; commit/stash them before launching Catallaxy:\n${r.out.trim()}`);
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repo)).code === 0;
}

export async function prepareDemandWorktree(root: string, plan: DemandPlanRecord): Promise<DemandPlanRecord> {
  const originalRepo = await requireGitRepo(plan.originalRepo);
  await requireCleanRepo(originalRepo);
  const nextPlan = {
    ...plan,
    originalRepo,
    repo: worktreePath(root, originalRepo, plan.demandId),
    baseBranch: plan.baseBranch || demandBranch(plan.demandId),
  };

  if (existsSync(`${nextPlan.repo}/.git`)) return nextPlan;

  await mkdir(dirname(nextPlan.repo), { recursive: true });
  const addArgs = await branchExists(originalRepo, nextPlan.baseBranch)
    ? ["worktree", "add", nextPlan.repo, nextPlan.baseBranch]
    : ["worktree", "add", "-b", nextPlan.baseBranch, nextPlan.repo, "HEAD"];
  const r = await git(addArgs, originalRepo);
  if (r.code !== 0) throw new Error(`git worktree add failed: ${r.err || r.out}`);
  return nextPlan;
}

export async function saveDemandPlan(root: string, record: DemandPlanRecord): Promise<DemandPlanRecord> {
  const dir = demandDir(root, record.demandId);
  await mkdir(dir, { recursive: true });
  await Bun.write(`${dir}/plan.json`, JSON.stringify(record, null, 2));
  await Bun.write(`${dir}/plan.md`, renderPlanMarkdown(record));
  return record;
}

export async function writeDemandPlan(root: string, plan: DemandPlan): Promise<DemandPlanRecord> {
  return saveDemandPlan(root, normalizePlan(root, plan));
}

export async function loadDemandPlan(root: string, demandId: string): Promise<DemandPlanRecord> {
  return await Bun.file(`${demandDir(root, demandId)}/plan.json`).json();
}

export function renderPlanMarkdown(plan: DemandPlanRecord): string {
  const lines: string[] = [];
  lines.push(`# ${plan.title}`);
  lines.push("");
  lines.push(`Demand: ${plan.demandId}`);
  lines.push(`Original repo: ${plan.originalRepo}`);
  lines.push(`Catallaxy test worktree: ${plan.repo}`);
  lines.push(`Base branch: ${plan.baseBranch}`);
  lines.push("");
  lines.push("## Goal");
  lines.push(plan.goal);
  lines.push("");
  lines.push("## Files to write before auction");
  for (const f of plan.filesToWrite) lines.push(`- ${f}`);
  lines.push("");
  lines.push("## Test files");
  for (const f of plan.testFiles) lines.push(`- ${f}`);
  lines.push("");
  lines.push("## Deterministic checks");
  for (const c of plan.deterministicChecks) lines.push(`- \`${c}\``);
  lines.push("");
  lines.push("## Reviewer prompt");
  lines.push(plan.reviewerPrompt);
  lines.push("");
  lines.push("## Implementation prompt for Catallaxy agents");
  lines.push(plan.implementationPrompt);
  lines.push("");
  lines.push("## Economics");
  lines.push(`Reservation: ${plan.reservation}`);
  lines.push(`Review fee: ${plan.reviewFee}`);
  lines.push(`Auction deadline: ${plan.deadlineMin} minutes`);
  lines.push("");
  return lines.join("\n");
}

export function missingFiles(cwd: string, files: string[]): string[] {
  return files.filter((f) => !existsSync(resolve(cwd, f)));
}

async function listJson(dir: string): Promise<string[]> {
  try { return (await readdir(dir)).filter((f) => f.endsWith(".json")); } catch { return []; }
}

export async function nextTaskId(root: string): Promise<string> {
  let max = 0;
  for (const f of await listJson(resolve(root, "market", "tasks"))) {
    const m = /^task-(\d+)\.json$/.exec(f);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `task-${String(max + 1).padStart(3, "0")}`;
}

async function loadReservations(path: string): Promise<Record<string, number>> {
  try { return await Bun.file(path).json(); } catch { return {}; }
}

export async function commitDemandWorktree(plan: DemandPlanRecord): Promise<boolean> {
  const files = [...new Set([...plan.testFiles, ...plan.filesToWrite])];
  const add = await git(["add", "--", ...files], plan.repo);
  if (add.code !== 0) throw new Error(`git add failed in demand worktree: ${add.err || add.out}`);
  const status = await git(["status", "--porcelain", "--", ...files], plan.repo);
  if (status.code !== 0) throw new Error(`git status failed in demand worktree: ${status.err || status.out}`);
  if (!status.out.trim()) return false;
  const commit = await git(["commit", "-m", `catallaxy: add tests for ${plan.demandId}`], plan.repo);
  if (commit.code !== 0) throw new Error(`git commit failed in demand worktree: ${commit.err || commit.out}`);
  return true;
}

export async function createMarketTask(root: string, plan: DemandPlanRecord): Promise<LaunchResult> {
  const missing = missingFiles(plan.repo, [...plan.testFiles, ...plan.filesToWrite]);
  if (missing.length > 0) throw new Error(`refusing to launch; missing planned files: ${missing.join(", ")}`);
  await commitDemandWorktree(plan);

  const taskId = await nextTaskId(root);
  const now = new Date();
  const taskPath = resolve(root, "market", "tasks", `${taskId}.json`);
  const reservationPath = resolve(root, "orchestrator", "private", "reservations.json");
  await mkdir(dirname(taskPath), { recursive: true });
  await mkdir(dirname(reservationPath), { recursive: true });

  const task = {
    id: taskId,
    description: [
      `[demand:${plan.demandId}] ${plan.title}`,
      "",
      plan.implementationPrompt,
      "",
      "Goal:",
      plan.goal,
      "",
      "Tests/files supplied by the buyer on base branch:",
      ...[...plan.testFiles, ...plan.filesToWrite].map((f) => `- ${f}`),
    ].join("\n"),
    repo: plan.repo,
    base_branch: plan.baseBranch,
    review_fee: plan.reviewFee,
    deterministic_checks: plan.deterministicChecks.map((cmd) => ({ type: "command", cmd, must_pass: true })),
    subjective_criteria: plan.reviewerPrompt,
    status: "open",
    posted_by: "catallaxy-interface",
    posted_at: now.toISOString(),
    deadline_at: new Date(now.getTime() + plan.deadlineMin * 60_000).toISOString(),
  };

  await Bun.write(taskPath, JSON.stringify(task, null, 2));
  const reservations = await loadReservations(reservationPath);
  reservations[taskId] = plan.reservation;
  await Bun.write(reservationPath, JSON.stringify(reservations, null, 2));
  return { taskId, taskPath, reservationPath, demandId: plan.demandId, repo: plan.repo, baseBranch: plan.baseBranch };
}
