import { expect, test } from "bun:test";
import { LIGHT_PRETRAIN_FIXTURE_SLUGS } from "../orchestrator/pretrainLightFixtures";
import { LIGHT_PRETRAIN_REPOS, LIGHT_PRETRAIN_TASKS, MIN_LIGHT_PRETRAIN_RESERVATION } from "../orchestrator/pretrainLightTasks";

test("light pretrain catalog is unique, low-reservation, and backed by existing-repo fixtures", () => {
  const slugs = LIGHT_PRETRAIN_TASKS.map((t) => t.slug).sort();
  expect(LIGHT_PRETRAIN_TASKS.length).toBeGreaterThanOrEqual(16);
  expect(new Set(slugs).size).toBe(LIGHT_PRETRAIN_TASKS.length);
  expect(Math.min(...LIGHT_PRETRAIN_TASKS.map((t) => t.reservation))).toBeGreaterThanOrEqual(MIN_LIGHT_PRETRAIN_RESERVATION);
  expect(Math.max(...LIGHT_PRETRAIN_TASKS.map((t) => t.reservation))).toBeLessThan(2_000_000);
  expect(LIGHT_PRETRAIN_FIXTURE_SLUGS).toEqual(slugs);

  for (const task of LIGHT_PRETRAIN_TASKS) {
    expect(task.description.startsWith(`[pretrain-light:${task.slug}]`)).toBe(true);
    expect(task.repo).toBe(`${LIGHT_PRETRAIN_REPOS}/${task.slug}`);
    expect(task.check).not.toContain("pretrain/");
  }
});
