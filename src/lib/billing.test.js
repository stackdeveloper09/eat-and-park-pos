import { describe, expect, test } from "vitest";
import { outstandingDue, partialPayment, paymentBreakdown, splitPayment } from "./billing.js";

describe("outstandingDue", () => {
  test("uses the remaining balance when a partial payment was recorded", () => {
    expect(outstandingDue({ finalTotal: 7509, amountPaid: 6000, amountDue: 1509 })).toBe(1509);
  });

  test("falls back to the full bill for older due records without a balance", () => {
    expect(outstandingDue({ finalTotal: 7509 })).toBe(7509);
  });

  test("does not return a negative due balance", () => {
    expect(outstandingDue({ finalTotal: 7509, amountDue: -1 })).toBe(0);
  });
});

describe("splitPayment", () => {
  test("assigns the full amount to cash by default", () => {
    expect(splitPayment(425, 425)).toEqual({ cash: 425, online: 0 });
  });

  test("calculates online remainder so both tenders equal the bill", () => {
    expect(splitPayment(425, 200)).toEqual({ cash: 200, online: 225 });
  });

  test("clamps cash to the amount due", () => {
    expect(splitPayment(425, 500)).toEqual({ cash: 425, online: 0 });
    expect(splitPayment(425, -10)).toEqual({ cash: 0, online: 425 });
  });

  test("allocates split tenders in reports", () => {
    expect(paymentBreakdown({ finalTotal: 425, payment: "split", paymentSplit: { cash: 200, online: 225 } }))
      .toEqual({ cash: 200, upi: 225, card: 0, split: 0 });
  });

  test("keeps historical split payments with missing detail visible", () => {
    expect(paymentBreakdown({ finalTotal: 425, payment: "split", paymentSplit: { cash: 0, online: 0 } }))
      .toEqual({ cash: 0, upi: 0, card: 0, split: 425 });
  });

  test("assigns regular payment totals to their method", () => {
    expect(paymentBreakdown({ finalTotal: 425, payment: "cash" }))
      .toEqual({ cash: 425, upi: 0, card: 0, split: 0 });
  });
});

describe("partialPayment", () => {
  test("leaves only the unpaid balance due after a partial collection", () => {
    expect(partialPayment(7509, 6000, 0)).toEqual({
      cash: 6000,
      online: 0,
      received: 6000,
      due: 1509,
    });
  });
});
