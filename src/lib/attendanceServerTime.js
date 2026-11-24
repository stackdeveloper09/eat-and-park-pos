import { doc, getDocFromServer, serverTimestamp, setDoc } from "firebase/firestore";
import { db } from "../firebase";

function timestampMillis(value) {
  if (typeof value === "number") return value;
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (typeof value?.toDate === "function") return value.toDate().getTime();
  return 0;
}

export async function fetchFirebaseServerTime(uid) {
  const clockRef = doc(db, "attendanceServerTime", uid);
  await setDoc(clockRef, { serverTime: serverTimestamp() });
  const snapshot = await getDocFromServer(clockRef);
  const timestamp = timestampMillis(snapshot.data()?.serverTime);
  if (!snapshot.exists() || !timestamp) throw new Error("Firebase server time verify nahi ho saka.");
  return timestamp;
}

export function getIndiaMinutes(timestamp) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return Number(values.hour) * 60 + Number(values.minute);
}
