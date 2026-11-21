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

export function calculateStaffSalary({ monthlySalary, presentDays, totalApprovedAdvance }) {
  if (!Number.isFinite(monthlySalary) || monthlySalary < 0
    || !Number.isInteger(presentDays) || presentDays < 0
    || !Number.isFinite(totalApprovedAdvance) || totalApprovedAdvance < 0) {
    throw new RangeError("Salary, present days, and approved advance must be valid non-negative values.");
  }

  const earnedLeaves = presentDays >= 28 ? 4
    : presentDays >= 21 ? 3
      : presentDays >= 14 ? 2
        : presentDays >= 7 ? 1
          : 0;
  const perDaySalary = monthlySalary / 30;
  const totalPaidDays = presentDays + earnedLeaves;
  const grossSalary = totalPaidDays * perDaySalary;

  return {
    perDaySalary,
    earnedLeaves,
    totalPaidDays,
    grossSalary,
    totalApprovedAdvance,
    finalPayable: grossSalary - totalApprovedAdvance,
  };
}
