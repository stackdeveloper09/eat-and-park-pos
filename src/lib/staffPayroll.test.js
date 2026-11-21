import { describe, expect, test } from "vitest";
import {
  ATTENDANCE_RADIUS_METERS,
  calculateStaffSalary,
  haversineDistanceMeters,
  RESTAURANT_LOCATION,
} from "./staffPayroll";

describe("staff geofence", () => {
  test("restaurant coordinates are within the allowed radius", () => {
    expect(haversineDistanceMeters(
      RESTAURANT_LOCATION.latitude,
      RESTAURANT_LOCATION.longitude,
      RESTAURANT_LOCATION.latitude,
      RESTAURANT_LOCATION.longitude,
    )).toBe(0);
    expect(ATTENDANCE_RADIUS_METERS).toBe(100);
  });

  test("calculates distance in meters and rejects invalid coordinates", () => {
    expect(haversineDistanceMeters(0, 0, 0.001, 0)).toBeCloseTo(111.2, 0);
    expect(() => haversineDistanceMeters(91, 0, 0, 0)).toThrow(RangeError);
  });
});

describe("staff salary", () => {
  test.each([
    [6, 0], [7, 1], [13, 1], [14, 2],
    [20, 2], [21, 3], [27, 3], [28, 4],
  ])("%i present days earn %i paid leaves", (presentDays, earnedLeaves) => {
    expect(calculateStaffSalary({
      monthlySalary: 30000,
      presentDays,
      totalApprovedAdvance: 0,
    }).earnedLeaves).toBe(earnedLeaves);
  });

  test("does not cap paid days at 30 and subtracts approved advances", () => {
    expect(calculateStaffSalary({
      monthlySalary: 30000,
      presentDays: 30,
      totalApprovedAdvance: 5000,
    })).toEqual({
      perDaySalary: 1000,
      earnedLeaves: 4,
      totalPaidDays: 34,
      grossSalary: 34000,
      totalApprovedAdvance: 5000,
      finalPayable: 29000,
    });
  });
});
