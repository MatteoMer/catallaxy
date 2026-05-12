import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { creditEscrowRefund, type Ledger } from "./ledger";

const ROOT = process.cwd();
const ESCROWS_PATH = process.env.ESCROWS_PATH ?? `${ROOT}/orchestrator/private/escrows.json`;

export interface TaskEscrow {
  task_id: string;
  creator: string;
  amount: number;
  remaining: number;
  created_at: string;
}

export type EscrowBook = Record<string, TaskEscrow>;

export async function loadEscrows(): Promise<EscrowBook> {
  try {
    const raw = await Bun.file(ESCROWS_PATH).json();
    if (!raw || typeof raw !== "object") return {};
    return raw as EscrowBook;
  } catch {
    return {};
  }
}

export async function saveEscrows(escrows: EscrowBook): Promise<void> {
  await mkdir(dirname(ESCROWS_PATH), { recursive: true });
  await Bun.write(ESCROWS_PATH, JSON.stringify(escrows, null, 2));
}

export async function getEscrow(taskId: string): Promise<TaskEscrow | null> {
  return (await loadEscrows())[taskId] ?? null;
}

export async function createEscrow(taskId: string, creator: string, amount: number, at: Date = new Date()): Promise<TaskEscrow> {
  const escrows = await loadEscrows();
  if (escrows[taskId]) throw new Error(`escrow already exists for ${taskId}`);
  const escrow: TaskEscrow = {
    task_id: taskId,
    creator,
    amount,
    remaining: amount,
    created_at: at.toISOString(),
  };
  escrows[taskId] = escrow;
  await saveEscrows(escrows);
  return escrow;
}

export async function refundEscrow(
  ledger: Ledger,
  taskId: string,
  description: string,
  at: Date = new Date(),
): Promise<number> {
  const escrows = await loadEscrows();
  const escrow = escrows[taskId];
  if (!escrow || escrow.remaining <= 0) return 0;
  const amount = escrow.remaining;
  creditEscrowRefund(ledger, escrow.creator, amount, description, at);
  delete escrows[taskId];
  await saveEscrows(escrows);
  return amount;
}

export async function settleEscrowAfterPayment(
  ledger: Ledger,
  taskId: string,
  paid: number,
  at: Date = new Date(),
): Promise<{ creator: string; refunded: number } | null> {
  const escrows = await loadEscrows();
  const escrow = escrows[taskId];
  if (!escrow) return null;
  if (paid > escrow.remaining) {
    throw new Error(`escrow underfunded for ${taskId}: payment ${paid} > remaining ${escrow.remaining}`);
  }
  escrow.remaining -= paid;
  const refunded = escrow.remaining;
  if (refunded > 0) {
    creditEscrowRefund(ledger, escrow.creator, refunded, `Escrow refund: ${taskId} leftover after paying ${paid}`, at);
  }
  delete escrows[taskId];
  await saveEscrows(escrows);
  return { creator: escrow.creator, refunded };
}
