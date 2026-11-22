export const RESTAURANT_LOCATION = Object.freeze({
  latitude: 28.6139,
  longitude: 77.209,
});

export const ATTENDANCE_RADIUS_METERS = 100;
const EARTH_RADIUS_METERS = 6_371_000;

export function haversineDistanceMeters(latitude1, longitude1, latitude2, longitude2) {
  const coordinates = [latitude1, longitude1, latitude2, longitude2];
  if (!coordinates.every(Number.isFinite)
    || latitude1 < -90 || latitude1 > 90
    || latitude2 < -90 || latitude2 > 90
    || longitude1 < -180 || longitude1 > 180
    || longitude2 < -180 || longitude2 > 180) {
    throw new RangeError("Coordinates must be valid latitude and longitude values.");
  }

  const radians = (degrees) => degrees * Math.PI / 180;
  const latitudeDelta = radians(latitude2 - latitude1);
  const longitudeDelta = radians(longitude2 - longitude1);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(latitude1)) * Math.cos(radians(latitude2))
    * Math.sin(longitudeDelta / 2) ** 2;

  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function daysInMonth(monthKey) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey || "")) {
    throw new RangeError("Month must be in YYYY-MM format.");
  }
  const [year, month] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isValidDateKey(dateKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey || "")) return false;
  const date = new Date(`${dateKey}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === dateKey;
}

export function dateRangeInclusive(fromDate, toDate) {
  if (!isValidDateKey(fromDate) || !isValidDateKey(toDate) || fromDate > toDate) {
    throw new RangeError("A valid date range is required.");
  }
  const current = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate}T00:00:00Z`);
  const dates = [];
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

export function attendanceDayValue(status) {
  switch (String(status || "").trim().toLowerCase()) {
    case "present": return 1;
    case "half day":
    case "half-day":
    case "half_day": return 0.5;
    case "paid leave":
    case "leave": return 1;
    default: return 0;
  }
}

export function calculateSalaryBalance(payable, paid) {
  if (!Number.isFinite(payable) || payable < 0 || !Number.isFinite(paid) || paid < 0) {
    throw new RangeError("Payable and paid salary amounts must be valid non-negative values.");
  }
  return {
    paid,
    balanceDue: Math.max(0, payable - paid),
  };
}

export function calculateStaffSalary({
  monthlySalary,
  presentDays,
  totalApprovedAdvance,
  daysInPayPeriod = 30,
  paidLeaveDays = 0,
}) {
  if (!Number.isFinite(monthlySalary) || monthlySalary < 0
    || !Number.isFinite(presentDays) || presentDays < 0
    || !Number.isFinite(paidLeaveDays) || paidLeaveDays < 0
    || !Number.isFinite(daysInPayPeriod) || daysInPayPeriod < 1
    || !Number.isFinite(totalApprovedAdvance) || totalApprovedAdvance < 0) {
    throw new RangeError("Salary, present days, and approved advance must be valid non-negative values.");
  }

  const earnedLeaves = presentDays >= 28 ? 4
    : presentDays >= 21 ? 3
      : presentDays >= 14 ? 2
        : presentDays >= 7 ? 1
          : 0;
  const perDaySalary = monthlySalary / daysInPayPeriod;
  const totalPaidDays = presentDays + paidLeaveDays + earnedLeaves;
  const grossSalary = totalPaidDays * perDaySalary;
  const finalPayable = Math.max(0, grossSalary - totalApprovedAdvance);

  return {
    perDaySalary,
    earnedLeaves,
    totalPaidDays,
    grossSalary,
    totalApprovedAdvance,
    finalPayable,
    carryForwardAdvance: Math.max(0, totalApprovedAdvance - grossSalary),
  };
}
