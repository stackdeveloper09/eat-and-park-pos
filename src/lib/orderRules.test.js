import { describe, test, expect } from "vitest";
import {
  isActiveOrder, isOpenDineIn, isOpenParcel, isDue, paidOrders, paidRevenue, buildPaidPatch, isDeliveryOrder, nextKitchenStatus, OPEN_WINDOW_MS,
  getOrderMetrics,
} from "./orderRules.js";

const now = () => Date.now();
const mk = (o) => ({ orderType: "dine_in", status: "new", paid: false, createdAt: now(), finalTotal: 100, ...o });

describe("order rules", () => {
  test("unpaid order active hai", () => {
    expect(isActiveOrder(mk({}))).toBe(true);
  });
  test("served par bhi unpaid hai to active hai", () => {
    expect(isActiveOrder(mk({ status: "served" }))).toBe(true);
  });
  test("paid order active nahi, chahe status ready ho", () => {
    expect(isActiveOrder(mk({ paid: true, status: "ready" }))).toBe(false);
  });
  test("due order active nahi", () => {
    expect(isActiveOrder(mk({ paymentStatus: "due" }))).toBe(false);
  });
  test("cancelled order active nahi", () => {
    expect(isActiveOrder(mk({ status: "cancelled" }))).toBe(false);
  });

  test("chalu dine-in table occupied hai", () => {
    expect(isOpenDineIn(mk({}))).toBe(true);
  });
  test("paid dine-in table occupied nahi", () => {
    expect(isOpenDineIn(mk({ paid: true }))).toBe(false);
  });
  test("18 ghante se purana order table occupied nahi", () => {
    expect(isOpenDineIn(mk({ createdAt: now() - OPEN_WINDOW_MS - 1000 }))).toBe(false);
  });
  test("parcel dine-in nahi ginta, aur dine-in parcel nahi", () => {
    expect(isOpenDineIn(mk({ orderType: "parcel" }))).toBe(false);
    expect(isOpenParcel(mk({ orderType: "dine_in" }))).toBe(false);
    expect(isOpenParcel(mk({ orderType: "parcel" }))).toBe(true);
  });
  test("delivery parcel fulfillment mode se identify hota hai", () => {
    expect(isDeliveryOrder(mk({ orderType: "parcel", fulfillmentMode: "delivery" }))).toBe(true);
  });
  test("legacy delivery parcel address se identify hota hai", () => {
    expect(isDeliveryOrder(mk({ orderType: "parcel", customer: { address: "Ara, Bihar" } }))).toBe(true);
  });
  test("takeaway parcel delivery nahi hota", () => {
    expect(isDeliveryOrder(mk({
      orderType: "parcel",
      fulfillmentMode: "takeaway",
      customer: { address: "TAKEAWAY (At Table)" },
    }))).toBe(false);
  });
  test("ready customer delivery order waits for the rider panel", () => {
    expect(nextKitchenStatus(mk({
      orderType: "parcel",
      fulfillmentMode: "delivery",
      status: "ready",
    }))).toBe(null);
  });
  test("ready takeaway parcel can be served by staff", () => {
    expect(nextKitchenStatus(mk({
      orderType: "parcel",
      fulfillmentMode: "takeaway",
      status: "ready",
    }))).toBe("served");
  });
  test("ready dine-in order can be served by staff", () => {
    expect(nextKitchenStatus(mk({ status: "ready" }))).toBe("served");
  });
  test("kitchen progression remains new to preparing to ready", () => {
    expect(nextKitchenStatus(mk({ status: "new" }))).toBe("preparing");
    expect(nextKitchenStatus(mk({ status: "preparing" }))).toBe("ready");
  });
  test(".filter(isOpenDineIn) index ki wajah se galat nahi hota", () => {
    const list = [mk({}), mk({}), mk({ paid: true })];
    expect(list.filter(isOpenDineIn)).toHaveLength(2);
  });

  test("isDue sirf unpaid due ko pakadta hai", () => {
    expect(isDue(mk({ paymentStatus: "due" }))).toBe(true);
    expect(isDue(mk({ paymentStatus: "due", paid: true }))).toBe(false);
  });

  test("revenue me sirf paid aur non-cancelled", () => {
    const list = [
      mk({ paid: true, finalTotal: 500 }),
      mk({ paid: true, finalTotal: 300, status: "cancelled" }),
      mk({ paid: false, finalTotal: 900 }),
      mk({ paid: true, finalTotal: "200" }),
    ];
    expect(paidOrders(list)).toHaveLength(2);
    expect(paidRevenue(list)).toBe(700);
  });
  test("finalTotal na ho to 0 maana jaye", () => {
    expect(paidRevenue([mk({ paid: true, finalTotal: undefined })])).toBe(0);
  });
  test("shared metrics revenue, active orders aur duration ko consistent rakhta hai", () => {
    const now = 60 * 60 * 1000;
    const list = [
      mk({ id: "active", createdAt: now - 24 * 60 * 1000 }),
      mk({ id: "paid", paid: true, createdAt: now - 60 * 60 * 1000, finalTotal: 250 }),
      mk({ id: "cancelled", paid: true, status: "cancelled", finalTotal: 500 }),
      mk({ id: "due", paymentStatus: "due" }),
    ];

    const metrics = getOrderMetrics(list, now);

    expect(metrics.revenue).toBe(250);
    expect(metrics.paidCount).toBe(1);
    expect(metrics.activeOrders.map((order) => order.id)).toEqual(["active"]);
    expect(metrics.activeCount).toBe(1);
    expect(metrics.durationMinutes(list[0])).toBe(24);
  });
  test("shared duration metric clamps future and missing timestamps", () => {
    const metrics = getOrderMetrics([], 1000);

    expect(metrics.durationMinutes({ createdAt: 2000 })).toBe(0);
    expect(metrics.durationMinutes({})).toBe(0);
  });
  test("buildPaidPatch: sahi fields likhta hai", () => {
    const p = buildPaidPatch(mk({}), "upi", "Ramesh");
    expect(p.paid).toBe(true);
    expect(p.paymentStatus).toBe("paid");
    expect(p.payment).toBe("upi");
    expect(p.paidBy).toBe("Ramesh");
    expect(typeof p.paidAt).toBe("number");
  });
  test("buildPaidPatch: naam na ho to Staff", () => {
    expect(buildPaidPatch(mk({}), "cash").paidBy).toBe("Staff");
  });
  test("buildPaidPatch: parcel paid hote hi served", () => {
    expect(buildPaidPatch(mk({ orderType: "parcel", status: "new" }), "cash").status).toBe("served");
  });
  test("buildPaidPatch: table takeaway is not treated as delivery", () => {
    expect(buildPaidPatch(mk({
      orderType: "parcel",
      fulfillmentMode: "takeaway",
      customer: { address: "TAKEAWAY (At Table)" },
      status: "new",
    }), "cash").status).toBe("served");
  });
  test("buildPaidPatch: delivery status remains with rider", () => {
    expect(buildPaidPatch(mk({
      orderType: "parcel",
      fulfillmentMode: "delivery",
      status: "new",
    }), "cash")).not.toHaveProperty("status");
  });
  test("buildPaidPatch: ready dine-in served ho jata hai", () => {
    expect(buildPaidPatch(mk({ status: "ready" }), "cash").status).toBe("served");
  });
  test("buildPaidPatch: preparing/new ka status nahi chhedta (kitchen se gayab na ho)", () => {
    expect(buildPaidPatch(mk({ status: "preparing" }), "cash")).not.toHaveProperty("status");
    expect(buildPaidPatch(mk({ status: "new" }), "cash")).not.toHaveProperty("status");
  });
});
