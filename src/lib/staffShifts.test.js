import { describe, expect, test } from "vitest";
import {
  attendanceTimestamp,
  autoStatus,
  calculateWorkedMinutes,
  DEFAULT_SHIFTS,
  indiaDateKey,
} from "./staffShifts";

describe("automatic shift attendance", () => {
  test.each([
    ["10:00", "Present", false, 0],
    ["10:10", "Present", true, 10],
    ["10:29", "Present", true, 29],
    ["10:30", "Half Day", true, 30],
    ["11:15", "Half Day", true, 75],
  ])("Morning shift at %s yields %s", (checkIn, status, late, lateMinutes) => {
    expect(autoStatus(checkIn, DEFAULT_SHIFTS.morning)).toMatchObject({
      status,
      late,
      lateMinutes,
      incomplete: true,
    });
  });

  test("Late shift at 12:30 is Half Day and an open check-in is Incomplete", () => {
    expect(autoStatus("12:30", DEFAULT_SHIFTS.late)).toMatchObject({
      status: "Half Day",
      late: true,
      lateMinutes: 30,
      incomplete: true,
    });
  });

  test("checkout after midnight is attributed to the check-in date and rest time is unpaid", () => {
    const checkIn = attendanceTimestamp("2026-11-22", "10:00");
    const checkOut = attendanceTimestamp("2026-11-22", "00:30", checkIn);
    expect(indiaDateKey(checkOut)).toBe("2026-11-23");
    expect(autoStatus(checkIn, DEFAULT_SHIFTS.morning, checkOut)).toMatchObject({
      status: "Present",
      incomplete: false,
      earlyLeave: false,
    });

    const morningOut = attendanceTimestamp("2026-11-22", "22:00");
    expect(calculateWorkedMinutes(checkIn, morningOut, DEFAULT_SHIFTS.morning)).toBe(600);
  });
});
