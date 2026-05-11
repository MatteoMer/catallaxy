import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, resolve } from "node:path";

type Task = {
  id: string;
  description: string;
  repo: string;
  base_branch: string;
  review_fee: number;
  deterministic_checks: Array<{ type: "command"; cmd: string; must_pass: boolean } | { type: "files_untouched"; paths: string[] }>;
  subjective_criteria?: string;
  status: "open" | "assigned" | "completed" | "expired";
  posted_by: string;
  posted_at: string;
  deadline_at: string;
};

type ReviewRequest = { task_id: string; agent: string; branch: string; seq: number; requested_at: string };
type ReviewResponse = { task_id: string; agent: string; seq: number; verdict: "lgtm" | "needs_work"; feedback: string; reviewed_at: string };

export const CAMPAIGN_DEADLINE_MIN = 6;

function parseTask(data: any): Task {
  if (!data || typeof data !== "object") throw new Error("invalid task");
  if (!["open", "assigned", "completed", "expired"].includes(data.status)) throw new Error("invalid task status");
  return {
    id: String(data.id),
    description: String(data.description),
    repo: String(data.repo),
    base_branch: String(data.base_branch ?? "main"),
    review_fee: Number(data.review_fee),
    deterministic_checks: Array.isArray(data.deterministic_checks) ? data.deterministic_checks : [],
    subjective_criteria: data.subjective_criteria === undefined ? undefined : String(data.subjective_criteria),
    status: data.status,
    posted_by: String(data.posted_by),
    posted_at: String(data.posted_at),
    deadline_at: String(data.deadline_at),
  };
}

function parseReviewRequest(data: any): ReviewRequest {
  if (!data || typeof data !== "object") throw new Error("invalid review request");
  return {
    task_id: String(data.task_id),
    agent: String(data.agent),
    branch: String(data.branch),
    seq: Number(data.seq),
    requested_at: String(data.requested_at),
  };
}

function parseReviewResponse(data: any): ReviewResponse {
  if (!data || typeof data !== "object") throw new Error("invalid review response");
  if (data.verdict !== "lgtm" && data.verdict !== "needs_work") throw new Error("invalid review verdict");
  return {
    task_id: String(data.task_id),
    agent: String(data.agent),
    seq: Number(data.seq),
    verdict: data.verdict,
    feedback: String(data.feedback),
    reviewed_at: String(data.reviewed_at),
  };
}

export interface CampaignCheckpointPlan {
  id?: string;
  title: string;
  goal: string;
  filesToWrite: string[];
  testFiles: string[];
  deterministicChecks: string[];
  reviewerPrompt: string;
  implementationPrompt: string;
  reservation?: number;
  reviewFee?: number;
}

export interface CampaignPlan {
  campaignId?: string;
  title: string;
  goal: string;
  repo?: string;
  baseBranch?: string;
  checkpoints: CampaignCheckpointPlan[];
  reservation?: number;
  reviewFee?: number;
}

export interface CampaignCheckpointRecord extends Required<Omit<CampaignCheckpointPlan, "id" | "reservation" | "reviewFee">> {
  id: string;
  index: number;
  reservation: number;
  reviewFee: number;
  deadlineMin: number;
}

export interface CampaignPlanRecord {
  campaignId: string;
  title: string;
  goal: string;
  /** Original user repo. Not mutated during planning/checkpoint execution; completion publishes here via ff-only merge when safe. */
  originalRepo: string;
  /** Branch that was checked out in the original repo when the campaign worktree was created. */
  originalBranch?: string;
  /** Commit that the campaign branch forked from. */
  originalHead?: string;
  /** Canonical campaign worktree. Checkpoint tests are committed here one checkpoint at a time. */
  repo: string;
  /** Branch in the campaign worktree containing accepted work plus the current checkpoint tests. */
  baseBranch: string;
  checkpoints: CampaignCheckpointRecord[];
  createdAt: string;
}

export interface CampaignState {
  campaignId: string;
  status: "draft" | "launched" | "completed";
  nextCheckpoint: number;
  currentTask?: string;
  appliedCheckpoints: string[];
  completedTasks: string[];
  retries: Record<string, number>;
  launchedAt?: string;
  completedAt?: string;
  publish?: {
    status: "published" | "failed";
    targetRepo: string;
    targetBranch?: string;
    commit?: string;
    error?: string;
    at: string;
  };
  updatedAt: string;
}

export interface LaunchResult {
  taskId: string;
  taskPath: string;
  reservationPath: string;
  campaignId: string;
  checkpointId: string;
  checkpointIndex: number;
  repo: string;
  baseBranch: string;
}

export interface AdvanceResult {
  posted: string[];
  reposted: string[];
  merged: string[];
  completedCampaigns: string[];
  publishedCampaigns: string[];
  publishFailed: Array<{ campaignId: string; error: string }>;
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
  return out || "campaign";
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
  return slug(input).replace(/\.+/g, "-").replace(/^-+|-+$/g, "") || "campaign";
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function cleanRepoRelativePath(path: string): string {
  const p = path.trim().replace(/^@/, "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!p) throw new Error("planned file path cannot be empty");
  if (p.startsWith("/") || p.split("/").includes("..")) {
    throw new Error(`planned file path must be repo-relative: ${path}`);
  }
  return p;
}

export function campaignDir(root: string, campaignId: string): string {
  return resolve(root, ".catallaxy", "campaigns", campaignId);
}

export function campaignStagingDir(root: string, campaignId: string): string {
  return resolve(campaignDir(root, campaignId), "staging");
}

export function checkpointStageDir(root: string, campaignId: string, checkpointId: string): string {
  return resolve(campaignStagingDir(root, campaignId), checkpointId);
}

export function checkpointStagePath(root: string, campaignId: string, checkpointId: string, repoRelativePath: string): string {
  return resolve(checkpointStageDir(root, campaignId, checkpointId), cleanRepoRelativePath(repoRelativePath));
}

export function defaultRepo(cwd: string): string {
  const playground = resolve(cwd, "repos", "playground");
  return existsSync(playground) ? playground : cwd;
}

export function campaignWorktreePath(root: string, originalRepo: string, campaignId: string): string {
  const repoLabel = `${hashString(originalRepo)}-${slug(basename(originalRepo))}`;
  return resolve(root, "orchestrator", "private", "user-worktrees", repoLabel, campaignId);
}

export function campaignBranch(campaignId: string): string {
  return `catallaxy/campaign/${refSlug(campaignId)}/base`;
}

function checkpointId(index: number, checkpoint: CampaignCheckpointPlan): string {
  const base = checkpoint.id?.trim() || checkpoint.title || checkpoint.goal || `checkpoint-${index + 1}`;
  return `${String(index + 1).padStart(3, "0")}-${slug(base)}`;
}

export function normalizeCampaignPlan(root: string, plan: CampaignPlan): CampaignPlanRecord {
  const now = new Date().toISOString();
  const campaignId = plan.campaignId?.trim() || `${now.slice(0, 10)}-${slug(plan.title)}`;
  const originalRepo = resolve(plan.repo ? resolve(root, plan.repo) : userRepo(root));
  if (!plan.title.trim()) throw new Error("title is required");
  if (!plan.goal.trim()) throw new Error("goal is required");
  if (!plan.checkpoints.length) throw new Error("at least one checkpoint is required");

  const seenIds = new Set<string>();
  const checkpoints = plan.checkpoints.map((checkpoint, index): CampaignCheckpointRecord => {
    let id = checkpointId(index, checkpoint);
    if (seenIds.has(id)) id = `${id}-${index + 1}`;
    seenIds.add(id);

    const filesToWrite = unique(checkpoint.filesToWrite.map(cleanRepoRelativePath));
    const testFiles = unique(checkpoint.testFiles.map(cleanRepoRelativePath));
    const deterministicChecks = unique(checkpoint.deterministicChecks.map((c) => c.trim()).filter(Boolean));
    if (!checkpoint.title.trim()) throw new Error(`checkpoint ${index + 1}: title is required`);
    if (!checkpoint.goal.trim()) throw new Error(`checkpoint ${index + 1}: goal is required`);
    if (testFiles.length === 0) throw new Error(`checkpoint ${index + 1}: at least one test file is required`);
    if (deterministicChecks.length === 0) throw new Error(`checkpoint ${index + 1}: at least one deterministic check is required`);
    if (!checkpoint.reviewerPrompt.trim()) throw new Error(`checkpoint ${index + 1}: reviewerPrompt is required`);
    if (!checkpoint.implementationPrompt.trim()) throw new Error(`checkpoint ${index + 1}: implementationPrompt is required`);

    return {
      id,
      index,
      title: checkpoint.title.trim(),
      goal: checkpoint.goal.trim(),
      filesToWrite,
      testFiles,
      deterministicChecks,
      reviewerPrompt: checkpoint.reviewerPrompt.trim(),
      implementationPrompt: checkpoint.implementationPrompt.trim(),
      reservation: checkpoint.reservation ?? plan.reservation ?? 500_000,
      reviewFee: checkpoint.reviewFee ?? plan.reviewFee ?? 2_000,
      deadlineMin: CAMPAIGN_DEADLINE_MIN,
    };
  });

  return {
    campaignId,
    title: plan.title.trim(),
    goal: plan.goal.trim(),
    originalRepo,
    repo: campaignWorktreePath(root, originalRepo, campaignId),
    baseBranch: plan.baseBranch ?? campaignBranch(campaignId),
    checkpoints,
    createdAt: now,
  };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await writeText(path, JSON.stringify(data, null, 2));
}

async function git(args: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  return await new Promise((resolve) => {
    const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => { out += chunk; });
    proc.stderr.on("data", (chunk) => { err += chunk; });
    proc.on("error", (e) => resolve({ code: 1, out, err: err || e.message }));
    proc.on("close", (code) => resolve({ code: code ?? 1, out, err }));
  });
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

async function currentBranch(repo: string): Promise<string | undefined> {
  const r = await git(["rev-parse", "--abbrev-ref", "HEAD"], repo);
  if (r.code !== 0) throw new Error(`git rev-parse branch failed in ${repo}: ${r.err || r.out}`);
  const branch = r.out.trim();
  return branch && branch !== "HEAD" ? branch : undefined;
}

async function currentHead(repo: string): Promise<string> {
  const r = await git(["rev-parse", "HEAD"], repo);
  if (r.code !== 0) throw new Error(`git rev-parse HEAD failed in ${repo}: ${r.err || r.out}`);
  return r.out.trim();
}

export async function prepareCampaignWorktree(root: string, plan: CampaignPlanRecord): Promise<CampaignPlanRecord> {
  const originalRepo = await requireGitRepo(plan.originalRepo);
  await requireCleanRepo(originalRepo);
  const nextPlan = {
    ...plan,
    originalRepo,
    originalBranch: plan.originalBranch ?? await currentBranch(originalRepo),
    originalHead: plan.originalHead ?? await currentHead(originalRepo),
    repo: campaignWorktreePath(root, originalRepo, plan.campaignId),
    baseBranch: plan.baseBranch || campaignBranch(plan.campaignId),
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

export function initialCampaignState(campaignId: string): CampaignState {
  const now = new Date().toISOString();
  return {
    campaignId,
    status: "draft",
    nextCheckpoint: 0,
    appliedCheckpoints: [],
    completedTasks: [],
    retries: {},
    updatedAt: now,
  };
}

export async function saveCampaignPlan(root: string, record: CampaignPlanRecord): Promise<CampaignPlanRecord> {
  const dir = campaignDir(root, record.campaignId);
  await mkdir(dir, { recursive: true });
  await writeJson(`${dir}/plan.json`, record);
  await writeText(`${dir}/plan.md`, renderCampaignPlanMarkdown(record));
  if (!existsSync(`${dir}/state.json`)) {
    await writeJson(`${dir}/state.json`, initialCampaignState(record.campaignId));
  }
  return record;
}

export async function writeCampaignPlan(root: string, plan: CampaignPlan): Promise<CampaignPlanRecord> {
  return saveCampaignPlan(root, normalizeCampaignPlan(root, plan));
}

export async function loadCampaignPlan(root: string, campaignId: string): Promise<CampaignPlanRecord> {
  return await readJson<CampaignPlanRecord>(`${campaignDir(root, campaignId)}/plan.json`);
}

export async function loadCampaignState(root: string, campaignId: string): Promise<CampaignState> {
  try {
    const raw = await readJson<any>(`${campaignDir(root, campaignId)}/state.json`);
    return {
      ...initialCampaignState(campaignId),
      ...raw,
      appliedCheckpoints: raw.appliedCheckpoints ?? [],
      completedTasks: raw.completedTasks ?? [],
      retries: raw.retries ?? {},
    };
  } catch {
    return initialCampaignState(campaignId);
  }
}

export async function saveCampaignState(root: string, state: CampaignState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await mkdir(campaignDir(root, state.campaignId), { recursive: true });
  await writeJson(`${campaignDir(root, state.campaignId)}/state.json`, state);
}

async function publishCompletedCampaign(plan: CampaignPlanRecord, state: CampaignState): Promise<{ ok: true } | { ok: false; error: string }> {
  if (state.publish?.status === "published") return { ok: true };

  const at = new Date().toISOString();
  try {
    await requireCleanRepo(plan.originalRepo);
    const targetBranch = await currentBranch(plan.originalRepo);
    if (plan.originalBranch && targetBranch !== plan.originalBranch) {
      throw new Error(`original repo is on branch ${targetBranch ?? "(detached)"}; expected ${plan.originalBranch}`);
    }

    const merge = await git(["merge", "--ff-only", plan.baseBranch], plan.originalRepo);
    if (merge.code !== 0) {
      throw new Error(`git merge --ff-only ${plan.baseBranch} failed in original repo: ${merge.err || merge.out}`);
    }

    state.publish = {
      status: "published",
      targetRepo: plan.originalRepo,
      targetBranch,
      commit: await currentHead(plan.originalRepo),
      at,
    };
    return { ok: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    state.publish = {
      status: "failed",
      targetRepo: plan.originalRepo,
      targetBranch: plan.originalBranch,
      error,
      at,
    };
    return { ok: false, error };
  }
}

export function renderCampaignPlanMarkdown(plan: CampaignPlanRecord): string {
  const lines: string[] = [];
  lines.push(`# ${plan.title}`);
  lines.push("");
  lines.push(`Campaign: ${plan.campaignId}`);
  lines.push(`Original repo: ${plan.originalRepo}`);
  if (plan.originalBranch) lines.push(`Publish target branch: ${plan.originalBranch}`);
  lines.push(`Campaign worktree: ${plan.repo}`);
  lines.push(`Base branch: ${plan.baseBranch}`);
  lines.push(`Checkpoints: ${plan.checkpoints.length}`);
  lines.push("");
  lines.push("## Goal");
  lines.push(plan.goal);
  lines.push("");

  for (const checkpoint of plan.checkpoints) {
    lines.push(`## Checkpoint ${checkpoint.index + 1}: ${checkpoint.title}`);
    lines.push("");
    lines.push(`ID: ${checkpoint.id}`);
    lines.push("");
    lines.push("### Goal");
    lines.push(checkpoint.goal);
    lines.push("");
    lines.push("### Files to stage before launch");
    for (const f of checkpoint.filesToWrite) lines.push(`- ${f}`);
    lines.push("");
    lines.push("### Test files");
    for (const f of checkpoint.testFiles) lines.push(`- ${f}`);
    lines.push("");
    lines.push("### Deterministic checks");
    for (const c of checkpoint.deterministicChecks) lines.push(`- \`${c}\``);
    lines.push("");
    lines.push("### Reviewer prompt");
    lines.push(checkpoint.reviewerPrompt);
    lines.push("");
    lines.push("### Implementation prompt for Catallaxy agents");
    lines.push(checkpoint.implementationPrompt);
    lines.push("");
    lines.push("### Economics");
    lines.push(`Reservation: ${checkpoint.reservation}`);
    lines.push(`Review fee: ${checkpoint.reviewFee}`);
    lines.push(`Auction deadline: ${checkpoint.deadlineMin} minutes`);
    lines.push("");
  }

  return lines.join("\n");
}

export function checkpointTargetFiles(checkpoint: CampaignCheckpointRecord): string[] {
  return unique([...checkpoint.testFiles, ...checkpoint.filesToWrite]);
}

function cumulativeDeterministicChecks(plan: CampaignPlanRecord, checkpoint: CampaignCheckpointRecord): string[] {
  return unique(
    plan.checkpoints
      .filter((c) => c.index <= checkpoint.index)
      .flatMap((c) => c.deterministicChecks),
  );
}

export function campaignStagedFiles(root: string, plan: CampaignPlanRecord): { checkpoint: CampaignCheckpointRecord; targetPath: string; stagedPath: string }[] {
  const entries: { checkpoint: CampaignCheckpointRecord; targetPath: string; stagedPath: string }[] = [];
  for (const checkpoint of plan.checkpoints) {
    for (const targetPath of checkpointTargetFiles(checkpoint)) {
      entries.push({
        checkpoint,
        targetPath,
        stagedPath: checkpointStagePath(root, plan.campaignId, checkpoint.id, targetPath),
      });
    }
  }
  return entries;
}

export function missingFiles(cwd: string, files: string[]): string[] {
  return files.filter((f) => !existsSync(resolve(cwd, f)));
}

export function missingStagedFiles(root: string, plan: CampaignPlanRecord, checkpoint?: CampaignCheckpointRecord): string[] {
  return campaignStagedFiles(root, plan)
    .filter((entry) => !checkpoint || entry.checkpoint.id === checkpoint.id)
    .filter((entry) => !existsSync(entry.stagedPath))
    .map((entry) => `${entry.checkpoint.id}:${entry.targetPath}`);
}

async function listJson(dir: string): Promise<string[]> {
  try { return (await readdir(dir)).filter((f) => f.endsWith(".json")); } catch { return []; }
}

export async function listCampaignIds(root: string): Promise<string[]> {
  try {
    const entries = await readdir(resolve(root, ".catallaxy", "campaigns"), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
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
  try { return await readJson<Record<string, number>>(path); } catch { return {}; }
}

async function writeReservations(path: string, reservations: Record<string, number>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeJson(path, reservations);
}

async function applyCheckpointFiles(root: string, plan: CampaignPlanRecord, checkpoint: CampaignCheckpointRecord): Promise<void> {
  const missing = missingStagedFiles(root, plan, checkpoint);
  if (missing.length > 0) throw new Error(`missing staged checkpoint files: ${missing.join(", ")}`);

  for (const targetPath of checkpointTargetFiles(checkpoint)) {
    const stagedPath = checkpointStagePath(root, plan.campaignId, checkpoint.id, targetPath);
    const dst = resolve(plan.repo, targetPath);
    await mkdir(dirname(dst), { recursive: true });
    await cp(stagedPath, dst, { force: true });
  }
}

async function commitCampaignWorktree(plan: CampaignPlanRecord, paths: string[], message: string): Promise<boolean> {
  const add = await git(["add", "--", ...paths], plan.repo);
  if (add.code !== 0) throw new Error(`git add failed in campaign worktree: ${add.err || add.out}`);
  const status = await git(["status", "--porcelain", "--", ...paths], plan.repo);
  if (status.code !== 0) throw new Error(`git status failed in campaign worktree: ${status.err || status.out}`);
  if (!status.out.trim()) return false;
  const commit = await git(["commit", "-m", message], plan.repo);
  if (commit.code !== 0) throw new Error(`git commit failed in campaign worktree: ${commit.err || commit.out}`);
  return true;
}

async function ensureCheckpointApplied(root: string, plan: CampaignPlanRecord, state: CampaignState, checkpoint: CampaignCheckpointRecord): Promise<void> {
  if (state.appliedCheckpoints.includes(checkpoint.id)) return;
  await applyCheckpointFiles(root, plan, checkpoint);
  await commitCampaignWorktree(
    plan,
    checkpointTargetFiles(checkpoint),
    `catallaxy(${plan.campaignId}): add checkpoint ${checkpoint.index + 1} tests`,
  );
  state.appliedCheckpoints.push(checkpoint.id);
}

async function postCheckpointTask(root: string, plan: CampaignPlanRecord, checkpoint: CampaignCheckpointRecord): Promise<LaunchResult> {
  const taskId = await nextTaskId(root);
  const now = new Date();
  const taskPath = resolve(root, "market", "tasks", `${taskId}.json`);
  const reservationPath = resolve(root, "orchestrator", "private", "reservations.json");
  await mkdir(dirname(taskPath), { recursive: true });
  await mkdir(dirname(reservationPath), { recursive: true });

  const targetFiles = checkpointTargetFiles(checkpoint);
  const task: Task = parseTask({
    id: taskId,
    description: [
      `[campaign:${plan.campaignId} checkpoint ${checkpoint.index + 1}/${plan.checkpoints.length} ${checkpoint.id}] ${plan.title}`,
      "",
      checkpoint.implementationPrompt,
      "",
      "Campaign goal:",
      plan.goal,
      "",
      "Checkpoint goal:",
      checkpoint.goal,
      "",
      "Tests/files introduced on the base branch for this checkpoint:",
      ...targetFiles.map((f) => `- ${f}`),
      "",
      "Keep all previous campaign checkpoints passing. Do not weaken buyer-supplied tests or fixtures unless the checkpoint explicitly asks for it.",
    ].join("\n"),
    repo: plan.repo,
    base_branch: plan.baseBranch,
    review_fee: checkpoint.reviewFee,
    deterministic_checks: cumulativeDeterministicChecks(plan, checkpoint).map((cmd) => ({ type: "command", cmd, must_pass: true })),
    subjective_criteria: checkpoint.reviewerPrompt,
    status: "open",
    posted_by: "catallaxy-interface",
    posted_at: now.toISOString(),
    deadline_at: new Date(now.getTime() + checkpoint.deadlineMin * 60_000).toISOString(),
  });

  await writeJson(taskPath, task);
  const reservations = await loadReservations(reservationPath);
  reservations[taskId] = checkpoint.reservation;
  await writeReservations(reservationPath, reservations);
  return {
    taskId,
    taskPath,
    reservationPath,
    campaignId: plan.campaignId,
    checkpointId: checkpoint.id,
    checkpointIndex: checkpoint.index,
    repo: plan.repo,
    baseBranch: plan.baseBranch,
  };
}

export async function launchCampaign(root: string, plan: CampaignPlanRecord): Promise<LaunchResult> {
  const missing = missingStagedFiles(root, plan);
  if (missing.length > 0) throw new Error(`refusing to launch; missing staged files: ${missing.join(", ")}`);

  const state = await loadCampaignState(root, plan.campaignId);
  if (state.status === "completed") throw new Error(`campaign ${plan.campaignId} is already completed`);
  if (state.currentTask) {
    const current = plan.checkpoints[state.nextCheckpoint];
    return {
      taskId: state.currentTask,
      taskPath: resolve(root, "market", "tasks", `${state.currentTask}.json`),
      reservationPath: resolve(root, "orchestrator", "private", "reservations.json"),
      campaignId: plan.campaignId,
      checkpointId: current?.id ?? "unknown",
      checkpointIndex: state.nextCheckpoint,
      repo: plan.repo,
      baseBranch: plan.baseBranch,
    };
  }

  const checkpoint = plan.checkpoints[state.nextCheckpoint];
  if (!checkpoint) throw new Error(`campaign ${plan.campaignId} has no checkpoint ${state.nextCheckpoint + 1}`);
  state.status = "launched";
  state.launchedAt ??= new Date().toISOString();
  await ensureCheckpointApplied(root, plan, state, checkpoint);
  const launched = await postCheckpointTask(root, plan, checkpoint);
  state.currentTask = launched.taskId;
  await saveCampaignState(root, state);
  return launched;
}

async function readTaskStatus(root: string, taskId: string): Promise<Task["status"] | null> {
  try { return parseTask(await readJson<any>(resolve(root, "market", "tasks", `${taskId}.json`))).status; }
  catch { return null; }
}

async function latestLgtm(root: string, taskId: string): Promise<{ agent: string; seq: number; branch: string } | null> {
  const responses = [] as Array<{ agent: string; seq: number; reviewed_at: string }>;
  for (const f of await listJson(resolve(root, "market", "review_responses"))) {
    try {
      const r = parseReviewResponse(await readJson<any>(resolve(root, "market", "review_responses", f)));
      if (r.task_id === taskId && r.verdict === "lgtm") responses.push({ agent: r.agent, seq: r.seq, reviewed_at: r.reviewed_at });
    } catch {}
  }
  responses.sort((a, b) => b.seq - a.seq || b.reviewed_at.localeCompare(a.reviewed_at));
  for (const r of responses) {
    const reqPath = resolve(root, "market", "review_requests", `${taskId}-${r.agent}-${r.seq}.json`);
    try {
      const req = parseReviewRequest(await readJson<any>(reqPath));
      return { agent: r.agent, seq: r.seq, branch: req.branch };
    } catch {}
  }
  return null;
}

async function mergeCompletedTask(root: string, plan: CampaignPlanRecord, taskId: string): Promise<boolean> {
  const lgtm = await latestLgtm(root, taskId);
  if (!lgtm) return false;

  const workDir = resolve(root, "agents", lgtm.agent, "sandbox", "work", taskId);
  if (!existsSync(`${workDir}/.git`)) throw new Error(`cannot merge ${taskId}; missing agent worktree ${workDir}`);

  const fetch = await git(["fetch", workDir, lgtm.branch], plan.repo);
  if (fetch.code !== 0) throw new Error(`git fetch failed for ${taskId}: ${fetch.err || fetch.out}`);
  const merge = await git(["merge", "--no-ff", "--no-edit", "FETCH_HEAD"], plan.repo);
  if (merge.code !== 0) throw new Error(`git merge failed for ${taskId}: ${merge.err || merge.out}`);
  return true;
}

async function completeCampaign(root: string, plan: CampaignPlanRecord, state: CampaignState, result: AdvanceResult, newlyCompleted: boolean): Promise<void> {
  state.status = "completed";
  state.completedAt ??= new Date().toISOString();
  if (newlyCompleted) result.completedCampaigns.push(plan.campaignId);

  const published = await publishCompletedCampaign(plan, state);
  if (published.ok) result.publishedCampaigns.push(plan.campaignId);
  else result.publishFailed.push({ campaignId: plan.campaignId, error: published.error });

  await saveCampaignState(root, state);
}

async function advanceOneCampaign(root: string, plan: CampaignPlanRecord, state: CampaignState, result: AdvanceResult): Promise<void> {
  if (state.status === "completed") {
    if (state.publish?.status !== "published") await completeCampaign(root, plan, state, result, false);
    return;
  }
  if (state.status !== "launched") return;

  if (state.currentTask) {
    const status = await readTaskStatus(root, state.currentTask);
    if (status === "completed") {
      if (!state.completedTasks.includes(state.currentTask)) {
        const merged = await mergeCompletedTask(root, plan, state.currentTask);
        if (!merged) return;
        state.completedTasks.push(state.currentTask);
        result.merged.push(state.currentTask);
      }
      state.nextCheckpoint++;
      state.currentTask = undefined;
      if (state.nextCheckpoint >= plan.checkpoints.length) {
        await completeCampaign(root, plan, state, result, true);
        return;
      }
    } else if (status === "expired") {
      const checkpoint = plan.checkpoints[state.nextCheckpoint];
      const retryKey = checkpoint?.id ?? String(state.nextCheckpoint);
      state.retries[retryKey] = (state.retries[retryKey] ?? 0) + 1;
      state.currentTask = undefined;
    } else if (status === "open" || status === "assigned") {
      return;
    } else if (status === null) {
      state.currentTask = undefined;
    }
  }

  const checkpoint = plan.checkpoints[state.nextCheckpoint];
  if (!checkpoint) {
    await completeCampaign(root, plan, state, result, true);
    return;
  }

  await ensureCheckpointApplied(root, plan, state, checkpoint);
  const launched = await postCheckpointTask(root, plan, checkpoint);
  state.currentTask = launched.taskId;
  if ((state.retries[checkpoint.id] ?? 0) > 0) result.reposted.push(launched.taskId);
  else result.posted.push(launched.taskId);
  await saveCampaignState(root, state);
}

export async function advanceCampaigns(root: string = catallaxyRoot(process.cwd())): Promise<AdvanceResult> {
  const result: AdvanceResult = { posted: [], reposted: [], merged: [], completedCampaigns: [], publishedCampaigns: [], publishFailed: [] };
  for (const campaignId of await listCampaignIds(root)) {
    const plan = await loadCampaignPlan(root, campaignId).catch(() => null);
    if (!plan) continue;
    const state = await loadCampaignState(root, campaignId);
    await advanceOneCampaign(root, plan, state, result);
  }
  return result;
}
