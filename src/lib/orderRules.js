// Eat & Park - order ke saare business rules yahin hain.
// Rule badalna ho to sirf yahan badlo; Tables, Dashboard, Orders sab yahi use karte hain.

export const OPEN_WINDOW_MS = 18 * 3600 * 1000;
export const PAID_STATUSES = ["paid"];

export const isCancelled = (o) => o.status === "cancelled";

const orderCreatedAt = (order) => {
  const value = order?.createdAt;
  if (typeof value === "number") return value;
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (typeof value?.seconds === "number") return value.seconds * 1000;
  return Number(value) || 0;
};

export const isDeliveryOrder = (order) => {
  if (order.fulfillmentMode === "delivery") return true;
  if (order.orderType !== "parcel" || order.fulfillmentMode) return false;
  const address = String(order.customer?.exactAddress || order.customer?.address || "").trim();
  return Boolean(address) && !/^takeaway\b/i.test(address);
};

export const nextKitchenStatus = (order) => {
  if (order.status === "new") return "preparing";
  if (order.status === "preparing") return "ready";
  if (order.status === "ready" && order.orderType === "parcel" && isDeliveryOrder(order)) return null;
  if (order.status === "ready") return "served";
  return null;
};

// Due = udhaar, abhi paisa nahi aaya
export const isDue = (o) => o.paymentStatus === "due" && !o.paid && !isCancelled(o);

// Chalu order (table/parcel): unpaid, due nahi, cancelled nahi, aur 18 ghante ke andar
const isOpenBase = (o) =>
  !isCancelled(o) && !o.paid &&
  o.paymentStatus !== "due" && !PAID_STATUSES.includes(o.paymentStatus) &&
  Date.now() - (o.createdAt || 0) < OPEN_WINDOW_MS;

export const isOpenParcel = (o) => o.orderType === "parcel" && isOpenBase(o);
export const isOpenDineIn = (o) => o.orderType === "dine_in" && isOpenBase(o);

// "Active" = unpaid, due nahi, cancelled nahi (Tables, Dashboard, Orders tab teeno yahi)
const isActiveOrderAt = (order, now) =>
  !isCancelled(order) && !order.paid && order.paymentStatus !== "due" &&
  now - (order.createdAt || 0) < OPEN_WINDOW_MS;
export const isActiveOrder = (order) => isActiveOrderAt(order, Date.now());

// Paid orders aur unka revenue (cancelled kabhi nahi ginte)
export const paidOrders = (orders) => orders.filter((o) => o.paid && !isCancelled(o));
export const paidRevenue = (orders) =>
  paidOrders(orders).reduce((s, o) => s + (Number(o.finalTotal) || 0), 0);

export const getOrderMetrics = (orders, now = Date.now()) => {
  const list = Array.isArray(orders) ? orders : [];
  const paid = paidOrders(list);
  const activeOrders = list.filter((order) => isActiveOrderAt(order, now));

  return {
    revenue: paid.reduce((sum, order) => sum + (Number(order.finalTotal) || 0), 0),
    paidCount: paid.length,
    activeOrders,
    activeCount: activeOrders.length,
    durationMinutes: (order) => {
      const createdAt = orderCreatedAt(order);
      return createdAt ? Math.max(0, Math.floor((now - createdAt) / 60000)) : 0;
    },
  };
};

// "Paid" karte waqt Firestore me jo fields likhni hain.
export const buildPaidPatch = (order, mode, by) => {
  const patch = {
    paid: true,
    paymentStatus: "paid",
    paidAt: Date.now(),
    paidBy: by || "Staff",
    payment: mode,
  };
  
  // Paid dine-in and pickup orders are served; delivery status stays with the rider.
  const isDineIn = order.orderType === "dine_in";
  const isPaidParcelPickup = order.orderType === "parcel" && !isDeliveryOrder(order);
  if ((isDineIn || isPaidParcelPickup) && order.status !== "cancelled") {
    patch.status = "served";
    patch.servedAt = Date.now();
  }
  return patch;
};