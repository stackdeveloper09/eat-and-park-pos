export function splitPayment(total, cash) {
  const parsedTotal = Number(total);
  const amountDue = Number.isFinite(parsedTotal) ? Math.max(0, parsedTotal) : 0;
  const parsedCash = Number(cash);
  const cashAmount = Number.isFinite(parsedCash) ? Math.min(amountDue, Math.max(0, parsedCash)) : 0;

  return { cash: cashAmount, online: amountDue - cashAmount };
}

export function partialPayment(total, cash, online) {
  const parsedTotal = Number(total);
  const amountDue = Number.isFinite(parsedTotal) ? Math.max(0, parsedTotal) : 0;
  const parsedCash = Number(cash);
  const cashAmount = Number.isFinite(parsedCash) ? Math.min(amountDue, Math.max(0, parsedCash)) : 0;
  const parsedOnline = Number(online);
  const onlineAmount = Number.isFinite(parsedOnline)
    ? Math.min(amountDue - cashAmount, Math.max(0, parsedOnline))
    : 0;

  return {
    cash: cashAmount,
    online: onlineAmount,
    received: cashAmount + onlineAmount,
    due: amountDue - cashAmount - onlineAmount,
  };
}

export function outstandingDue(order) {
  const recordedDue = Number(order?.amountDue);
  if (order?.amountDue != null && Number.isFinite(recordedDue)) {
    return Math.max(0, recordedDue);
  }
  const total = Number(order?.finalTotal);
  return Number.isFinite(total) ? Math.max(0, total) : 0;
}

export function paymentBreakdown(order) {
  const parsedTotal = Number(order.paymentStatus === "due" && order.amountPaid != null ? order.amountPaid : order.finalTotal);
  const total = Number.isFinite(parsedTotal) ? Math.max(0, parsedTotal) : 0;
  const mode = String(order.payment || "cash").toLowerCase();

  if (mode === "split") {
    const recordedCash = Number(order.paymentSplit?.cash);
    const recordedOnline = Number(order.paymentSplit?.online);
    const cash = Number.isFinite(recordedCash) ? Math.min(total, Math.max(0, recordedCash)) : 0;
    const online = Number.isFinite(recordedOnline) ? Math.min(total - cash, Math.max(0, recordedOnline)) : 0;
    return { cash, upi: online, card: 0, split: total - cash - online };
  }

  return {
    cash: mode === "cash" ? total : 0,
    upi: mode === "upi" ? total : 0,
    card: mode === "card" ? total : 0,
    split: 0,
  };
}
