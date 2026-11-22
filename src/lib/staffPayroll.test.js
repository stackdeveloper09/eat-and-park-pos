import { describe, expect, test } from "vitest";
import {
  ATTENDANCE_RADIUS_METERS,
  attendanceDayValue,
  calculateStaffSalary,
  daysInMonth,
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
      carryForwardAdvance: 0,
    });
  });

  test("uses actual month length, supports half days and paid leave, and carries excess advance", () => {
    expect(daysInMonth("2026-02")).toBe(28);
    expect(daysInMonth("2024-02")).toBe(29);
    expect(daysInMonth("2026-11")).toBe(30);
    expect(attendanceDayValue("Present")).toBe(1);
    expect(attendanceDayValue("Half Day")).toBe(0.5);
    expect(attendanceDayValue("Absent")).toBe(0);
    expect(attendanceDayValue("Paid Leave")).toBe(1);

    expect(calculateStaffSalary({
      monthlySalary: 31000,
      presentDays: 2.5,
      paidLeaveDays: 1,
      totalApprovedAdvance: 6000,
      daysInPayPeriod: 31,
    })).toEqual({
      perDaySalary: 1000,
      earnedLeaves: 0,
      totalPaidDays: 3.5,
      grossSalary: 3500,
      totalApprovedAdvance: 6000,
      finalPayable: 0,
      carryForwardAdvance: 2500,
    });
  });
});
