export const INDIA_TIME_ZONE = "Asia/Kolkata";

export function getTodayIST(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: INDIA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const result = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${result.year}-${result.month}-${result.day}`;
}

function utcDateKey(value) {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}

export const DEFAULT_SHIFTS = Object.freeze({
  morning: Object.freeze({
    name: "Morning",
    startTime: "10:00",
    endTime: "22:00",
    breakStart: "15:00",
    breakEnd: "17:00",
    halfDayLateMinutes: 30,
    lateGraceMinutes: 10,
    earlyLeaveHours: 2,
  }),
  late: Object.freeze({
    name: "Late",
    startTime: "12:00",
    endTime: "23:00",
    halfDayLateMinutes: 30,
    lateGraceMinutes: 10,
    earlyLeaveHours: 2,
  }),
});

function timestampValue(value) {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (typeof value?.toDate === "function") return value.toDate().getTime();
  if (typeof value === "string" && /^\d{1,2}:\d{2}$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function partsInIndia(value) {
  if (typeof value === "string" && /^\d{1,2}:\d{2}$/.test(value)) {
    const minutes = timeMinutes(value);
    return minutes == null ? null : { date: indiaDateKey(), minutes };
  }
  const timestamp = timestampValue(value);
  if (timestamp == null) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: INDIA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const result = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return {
    date: `${result.year}-${result.month}-${result.day}`,
    minutes: Number(result.hour) * 60 + Number(result.minute),
  };
}

function timeMinutes(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || ""));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function timestampForIndia(dateKey, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ""))) return null;
  const minute = timeMinutes(time);
  if (minute == null) return null;
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (utcDateKey(date) !== dateKey) return null;
  return Date.UTC(year, month - 1, day, Math.floor(minute / 60), minute % 60) - (5 * 60 + 30) * 60_000;
}

export function indiaDateKey(value = new Date()) {
  return getTodayIST(value);
}

export function indiaMonthKey(value = new Date()) {
  return indiaDateKey(value).slice(0, 7);
}

export function formatIndiaTime(value) {
  const timestamp = timestampValue(value);
  if (timestamp == null) return "—";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: INDIA_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(timestamp));
}

export function indiaTimeInput(value) {
  const timestamp = timestampValue(value);
  if (timestamp == null) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: INDIA_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const result = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${result.hour}:${result.minute}`;
}

export function attendanceTimestamp(dateKey, time, checkInAt = null) {
  let timestamp = timestampForIndia(dateKey, time);
  if (timestamp == null) return null;
  if (checkInAt != null) {
    const checkIn = timestampValue(checkInAt);
    if (checkIn == null) throw new RangeError("Check-in time is invalid.");
    if (timestamp < checkIn) timestamp += 24 * 60 * 60 * 1000;
  }
  return timestamp;
}

export function autoStatus(checkIn, shift, checkOut = null) {
  const checkInParts = partsInIndia(checkIn);
  const shiftStart = timeMinutes(shift?.startTime);
  if (!checkInParts || shiftStart == null) {
    throw new RangeError("A valid check-in time and shift start time are required.");
  }

  const lateMinutes = Math.max(0, checkInParts.minutes - shiftStart);
  const halfDayLateMinutes = Number.isFinite(Number(shift.halfDayLateMinutes))
    ? Number(shift.halfDayLateMinutes)
    : 30;
  const lateGraceMinutes = Number.isFinite(Number(shift.lateGraceMinutes))
    ? Number(shift.lateGraceMinutes)
    : 10;
  const hasCheckOut = checkOut != null && timestampValue(checkOut) != null;
  let earlyLeave = false;
  if (hasCheckOut && timeMinutes(shift.endTime) != null) {
    let shiftEnd = timestampForIndia(checkInParts.date, shift.endTime);
    if (timeMinutes(shift.endTime) <= shiftStart) shiftEnd += 24 * 60 * 60 * 1000;
    const checkOutTimestamp = timestampValue(checkOut);
    earlyLeave = checkOutTimestamp < shiftEnd - Number(shift.earlyLeaveHours || 0) * 60 * 60 * 1000;
  }

  return {
    status: lateMinutes >= halfDayLateMinutes ? "Half Day" : "Present",
    late: lateMinutes >= lateGraceMinutes && lateMinutes > 0,
    lateMinutes,
    earlyLeave,
  };
}

export function calculateWorkedMinutes(checkIn, checkOut, shift) {
  const start = timestampValue(checkIn);
  const end = timestampValue(checkOut);
  if (start == null || end == null || end <= start) return 0;
  let unpaidBreakMillis = 0;
  const firstDate = partsInIndia(start)?.date;
  const lastDate = partsInIndia(end)?.date;
  if (!firstDate || !lastDate || !shift?.breakStart || !shift?.breakEnd) {
    return Math.max(0, Math.round((end - start) / 60_000));
  }

  const date = new Date(`${firstDate}T00:00:00Z`);
  const finalDate = new Date(`${lastDate}T00:00:00Z`);
  while (date <= finalDate) {
    const dateKey = utcDateKey(date);
    const breakStart = timestampForIndia(dateKey, shift.breakStart);
    let breakEnd = timestampForIndia(dateKey, shift.breakEnd);
    if (breakStart != null && breakEnd != null) {
      if (breakEnd <= breakStart) breakEnd += 24 * 60 * 60 * 1000;
      unpaidBreakMillis += Math.max(0, Math.min(end, breakEnd) - Math.max(start, breakStart));
    }
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return Math.max(0, Math.round((end - start - unpaidBreakMillis) / 60_000));
}

export function isShiftRestTime(value, shift) {
  const local = partsInIndia(value);
  const start = timeMinutes(shift?.breakStart);
  const end = timeMinutes(shift?.breakEnd);
  return Boolean(local && start != null && end != null && local.minutes >= start && local.minutes < end);
}
