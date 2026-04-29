import { z } from "zod";

const Timestamp = z.string().datetime();

const DeterministicCheckSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("command"), cmd: z.string(), must_pass: z.boolean().default(true) }),
  z.object({ type: z.literal("files_untouched"), paths: z.array(z.string()) }),
]);
export type DeterministicCheck = z.infer<typeof DeterministicCheckSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  description: z.string(),
  repo: z.string(),
  base_branch: z.string().default("main"),
  review_fee: z.number().int().positive(),
  deterministic_checks: z.array(DeterministicCheckSchema).default([]),
  subjective_criteria: z.string().optional(),
  status: z.enum(["open", "assigned", "accepted", "expired"]),
  posted_by: z.string(),
  posted_at: Timestamp,
  deadline_at: Timestamp,
});
export type Task = z.infer<typeof TaskSchema>;

export const BidSchema = z.object({
  task_id: z.string(),
  agent: z.string(),
  price: z.number().positive(),
  created_at: Timestamp,
});
export type Bid = z.infer<typeof BidSchema>;

export const AssignmentSchema = z.object({
  task_id: z.string(),
  winner: z.string(),
  payment: z.number().positive(),
  assigned_at: Timestamp,
});
export type Assignment = z.infer<typeof AssignmentSchema>;

export const ReviewRequestSchema = z.object({
  task_id: z.string(),
  agent: z.string(),
  branch: z.string(),
  seq: z.number().int().nonnegative(),
  requested_at: Timestamp,
});
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;

export const ReviewResponseSchema = z.object({
  task_id: z.string(),
  agent: z.string(),
  seq: z.number().int().nonnegative(),
  verdict: z.enum(["lgtm", "needs_work"]),
  feedback: z.string(),
  reviewed_at: Timestamp,
});
export type ReviewResponse = z.infer<typeof ReviewResponseSchema>;

export const BalanceSchema = z.object({
  balance: z.number(),
  history: z.array(
    z.object({
      at: Timestamp,
      type: z.enum([
        "debit_thinking",
        "debit_review_fee",
        "credit_bounty",
        "debit_bounty",
        "transfer",
      ]),
      amount: z.number(),
      description: z.string(),
    })
  ),
});
export type Balance = z.infer<typeof BalanceSchema>;

export const LedgerSchema = z.record(z.string(), BalanceSchema);
export type Ledger = z.infer<typeof LedgerSchema>;
