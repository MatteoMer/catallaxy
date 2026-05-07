import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  createMarketTask,
  defaultRepo,
  demandBranch,
  missingFiles,
  normalizePlan,
  nextTaskId,
  prepareDemandWorktree,
  writeDemandPlan,
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
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${err || out}`);
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

const basePlan = {
  demandId: "csv-import",
  title: "CSV import",
  goal: "Import CSV files.",
  filesToWrite: ["tests/csv.test.ts"],
  testFiles: ["tests/csv.test.ts"],
  deterministicChecks: ["bun test tests/csv.test.ts"],
  reviewerPrompt: "Review CSV behavior.",
  implementationPrompt: "Implement CSV import.",
};

test("normalizes a demand plan with worktree defaults", () => {
  const root = "/catallaxy";
  const plan = normalizePlan(root, { ...basePlan, title: "Add CSV import", repo: "/user/repo" });

  expect(plan.demandId).toBe("csv-import");
  expect(plan.originalRepo).toBe("/user/repo");
  expect(plan.repo).toContain("/catallaxy/orchestrator/private/user-worktrees/");
  expect(plan.repo).toContain("csv-import");
  expect(plan.baseBranch).toBe(demandBranch("csv-import"));
  expect(plan.reservation).toBe(500_000);
  expect(plan.reviewFee).toBe(2_000);
});

test("writes plan artifacts and refuses launch when planned files are missing", async () => {
  const root = await tempDir();
  const userRepo = await initUserRepo();
  const plan = await prepareDemandWorktree(root, normalizePlan(root, { ...basePlan, repo: userRepo }));
  await writeDemandPlan(root, { ...basePlan, repo: userRepo });

  expect(missingFiles(plan.repo, plan.testFiles)).toEqual(["tests/csv.test.ts"]);
  await expect(createMarketTask(root, plan)).rejects.toThrow("missing planned files");
});

test("defaults repo to repos/playground when present", async () => {
  const cwd = await tempDir();
  await mkdir(join(cwd, "repos", "playground"), { recursive: true });
  expect(defaultRepo(cwd)).toBe(join(cwd, "repos", "playground"));
});

test("creates isolated user worktree, commits tests, and posts market task", async () => {
  const root = await tempDir();
  const userRepo = await initUserRepo();
  let plan = normalizePlan(root, { ...basePlan, repo: userRepo, reservation: 123_000 });
  plan = await prepareDemandWorktree(root, plan);

  expect(plan.repo).not.toBe(userRepo);
  expect(existsSync(join(plan.repo, ".git"))).toBe(true);
  expect(plan.baseBranch).toBe("catallaxy/demand/csv-import/tests");

  await mkdir(join(plan.repo, "tests"), { recursive: true });
  await writeFile(join(plan.repo, "tests", "csv.test.ts"), "test.todo('csv')\n");

  expect(await nextTaskId(root)).toBe("task-001");
  const launched = await createMarketTask(root, plan);
  expect(launched.taskId).toBe("task-001");
  expect(launched.repo).toBe(plan.repo);
  expect(launched.baseBranch).toBe(plan.baseBranch);

  const task = await Bun.file(join(root, "market", "tasks", "task-001.json")).json();
  expect(task.posted_by).toBe("catallaxy-interface");
  expect(task.repo).toBe(plan.repo);
  expect(task.base_branch).toBe(plan.baseBranch);
  expect(task.description).toContain("[demand:csv-import]");
  expect(task.subjective_criteria).toContain("Review CSV behavior");
  expect(task.deterministic_checks[0].cmd).toBe("bun test tests/csv.test.ts");

  const reservations = await Bun.file(join(root, "orchestrator", "private", "reservations.json")).json();
  expect(reservations["task-001"]).toBe(123_000);
  expect(await nextTaskId(root)).toBe("task-002");

  const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: plan.repo });
  expect(status.stdout.toString().trim()).toBe("");
});

test("refuses to create demand worktree from dirty user repo", async () => {
  const root = await tempDir();
  const userRepo = await initUserRepo();
  await writeFile(join(userRepo, "dirty.txt"), "dirty\n");
  const plan = normalizePlan(root, { ...basePlan, repo: userRepo });
  await expect(prepareDemandWorktree(root, plan)).rejects.toThrow("uncommitted changes");
});
