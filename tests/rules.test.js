import { readFileSync } from "node:fs";
import { beforeAll, afterAll, describe, test } from "vitest";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, addDoc, deleteDoc, collection, getDocs, query, where } from "firebase/firestore";

let env;
const as = (uid) => env.authenticatedContext(uid).firestore();
const anon = () => env.unauthenticatedContext().firestore();

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-eatpark",
    firestore: { rules: readFileSync("firestore.rules", "utf8") },
  });
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "staff/w1"), { role: "waiter" });
    await setDoc(doc(db, "staff/a1"), { role: "admin" });
    await setDoc(doc(db, "staff/o1"), { role: "owner" });
    await setDoc(doc(db, "staff/m1"), { role: "manager" });
    await setDoc(doc(db, "staff/d1"), { role: "delivery" });
    await setDoc(doc(db, "staff/c1"), { role: "cashier" });
    await setDoc(doc(db, "staff/ch1"), { role: "chef" });
    await setDoc(doc(db, "settings/privatePins"), { pin: "x" });
    await setDoc(doc(db, "settings/menu"), { items: [] });
    await setDoc(doc(db, "orders/paid1"), { paid: true, status: "served", finalTotal: 100, createdBy: "c1" });
    await setDoc(doc(db, "orders/open1"), { paid: false, status: "new", finalTotal: 100, createdBy: "c1" });
    await setDoc(doc(db, "expenses/e1"), { amount: 10, date: "2026-10-30" });
    await setDoc(doc(db, "inventory/items"), { list: [] });
  });
});
afterAll(async () => { await env.cleanup(); });

describe("settings", () => {
  test("anon cannot read privatePins", () => assertFails(getDoc(doc(anon(), "settings/privatePins"))));
  test("waiter cannot write privatePins", () => assertFails(setDoc(doc(as("w1"), "settings/privatePins"), { pin: "y" })));
  test("admin can read privatePins", () => assertSucceeds(getDoc(doc(as("a1"), "settings/privatePins"))));
  test("anon can still read menu", () => assertSucceeds(getDoc(doc(anon(), "settings/menu"))));
});

describe("orders", () => {
  test("waiter cannot change total on paid order", () => assertFails(updateDoc(doc(as("w1"), "orders/paid1"), { finalTotal: 1 })));
  test("waiter can change status on paid order", () => assertSucceeds(updateDoc(doc(as("w1"), "orders/paid1"), { status: "served" })));
  test("owner can undo paid", () => assertSucceeds(updateDoc(doc(as("o1"), "orders/paid1"), { paid: false })));
  test("waiter can mark open order paid", () => assertSucceeds(updateDoc(doc(as("w1"), "orders/open1"), { paid: true })));
  test("waiter cannot delete order", () => assertFails(deleteDoc(doc(as("w1"), "orders/open1"))));
  test("owner role passes isStaff (reads orders)", () => assertSucceeds(getDoc(doc(as("o1"), "orders/open1"))));
  test("chef cashier waiter and staff roles can read orders", () => Promise.all([
    assertSucceeds(getDoc(doc(as("ch1"), "orders/open1"))),
    assertSucceeds(getDoc(doc(as("c1"), "orders/open1"))),
    assertSucceeds(getDoc(doc(as("w1"), "orders/open1"))),
  ]));
});

describe("other collections", () => {
  test("waiter can write auditLog", () => assertSucceeds(addDoc(collection(as("w1"), "auditLog"), { action: "x" })));
  test("waiter cannot read auditLog", () => assertFails(getDocs(collection(as("w1"), "auditLog"))));
  test("waiter can add expense", () => assertSucceeds(addDoc(collection(as("w1"), "expenses"), { amount: 5 })));
  test("waiter cannot delete expense", () => assertFails(deleteDoc(doc(as("w1"), "expenses/e1"))));
  test("waiter can read inventory", () => assertSucceeds(getDoc(doc(as("w1"), "inventory/items"))));
  test("waiter cannot write inventory", () => assertFails(setDoc(doc(as("w1"), "inventory/items"), { list: [] })));
  test("waiter cannot read dayClose", () => assertFails(getDoc(doc(as("w1"), "dayClose/2026-10-30"))));
  test("owner can write dayClose", () => assertSucceeds(setDoc(doc(as("o1"), "dayClose/2026-10-30"), { revenue: 1 })));
  test("admin can list staff profiles for payroll", () => assertSucceeds(getDocs(collection(as("a1"), "staff"))));
  test("waiter cannot list staff profiles", () => assertFails(getDocs(collection(as("w1"), "staff"))));
  test("admin can create an Auth-UID staff profile", () => assertSucceeds(setDoc(doc(as("a1"), "staff/new1"), {
    name: "New Staff", role: "staff", monthlySalary: 24000, active: true,
  })));
  test("waiter cannot create a staff profile", () => assertFails(setDoc(doc(as("w1"), "staff/new2"), {
    name: "New Staff", role: "staff", monthlySalary: 24000, active: true,
  })));
  test("admin can save GPS settings and the new radius is enforced", async () => {
    await assertSucceeds(setDoc(doc(as("a1"), "settings/restaurant"), {
      lat: 28.6139, lng: 77.209, radius: 150,
    }));
    await assertSucceeds(addDoc(collection(as("w1"), "staffAttendance"), {
      uid: "w1", name: "Waiter", role: "waiter", action: "present",
      at: Date.now(), date: "2026-11-21", distanceMeters: 120,
    }));
    await assertSucceeds(setDoc(doc(as("a1"), "settings/restaurant"), {
      lat: 28.6139, lng: 77.209, radius: 100,
    }));
  });
  test("admin owner can save shifts; waiter cannot", async () => {
    await assertSucceeds(setDoc(doc(as("a1"), "settings/shifts"), {
      shifts: {
        morning: { name: "Morning", startTime: "10:00", endTime: "22:00", breakStart: "15:00", breakEnd: "17:00", halfDayLateMinutes: 30, lateGraceMinutes: 10, earlyLeaveHours: 2 },
        late: { name: "Late", startTime: "12:00", endTime: "23:00", halfDayLateMinutes: 30, lateGraceMinutes: 10, earlyLeaveHours: 2 },
      },
    }));
    await assertFails(setDoc(doc(as("w1"), "settings/shifts"), {
      shifts: { morning: { name: "Morning", startTime: "10:00", endTime: "22:00" } },
    }));
  });
  test("admin can create and replace deterministic manual attendance", async () => {
    const attendanceRef = doc(as("a1"), "attendance/w1_2026-11-21");
    await assertSucceeds(setDoc(attendanceRef, {
      staffId: "w1", date: "2026-11-21", status: "Half Day", markedBy: "Admin", source: "manual",
    }));
    await assertSucceeds(updateDoc(attendanceRef, {
      status: "Paid Leave",
    }));
  });
  test("admin manual attendance rejects unsupported status and wrong source", async () => {
    await assertFails(setDoc(doc(as("a1"), "attendance/w1_2026-11-22"), {
      staffId: "w1", date: "2026-11-22", status: "Late", markedBy: "Admin", source: "manual",
    }));
    await assertFails(setDoc(doc(as("a1"), "attendance/w1_2026-11-23"), {
      staffId: "w1", date: "2026-11-23", status: "Present", markedBy: "Admin", source: "gps",
    }));
  });
  test("waiter cannot manually mark attendance", () => assertFails(addDoc(collection(as("w1"), "attendance"), {
    staffId: "w1", date: "2026-11-21", status: "Present", markedBy: "Admin", source: "manual",
  })));
  test("staff can request an advance and admin can approve it", async () => {
    const request = await addDoc(collection(as("w1"), "advances"), {
      staffId: "w1",
      staffName: "Waiter",
      amount: 1000,
      reason: "Travel",
      status: "Pending",
      createdAt: Date.now(),
      month: "2026-11",
    });
    await assertSucceeds(getDocs(query(collection(as("w1"), "advances"), where("staffId", "==", "w1"))));
    await assertSucceeds(getDocs(query(collection(as("a1"), "advances"), where("status", "==", "Pending"))));
    await assertSucceeds(updateDoc(doc(as("a1"), "advances", request.id), {
      status: "Approved", approvedBy: "a1", approvedAt: Date.now(),
    }));
    await assertFails(updateDoc(doc(as("w1"), "advances", request.id), { status: "Approved" }));
    await assertFails(updateDoc(doc(as("m1"), "advances", request.id), {
      status: "Rejected", rejectedBy: "m1", rejectedAt: Date.now(),
    }));
  });
  test("admin can add and cancel manual advances; staff cannot create them", async () => {
    const manual = await addDoc(collection(as("a1"), "advances"), {
      staffId: "w1", staffName: "Waiter", amount: 500, date: "2026-11-21",
      month: "2026-11", note: "Travel", reason: "Travel", source: "manual",
      status: "Approved", createdAt: Date.now(), approvedBy: "a1", approvedAt: Date.now(),
    });
    await assertSucceeds(updateDoc(doc(as("a1"), "advances", manual.id), {
      status: "Cancelled", cancelledBy: "a1", cancelledAt: Date.now(),
    }));
    await assertFails(addDoc(collection(as("w1"), "advances"), {
      staffId: "w1", staffName: "Waiter", amount: 500, date: "2026-11-21",
      month: "2026-11", note: "Manual", reason: "Manual", source: "manual",
      status: "Approved", createdAt: Date.now(), approvedBy: "w1", approvedAt: Date.now(),
    }));
    await assertFails(addDoc(collection(as("m1"), "advances"), {
      staffId: "w1", staffName: "Waiter", amount: 500, date: "2026-11-21",
      month: "2026-11", note: "Manual", reason: "Manual", source: "manual",
      status: "Approved", createdAt: Date.now(), approvedBy: "m1", approvedAt: Date.now(),
    }));
  });
  test("staff can create and cancel only their own pending leave request", async () => {
    const pending = await addDoc(collection(as("w1"), "leaveRequests"), {
      staffId: "w1", staffName: "Waiter", fromDate: "2026-11-20", toDate: "2026-11-21",
      type: "Paid Leave", reason: "Family", status: "pending", createdAt: Date.now(),
    });
    await assertSucceeds(getDoc(doc(as("w1"), "leaveRequests", pending.id)));
    await assertSucceeds(updateDoc(doc(as("w1"), "leaveRequests", pending.id), {
      status: "cancelled", cancelledAt: Date.now(),
    }));
    const other = await env.withSecurityRulesDisabled(async (ctx) => {
      const ref = doc(ctx.firestore(), "leaveRequests/for-w1");
      await setDoc(ref, {
        staffId: "a1", staffName: "Admin", fromDate: "2026-11-20", toDate: "2026-11-21",
        type: "Paid Leave", reason: "Family", status: "pending", createdAt: Date.now(),
      });
      return ref.id;
    });
    await assertFails(getDoc(doc(as("w1"), "leaveRequests", other)));
    await assertFails(addDoc(collection(as("w1"), "leaveRequests"), {
      staffId: "a1", staffName: "Admin", fromDate: "2026-11-20", toDate: "2026-11-21",
      type: "Paid Leave", reason: "Family", status: "pending", createdAt: Date.now(),
    }));
    await assertSucceeds(updateDoc(doc(as("a1"), "leaveRequests", other), {
      status: "approved", adminNote: "Approved", decidedBy: "a1", decidedAt: Date.now(),
    }));
    await assertSucceeds(setDoc(doc(as("a1"), "attendance/a1_2026-11-20"), {
      staffId: "a1", date: "2026-11-20", status: "Paid Leave", markedBy: "Admin",
      source: "leave", leaveRequestId: other,
    }));
  });
  test("admins write salary payments; staff reads are scoped and payments soft-cancel", async () => {
    const payment = await addDoc(collection(as("a1"), "salaryPayments"), {
      staffId: "w1", month: "2026-11", amount: 4000, date: "2026-11-22",
      note: "Part payment", createdBy: "a1", createdAt: Date.now(), status: "paid",
    });
    await assertSucceeds(updateDoc(doc(as("a1"), "salaryPayments", payment.id), {
      status: "cancelled", cancelledBy: "a1", cancelledAt: Date.now(),
    }));
    await assertFails(addDoc(collection(as("w1"), "salaryPayments"), {
      staffId: "w1", month: "2026-11", amount: 1000, date: "2026-11-22",
      note: "", createdBy: "w1", createdAt: Date.now(), status: "paid",
    }));
    await assertFails(addDoc(collection(as("m1"), "salaryPayments"), {
      staffId: "w1", month: "2026-11", amount: 1000, date: "2026-11-22",
      note: "", createdBy: "m1", createdAt: Date.now(), status: "paid",
    }));
    await assertSucceeds(setDoc(doc(as("a1"), "salaryCarryForwards/w1_2026-11"), {
      staffId: "w1", fromMonth: "2026-11", month: "2026-12", amount: 2000,
      status: "active", createdBy: "a1", createdAt: Date.now(), updatedAt: Date.now(), updatedBy: "a1",
    }));
    await assertSucceeds(updateDoc(doc(as("o1"), "salaryCarryForwards/w1_2026-11"), {
      amount: 1500, updatedAt: Date.now(), updatedBy: "o1",
    }));
    await assertFails(setDoc(doc(as("w1"), "salaryCarryForwards/w1_2026-11"), {
      staffId: "w1", fromMonth: "2026-11", month: "2026-12", amount: 2000,
      status: "active", createdBy: "w1", createdAt: Date.now(), updatedAt: Date.now(), updatedBy: "w1",
    }));
  });
  test("admin can save a staff salary", () => assertSucceeds(setDoc(doc(as("a1"), "staffPayroll/w1"), {
    uid: "w1", monthlySalary: 30000, updatedAt: Date.now(), updatedBy: "a1",
  })));
  test("staff can read their own salary", () => assertSucceeds(getDoc(doc(as("w1"), "staffPayroll/w1"))));
  test("waiter cannot write staff salary", () => assertFails(setDoc(doc(as("w1"), "staffPayroll/w1"), {
    uid: "w1", monthlySalary: 30000, updatedAt: Date.now(), updatedBy: "w1",
  })));
  test("staff can edit only their own phone field", async () => {
    await assertSucceeds(updateDoc(doc(as("w1"), "staff/w1"), { phone: "+919876543210" }));
    await assertFails(updateDoc(doc(as("w1"), "staff/w1"), { monthlySalary: 1 }));
    await assertFails(updateDoc(doc(as("w1"), "staff/a1"), { phone: "+919876543210" }));
  });
  test("staff can read only their own salary payments and carry-forwards", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "salaryPayments/payment-w1"), {
        staffId: "w1", month: "2026-11", amount: 4000, date: "2026-11-22",
        note: "", createdBy: "a1", createdAt: Date.now(), status: "paid",
      });
      await setDoc(doc(db, "salaryPayments/payment-c1"), {
        staffId: "c1", month: "2026-11", amount: 4000, date: "2026-11-22",
        note: "", createdBy: "a1", createdAt: Date.now(), status: "paid",
      });
      await setDoc(doc(db, "salaryCarryForwards/carry-w1"), {
        staffId: "w1", fromMonth: "2026-10", month: "2026-11", amount: 500,
        status: "active", createdBy: "a1", createdAt: Date.now(), updatedAt: Date.now(), updatedBy: "a1",
      });
    });
    await assertSucceeds(getDoc(doc(as("w1"), "salaryPayments/payment-w1")));
    await assertFails(getDoc(doc(as("w1"), "salaryPayments/payment-c1")));
    await assertSucceeds(getDoc(doc(as("w1"), "salaryCarryForwards/carry-w1")));
  });
  test("staff can read and mark read only their own notifications", async () => {
    await assertSucceeds(setDoc(doc(as("a1"), "notifications/for-w1"), {
      userId: "w1", title: "Test", message: "Message", read: false, createdAt: Date.now(),
    }));
    await assertSucceeds(getDoc(doc(as("w1"), "notifications/for-w1")));
    await assertSucceeds(updateDoc(doc(as("w1"), "notifications/for-w1"), { read: true }));
    await assertFails(updateDoc(doc(as("w1"), "notifications/for-w1"), { message: "Changed" }));
    await assertFails(getDoc(doc(as("c1"), "notifications/for-w1")));
    await assertFails(setDoc(doc(as("w1"), "notifications/staff-created"), {
      userId: "w1", title: "Test", message: "Message", read: false, createdAt: Date.now(),
    }));
  });
  test("staff can mark attendance only for self and inside the radius", async () => {
    await assertSucceeds(setDoc(doc(as("w1"), "attendance/w1_2026-11-21"), {
      staffId: "w1", date: "2026-11-21", status: "Present", source: "gps",
      distanceMeters: 80, checkInAt: Date.now() - 60000, shiftId: "morning",
      shiftName: "Morning", late: false, lateMinutes: 0, incomplete: true, earlyLeave: false,
    }));
    await assertSucceeds(updateDoc(doc(as("w1"), "attendance/w1_2026-11-21"), {
      checkOutAt: Date.now(), incomplete: false, earlyLeave: false,
      workedMinutes: 600,
    }));
    await assertSucceeds(getDocs(query(collection(as("w1"), "attendance"), where("staffId", "==", "w1"))));
    await assertFails(addDoc(collection(as("w1"), "attendance"), {
      staffId: "a1", date: "2026-11-21", status: "Present", distanceMeters: 80,
    }));
    await assertFails(addDoc(collection(as("w1"), "attendance"), {
      staffId: "w1", date: "2026-11-21", status: "Present", distanceMeters: 120,
    }));
    await assertSucceeds(addDoc(collection(as("w1"), "staffAttendance"), {
      uid: "w1", name: "Waiter", role: "waiter", action: "present",
      at: Date.now(), date: "2026-11-21", distanceMeters: 80,
    }));
    await assertSucceeds(getDocs(query(collection(as("w1"), "staffAttendance"), where("uid", "==", "w1"))));
    await assertFails(addDoc(collection(as("w1"), "staffAttendance"), {
      uid: "w1", name: "Waiter", role: "waiter", action: "present",
      at: Date.now(), date: "2026-11-21", distanceMeters: 120,
    }));
    await assertFails(addDoc(collection(as("w1"), "staffAttendance"), {
      uid: "a1", name: "Admin", role: "admin", action: "present",
      at: Date.now(), date: "2026-11-21", distanceMeters: 80,
    }));
  });
  test("admin can create an approved staff advance", () => assertSucceeds(addDoc(collection(as("a1"), "staffAdvances"), {
    uid: "w1", amount: 1000, month: "2026-11", status: "approved",
    createdAt: Date.now(), approvedBy: "a1",
  })));
  test("delivery staff can mark their own attendance", () => assertSucceeds(addDoc(collection(as("d1"), "staffAttendance"), {
    uid: "d1", name: "Rider", role: "delivery", action: "present",
    at: Date.now(), date: "2026-11-21", distanceMeters: 80,
  })));
});
