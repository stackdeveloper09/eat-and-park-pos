import { describe, expect, test } from "vitest";
import {
  ATTENDANCE_RADIUS_METERS,
  attendanceDayValue,
  calculateSalaryBalance,
  calculateStaffSalary,
  dateRangeInclusive,
  daysInMonth,
  haversineDistanceMeters,
  normalizeAttendanceRadiusMeters,
  isValidDateKey,
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
    expect(ATTENDANCE_RADIUS_METERS).toBe(150);
  });

  test("normalizes legacy 100 meter radius to 150 and preserves custom radius", () => {
    expect(normalizeAttendanceRadiusMeters(100)).toBe(150);
    expect(normalizeAttendanceRadiusMeters(180)).toBe(180);
    expect(normalizeAttendanceRadiusMeters(null)).toBe(150);
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

  test("validates historic date keys and creates inclusive date ranges", () => {
    expect(isValidDateKey("2026-02-28")).toBe(true);
    expect(isValidDateKey("2026-02-29")).toBe(false);
    expect(dateRangeInclusive("2026-11-20", "2026-11-22")).toEqual([
      "2026-11-20", "2026-11-21", "2026-11-22",
    ]);
    expect(() => dateRangeInclusive("2026-11-23", "2026-11-22")).toThrow(RangeError);
  });

  test.each([
    [5000, 0, { paid: 0, balanceDue: 5000 }],
    [5000, 1500, { paid: 1500, balanceDue: 3500 }],
    [5000, 5000, { paid: 5000, balanceDue: 0 }],
    [5000, 5500, { paid: 5500, balanceDue: 0 }],
  ])("calculates a partial salary balance for payable %i and paid %i", (payable, paid, expected) => {
    expect(calculateSalaryBalance(payable, paid)).toEqual(expected);
  });
});
