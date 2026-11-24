import {
  collection,
  deleteField,
  doc,
  getDocs,
  query,
  Timestamp,
  where,
  writeBatch,
} from "firebase/firestore";
import { db } from "../firebase";
import { getTodayIST } from "./staffShifts";
import { fetchFirebaseServerTime, getIndiaMinutes } from "./attendanceServerTime";

function checkoutAt2200(date) {
  const [year, month, day] = date.split("-").map(Number);
  return Timestamp.fromMillis(Date.UTC(year, month - 1, day, 16, 30));
}

export async function autoCloseOpenRecords({ staffId, role }) {
  if (!staffId) return 0;
  const serverNow = await fetchFirebaseServerTime(staffId);
  const today = getTodayIST(new Date(serverNow));
  const adminRole = ["admin", "owner", "manager"].includes(String(role || "").toLowerCase());
  const attendanceQuery = adminRole
    ? query(collection(db, "attendance"), where("date", "<=", today))
    : query(collection(db, "attendance"), where("staffId", "==", staffId));
  const snapshot = await getDocs(attendanceQuery);
  const records = snapshot.docs.filter((entry) => {
    const record = entry.data();
    const legacyMissed = record.checkOutMissed === true
      || String(record.status || "").toLowerCase() === "checkout_missed";
    const shouldClose = record.checkInAt
      && !record.checkOutAt
      && (record.date < today || getIndiaMinutes(serverNow) >= 22 * 60);
    return /^\d{4}-\d{2}-\d{2}$/.test(record.date || "")
      && record.date <= today
      && (shouldClose || legacyMissed || "incomplete" in record || "checkOutMissed" in record);
  });

  for (let offset = 0; offset < records.length; offset += 400) {
    const batch = writeBatch(db);
    records.slice(offset, offset + 400).forEach((entry) => {
      const record = entry.data();
      const hasOpenCheckIn = Boolean(record.checkInAt && !record.checkOutAt);
      const shouldClose = hasOpenCheckIn && (record.date < today || getIndiaMinutes(serverNow) >= 22 * 60);
      if (!shouldClose
        && !("checkOutMissed" in record)
        && String(record.status || "").toLowerCase() !== "checkout_missed"
        && !("incomplete" in record)) return;
      const checkOutAt = shouldClose ? checkoutAt2200(record.date) : record.checkOutAt;
      const oldMissedStatus = String(record.status || "").toLowerCase() === "checkout_missed";
      const updates = {
        ...(shouldClose ? { checkOutAt, autoCheckout: true } : {}),
        ...(oldMissedStatus ? { status: "Present" } : {}),
        incomplete: deleteField(),
        checkOutMissed: deleteField(),
      };
      batch.update(doc(db, "attendance", entry.id), updates);
    });
    await batch.commit();
  }

  return records.length;
}
