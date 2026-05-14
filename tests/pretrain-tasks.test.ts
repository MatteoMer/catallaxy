import { expect, test } from "bun:test";
import { PRETRAIN_FIXTURE_SLUGS } from "../orchestrator/pretrainFixtures";
import { MIN_PRETRAIN_RESERVATION, PRETRAIN_TASKS } from "../orchestrator/pretrainTasks";

test("pretrain catalog is large, unique, high-reservation, and fully test-seeded", () => {
  const slugs = PRETRAIN_TASKS.map((t) => t.slug).sort();
  expect(PRETRAIN_TASKS.length).toBeGreaterThanOrEqual(64);
  expect(new Set(slugs).size).toBe(PRETRAIN_TASKS.length);
  expect(Math.min(...PRETRAIN_TASKS.map((t) => t.reservation))).toBeGreaterThanOrEqual(MIN_PRETRAIN_RESERVATION);
  expect(PRETRAIN_FIXTURE_SLUGS).toEqual(slugs);
});
