import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  advanceCampaigns,
  campaignBranch,
  campaignStagedFiles,
  checkpointStagePath,
  defaultRepo,
  launchCampaign,
  loadCampaignState,
  missingStagedFiles,
  normalizeCampaignPlan,
  nextTaskId,
  prepareCampaignWorktree,
  saveCampaignPlan,
} from "../.pi/extensions/catallaxy-interface/task";

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "catallaxy-interface-"));
}

async function run(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${err || out}`);
}

async function initUserRepo(): Promise<string> {
  const repo = await tempDir();
  await run(repo, ["init", "-b", "main"]);
  await run(repo, ["config", "user.email", "test@example.com"]);
  await run(repo, ["config", "user.name", "Test User"]);
  await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }, null, 2));
  await run(repo, ["add", "package.json"]);
  await run(repo, ["commit", "-m", "initial"]);
  return repo;
}

const baseCampaign = {
  campaignId: "csv-import",
  title: "CSV import",
  goal: "Import CSV files safely.",
  checkpoints: [
    {
      title: "Parse CSV rows",
      goal: "Parse quoted CSV rows.",
      filesToWrite: ["tests/csv-parse.test.ts"],
      testFiles: ["tests/csv-parse.test.ts"],
      deterministicChecks: ["bun test tests/csv-parse.test.ts"],
      reviewerPrompt: "Review CSV parsing behavior.",
      implementationPrompt: "Implement CSV row parsing.",
    },
  ],
};

test("normalizes a campaign plan with checkpoint defaults", () => {
  const root = "/catallaxy";
  const plan = normalizeCampaignPlan(root, { ...baseCampaign, title: "Add CSV import", repo: "/user/repo" });

  expect(plan.campaignId).toBe("csv-import");
  expect(plan.originalRepo).toBe("/user/repo");
  expect(plan.repo).toContain("/catallaxy/orchestrator/private/user-worktrees/");
  expect(plan.repo).toContain("csv-import");
  expect(plan.baseBranch).toBe(campaignBranch("csv-import"));
  expect(plan.checkpoints).toHaveLength(1);
  expect(plan.checkpoints[0].id).toBe("001-parse-csv-rows");
  expect(plan.checkpoints[0].reservation).toBe(500_000);
  expect(plan.checkpoints[0].reviewFee).toBe(2_000);
  expect(plan.checkpoints[0].deadlineMin).toBe(6);
});

test("writes campaign artifacts and refuses launch when staged files are missing", async () => {
  const root = await tempDir();
  const userRepo = await initUserRepo();
  const plan = await prepareCampaignWorktree(root, normalizeCampaignPlan(root, { ...baseCampaign, repo: userRepo }));
  await saveCampaignPlan(root, plan);

  expect(missingStagedFiles(root, plan)).toEqual(["001-parse-csv-rows:tests/csv-parse.test.ts"]);
  await expect(launchCampaign(root, plan)).rejects.toThrow("missing staged files");
});

test("defaults repo to repos/playground when present", async () => {
  const cwd = await tempDir();
  await mkdir(join(cwd, "repos", "playground"), { recursive: true });
  expect(defaultRepo(cwd)).toBe(join(cwd, "repos", "playground"));
});

test("creates isolated campaign worktree, commits first checkpoint, and posts market task", async () => {
  const root = await tempDir();
  const userRepo = await initUserRepo();
  let plan = normalizeCampaignPlan(root, { ...baseCampaign, repo: userRepo, reservation: 123_000 });
  plan = await prepareCampaignWorktree(root, plan);
  await saveCampaignPlan(root, plan);

  expect(plan.repo).not.toBe(userRepo);
  expect(existsSync(join(plan.repo, ".git"))).toBe(true);
  expect(plan.originalBranch).toBe("main");
  expect(plan.originalHead).toMatch(/^[0-9a-f]{40}$/);
  expect(plan.baseBranch).toBe("catallaxy/campaign/csv-import/base");

  const staged = campaignStagedFiles(root, plan);
  expect(staged).toHaveLength(1);
  await mkdir(join(staged[0].stagedPath, ".."), { recursive: true });
  await writeFile(staged[0].stagedPath, "test.todo('csv parse')\n");

  expect(await nextTaskId(root)).toBe("task-001");
  const launched = await launchCampaign(root, plan);
  expect(launched.taskId).toBe("task-001");
  expect(launched.campaignId).toBe("csv-import");
  expect(launched.checkpointId).toBe("001-parse-csv-rows");
  expect(launched.repo).toBe(plan.repo);
  expect(launched.baseBranch).toBe(plan.baseBranch);

  const task = await Bun.file(join(root, "market", "tasks", "task-001.json")).json();
  expect(task.posted_by).toBe("catallaxy-interface");
  expect(task.repo).toBe(plan.repo);
  expect(task.base_branch).toBe(plan.baseBranch);
  expect(task.description).toContain("[campaign:csv-import checkpoint 1/1 001-parse-csv-rows]");
  expect(task.subjective_criteria).toContain("Review CSV parsing behavior");
  expect(task.deterministic_checks[0].cmd).toBe("bun test tests/csv-parse.test.ts");
  expect(new Date(task.deadline_at).getTime() - new Date(task.posted_at).getTime()).toBe(6 * 60_000);

  const reservations = await Bun.file(join(root, "orchestrator", "private", "reservations.json")).json();
  expect(reservations["task-001"]).toBe(123_000);
  expect(await nextTaskId(root)).toBe("task-002");

  const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: plan.repo });
  expect(status.stdout.toString().trim()).toBe("");
  expect(existsSync(join(plan.repo, "tests", "csv-parse.test.ts"))).toBe(true);
});

test("advances campaign after LGTM by merging winner and posting next checkpoint", async () => {
  const root = await tempDir();
  const userRepo = await initUserRepo();
  let plan = normalizeCampaignPlan(root, {
    ...baseCampaign,
    repo: userRepo,
    checkpoints: [
      baseCampaign.checkpoints[0],
      {
        title: "Stream CSV files",
        goal: "Stream CSV without buffering entire input.",
        filesToWrite: ["tests/csv-stream.test.ts"],
        testFiles: ["tests/csv-stream.test.ts"],
        deterministicChecks: ["bun test tests/csv-*.test.ts"],
        reviewerPrompt: "Review streaming behavior.",
        implementationPrompt: "Implement streaming CSV import.",
      },
    ],
  });
  plan = await prepareCampaignWorktree(root, plan);
  await saveCampaignPlan(root, plan);

  for (const entry of campaignStagedFiles(root, plan)) {
    await mkdir(join(entry.stagedPath, ".."), { recursive: true });
    await writeFile(entry.stagedPath, `test.todo('${entry.targetPath}')\n`);
  }

  const first = await launchCampaign(root, plan);
  expect(first.taskId).toBe("task-001");

  const agent = "alice";
  const workDir = join(root, "agents", agent, "sandbox", "work", first.taskId);
  await mkdir(join(workDir, ".."), { recursive: true });
  await run(root, ["clone", plan.repo, workDir]);
  await run(workDir, ["config", "user.email", "alice@example.com"]);
  await run(workDir, ["config", "user.name", "Alice"]);
  await run(workDir, ["checkout", "-b", "impl/csv-parse"]);
  await writeFile(join(workDir, "parser.ts"), "export const parser = true;\n");
  await run(workDir, ["add", "parser.ts"]);
  await run(workDir, ["commit", "-m", "implement parser"]);

  const task = await Bun.file(join(root, "market", "tasks", "task-001.json")).json();
  task.status = "completed";
  await Bun.write(join(root, "market", "tasks", "task-001.json"), JSON.stringify(task, null, 2));
  await mkdir(join(root, "market", "review_requests"), { recursive: true });
  await mkdir(join(root, "market", "review_responses"), { recursive: true });
  await Bun.write(join(root, "market", "review_requests", "task-001-alice-0.json"), JSON.stringify({
    task_id: "task-001",
    agent,
    branch: "impl/csv-parse",
    seq: 0,
    requested_at: new Date().toISOString(),
  }, null, 2));
  await Bun.write(join(root, "market", "review_responses", "task-001-alice-0.json"), JSON.stringify({
    task_id: "task-001",
    agent,
    seq: 0,
    verdict: "lgtm",
    feedback: "LGTM",
    reviewed_at: new Date().toISOString(),
  }, null, 2));

  const advanced = await advanceCampaigns(root);
  expect(advanced.merged).toEqual(["task-001"]);
  expect(advanced.posted).toEqual(["task-002"]);
  expect(existsSync(join(plan.repo, "parser.ts"))).toBe(true);
  expect(existsSync(join(plan.repo, "tests", "csv-stream.test.ts"))).toBe(true);

  const state = await loadCampaignState(root, plan.campaignId);
  expect(state.nextCheckpoint).toBe(1);
  expect(state.currentTask).toBe("task-002");
  expect(state.completedTasks).toEqual(["task-001"]);

  const secondTask = await Bun.file(join(root, "market", "tasks", "task-002.json")).json();
  expect(secondTask.description).toContain("checkpoint 2/2");
  expect(secondTask.deterministic_checks.map((c: { cmd: string }) => c.cmd)).toEqual([
    "bun test tests/csv-parse.test.ts",
    "bun test tests/csv-*.test.ts",
  ]);
});

test("publishes completed campaign back to the original repo", async () => {
  const root = await tempDir();
  const userRepo = await initUserRepo();
  let plan = normalizeCampaignPlan(root, { ...baseCampaign, repo: userRepo });
  plan = await prepareCampaignWorktree(root, plan);
  await saveCampaignPlan(root, plan);

  for (const entry of campaignStagedFiles(root, plan)) {
    await mkdir(join(entry.stagedPath, ".."), { recursive: true });
    await writeFile(entry.stagedPath, `test.todo('${entry.targetPath}')\n`);
  }

  const launched = await launchCampaign(root, plan);
  const agent = "alice";
  const workDir = join(root, "agents", agent, "sandbox", "work", launched.taskId);
  await mkdir(join(workDir, ".."), { recursive: true });
  await run(root, ["clone", plan.repo, workDir]);
  await run(workDir, ["config", "user.email", "alice@example.com"]);
  await run(workDir, ["config", "user.name", "Alice"]);
  await run(workDir, ["checkout", "-b", "impl/csv-parse"]);
  await writeFile(join(workDir, "parser.ts"), "export const parser = true;\n");
  await run(workDir, ["add", "parser.ts"]);
  await run(workDir, ["commit", "-m", "implement parser"]);

  const task = await Bun.file(join(root, "market", "tasks", launched.taskId + ".json")).json();
  task.status = "completed";
  await Bun.write(join(root, "market", "tasks", launched.taskId + ".json"), JSON.stringify(task, null, 2));
  await mkdir(join(root, "market", "review_requests"), { recursive: true });
  await mkdir(join(root, "market", "review_responses"), { recursive: true });
  await Bun.write(join(root, "market", "review_requests", `${launched.taskId}-${agent}-0.json`), JSON.stringify({
    task_id: launched.taskId,
    agent,
    branch: "impl/csv-parse",
    seq: 0,
    requested_at: new Date().toISOString(),
  }, null, 2));
  await Bun.write(join(root, "market", "review_responses", `${launched.taskId}-${agent}-0.json`), JSON.stringify({
    task_id: launched.taskId,
    agent,
    seq: 0,
    verdict: "lgtm",
    feedback: "LGTM",
    reviewed_at: new Date().toISOString(),
  }, null, 2));

  const advanced = await advanceCampaigns(root);
  expect(advanced.completedCampaigns).toEqual(["csv-import"]);
  expect(advanced.publishedCampaigns).toEqual(["csv-import"]);
  expect(advanced.publishFailed).toEqual([]);
  expect(existsSync(join(userRepo, "parser.ts"))).toBe(true);
  expect(existsSync(join(userRepo, "tests", "csv-parse.test.ts"))).toBe(true);

  const state = await loadCampaignState(root, plan.campaignId);
  expect(state.status).toBe("completed");
  expect(state.publish?.status).toBe("published");
  expect(state.publish?.targetRepo).toBe(plan.originalRepo);
});

test("refuses to create campaign worktree from dirty user repo", async () => {
  const root = await tempDir();
  const userRepo = await initUserRepo();
  await writeFile(join(userRepo, "dirty.txt"), "dirty\n");
  const plan = normalizeCampaignPlan(root, { ...baseCampaign, repo: userRepo });
  await expect(prepareCampaignWorktree(root, plan)).rejects.toThrow("uncommitted changes");
});

test("staging paths preserve checkpoint isolation", () => {
  const path = checkpointStagePath("/root", "campaign", "001-a", "tests/foo.test.ts");
  expect(path).toBe("/root/.catallaxy/campaigns/campaign/staging/001-a/tests/foo.test.ts");
});
