import { expect, test } from "bun:test";
import { clearingPayment } from "../orchestrator/exchange";

test("reverse Vickrey pays the second-lowest valid bid", () => {
  expect(clearingPayment([
    { price: 120_000 },
    { price: 180_000 },
    { price: 250_000 },
  ], 500_000)).toBe(180_000);
});

test("reverse Vickrey pays reservation when there is only one valid bid", () => {
  expect(clearingPayment([{ price: 120_000 }], 500_000)).toBe(500_000);
});

test("clearing payment is capped by reservation", () => {
  expect(clearingPayment([
    { price: 120_000 },
    { price: 900_000 },
  ], 500_000)).toBe(500_000);
});

test("clearing payment requires at least one valid bid", () => {
  expect(() => clearingPayment([], 500_000)).toThrow("at least one valid bid");
});
