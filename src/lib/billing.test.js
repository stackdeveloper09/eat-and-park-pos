import { describe, expect, test } from "vitest";
import { paymentBreakdown, splitPayment } from "./billing.js";

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
