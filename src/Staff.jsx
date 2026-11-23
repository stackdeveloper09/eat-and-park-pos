import React, { useEffect, useMemo, useState } from "react";
import { auth, db, functions } from "./firebase";
import { httpsCallable } from "firebase/functions";
import {
  addDoc,
  collection,
  doc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import {
  ATTENDANCE_RADIUS_METERS,
  attendanceDayValue,
  calculateSalaryBalance,
  calculateStaffSalary,
  dateRangeInclusive,
  daysInMonth,
  isValidDateKey,
  RESTAURANT_LOCATION,
} from "./lib/staffPayroll";
import {
  attendanceTimestamp,
  autoStatus,
  calculateWorkedMinutes,
  DEFAULT_SHIFTS,
  formatIndiaTime,
  indiaTimeInput,
  indiaDateKey,
  indiaMonthKey,
} from "./lib/staffShifts";
import { ROLES } from "./lib/roles";

const ATTENDANCE_STATUSES = ["Present", "Half Day", "Absent", "Paid Leave"];
const TABS = [
  { id: "staff", label: "Staff Management" },
  { id: "shifts", label: "Shift Settings" },
  { id: "gps", label: "GPS Settings" },
  { id: "advances", label: "Advance Requests" },
  { id: "leaves", label: "Leave Requests" },
  { id: "payroll", label: "Payroll & Attendance" },
];

const currentMonthKey = () => indiaMonthKey();
const todayKey = () => indiaDateKey();

const nextMonthKey = (monthKey) => {
  const [year, month] = monthKey.split("-").map(Number);
  const next = new Date(Date.UTC(year, month, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
};


const formatCurrency = (value) => new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 2,
}).format(value);

const getErrorMessage = (error) => (
  error instanceof Error ? error.message : "Something went wrong. Please try again."
);

function getStaffId(record) {
  return record.staffId || record.uid || "";
}

function displayStaffName(member) {
  return String(member?.name || "").trim() || String(member?.id || "").slice(0, 6);
}

function normalizedAttendanceStatus(record) {
  if (record.action === "present") return "Present";
  const status = String(record.status || "").trim().toLowerCase();
  if (status === "half day" || status === "half-day" || status === "half_day") return "Half Day";
  if (status === "paid leave" || status === "leave") return "Paid Leave";
  if (status === "absent") return "Absent";
  return status === "present" ? "Present" : "";
}

function attendanceSource(record) {
  if (record.source === "leave") return "leave";
  return record.source === "gps" || record.distanceMeters != null || record.action === "present"
    ? "gps"
    : "manual";
}

function getRecordMonth(record) {
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(record.month || "")) return record.month;
  const createdAt = record.createdAt;
  const date = createdAt && typeof createdAt.toDate === "function"
    ? createdAt.toDate()
    : createdAt
      ? new Date(createdAt)
      : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function normalizeStaffPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `+91${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return "";
}

function staffWelcomeWhatsAppUrl(member, name, phone) {
  const normalizedPhone = normalizeStaffPhone(phone);
  if (!normalizedPhone) return "";
  const message = [
    `Namaste ${name || member.name || "Staff"}, Eat & Park mein aapka swagat hai.`,
    ...(member.email ? [`Login ID: ${member.email}`] : []),
    "Login link: https://eatndpark.vercel.app/staff",
    member.mustChangePassword === true
      ? "Pehli baar login karne par apna naya password set karna hoga."
      : "Apne existing password se login karein.",
    "- Team Eat & Park",
  ].join("\n");
  return `https://wa.me/${normalizedPhone.replace(/\D/g, "")}?text=${encodeURIComponent(message)}`;
}

export default function Staff({ C, isMobile }) {
  const [activeTab, setActiveTab] = useState("staff");
  const [month, setMonth] = useState(currentMonthKey);
  const [members, setMembers] = useState([]);
  const [shifts, setShifts] = useState(DEFAULT_SHIFTS);
  const [shiftDrafts, setShiftDrafts] = useState(DEFAULT_SHIFTS);
  const [shiftSaveStates, setShiftSaveStates] = useState({});
  const [shiftSettingsLoading, setShiftSettingsLoading] = useState(true);
  const [staffDrafts, setStaffDrafts] = useState({});
  const [staffSaveStates, setStaffSaveStates] = useState({});
  const [addStaffOpen, setAddStaffOpen] = useState(false);
  const [createdStaffCredentials, setCreatedStaffCredentials] = useState(null);
  const [selectedMemberId, setSelectedMemberId] = useState("");
  const [paymentMemberId, setPaymentMemberId] = useState("");
  const [paymentForm, setPaymentForm] = useState({
    amount: "",
    date: todayKey(),
    note: "",
    carryForward: false,
  });
  const [advanceForm, setAdvanceForm] = useState({
    staffId: "",
    amount: "",
    date: todayKey(),
    note: "",
  });
  const [advanceFilterStaff, setAdvanceFilterStaff] = useState("all");
  const [advanceFilterMonth, setAdvanceFilterMonth] = useState(currentMonthKey);
  const [advanceNoteDrafts, setAdvanceNoteDrafts] = useState({});
  const [leaveNoteDrafts, setLeaveNoteDrafts] = useState({});
  const [legacyPayroll, setLegacyPayroll] = useState({});
  const [advanceRequests, setAdvanceRequests] = useState([]);
  const [legacyAdvances, setLegacyAdvances] = useState([]);
  const [salaryPayments, setSalaryPayments] = useState([]);
  const [salaryCarryForwards, setSalaryCarryForwards] = useState([]);
  const [leaveRequests, setLeaveRequests] = useState([]);
  const [manualAttendance, setManualAttendance] = useState([]);
  const [gpsAttendance, setGpsAttendance] = useState([]);
  const [gpsAttendanceLoading, setGpsAttendanceLoading] = useState(true);
  const [manualAttendanceLoading, setManualAttendanceLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [newStaff, setNewStaff] = useState({
    accountMode: "create",
    uid: "",
    email: "",
    phone: "",
    name: "",
    role: "staff",
    monthlySalary: "",
    active: true,
    shiftId: "morning",
  });
  const [gpsForm, setGpsForm] = useState({
    lat: String(RESTAURANT_LOCATION.latitude),
    lng: String(RESTAURANT_LOCATION.longitude),
    radius: String(ATTENDANCE_RADIUS_METERS),
  });
  const [gpsLoading, setGpsLoading] = useState(true);
  const [gpsSaved, setGpsSaved] = useState(null);
  const [gpsAccuracy, setGpsAccuracy] = useState(null);
  const [gpsLocating, setGpsLocating] = useState(false);
  const [gpsError, setGpsError] = useState("");
  const [attendanceForm, setAttendanceForm] = useState({
    staffId: "",
    date: todayKey(),
    status: "Present",
    checkInTime: "",
    checkOutTime: "",
  });

  const currentAdminRole = members.find((member) => member.id === auth.currentUser?.uid)?.role;
  const canEditShifts = currentAdminRole === "admin" || currentAdminRole === "owner";
  const whatsappPhone = createdStaffCredentials?.phone
    ? String(createdStaffCredentials.phone).replace(/\D/g, "")
    : "";
  const whatsappMessage = createdStaffCredentials
    ? [
      `Namaste ${createdStaffCredentials.name}, aapka Eat & Park account ban gaya hai.`,
      `Login ID: ${createdStaffCredentials.email}`,
      `Temporary password: ${createdStaffCredentials.temporaryPassword}`,
      "Login link: https://eatndpark.vercel.app/staff",
      "Pehli baar login karne par apna naya password set karna hoga",
    ].join("\n")
    : "";
  const whatsappHref = whatsappPhone
    ? `https://wa.me/${whatsappPhone}?text=${encodeURIComponent(whatsappMessage)}`
    : "";

  useEffect(() => {
    const unsubscribe = onSnapshot(collection(db, "staff"), (snapshot) => {
      const staffList = snapshot.docs
        .map((staffDoc) => ({ id: staffDoc.id, ...staffDoc.data() }))
        .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
      setMembers(staffList);
      setAttendanceForm((form) => {
        if (form.staffId) return form;
        const firstActiveMember = staffList.find((member) => member.active !== false);
        return firstActiveMember ? { ...form, staffId: firstActiveMember.id } : form;
      });
      setAdvanceForm((form) => {
        if (form.staffId) return form;
        const firstActiveMember = staffList.find((member) => member.active !== false);
        return firstActiveMember ? { ...form, staffId: firstActiveMember.id } : form;
      });
      setLoadError("");
    }, (error) => {
      console.error("Staff list load failed:", error);
      setLoadError(`Staff list load nahi hui: ${getErrorMessage(error)}`);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const shiftsRef = doc(db, "settings", "shifts");
    const unsubscribe = onSnapshot(shiftsRef, (snapshot) => {
      if (snapshot.exists()) {
        const savedShifts = snapshot.data()?.shifts;
        if (!savedShifts || typeof savedShifts !== "object") {
          setLoadError("Shift settings ka format invalid hai.");
          setShiftSettingsLoading(false);
          return;
        }
        setShifts(savedShifts);
        setShiftDrafts(savedShifts);
      } else {
        setShifts(DEFAULT_SHIFTS);
        setShiftDrafts(DEFAULT_SHIFTS);
        if (canEditShifts) {
          setDoc(shiftsRef, { shifts: DEFAULT_SHIFTS }).catch((error) => {
            console.error("Default shift settings seed failed:", error);
            setLoadError(`Default shifts save nahi hue: ${getErrorMessage(error)}`);
          });
        }
      }
      setShiftSettingsLoading(false);
    }, (error) => {
      console.error("Shift settings load failed:", error);
      setLoadError(`Shift settings load nahi hui: ${getErrorMessage(error)}`);
      setShiftSettingsLoading(false);
    });
    return unsubscribe;
  }, [canEditShifts]);

  useEffect(() => {
    const unsubscribe = onSnapshot(collection(db, "staffPayroll"), (snapshot) => {
      setLegacyPayroll(Object.fromEntries(
        snapshot.docs.map((payrollDoc) => [payrollDoc.id, payrollDoc.data()]),
      ));
    }, (error) => {
      console.error("Legacy staff payroll load failed:", error);
      setLoadError(`Payroll data load nahi hua: ${getErrorMessage(error)}`);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribeRequests = onSnapshot(collection(db, "advances"), (snapshot) => {
      setAdvanceRequests(snapshot.docs.map((entry) => {
        const data = entry.data();
        return {
          id: entry.id,
          ...data,
          collectionName: "advances",
          source: data.source || "request",
        };
      }));
    }, (error) => {
      console.error("Advance requests load failed:", error);
      setLoadError(`Advance requests load nahi hui: ${getErrorMessage(error)}`);
    });
    const unsubscribeLegacy = onSnapshot(collection(db, "staffAdvances"), (snapshot) => {
      setLegacyAdvances(snapshot.docs.map((entry) => {
        const data = entry.data();
        return {
          id: entry.id,
          ...data,
          collectionName: "staffAdvances",
          source: data.source || "request",
        };
      }));
    }, (error) => {
      console.error("Legacy staff advances load failed:", error);
      setLoadError(`Payroll advances load nahi hui: ${getErrorMessage(error)}`);
    });
    const unsubscribePayments = onSnapshot(collection(db, "salaryPayments"), (snapshot) => {
      setSalaryPayments(snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() })));
    }, (error) => {
      console.error("Salary payments load failed:", error);
      setLoadError(`Salary payments load nahi hui: ${getErrorMessage(error)}`);
    });
    const unsubscribeCarryForwards = onSnapshot(collection(db, "salaryCarryForwards"), (snapshot) => {
      setSalaryCarryForwards(snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() })));
    }, (error) => {
      console.error("Salary carry-forward load failed:", error);
      setLoadError(`Carry-forward balances load nahi hue: ${getErrorMessage(error)}`);
    });
    const unsubscribeLeaves = onSnapshot(collection(db, "leaveRequests"), (snapshot) => {
      setLeaveRequests(snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() })));
    }, (error) => {
      console.error("Leave requests load failed:", error);
      setLoadError(`Leave requests load nahi hui: ${getErrorMessage(error)}`);
    });
    return () => {
      unsubscribeRequests();
      unsubscribeLegacy();
      unsubscribePayments();
      unsubscribeCarryForwards();
      unsubscribeLeaves();
    };
  }, []);

  useEffect(() => {
    const unsubscribe = onSnapshot(doc(db, "settings", "restaurant"), (snapshot) => {
      if (snapshot.exists()) {
        const settings = snapshot.data();
        setGpsForm({
          lat: String(settings.lat),
          lng: String(settings.lng),
          radius: String(settings.radius),
        });
        setGpsSaved({ lat: settings.lat, lng: settings.lng });
      }
      setGpsLoading(false);
    }, (error) => {
      console.error("Restaurant GPS settings load failed:", error);
      setLoadError(`GPS settings load nahi hui: ${getErrorMessage(error)}`);
      setGpsLoading(false);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const startDate = `${month}-01`;
    const endDate = `${nextMonthKey(month)}-01`;
    const attendanceQuery = query(
      collection(db, "attendance"),
      where("date", ">=", startDate),
      where("date", "<", endDate),
    );
    const gpsQuery = query(
      collection(db, "staffAttendance"),
      where("date", ">=", startDate),
      where("date", "<", endDate),
    );
    const unsubscribeManual = onSnapshot(attendanceQuery, (snapshot) => {
      setManualAttendance(snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() })));
      setManualAttendanceLoading(false);
    }, (error) => {
      console.error("Monthly manual attendance load failed:", error);
      setLoadError(`Monthly attendance load nahi hui: ${getErrorMessage(error)}`);
      setManualAttendanceLoading(false);
    });
    const unsubscribeGps = onSnapshot(gpsQuery, (snapshot) => {
      setGpsAttendance(snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data(), source: "gps" })));
      setGpsAttendanceLoading(false);
    }, (error) => {
      console.error("Monthly GPS attendance load failed:", error);
      setLoadError(`Monthly GPS attendance load nahi hui: ${getErrorMessage(error)}`);
      setGpsAttendanceLoading(false);
    });
    return () => {
      unsubscribeManual();
      unsubscribeGps();
    };
  }, [month]);

  const activeMembers = useMemo(
    () => members.filter((member) => member.active !== false),
    [members],
  );

  const allAttendanceRecords = useMemo(() => {
    const recordsByStaffDate = new Map();
    [...gpsAttendance, ...manualAttendance].forEach((record) => {
      const staffId = getStaffId(record);
      if (!staffId || !record.date) return;
      const key = `${staffId}_${record.date}`;
      const status = normalizedAttendanceStatus(record);
      if (!status) return;
      const normalized = {
        ...record,
        status,
        source: attendanceSource(record),
      };
      const current = recordsByStaffDate.get(key);
      const sourcePriority = { gps: 0, manual: 1, leave: 2 };
      if (!current || sourcePriority[normalized.source] > sourcePriority[current.source]) {
        recordsByStaffDate.set(key, normalized);
      }
    });
    return recordsByStaffDate;
  }, [gpsAttendance, manualAttendance]);

  const attendanceStatsByStaff = useMemo(() => {
    const stats = new Map();
    allAttendanceRecords.forEach((record) => {
      if (!record.date?.startsWith(`${month}-`)) return;
      const staffId = getStaffId(record);
      const current = stats.get(staffId) || { presentDays: 0, paidLeaveDays: 0 };
      if (record.status === "Paid Leave") current.paidLeaveDays += 1;
      else current.presentDays += attendanceDayValue(record.status);
      stats.set(staffId, current);
    });
    return stats;
  }, [allAttendanceRecords, month]);

  const approvedAdvanceTotals = useMemo(() => {
    const totals = new Map();
    [...advanceRequests, ...legacyAdvances].forEach((advance) => {
      const staffId = getStaffId(advance);
      const amount = Number(advance.amount);
      if (!staffId
        || String(advance.status || "").toLowerCase() !== "approved"
        || getRecordMonth(advance) !== month
        || !Number.isFinite(amount)
        || amount < 0) return;
      totals.set(staffId, (totals.get(staffId) || 0) + amount);
    });
    return totals;
  }, [advanceRequests, legacyAdvances, month]);

  const approvedAdvancesByStaff = useMemo(() => {
    const advancesByStaff = new Map();
    [...advanceRequests, ...legacyAdvances].forEach((advance) => {
      const staffId = getStaffId(advance);
      if (!staffId
        || String(advance.status || "").toLowerCase() !== "approved"
        || getRecordMonth(advance) !== month) return;
      const list = advancesByStaff.get(staffId) || [];
      list.push(advance);
      advancesByStaff.set(staffId, list);
    });
    advancesByStaff.forEach((list) => list.sort((a, b) => {
      const dateA = a.date || getRecordMonth(a);
      const dateB = b.date || getRecordMonth(b);
      return String(dateB).localeCompare(String(dateA));
    }));
    return advancesByStaff;
  }, [advanceRequests, legacyAdvances, month]);

  const payrollMembers = useMemo(() => activeMembers.filter((member) => {
    const monthlySalary = Number(legacyPayroll[member.id]?.monthlySalary ?? member.monthlySalary ?? 0);
    return Number.isFinite(monthlySalary) && monthlySalary > 0;
  }), [activeMembers, legacyPayroll]);
  const selectedMember = members.find((member) => member.id === selectedMemberId) || null;

  const allAdvances = useMemo(
    () => [...advanceRequests, ...legacyAdvances],
    [advanceRequests, legacyAdvances],
  );
  const payrollRows = useMemo(() => payrollMembers.map((member) => {
    const stats = attendanceStatsByStaff.get(member.id) || { presentDays: 0, paidLeaveDays: 0 };
    const approvedAdvance = approvedAdvanceTotals.get(member.id) || 0;
    const monthlySalary = Number(legacyPayroll[member.id]?.monthlySalary ?? member.monthlySalary ?? 0);
    const salary = calculateStaffSalary({
      monthlySalary,
      presentDays: stats.presentDays,
      paidLeaveDays: stats.paidLeaveDays,
      totalApprovedAdvance: approvedAdvance,
      daysInPayPeriod: daysInMonth(month),
    });
    const carryForwardIn = salaryCarryForwards
      .filter((entry) => entry.staffId === member.id
        && entry.month === month
        && String(entry.status || "active").toLowerCase() === "active")
      .reduce((total, entry) => total + Number(entry.amount || 0), 0);
    const paid = salaryPayments
      .filter((payment) => payment.staffId === member.id
        && payment.month === month
        && String(payment.status || "paid").toLowerCase() !== "cancelled")
      .reduce((total, payment) => total + Number(payment.amount || 0), 0);
    const payable = salary.finalPayable + carryForwardIn;
    const { balanceDue } = calculateSalaryBalance(payable, paid);
    return {
      member,
      monthlySalary,
      stats,
      salary,
      approvedAdvance,
      carryForwardIn,
      payable,
      paid,
      balanceDue,
      status: balanceDue === 0 ? "Paid" : paid > 0 ? "Partial" : "Unpaid",
    };
  }), [
    attendanceStatsByStaff,
    approvedAdvanceTotals,
    legacyPayroll,
    month,
    payrollMembers,
    salaryCarryForwards,
    salaryPayments,
  ]);
  const payrollSummary = useMemo(() => payrollRows.reduce((summary, row) => ({
    gross: summary.gross + row.salary.grossSalary,
    advances: summary.advances + row.approvedAdvance,
    paid: summary.paid + row.paid,
    payable: summary.payable + row.balanceDue,
  }), { gross: 0, advances: 0, paid: 0, payable: 0 }), [payrollRows]);

  const advanceHistory = useMemo(() => allAdvances.filter((advance) => (
    (advanceFilterStaff === "all" || getStaffId(advance) === advanceFilterStaff)
    && (advanceFilterMonth === "all" || getRecordMonth(advance) === advanceFilterMonth)
  )).sort((a, b) => String(b.date || getRecordMonth(b)).localeCompare(String(a.date || getRecordMonth(a)))), [
    advanceFilterMonth,
    advanceFilterStaff,
    allAdvances,
  ]);
  const approvedAdvanceSummary = useMemo(() => {
    const byStaff = new Map();
    allAdvances.forEach((advance) => {
      if (String(advance.status || "").toLowerCase() !== "approved") return;
      const staffId = getStaffId(advance);
      if (!staffId) return;
      const amount = Number(advance.amount || 0);
      if (!Number.isFinite(amount) || amount < 0) return;
      const current = byStaff.get(staffId) || { month: 0, overall: 0 };
      current.overall += amount;
      if (getRecordMonth(advance) === month) current.month += amount;
      byStaff.set(staffId, current);
    });
    return {
      byStaff,
      month: [...byStaff.values()].reduce((total, entry) => total + entry.month, 0),
      overall: [...byStaff.values()].reduce((total, entry) => total + entry.overall, 0),
    };
  }, [allAdvances, month]);

  const pendingRequests = useMemo(
    () => allAdvances
      .filter((advance) => String(advance.status || "").toLowerCase() === "pending")
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)),
    [allAdvances],
  );

  const reportError = (context, error) => {
    console.error(`${context}:`, error);
    const message = `${context}: ${getErrorMessage(error)}`;
    setActionError(message);
    window.alert(message);
  };

  const handleAddStaff = async (event) => {
    event.preventDefault();
    setActionError("");
    setCreatedStaffCredentials(null);
    const uid = newStaff.uid.trim();
    const email = newStaff.email.trim().toLowerCase();
    const name = newStaff.name.trim();
    const phone = normalizeStaffPhone(newStaff.phone);
    const monthlySalary = newStaff.monthlySalary.trim() ? Number(newStaff.monthlySalary) : NaN;
    const validRole = ROLES.some((role) => role.value === newStaff.role);
    if (
      !name ||
      (newStaff.accountMode === "create" && !phone) ||
      !validRole ||
      !Number.isFinite(monthlySalary) ||
      monthlySalary < 0 ||
      (newStaff.accountMode === "create"
        ? !email
        : !uid)
    ) {
      setActionError(newStaff.accountMode === "create"
        ? "Name, role, valid salary, email, aur sahi WhatsApp number bharein."
        : "Name, role, valid salary, aur existing Auth UID sahi bharein.");
      return;
    }
    setBusyId("add-staff");
    try {
      if (newStaff.accountMode === "create") {
        const response = await httpsCallable(functions, "createStaffAccount")({
          email,
          name,
          phone,
          role: newStaff.role,
          monthlySalary,
          active: newStaff.active,
          shiftId: newStaff.shiftId || "",
        });
        setCreatedStaffCredentials(response.data);
        if (!response.data.emailSent) {
          setActionError("Account ban gaya, email nahi gaya, WhatsApp wala button use karo.");
        }
      } else {
        await runTransaction(db, async (transaction) => {
          const staffRef = doc(db, "staff", uid);
          if ((await transaction.get(staffRef)).exists()) {
            throw new Error("Is Auth UID ka staff profile pehle se maujood hai.");
          }
          transaction.set(staffRef, {
            name,
            role: newStaff.role,
            monthlySalary,
            active: newStaff.active,
            shiftId: newStaff.shiftId || "",
          });
        });
      }
      setNewStaff({
        accountMode: "create",
        uid: "",
        email: "",
        phone: "",
        name: "",
        role: "staff",
        monthlySalary: "",
        active: true,
        shiftId: "morning",
      });
      setAddStaffOpen(false);
    } catch (error) {
      const message = error?.code === "functions/not-found"
        ? "createStaffAccount Cloud Function deploy karein, phir dobara try karein."
        : getErrorMessage(error);
      setActionError(`Staff member add nahi hua: ${message}`);
      console.error("Staff member add failed:", error);
    } finally {
      setBusyId("");
    }
  };

  const handleSaveGps = async (event) => {
    event.preventDefault();
    setActionError("");
    setGpsError("");
    const lat = Number(gpsForm.lat);
    const lng = Number(gpsForm.lng);
    const radius = Number(gpsForm.radius);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90
      || !Number.isFinite(lng) || lng < -180 || lng > 180
      || !Number.isFinite(radius) || radius <= 0 || radius > 10000) {
      setGpsError("Valid latitude, longitude aur radius (1–10,000 meters) enter karein.");
      return;
    }
    setBusyId("gps");
    try {
      await setDoc(doc(db, "settings", "restaurant"), { lat, lng, radius }, { merge: true });
      setGpsSaved({ lat, lng });
    } catch (error) {
      setGpsError(`GPS settings save nahi hui: ${getErrorMessage(error)}`);
      console.error("GPS settings save failed:", error);
    } finally {
      setBusyId("");
    }
  };

  const handleUseCurrentLocation = () => {
    setGpsError("");
    setGpsAccuracy(null);
    if (!window.isSecureContext && !["localhost", "127.0.0.1"].includes(window.location.hostname)) {
      setGpsError("Location ke liye HTTPS connection zaroori hai. Secure URL par app kholkar dobara try karein.");
      return;
    }
    if (!navigator.geolocation) {
      setGpsError("Is browser mein location service available nahi hai.");
      return;
    }
    setGpsLocating(true);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setGpsForm((form) => ({
          ...form,
          lat: String(coords.latitude),
          lng: String(coords.longitude),
        }));
        setGpsAccuracy(Math.round(coords.accuracy));
        setGpsLocating(false);
      },
      (error) => {
        const message = error.code === 1
          ? "Location permission deny hui. Browser settings mein permission allow karein."
          : error.code === 3
            ? "Location request timeout ho gayi. GPS on karke dobara try karein."
            : "Current location nahi mil saki. Device GPS/location settings check karein.";
        setGpsError(message);
        setGpsLocating(false);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  };

  const handleAdvanceDecision = async (advance, status) => {
    const adminUid = auth.currentUser?.uid;
    if (!adminUid) {
      setActionError("Admin session expire ho gaya. Dobara sign in karein.");
      return;
    }
    setActionError("");
    const operationId = `advance-${advance.id}`;
    setBusyId(operationId);
    try {
      const update = status === "Approved"
        ? { status, approvedBy: adminUid, approvedAt: Date.now() }
        : {
          status,
          rejectedBy: adminUid,
          rejectedAt: Date.now(),
          adminNote: (advanceNoteDrafts[advance.id] || "").trim(),
        };
      const batch = writeBatch(db);
      batch.update(doc(db, advance.collectionName, advance.id), update);
      batch.set(doc(collection(db, "notifications")), {
        userId: getStaffId(advance),
        title: `Advance ${status.toLowerCase()}`,
        message: status === "Approved"
          ? `Your advance request for ${formatCurrency(Number(advance.amount || 0))} was approved.`
          : `Your advance request was rejected.${update.adminNote ? ` Admin note: ${update.adminNote}` : ""}`,
        read: false,
        createdAt: Date.now(),
      });
      await batch.commit();
    } catch (error) {
      reportError(`Advance ${status === "Approved" ? "approve" : "reject"} nahi hua`, error);
    } finally {
      setBusyId("");
    }
  };

  const handleAddManualAdvance = async (event) => {
    event.preventDefault();
    const amount = Number(advanceForm.amount);
    const member = members.find((entry) => entry.id === advanceForm.staffId);
    const note = advanceForm.note.trim();
    if (!member || !Number.isFinite(amount) || amount <= 0 || amount > 10000000
      || !isValidDateKey(advanceForm.date) || note.length > 500) {
      setActionError("Staff, valid date, aur ₹0 se zyada (maximum ₹1 crore) ka advance enter karein.");
      return;
    }
    const adminUid = auth.currentUser?.uid;
    if (!adminUid) {
      setActionError("Admin session expire ho gaya. Dobara sign in karein.");
      return;
    }
    setActionError("");
    setBusyId("manual-advance");
    try {
      await addDoc(collection(db, "advances"), {
        staffId: member.id,
        staffName: displayStaffName(member),
        amount,
        date: advanceForm.date,
        month: advanceForm.date.slice(0, 7),
        note,
        reason: note || "Manual advance",
        source: "manual",
        status: "Approved",
        createdAt: Date.now(),
        approvedBy: adminUid,
        approvedAt: Date.now(),
      });
      setAdvanceForm((form) => ({ ...form, amount: "", note: "" }));
    } catch (error) {
      reportError("Manual advance save nahi hua", error);
    } finally {
      setBusyId("");
    }
  };

  const handleCancelAdvance = async (advance) => {
    if (!window.confirm("Is advance ko cancel karein? Record history mein rahega.")) return;
    const staffId = getStaffId(advance);
    const advanceMonth = getRecordMonth(advance);
    const salaryAlreadyPaid = salaryPayments.some((payment) => (
      payment.staffId === staffId
      && payment.month === advanceMonth
      && String(payment.status || "paid").toLowerCase() !== "cancelled"
      && Number(payment.amount) > 0
    ));
    if (salaryAlreadyPaid
      && String(advance.status || "").toLowerCase() === "approved"
      && !window.confirm("Is month ke salary payment mein ye advance already adjust hua ho sakta hai. Phir bhi cancel karein?")) return;
    const adminUid = auth.currentUser?.uid;
    if (!adminUid) {
      setActionError("Admin session expire ho gaya. Dobara sign in karein.");
      return;
    }
    setBusyId(`cancel-advance-${advance.id}`);
    setActionError("");
    try {
      await updateDoc(doc(db, advance.collectionName, advance.id), {
        status: "Cancelled",
        cancelledBy: adminUid,
        cancelledAt: Date.now(),
      });
    } catch (error) {
      reportError("Advance cancel nahi hua", error);
    } finally {
      setBusyId("");
    }
  };

  const commitAttendanceOperations = async (operations) => {
    for (let offset = 0; offset < operations.length; offset += 450) {
      const batch = writeBatch(db);
      operations.slice(offset, offset + 450).forEach((operation) => {
        if (operation.type === "delete") batch.delete(operation.ref);
        else batch.set(operation.ref, operation.data);
      });
      await batch.commit();
    }
  };

  const removeLeaveAttendance = async (leave) => {
    const dates = dateRangeInclusive(leave.fromDate, leave.toDate);
    const operations = [];
    for (const date of dates) {
      const snapshot = await getDocs(query(collection(db, "attendance"), where("date", "==", date)));
      snapshot.docs.forEach((entry) => {
        const record = entry.data();
        if (getStaffId(record) === leave.staffId
          && record.source === "leave"
          && record.leaveRequestId === leave.id) {
          operations.push({ type: "delete", ref: entry.ref });
        }
      });
    }
    await commitAttendanceOperations(operations);
  };

  const handleLeaveDecision = async (leave, nextStatus) => {
    const adminUid = auth.currentUser?.uid;
    if (!adminUid) {
      setActionError("Admin session expire ho gaya. Dobara sign in karein.");
      return;
    }
    setActionError("");
    setBusyId(`leave-${leave.id}`);
    try {
      if (nextStatus === "approved") {
        const dates = dateRangeInclusive(leave.fromDate, leave.toDate);
        const attendanceOps = [];
        const presentConflicts = [];
        const status = leave.type === "Paid Leave"
          ? "Paid Leave"
          : leave.type === "Half Day" ? "Half Day" : "Absent";
        for (const date of dates) {
          const [attendanceSnapshot, gpsSnapshot] = await Promise.all([
            getDocs(query(collection(db, "attendance"), where("date", "==", date))),
            getDocs(query(collection(db, "staffAttendance"), where("date", "==", date))),
          ]);
          const sameStaff = attendanceSnapshot.docs.filter((entry) => getStaffId(entry.data()) === leave.staffId);
          const hasPresent = [...sameStaff, ...gpsSnapshot.docs.filter((entry) => getStaffId(entry.data()) === leave.staffId)]
            .some((entry) => normalizedAttendanceStatus(entry.data()) === "Present");
          if (hasPresent) presentConflicts.push(date);
          const canonicalRef = doc(db, "attendance", `${leave.staffId}_${date}`);
          attendanceOps.push({
            type: "set",
            ref: canonicalRef,
            data: {
              staffId: leave.staffId,
              date,
              status,
              markedBy: "Admin",
              source: "leave",
              leaveRequestId: leave.id,
            },
          });
          sameStaff.forEach((entry) => {
            if (entry.id !== canonicalRef.id) attendanceOps.push({ type: "delete", ref: entry.ref });
          });
        }
        if (presentConflicts.length
          && !window.confirm(`Attendance already marked Present on ${presentConflicts.join(", ")}. Replace with leave status?`)) return;
        await commitAttendanceOperations(attendanceOps);
      } else {
        await removeLeaveAttendance(leave);
      }

      const decision = {
        status: nextStatus,
        adminNote: (leaveNoteDrafts[leave.id] || "").trim(),
        decidedBy: adminUid,
        decidedAt: Date.now(),
      };
      if (nextStatus === "cancelled") {
        decision.cancelledBy = adminUid;
        decision.cancelledAt = Date.now();
      }
      const batch = writeBatch(db);
      batch.update(doc(db, "leaveRequests", leave.id), decision);
      if (nextStatus !== "cancelled") {
        batch.set(doc(collection(db, "notifications")), {
          userId: leave.staffId,
          title: `Leave request ${nextStatus}`,
          message: `Your ${leave.type} request for ${leave.fromDate} to ${leave.toDate} was ${nextStatus}.${decision.adminNote ? ` Admin note: ${decision.adminNote}` : ""}`,
          read: false,
          createdAt: Date.now(),
        });
      }
      await batch.commit();
    } catch (error) {
      reportError(`Leave request ${nextStatus} nahi hui`, error);
    } finally {
      setBusyId("");
    }
  };

  const openPaymentModal = (row) => {
    setPaymentMemberId(row.member.id);
    setPaymentForm({
      amount: String(row.balanceDue),
      date: todayKey(),
      note: "",
      carryForward: false,
    });
  };

  const handleCreateSalaryPayment = async (event) => {
    event.preventDefault();
    const row = payrollRows.find((entry) => entry.member.id === paymentMemberId);
    const amount = Number(paymentForm.amount);
    const date = paymentForm.date;
    const note = paymentForm.note.trim();
    const adminUid = auth.currentUser?.uid;
    if (!row || !adminUid || !Number.isFinite(amount) || amount < 0
      || amount > row.balanceDue || !isValidDateKey(date) || note.length > 500
      || (amount === 0 && !paymentForm.carryForward)) {
      setActionError("Payment amount valid balance se zyada nahi ho sakta; zero payment ke liye carry-forward select karein.");
      return;
    }
    const remaining = Math.max(0, row.balanceDue - amount);
    const carryRef = doc(db, "salaryCarryForwards", `${row.member.id}_${month}`);
    const existingCarry = salaryCarryForwards.find((entry) => entry.id === carryRef.id);
    setActionError("");
    setBusyId("salary-payment");
    try {
      const batch = writeBatch(db);
      if (amount > 0) {
        const paymentRef = doc(collection(db, "salaryPayments"));
        batch.set(paymentRef, {
          staffId: row.member.id,
          month,
          amount,
          date,
          note,
          createdBy: adminUid,
          createdAt: Date.now(),
          status: "paid",
        });
        const notificationRef = doc(collection(db, "notifications"));
        batch.set(notificationRef, {
          userId: row.member.id,
          title: "Salary payment received",
          message: `Salary payment of ${formatCurrency(amount)} for ${month} was recorded.`,
          read: false,
          createdAt: Date.now(),
        });
      }
      if (remaining > 0 && paymentForm.carryForward) {
        batch.set(carryRef, {
          staffId: row.member.id,
          fromMonth: month,
          month: nextMonthKey(month),
          amount: remaining,
          status: "active",
          createdBy: existingCarry?.createdBy || adminUid,
          createdAt: existingCarry?.createdAt || Date.now(),
          updatedAt: Date.now(),
          updatedBy: adminUid,
        });
      } else if (existingCarry && String(existingCarry.status || "active").toLowerCase() === "active") {
        batch.update(carryRef, {
          status: "cancelled",
          cancelledAt: Date.now(),
          cancelledBy: adminUid,
          updatedAt: Date.now(),
          updatedBy: adminUid,
        });
      }
      await batch.commit();
      setPaymentMemberId("");
    } catch (error) {
      reportError("Salary payment save nahi hui", error);
    } finally {
      setBusyId("");
    }
  };

  const handleCancelSalaryPayment = async (payment) => {
    if (!window.confirm("Is salary payment ko cancel karein? Payment history mein rahegi aur balance dobara calculate hoga.")) return;
    const adminUid = auth.currentUser?.uid;
    if (!adminUid) {
      setActionError("Admin session expire ho gaya. Dobara sign in karein.");
      return;
    }
    const row = payrollRows.find((entry) => entry.member.id === payment.staffId);
    const outgoingCarry = salaryCarryForwards.find((entry) => (
      entry.staffId === payment.staffId && entry.fromMonth === payment.month
      && String(entry.status || "active").toLowerCase() === "active"
    ));
    setBusyId(`cancel-payment-${payment.id}`);
    setActionError("");
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, "salaryPayments", payment.id), {
        status: "cancelled",
        cancelledBy: adminUid,
        cancelledAt: Date.now(),
      });
      if (row && outgoingCarry) {
        const paidAfterCancellation = salaryPayments
          .filter((entry) => entry.staffId === payment.staffId
            && entry.month === payment.month
            && entry.id !== payment.id
            && String(entry.status || "paid").toLowerCase() !== "cancelled")
          .reduce((total, entry) => total + Number(entry.amount || 0), 0);
        const updatedBalance = Math.max(0, row.payable - paidAfterCancellation);
        batch.update(doc(db, "salaryCarryForwards", outgoingCarry.id), updatedBalance > 0
          ? { amount: updatedBalance, updatedAt: Date.now(), updatedBy: adminUid }
          : { status: "cancelled", cancelledAt: Date.now(), cancelledBy: adminUid, updatedAt: Date.now(), updatedBy: adminUid });
      }
      await batch.commit();
    } catch (error) {
      reportError("Salary payment cancel nahi hui", error);
    } finally {
      setBusyId("");
    }
  };

  const saveAttendance = async (
    staffId,
    date,
    status,
    inTime = attendanceForm.checkInTime,
    outTime = attendanceForm.checkOutTime,
  ) => {
    setActionError("");
    const parsedDate = new Date(`${date}T00:00:00Z`);
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date)
      && !Number.isNaN(parsedDate.getTime())
      && parsedDate.toISOString().slice(0, 10) === date;
    if (!staffId || !validDate || date > todayKey() || !ATTENDANCE_STATUSES.includes(status)) {
      setActionError("Staff, aaj ya usse pehle ki valid date, aur attendance status select karein.");
      return;
    }
    setBusyId("attendance");
    try {
      const [manualSnapshot, gpsSnapshot] = await Promise.all([
        getDocs(query(collection(db, "attendance"), where("date", "==", date))),
        getDocs(query(collection(db, "staffAttendance"), where("date", "==", date))),
      ]);
      const alreadyMarked = [...manualSnapshot.docs, ...gpsSnapshot.docs].find((entry) => {
        const record = entry.data();
        return getStaffId(record) === staffId && normalizedAttendanceStatus(record);
      });
      if (alreadyMarked) {
        const record = alreadyMarked.data();
        const existingStatus = normalizedAttendanceStatus(record) || "GPS attendance";
        if (!window.confirm(`Already marked as ${existingStatus}, replace?`)) return;
      }
      const attendanceRef = doc(db, "attendance", `${staffId}_${date}`);
      const currentRecord = allAttendanceRecords.get(`${staffId}_${date}`);
      const member = members.find((entry) => entry.id === staffId);
      const shiftId = member?.shiftId || currentRecord?.shiftId || "";
      const shift = shifts[shiftId];
      const checkInAt = inTime
        ? attendanceTimestamp(date, inTime)
        : currentRecord?.checkInAt || null;
      const checkOutAt = outTime
        ? attendanceTimestamp(date, outTime, checkInAt)
        : currentRecord?.checkOutAt || null;
      if (checkOutAt && !checkInAt) {
        setActionError("Out time ke liye In time bhi enter karein.");
        return;
      }
      const automatic = checkInAt && shift
        ? autoStatus(checkInAt, shift, checkOutAt)
        : null;
      const attendanceData = {
        staffId,
        date,
        status,
        markedBy: "Admin",
        source: "manual",
        ...(checkInAt ? { checkInAt } : {}),
        ...(checkOutAt ? { checkOutAt } : {}),
        ...(shift ? {
          shiftId,
          shiftName: shift.name,
          shiftStartTime: shift.startTime,
          shiftEndTime: shift.endTime,
          breakStart: shift.breakStart || "",
          breakEnd: shift.breakEnd || "",
          halfDayLateMinutes: Number(shift.halfDayLateMinutes ?? 30),
          lateGraceMinutes: Number(shift.lateGraceMinutes ?? 10),
          earlyLeaveHours: Number(shift.earlyLeaveHours ?? 2),
        } : {}),
        ...(automatic ? {
          late: automatic.late,
          lateMinutes: automatic.lateMinutes,
          incomplete: automatic.incomplete,
          earlyLeave: automatic.earlyLeave,
          ...(checkOutAt ? { workedMinutes: calculateWorkedMinutes(checkInAt, checkOutAt, shift) } : {}),
        } : {}),
      };
      const batch = writeBatch(db);
      batch.set(attendanceRef, attendanceData);
      batch.set(doc(collection(db, "notifications")), {
        userId: staffId,
        title: "Attendance updated",
        message: `Admin updated your attendance for ${date} to ${status}.`,
        read: false,
        createdAt: Date.now(),
      });
      manualSnapshot.docs.forEach((entry) => {
        if (entry.id !== attendanceRef.id && getStaffId(entry.data()) === staffId) {
          batch.delete(entry.ref);
        }
      });
      await batch.commit();
      setMonth(date.slice(0, 7));
      setAttendanceForm((form) => ({
        ...form,
        staffId,
        date,
        status,
        checkInTime: checkInAt ? indiaTimeInput(checkInAt) : "",
        checkOutTime: checkOutAt ? indiaTimeInput(checkOutAt) : "",
      }));
      setActionError("");
    } catch (error) {
      reportError("Attendance mark nahi hui", error);
    } finally {
      setBusyId("");
    }
  };

  const handleMarkAttendance = (event) => {
    event.preventDefault();
    return saveAttendance(
      attendanceForm.staffId,
      attendanceForm.date,
      attendanceForm.status,
      attendanceForm.checkInTime,
      attendanceForm.checkOutTime,
    );
  };

  const handleSaveStaffField = async (member, field) => {
    const value = staffDrafts[member.id]?.[field];
    if (value === undefined) return;
    const saveKey = `${member.id}-${field}`;
    setStaffSaveStates((current) => ({ ...current, [saveKey]: { status: "saving", message: "" } }));
    try {
      let updates = { [field]: value };
      if (field === "name") {
        updates.name = String(value).trim();
        if (!updates.name) throw new Error("Staff name khali nahi ho sakta.");
      } else if (field === "monthlySalary") {
        updates.monthlySalary = Number(value);
        if (value === "" || !Number.isFinite(updates.monthlySalary) || updates.monthlySalary < 0) {
          throw new Error("Valid non-negative monthly salary enter karein.");
        }
      } else if (field === "role" && !ROLES.some((role) => role.value === value)) {
        throw new Error("Valid staff role select karein.");
      } else if (field === "shiftId" && value && !shifts[value]) {
        throw new Error("Valid shift select karein.");
      } else if (field === "phone") {
        const phone = String(value || "").trim();
        updates.phone = phone ? normalizeStaffPhone(phone) : "";
        if (phone && !updates.phone) throw new Error("Valid WhatsApp number enter karein.");
      }

      if (field === "monthlySalary") {
        const adminUid = auth.currentUser?.uid;
        if (!adminUid) throw new Error("Admin session expire ho gaya. Dobara sign in karein.");
        const batch = writeBatch(db);
        batch.update(doc(db, "staff", member.id), updates);
        batch.set(doc(db, "staffPayroll", member.id), {
          uid: member.id,
          monthlySalary: updates.monthlySalary,
          updatedAt: Date.now(),
          updatedBy: adminUid,
        }, { merge: true });
        await batch.commit();
      } else {
        await updateDoc(doc(db, "staff", member.id), updates);
      }
      setStaffDrafts((current) => ({
        ...current,
        [member.id]: { ...current[member.id], [field]: field === "monthlySalary" ? String(updates.monthlySalary) : updates[field] },
      }));
      setStaffSaveStates((current) => ({ ...current, [saveKey]: { status: "saved", message: "" } }));
    } catch (error) {
      setStaffSaveStates((current) => ({ ...current, [saveKey]: { status: "error", message: getErrorMessage(error) } }));
      console.error(`Staff ${field} save failed for ${member.id}:`, error);
    }
  };

  const handleToggleActive = async (member, active) => {
    const saveKey = `${member.id}-active`;
    setStaffSaveStates((current) => ({ ...current, [saveKey]: { status: "saving", message: "" } }));
    try {
      await updateDoc(doc(db, "staff", member.id), { active });
      setStaffSaveStates((current) => ({ ...current, [saveKey]: { status: "saved", message: "" } }));
    } catch (error) {
      setStaffSaveStates((current) => ({ ...current, [saveKey]: { status: "error", message: getErrorMessage(error) } }));
      console.error(`Staff active status save failed for ${member.id}:`, error);
    }
  };

  const handleSaveShiftField = async (shiftId, field) => {
    const shift = shiftDrafts[shiftId];
    if (!shift) return;
    const saveKey = `${shiftId}-${field}`;
    const nextShift = { ...shift };
    if (["startTime", "endTime", "breakStart", "breakEnd"].includes(field)) {
      if (field.startsWith("break") && !nextShift.breakStart && !nextShift.breakEnd) {
        delete nextShift.breakStart;
        delete nextShift.breakEnd;
      } else if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(nextShift[field] || ""))) {
        setShiftSaveStates((current) => ({ ...current, [saveKey]: { status: "error", message: "Valid 24-hour time enter karein." } }));
        return;
      }
    } else if (field === "name") {
      if (!String(nextShift.name || "").trim() || String(nextShift.name).length > 80) {
        setShiftSaveStates((current) => ({ ...current, [saveKey]: { status: "error", message: "Shift name required hai (max 80 characters)." } }));
        return;
      }
      nextShift.name = String(nextShift.name).trim();
    } else {
      const value = Number(nextShift[field]);
      const integerField = field === "halfDayLateMinutes" || field === "lateGraceMinutes";
      const max = field === "earlyLeaveHours" ? 12 : 720;
      if (!Number.isFinite(value) || value < 0 || value > max || (integerField && !Number.isInteger(value))) {
        setShiftSaveStates((current) => ({ ...current, [saveKey]: { status: "error", message: "Shift threshold valid range mein enter karein." } }));
        return;
      }
      nextShift[field] = value;
    }
    if (Boolean(nextShift.breakStart) !== Boolean(nextShift.breakEnd)) {
      setShiftSaveStates((current) => ({ ...current, [saveKey]: { status: "error", message: "Break start aur end dono enter karein ya dono khali chhodein." } }));
      return;
    }
    const updatedShifts = { ...shiftDrafts, [shiftId]: nextShift };
    setShiftSaveStates((current) => ({ ...current, [saveKey]: { status: "saving", message: "" } }));
    try {
      await setDoc(doc(db, "settings", "shifts"), { shifts: updatedShifts });
      setShiftSaveStates((current) => ({ ...current, [saveKey]: { status: "saved", message: "" } }));
    } catch (error) {
      console.error(`Shift ${field} save failed:`, error);
      setShiftSaveStates((current) => ({ ...current, [saveKey]: { status: "error", message: getErrorMessage(error) } }));
    }
  };

  const inputStyle = {
    width: "100%",
    minWidth: 0,
    boxSizing: "border-box",
    padding: "10px 12px",
    color: C.ink,
    background: C.bg,
    border: `1px solid ${C.line}`,
    borderRadius: 9,
    font: "inherit",
  };
  const buttonStyle = {
    border: 0,
    borderRadius: 9,
    padding: "10px 14px",
    background: C.gold,
    color: "#0B111A",
    fontWeight: 800,
    cursor: "pointer",
    font: "inherit",
  };
  const cardStyle = {
    background: C.card,
    border: `1px solid ${C.line}`,
    borderRadius: 14,
    padding: 16,
  };
  const labelStyle = { display: "grid", gap: 6, color: C.gray, fontSize: 12, fontWeight: 700 };
  const renderStaffSaveStatus = (member, field) => {
    const state = staffSaveStates[`${member.id}-${field}`];
    if (!state) return null;
    if (state.status === "saving") return <small style={{ color: C.gray }}>Saving...</small>;
    if (state.status === "saved") return <small style={{ color: C.green }}>Saved ✓</small>;
    return <small role="alert" style={{ color: "#FCA5A5" }}>{state.message}</small>;
  };

  return (
    <section style={{ marginTop: 24 }}>
      <header style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0, color: C.ink, fontSize: isMobile ? 19 : 23 }}>Staff Admin Dashboard</h2>
        <div style={{ marginTop: 5, color: C.gray, fontSize: 12 }}>
          Staff profiles, restaurant geofence, advance approvals, and monthly payroll.
        </div>
      </header>

      <nav aria-label="Staff admin sections" style={{
        display: "flex",
        gap: 6,
        overflowX: "auto",
        borderBottom: `1px solid ${C.line}`,
        marginBottom: 16,
      }}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => {
              if (tab.id !== "staff") {
                setCreatedStaffCredentials(null);
              }
              setActiveTab(tab.id);
            }}
            aria-pressed={activeTab === tab.id}
            style={{
              flexShrink: 0,
              border: 0,
              borderBottom: activeTab === tab.id ? `3px solid ${C.gold}` : "3px solid transparent",
              padding: "11px 13px",
              background: "transparent",
              color: activeTab === tab.id ? C.gold : C.gray,
              fontWeight: 800,
              cursor: "pointer",
              font: "inherit",
              fontSize: 12,
            }}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {loadError && (
        <div role="alert" style={{ marginBottom: 12, padding: 12, color: "#FCA5A5", background: "#451A1A", borderRadius: 10, fontSize: 13 }}>
          {loadError}
        </div>
      )}
      {actionError && (
        <div role="alert" style={{ marginBottom: 12, padding: 12, color: "#FCA5A5", background: "#451A1A", borderRadius: 10, fontSize: 13 }}>
          {actionError}
        </div>
      )}
      {activeTab === "staff" && createdStaffCredentials && (
        <section
          role="dialog"
          aria-modal="true"
          aria-labelledby="created-staff-title"
          style={{ ...cardStyle, marginBottom: 14, border: `1px solid ${C.gold}` }}
        >
          <h3 id="created-staff-title" style={{ margin: "0 0 10px", color: C.ink }}>Staff account created</h3>
          <div style={{ color: C.gray, fontSize: 13, lineHeight: 1.7 }}>
            <div>Name: {createdStaffCredentials.name}</div>
            <div>Login ID: {createdStaffCredentials.email}</div>
            <div>
              Temporary password: <strong style={{ color: C.ink, userSelect: "all" }}>{createdStaffCredentials.temporaryPassword}</strong>
            </div>
            <div>
              {createdStaffCredentials.emailSent
                ? "Welcome email sent."
                : "Account ban gaya, email nahi gaya, WhatsApp wala button use karo."}
            </div>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 9, marginTop: 14 }}>
            <a
              href={whatsappHref}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setCreatedStaffCredentials(null)}
              style={{ ...buttonStyle, width: "auto", display: "inline-flex", alignItems: "center", textDecoration: "none" }}
            >
              WhatsApp par bhejo
            </a>
            <button type="button" onClick={() => setCreatedStaffCredentials(null)} style={{ ...buttonStyle, width: "auto", background: C.cardAlt }}>
              Close
            </button>
          </div>
        </section>
      )}

      {activeTab === "staff" && (
        <div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
            <button type="button" onClick={() => setAddStaffOpen((open) => !open)}
              aria-expanded={addStaffOpen}
              style={{ ...buttonStyle, width: "auto", background: addStaffOpen ? C.cardAlt : C.gold }}>
              {addStaffOpen ? "✕ Close staff profile" : "+ Add staff profile"}
            </button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: isMobile || !addStaffOpen ? "1fr" : "minmax(280px, 360px) 1fr", gap: 14 }}>
          {addStaffOpen && (
            <form onSubmit={handleAddStaff} style={{ ...cardStyle, display: "grid", alignContent: "start", gap: 12 }}>
            <div style={{ color: C.gray, fontSize: 12 }}>
              Temporary password server par generate hoga. Staff ko email bheja jayega aur aap WhatsApp se bhi share kar sakte hain.
            </div>
            <label style={labelStyle}>
              Name
              <input required maxLength={80} value={newStaff.name} onChange={(event) => setNewStaff((form) => ({ ...form, name: event.target.value }))} style={inputStyle} />
            </label>
            <label style={labelStyle}>
              Role
              <select value={newStaff.role} onChange={(event) => setNewStaff((form) => ({ ...form, role: event.target.value }))} style={inputStyle}>
                {ROLES.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}
              </select>
            </label>
            <label style={labelStyle}>
              Monthly salary (₹)
              <input required type="number" min="0" step="0.01" value={newStaff.monthlySalary} onChange={(event) => setNewStaff((form) => ({ ...form, monthlySalary: event.target.value }))} style={inputStyle} />
            </label>
            <label style={labelStyle}>
              Shift
              <select value={newStaff.shiftId} onChange={(event) => setNewStaff((form) => ({ ...form, shiftId: event.target.value }))} style={inputStyle}>
                <option value="">No shift</option>
                {Object.entries(shifts).map(([shiftId, shift]) => <option key={shiftId} value={shiftId}>{shift.name}</option>)}
              </select>
            </label>
            <label style={labelStyle}>
              Firebase account setup
              <select value={newStaff.accountMode} onChange={(event) => setNewStaff((form) => ({ ...form, accountMode: event.target.value }))} style={inputStyle}>
                <option value="create">Create new Auth account</option>
                <option value="existing">Link existing Auth UID</option>
              </select>
            </label>
            {newStaff.accountMode === "create" ? (
              <>
                <label style={labelStyle}>
                  Staff email
                  <input required type="email" autoComplete="email" value={newStaff.email} onChange={(event) => setNewStaff((form) => ({ ...form, email: event.target.value }))} style={inputStyle} />
                </label>
                <label style={labelStyle}>
                  Staff WhatsApp number
                  <input required type="tel" autoComplete="tel" value={newStaff.phone} onChange={(event) => setNewStaff((form) => ({ ...form, phone: event.target.value }))} placeholder="10-digit number or +country code" style={inputStyle} />
                </label>
              </>
            ) : (
              <label style={labelStyle}>
                Existing Firebase Auth UID
                <input required value={newStaff.uid} onChange={(event) => setNewStaff((form) => ({ ...form, uid: event.target.value }))} style={inputStyle} />
              </label>
            )}
            <label style={{ display: "flex", alignItems: "center", gap: 9, color: C.ink, fontSize: 13, fontWeight: 700 }}>
              <input type="checkbox" checked={newStaff.active} onChange={(event) => setNewStaff((form) => ({ ...form, active: event.target.checked }))} />
              Active staff
            </label>
            <button type="submit" disabled={busyId === "add-staff"} style={buttonStyle}>
              {busyId === "add-staff" ? "Adding..." : "Add staff"}
            </button>
            </form>
          )}

          <section style={cardStyle}>
            <h3 style={{ margin: "0 0 12px", color: C.ink, fontSize: 16 }}>Existing staff ({members.length})</h3>
            {members.length === 0
              ? <div style={{ color: C.gray, fontSize: 13 }}>No staff profiles found.</div>
              : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1200, color: C.ink, fontSize: 13 }}>
                    <thead>
                      <tr style={{ color: C.gray, textAlign: "left" }}>
                        {["Name", "WhatsApp number", "Shift", "Role", "Monthly salary", "Status", "Auth UID", "WhatsApp welcome"].map((heading) => (
                          <th key={heading} style={{ padding: "9px 8px", borderBottom: `1px solid ${C.line}` }}>{heading}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {members.map((member) => (
                        <tr key={member.id}>
                          <td style={{ padding: "8px", borderBottom: `1px solid ${C.line}` }}>
                            <input
                              aria-label={`Name for ${member.id}`}
                              maxLength={80}
                              value={staffDrafts[member.id]?.name ?? member.name ?? ""}
                              onChange={(event) => setStaffDrafts((current) => ({ ...current, [member.id]: { ...current[member.id], name: event.target.value } }))}
                              onBlur={() => handleSaveStaffField(member, "name")}
                              style={{ ...inputStyle, minWidth: 120, padding: "7px 8px" }}
                            />
                            {renderStaffSaveStatus(member, "name")}
                          </td>
                          <td style={{ padding: "8px", borderBottom: `1px solid ${C.line}` }}>
                            <input
                              aria-label={`WhatsApp number for ${member.id}`}
                              type="tel"
                              autoComplete="tel"
                              value={staffDrafts[member.id]?.phone ?? member.phone ?? ""}
                              onChange={(event) => setStaffDrafts((current) => ({ ...current, [member.id]: { ...current[member.id], phone: event.target.value } }))}
                              onBlur={() => handleSaveStaffField(member, "phone")}
                              placeholder="+91..."
                              style={{ ...inputStyle, minWidth: 145, padding: "7px 8px" }}
                            />
                            {renderStaffSaveStatus(member, "phone")}
                          </td>
                          <td style={{ padding: "8px", borderBottom: `1px solid ${C.line}` }}>
                            <select
                              aria-label={`Shift for ${member.id}`}
                              value={staffDrafts[member.id]?.shiftId ?? member.shiftId ?? ""}
                              onChange={(event) => setStaffDrafts((current) => ({ ...current, [member.id]: { ...current[member.id], shiftId: event.target.value } }))}
                              onBlur={() => handleSaveStaffField(member, "shiftId")}
                              style={{ ...inputStyle, minWidth: 110, padding: "7px 8px" }}
                            >
                              <option value="">No shift</option>
                              {Object.entries(shifts).map(([shiftId, shift]) => <option key={shiftId} value={shiftId}>{shift.name}</option>)}
                            </select>
                            {!member.shiftId && <small style={{ display: "block", color: "#FCA5A5" }}>No shift assigned</small>}
                            {renderStaffSaveStatus(member, "shiftId")}
                          </td>
                          <td style={{ padding: "8px", borderBottom: `1px solid ${C.line}` }}>
                            <select
                              aria-label={`Role for ${member.id}`}
                              value={staffDrafts[member.id]?.role ?? member.role ?? "staff"}
                              onChange={(event) => setStaffDrafts((current) => ({ ...current, [member.id]: { ...current[member.id], role: event.target.value } }))}
                              onBlur={() => handleSaveStaffField(member, "role")}
                              style={{ ...inputStyle, minWidth: 110, padding: "7px 8px" }}
                            >
                              {ROLES.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}
                            </select>
                            {renderStaffSaveStatus(member, "role")}
                          </td>
                          <td style={{ padding: "8px", borderBottom: `1px solid ${C.line}` }}>
                            <input
                              aria-label={`Monthly salary for ${member.id}`}
                              type="number"
                              min="0"
                              step="0.01"
                              value={staffDrafts[member.id]?.monthlySalary ?? legacyPayroll[member.id]?.monthlySalary ?? member.monthlySalary ?? ""}
                              onChange={(event) => setStaffDrafts((current) => ({ ...current, [member.id]: { ...current[member.id], monthlySalary: event.target.value } }))}
                              onBlur={() => handleSaveStaffField(member, "monthlySalary")}
                              style={{ ...inputStyle, minWidth: 120, padding: "7px 8px" }}
                            />
                            {renderStaffSaveStatus(member, "monthlySalary")}
                          </td>
                          <td style={{ padding: "8px", borderBottom: `1px solid ${C.line}` }}>
                            <label style={{ display: "flex", alignItems: "center", gap: 6, color: member.active === false ? C.gray : C.green }}>
                              <input type="checkbox" checked={member.active !== false} onChange={(event) => handleToggleActive(member, event.target.checked)} />
                              {member.active === false ? "Inactive" : "Active"}
                            </label>
                            {renderStaffSaveStatus(member, "active")}
                          </td>
                          <td style={{ padding: "10px 8px", borderBottom: `1px solid ${C.line}`, fontSize: 11 }}>{member.id}</td>
                          <td style={{ padding: "8px", borderBottom: `1px solid ${C.line}` }}>
                            {staffWelcomeWhatsAppUrl(
                              member,
                              staffDrafts[member.id]?.name ?? member.name,
                              staffDrafts[member.id]?.phone ?? member.phone ?? "",
                            ) ? (
                              <a
                                href={staffWelcomeWhatsAppUrl(
                                  member,
                                  staffDrafts[member.id]?.name ?? member.name,
                                  staffDrafts[member.id]?.phone ?? member.phone ?? "",
                                )}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{ ...buttonStyle, width: "auto", display: "inline-flex", alignItems: "center", textDecoration: "none", whiteSpace: "nowrap" }}
                              >
                                WhatsApp par bhejo
                              </a>
                            ) : (
                              <button type="button" disabled style={{ ...buttonStyle, width: "auto", padding: "8px 10px", whiteSpace: "nowrap", opacity: 0.55 }}>
                                Pehle number add karein
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </section>
                  </div>
        </div>
      )}

      {activeTab === "shifts" && (
        <section style={{ display: "grid", gap: 12 }}>
          {shiftSettingsLoading && <div style={{ color: C.gray }}>Shift settings load ho rahi hain...</div>}
          {!canEditShifts && <div style={{ color: C.gold, fontSize: 12 }}>Shift settings sirf admin/owner edit kar sakte hain.</div>}
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(2, minmax(0, 1fr))", gap: 12 }}>
            {Object.entries(shiftDrafts).map(([shiftId, shift]) => (
              <section key={shiftId} style={cardStyle}>
                <h3 style={{ color: C.ink, margin: "0 0 12px" }}>Shift {shiftId === "morning" ? "A" : "B"}</h3>
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 10 }}>
                  {[
                    ["name", "Shift name", "text"],
                    ["startTime", "Start time", "time"],
                    ["endTime", "End time", "time"],
                    ["breakStart", "Rest starts (optional)", "time"],
                    ["breakEnd", "Rest ends (optional)", "time"],
                    ["halfDayLateMinutes", "Half Day after (minutes)", "number"],
                    ["lateGraceMinutes", "Late badge after (minutes)", "number"],
                    ["earlyLeaveHours", "Early leave threshold (hours)", "number"],
                  ].map(([field, label, type]) => {
                    const saveState = shiftSaveStates[`${shiftId}-${field}`];
                    return (
                      <label key={field} style={labelStyle}>
                        {label}
                        <input
                          type={type}
                          min={type === "number" ? 0 : undefined}
                          max={field === "earlyLeaveHours" ? 12 : 720}
                          step={field === "earlyLeaveHours" ? "0.5" : type === "number" ? "1" : undefined}
                          value={shift[field] ?? ""}
                          disabled={!canEditShifts}
                          onChange={(event) => setShiftDrafts((current) => ({
                            ...current,
                            [shiftId]: { ...current[shiftId], [field]: event.target.value },
                          }))}
                          onBlur={() => handleSaveShiftField(shiftId, field)}
                          style={inputStyle}
                        />
                        {saveState?.status === "saving" && <small style={{ color: C.gray }}>Saving...</small>}
                        {saveState?.status === "saved" && <small style={{ color: C.green }}>Saved ✓</small>}
                        {saveState?.status === "error" && <small role="alert" style={{ color: "#FCA5A5" }}>{saveState.message}</small>}
                      </label>
                    );
                  })}
                </div>
                {shift.breakStart && shift.breakEnd && (
                  <small style={{ display: "block", color: C.gray, marginTop: 10 }}>
                    Unpaid rest: {shift.breakStart}–{shift.breakEnd}
                  </small>
                )}
              </section>
            ))}
          </div>
        </section>
      )}

      {activeTab === "gps" && (
        <form onSubmit={handleSaveGps} style={{ ...cardStyle, maxWidth: 600, display: "grid", gap: 14 }}>
          <div>
            <h3 style={{ margin: 0, color: C.ink, fontSize: 16 }}>Restaurant geofence</h3>
            <div style={{ marginTop: 5, color: C.gray, fontSize: 12 }}>
              These coordinates and radius are used by staff GPS check-in.
            </div>
          </div>
          {gpsLoading && <div style={{ color: C.gray, fontSize: 12 }}>Loading saved GPS settings...</div>}
          <button type="button" onClick={handleUseCurrentLocation} disabled={gpsLocating} style={{ ...buttonStyle, justifySelf: "start" }}>
            {gpsLocating ? "Getting location..." : "Use Current Location"}
          </button>
          <label style={labelStyle}>
            Latitude
            <input required type="number" min="-90" max="90" step="any" value={gpsForm.lat} onChange={(event) => setGpsForm((form) => ({ ...form, lat: event.target.value }))} style={inputStyle} />
          </label>
          <label style={labelStyle}>
            Longitude
            <input required type="number" min="-180" max="180" step="any" value={gpsForm.lng} onChange={(event) => setGpsForm((form) => ({ ...form, lng: event.target.value }))} style={inputStyle} />
          </label>
          <label style={labelStyle}>
            Allowed radius (meters)
            <input required type="number" min="1" max="10000" step="1" value={gpsForm.radius} onChange={(event) => setGpsForm((form) => ({ ...form, radius: event.target.value }))} style={inputStyle} />
          </label>
          {(gpsAccuracy != null || gpsForm.lat || gpsForm.lng) && (
            <div style={{ color: C.gray, fontSize: 12 }}>
              Preview: {gpsForm.lat}, {gpsForm.lng}
              {gpsAccuracy != null ? ` · Accuracy ±${gpsAccuracy} m` : ""}
            </div>
          )}
          {gpsSaved && (
            <a
              href={`https://www.google.com/maps?q=${gpsSaved.lat},${gpsSaved.lng}`}
              target="_blank"
              rel="noreferrer"
              style={{ color: C.gold, fontWeight: 800, fontSize: 13, justifySelf: "start" }}
            >
              Open in Maps
            </a>
          )}
          {gpsError && <div role="alert" style={{ color: "#FCA5A5", background: "#451A1A", borderRadius: 9, padding: 10, fontSize: 12 }}>{gpsError}</div>}
          <button type="submit" disabled={busyId === "gps"} style={{ ...buttonStyle, justifySelf: "start" }}>
            {busyId === "gps" ? "Saving..." : "Save Location"}
          </button>
        </form>
      )}

      {activeTab === "advances" && (
        <section style={{ display: "grid", gap: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(3, 1fr)", gap: 10 }}>
            {[
              ["Approved advances · selected month", approvedAdvanceSummary.month],
              ["Approved advances · overall", approvedAdvanceSummary.overall],
              ["Pending requests", pendingRequests.length],
            ].map(([label, value]) => (
              <div key={label} style={{ ...cardStyle, padding: 13 }}>
                <div style={{ color: C.gray, fontSize: 11 }}>{label}</div>
                <strong style={{ display: "block", color: C.gold, fontSize: 17, marginTop: 5 }}>
                  {typeof value === "number" && label !== "Pending requests" ? formatCurrency(value) : value}
                </strong>
              </div>
            ))}
          </div>

          <form onSubmit={handleAddManualAdvance} style={{ ...cardStyle, display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(4, minmax(0, 1fr)) auto", gap: 10, alignItems: "end" }}>
            <label style={labelStyle}>
              Staff
              <select required value={advanceForm.staffId} onChange={(event) => setAdvanceForm((form) => ({ ...form, staffId: event.target.value }))} style={inputStyle}>
                <option value="">Select staff</option>
                {activeMembers.map((member) => <option key={member.id} value={member.id}>{displayStaffName(member)}</option>)}
              </select>
            </label>
            <label style={labelStyle}>
              Amount (₹)
              <input required type="number" min="0.01" max="10000000" step="0.01" value={advanceForm.amount} onChange={(event) => setAdvanceForm((form) => ({ ...form, amount: event.target.value }))} style={inputStyle} />
            </label>
            <label style={labelStyle}>
              Date
              <input required type="date" value={advanceForm.date} onChange={(event) => setAdvanceForm((form) => ({ ...form, date: event.target.value }))} style={inputStyle} />
            </label>
            <label style={labelStyle}>
              Note
              <input maxLength={500} value={advanceForm.note} onChange={(event) => setAdvanceForm((form) => ({ ...form, note: event.target.value }))} style={inputStyle} />
            </label>
            <button type="submit" disabled={busyId === "manual-advance"} style={buttonStyle}>
              {busyId === "manual-advance" ? "Saving..." : "Add approved advance"}
            </button>
          </form>

          <section style={cardStyle}>
            <h3 style={{ margin: "0 0 12px", color: C.ink, fontSize: 16 }}>Pending staff requests ({pendingRequests.length})</h3>
            {pendingRequests.length === 0
              ? <div style={{ color: C.gray, fontSize: 13 }}>No pending advance requests.</div>
              : (
                <div style={{ display: "grid", gap: 10 }}>
                  {pendingRequests.map((advance) => {
                    const staffId = getStaffId(advance);
                    const member = members.find((entry) => entry.id === staffId);
                    const requestBusy = busyId === `advance-${advance.id}`;
                    return (
                      <article key={`${advance.collectionName}-${advance.id}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, padding: 13, border: `1px solid ${C.line}`, borderRadius: 11 }}>
                        <div>
                          <div style={{ color: C.ink, fontWeight: 800 }}>{member ? displayStaffName(member) : advance.staffName || advance.name || staffId || "Unknown staff"}</div>
                          <div style={{ color: C.gray, fontSize: 12, marginTop: 4 }}>
                            {advance.reason || advance.note || "No note"} · {advance.date || advance.month || ""}
                          </div>
                          <input
                            aria-label={`Admin note for ${displayStaffName(member)}`}
                            placeholder="Optional admin note"
                            value={advanceNoteDrafts[advance.id] || ""}
                            onChange={(event) => setAdvanceNoteDrafts((current) => ({ ...current, [advance.id]: event.target.value }))}
                            style={{ ...inputStyle, marginTop: 7, maxWidth: 340, padding: "7px 8px" }}
                          />
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <strong style={{ color: C.gold }}>{formatCurrency(Number(advance.amount || 0))}</strong>
                          <button type="button" disabled={requestBusy} onClick={() => handleAdvanceDecision(advance, "Approved")} style={buttonStyle}>
                            {requestBusy ? "Saving..." : "Approve"}
                          </button>
                          <button type="button" disabled={requestBusy} onClick={() => handleAdvanceDecision(advance, "Rejected")} style={{ ...buttonStyle, background: "#5B2630", color: "#FCA5A5" }}>
                            Reject
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
          </section>

          <section style={cardStyle}>
            <h3 style={{ margin: "0 0 12px", color: C.ink, fontSize: 16 }}>Approved advance totals by staff</h3>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", color: C.ink, fontSize: 12 }}>
                <thead><tr style={{ textAlign: "left", color: C.gray }}>
                  {["Staff", `${month} approved`, "Overall approved"].map((heading) => <th key={heading} style={{ padding: 9, borderBottom: `1px solid ${C.line}` }}>{heading}</th>)}
                </tr></thead>
                <tbody>{members.map((member) => {
                  const total = approvedAdvanceSummary.byStaff.get(member.id) || { month: 0, overall: 0 };
                  return <tr key={member.id}><td style={{ padding: 9, borderBottom: `1px solid ${C.line}` }}>{displayStaffName(member)}</td><td style={{ padding: 9, borderBottom: `1px solid ${C.line}` }}>{formatCurrency(total.month)}</td><td style={{ padding: 9, borderBottom: `1px solid ${C.line}` }}>{formatCurrency(total.overall)}</td></tr>;
                })}</tbody>
              </table>
            </div>
          </section>

          <section style={cardStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
              <h3 style={{ margin: 0, color: C.ink, fontSize: 16 }}>Advance history ({advanceHistory.length})</h3>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <select aria-label="Filter advances by staff" value={advanceFilterStaff} onChange={(event) => setAdvanceFilterStaff(event.target.value)} style={{ ...inputStyle, width: 180 }}>
                  <option value="all">All staff</option>
                  {members.map((member) => <option key={member.id} value={member.id}>{displayStaffName(member)}</option>)}
                </select>
                <select aria-label="Filter advances by month" value={advanceFilterMonth} onChange={(event) => setAdvanceFilterMonth(event.target.value)} style={{ ...inputStyle, width: 150 }}>
                  <option value="all">All months</option>
                  {[...new Set(allAdvances.map(getRecordMonth).filter(Boolean))].sort().reverse().map((entryMonth) => <option key={entryMonth} value={entryMonth}>{entryMonth}</option>)}
                </select>
              </div>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 700, color: C.ink, fontSize: 12 }}>
                <thead><tr style={{ textAlign: "left", color: C.gray }}>
                  {["Date", "Staff", "Amount", "Status", "Source", "Note", "Action"].map((heading) => <th key={heading} style={{ padding: 9, borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap" }}>{heading}</th>)}
                </tr></thead>
                <tbody>
                  {advanceHistory.map((advance) => {
                    const member = members.find((entry) => entry.id === getStaffId(advance));
                    const cancelled = String(advance.status || "").toLowerCase() === "cancelled";
                    const rowBusy = busyId === `cancel-advance-${advance.id}`;
                    return (
                      <tr key={`${advance.collectionName}-${advance.id}`}>
                        <td style={{ padding: 9, borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap" }}>{advance.date || advance.month || "—"}</td>
                        <td style={{ padding: 9, borderBottom: `1px solid ${C.line}` }}>{member ? displayStaffName(member) : advance.staffName || advance.name || getStaffId(advance)}</td>
                        <td style={{ padding: 9, borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap" }}>{formatCurrency(Number(advance.amount || 0))}</td>
                        <td style={{ padding: 9, borderBottom: `1px solid ${C.line}` }}>{advance.status || "Pending"}</td>
                        <td style={{ padding: 9, borderBottom: `1px solid ${C.line}` }}>{advance.source || "request"}</td>
                        <td style={{ padding: 9, borderBottom: `1px solid ${C.line}` }}>{advance.note || advance.reason || "—"}</td>
                        <td style={{ padding: 9, borderBottom: `1px solid ${C.line}` }}>
                          {!cancelled && <button type="button" disabled={rowBusy} onClick={() => handleCancelAdvance(advance)} style={{ ...buttonStyle, padding: "6px 9px", background: "#5B2630", color: "#FCA5A5" }}>{rowBusy ? "..." : "Cancel"}</button>}
                        </td>
                      </tr>
                    );
                  })}
                  {!advanceHistory.length && <tr><td colSpan={7} style={{ padding: 14, color: C.gray, textAlign: "center" }}>No advances match these filters.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </section>
      )}

      {activeTab === "leaves" && (
        <section style={{ ...cardStyle, display: "grid", gap: 12 }}>
          <h3 style={{ margin: 0, color: C.ink, fontSize: 16 }}>Staff leave requests ({leaveRequests.length})</h3>
          {leaveRequests.length === 0
            ? <div style={{ color: C.gray, fontSize: 13 }}>No leave requests yet.</div>
            : [...leaveRequests].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map((leave) => {
              const member = members.find((entry) => entry.id === leave.staffId);
              const status = String(leave.status || "pending").toLowerCase();
              const decisionBusy = busyId === `leave-${leave.id}`;
              const statusColor = status === "approved" ? C.green
                : status === "rejected" || status === "cancelled" ? "#FCA5A5" : C.gold;
              return (
                <article key={leave.id} style={{ padding: 13, border: `1px solid ${C.line}`, borderRadius: 11, display: "grid", gap: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <div>
                      <strong style={{ color: C.ink }}>{member ? displayStaffName(member) : leave.staffName || leave.staffId}</strong>
                      <div style={{ color: C.gray, fontSize: 12, marginTop: 4 }}>{leave.fromDate} – {leave.toDate} · {leave.type}</div>
                      <div style={{ color: C.gray, fontSize: 12, marginTop: 3 }}>{leave.reason}</div>
                    </div>
                    <strong style={{ color: statusColor, textTransform: "capitalize" }}>{status}</strong>
                  </div>
                  {leave.adminNote && <div style={{ color: C.gray, fontSize: 12 }}>Admin note: {leave.adminNote}</div>}
                  {status === "pending" && (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                      <input
                        aria-label={`Admin note for ${leave.staffName || leave.staffId}`}
                        maxLength={500}
                        placeholder="Optional admin note"
                        value={leaveNoteDrafts[leave.id] || ""}
                        onChange={(event) => setLeaveNoteDrafts((current) => ({ ...current, [leave.id]: event.target.value }))}
                        style={{ ...inputStyle, maxWidth: 360 }}
                      />
                      <button type="button" disabled={decisionBusy} onClick={() => handleLeaveDecision(leave, "approved")} style={buttonStyle}>
                        {decisionBusy ? "Saving..." : "Approve"}
                      </button>
                      <button type="button" disabled={decisionBusy} onClick={() => handleLeaveDecision(leave, "rejected")} style={{ ...buttonStyle, background: "#5B2630", color: "#FCA5A5" }}>
                        Reject
                      </button>
                    </div>
                  )}
                  {status === "approved" && (
                    <button type="button" disabled={decisionBusy} onClick={() => {
                      if (window.confirm("Approved leave cancel karein aur is request se bane attendance records hata dein?")) {
                        handleLeaveDecision(leave, "cancelled");
                      }
                    }} style={{ ...buttonStyle, justifySelf: "start", background: "#5B2630", color: "#FCA5A5" }}>
                      {decisionBusy ? "Cancelling..." : "Cancel approved leave"}
                    </button>
                  )}
                </article>
              );
            })}
        </section>
      )}

      {activeTab === "payroll" && (
        <section>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
            <div>
              <h3 style={{ margin: 0, color: C.ink, fontSize: 16 }}>Payroll calculation</h3>
              <div style={{ marginTop: 4, color: C.gray, fontSize: 12 }}>GPS and manually marked attendance are combined by unique staff/date.</div>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, color: C.gray, fontSize: 12, fontWeight: 700 }}>
              Salary month
              <input
                type="month"
                value={month}
                onChange={(event) => {
                  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value)) {
                    setGpsAttendanceLoading(true);
                    setManualAttendanceLoading(true);
                    setMonth(event.target.value);
                  }
                }}
                style={{ ...inputStyle, width: 170 }}
              />
            </label>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)", gap: 9, marginBottom: 14 }}>
            {[
              ["Total Gross", payrollSummary.gross],
              ["Total Advances", payrollSummary.advances],
              ["Total Paid", payrollSummary.paid],
              ["Total Payable", payrollSummary.payable],
            ].map(([label, amount]) => (
              <div key={label} style={cardStyle}>
                <div style={{ color: C.gray, fontSize: 11 }}>{label} · {month}</div>
                <strong style={{ display: "block", color: label === "Total Payable" ? C.gold : C.ink, fontSize: 17, marginTop: 5 }}>{formatCurrency(amount)}</strong>
              </div>
            ))}
          </div>

          <form onSubmit={handleMarkAttendance} style={{ ...cardStyle, display: "grid", gridTemplateColumns: isMobile ? "1fr" : "minmax(160px, 1fr) minmax(140px, 160px) minmax(130px, 150px) minmax(110px, 130px) minmax(110px, 130px) auto", gap: 10, alignItems: "end", marginBottom: 14 }}>
            <label style={labelStyle}>
              Staff member
              <select required value={attendanceForm.staffId} onChange={(event) => setAttendanceForm((form) => ({ ...form, staffId: event.target.value }))} style={inputStyle}>
                <option value="">Select staff</option>
                {activeMembers.map((member) => <option key={member.id} value={member.id}>{displayStaffName(member)}</option>)}
              </select>
            </label>
            <label style={labelStyle}>
              Attendance date
              <input required type="date" max={todayKey()} value={attendanceForm.date} onChange={(event) => setAttendanceForm((form) => ({ ...form, date: event.target.value }))} style={inputStyle} />
            </label>
            <label style={labelStyle}>
              Status
              <select value={attendanceForm.status} onChange={(event) => setAttendanceForm((form) => ({ ...form, status: event.target.value }))} style={inputStyle}>
                {ATTENDANCE_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
              </select>
            </label>
            <label style={labelStyle}>
              In time (optional)
              <input type="time" value={attendanceForm.checkInTime} onChange={(event) => setAttendanceForm((form) => ({ ...form, checkInTime: event.target.value }))} style={inputStyle} />
            </label>
            <label style={labelStyle}>
              Out time (optional)
              <input type="time" value={attendanceForm.checkOutTime} onChange={(event) => setAttendanceForm((form) => ({ ...form, checkOutTime: event.target.value }))} style={inputStyle} />
            </label>
            <button type="submit" disabled={busyId === "attendance" || !activeMembers.length} style={buttonStyle}>
              {busyId === "attendance" ? "Saving..." : "Save Attendance"}
            </button>
          </form>

          {(gpsAttendanceLoading || manualAttendanceLoading) && (
            <div style={{ color: C.gray, padding: 12 }}>Attendance data load ho raha hai...</div>
          )}
          <div style={{ ...cardStyle, overflowX: "auto", padding: 0 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1050, color: C.ink, fontSize: 12 }}>
              <thead>
                <tr style={{ background: C.cardAlt, textAlign: "left", color: C.gray }}>
                  {["Staff", "Present days", "Paid leave", "Earned leaves", "Paid days", "Monthly salary", "Per day", "Gross salary", "Approved advances", "Carry forward advance", "Final payable", "Paid", "Balance due", "Status", "Payment"].map((heading) => (
                    <th key={heading} style={{ padding: 11, borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap" }}>{heading}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {payrollRows.map((payrollRow) => {
                  const { member, monthlySalary, stats, salary, approvedAdvance } = payrollRow;
                  const { presentDays, paidLeaveDays } = stats;
                  const dateValue = presentDays.toLocaleString("en-IN", { maximumFractionDigits: 1 });
                  const statusColor = payrollRow.status === "Paid" ? C.green
                    : payrollRow.status === "Partial" ? C.gold : "#FCA5A5";
                  return (
                    <tr
                      key={member.id}
                      onClick={() => setSelectedMemberId(member.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelectedMemberId(member.id);
                        }
                      }}
                      tabIndex={0}
                      aria-label={`View payroll details for ${displayStaffName(member)}`}
                      style={{ cursor: "pointer" }}
                    >
                      <td style={{ padding: 10, borderBottom: `1px solid ${C.line}`, fontWeight: 800, whiteSpace: "nowrap" }}>{displayStaffName(member)}</td>
                      <td style={{ padding: 10, borderBottom: `1px solid ${C.line}` }}>{dateValue}</td>
                      <td style={{ padding: 10, borderBottom: `1px solid ${C.line}` }}>{paidLeaveDays}</td>
                      <td style={{ padding: 10, borderBottom: `1px solid ${C.line}` }}>{salary.earnedLeaves}</td>
                      <td style={{ padding: 10, borderBottom: `1px solid ${C.line}` }}>{salary.totalPaidDays}</td>
                      <td style={{ padding: 10, borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap" }}>{formatCurrency(monthlySalary)}</td>
                      <td style={{ padding: 10, borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap" }}>{formatCurrency(salary.perDaySalary)}</td>
                      <td style={{ padding: 10, borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap" }}>{formatCurrency(salary.grossSalary)}</td>
                      <td style={{ padding: 10, borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap" }}>− {formatCurrency(approvedAdvance)}</td>
                      <td style={{ padding: 10, borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap", color: payrollRow.carryForwardIn > 0 ? C.gold : C.gray }}>{formatCurrency(payrollRow.carryForwardIn)}</td>
                      <td style={{ padding: 10, borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap", color: C.gold, fontWeight: 900 }}>{formatCurrency(payrollRow.payable)}</td>
                      <td style={{ padding: 10, borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap" }}>{formatCurrency(payrollRow.paid)}</td>
                      <td style={{ padding: 10, borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap", color: payrollRow.balanceDue > 0 ? "#FCA5A5" : C.green }}>
                        {formatCurrency(payrollRow.balanceDue)}{payrollRow.balanceDue > 0 && <small style={{ display: "block" }}>Pending</small>}
                      </td>
                      <td style={{ padding: 10, borderBottom: `1px solid ${C.line}`, color: statusColor, fontWeight: 800 }}>{payrollRow.status}</td>
                      <td style={{ padding: 8, borderBottom: `1px solid ${C.line}` }}>
                        <button
                          type="button"
                          disabled={payrollRow.balanceDue <= 0}
                          onClick={(event) => {
                            event.stopPropagation();
                            openPaymentModal(payrollRow);
                          }}
                          style={{ ...buttonStyle, padding: "7px 10px", opacity: payrollRow.balanceDue <= 0 ? 0.5 : 1 }}
                        >
                          Pay
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {!payrollRows.length && (
                  <tr><td colSpan={15} style={{ padding: 18, color: C.gray, textAlign: "center" }}>No active staff with monthly salary above ₹0.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {selectedMember && (() => {
            const stats = attendanceStatsByStaff.get(selectedMember.id) || { presentDays: 0, paidLeaveDays: 0 };
            const approvedAdvance = approvedAdvanceTotals.get(selectedMember.id) || 0;
            const monthlySalary = Number(legacyPayroll[selectedMember.id]?.monthlySalary ?? selectedMember.monthlySalary ?? 0);
            const payrollRow = payrollRows.find((entry) => entry.member.id === selectedMember.id);
            const salary = calculateStaffSalary({
              monthlySalary,
              presentDays: stats.presentDays,
              paidLeaveDays: stats.paidLeaveDays,
              totalApprovedAdvance: approvedAdvance,
              daysInPayPeriod: daysInMonth(month),
            });
            const payable = payrollRow?.payable ?? salary.finalPayable;
            const balanceDue = payrollRow?.balanceDue ?? payable;
            const paymentHistory = salaryPayments
              .filter((payment) => payment.staffId === selectedMember.id && payment.month === month)
              .sort((a, b) => String(b.date).localeCompare(String(a.date)));
            const calendarCount = daysInMonth(month);
            const firstWeekday = new Date(`${month}-01T00:00:00`).getDay();
            const selectedDateRecord = allAttendanceRecords.get(`${selectedMember.id}_${attendanceForm.date}`);
            return (
              <div
                role="presentation"
                onClick={() => setSelectedMemberId("")}
                style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.72)", display: "grid", placeItems: "center", padding: 14 }}
              >
                <section
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="payroll-detail-title"
                  onClick={(event) => event.stopPropagation()}
                  style={{ ...cardStyle, width: "min(900px, 100%)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box" }}
                >
                  <header style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "start" }}>
                    <div>
                      <h3 id="payroll-detail-title" style={{ margin: 0, color: C.ink }}>{displayStaffName(selectedMember)}</h3>
                      <div style={{ color: C.gray, marginTop: 4, fontSize: 12 }}>{selectedMember.role || "staff"} · Salary {formatCurrency(monthlySalary)} · {month}</div>
                    </div>
                    <button type="button" onClick={() => setSelectedMemberId("")} aria-label="Close payroll details" style={{ ...buttonStyle, padding: "7px 11px" }}>Close</button>
                  </header>

                  <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)", gap: 8 }}>
                    {[
                      ["Per day", salary.perDaySalary],
                      ["Gross", salary.grossSalary],
                      ["Advances", approvedAdvance],
                      ["Final payable", payable],
                      ["Balance due", balanceDue],
                    ].map(([label, amount]) => (
                      <div key={label} style={{ background: C.cardAlt, padding: 10, borderRadius: 9 }}>
                        <div style={{ color: C.gray, fontSize: 11 }}>{label}</div>
                        <strong style={{ display: "block", color: label === "Final payable" ? C.gold : C.ink, marginTop: 4 }}>{formatCurrency(amount)}</strong>
                      </div>
                    ))}
                  </div>
                  {salary.carryForwardAdvance > 0 && (
                    <div style={{ color: "#FCA5A5", fontSize: 12, marginTop: 8 }}>Carry forward advance: {formatCurrency(salary.carryForwardAdvance)}</div>
                  )}
                  {payrollRow?.carryForwardIn > 0 && (
                    <div style={{ color: C.gold, fontSize: 12, marginTop: 8 }}>Previous month carry forward: {formatCurrency(payrollRow.carryForwardIn)}</div>
                  )}

                  <h4 style={{ color: C.ink, margin: "20px 0 8px" }}>Attendance calendar</h4>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 4, color: C.gray, fontSize: 10, textAlign: "center" }}>
                    {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => <strong key={day} style={{ padding: 4 }}>{day}</strong>)}
                    {Array.from({ length: firstWeekday }, (_, index) => <span key={`blank-${index}`} />)}
                    {Array.from({ length: calendarCount }, (_, index) => {
                      const day = index + 1;
                      const date = `${month}-${String(day).padStart(2, "0")}`;
                      const record = allAttendanceRecords.get(`${selectedMember.id}_${date}`);
                      const status = record?.status || "";
                      const color = status === "Present" ? C.green
                        : status === "Half Day" ? C.gold
                          : status === "Absent" ? "#F87171"
                            : status === "Paid Leave" ? C.blue
                              : C.gray;
                      return (
                        <button
                          key={date}
                          type="button"
                          disabled={date > todayKey()}
                          onClick={() => setAttendanceForm((form) => ({
                            ...form,
                            staffId: selectedMember.id,
                            date,
                            status: status || "Present",
                          }))}
                          title={status ? `${status} · ${record.source === "gps" ? "GPS" : record.source === "leave" ? "Leave" : "Manual"}` : "Not marked"}
                          style={{ minWidth: 0, padding: "6px 2px", border: `1px solid ${date === attendanceForm.date ? C.gold : C.line}`, borderRadius: 7, background: C.bg, color: date > todayKey() ? C.gray : color, cursor: date > todayKey() ? "not-allowed" : "pointer", opacity: date > todayKey() ? 0.45 : 1 }}
                        >
                          <span style={{ display: "block", fontSize: 12, fontWeight: 800 }}>{day}</span>
                          <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", fontSize: 8 }}>{status || "—"}</span>
                          {record && <span style={{ display: "block", fontSize: 7 }}>{record.source === "gps" ? "GPS" : "Manual"}</span>}
                          {record?.checkInAt && <span style={{ display: "block", fontSize: 7 }}>In {formatIndiaTime(record.checkInAt)}</span>}
                          {record?.checkOutAt && <span style={{ display: "block", fontSize: 7 }}>Out {formatIndiaTime(record.checkOutAt)}</span>}
                          {record?.shiftName && <span style={{ display: "block", fontSize: 7 }}>{record.shiftName}</span>}
                          {record?.lateMinutes > 0 && <span style={{ display: "block", fontSize: 7, color: C.gold }}>Late {record.lateMinutes}m</span>}
                          {record?.incomplete && <span style={{ display: "block", fontSize: 7, color: "#FCA5A5" }}>Incomplete</span>}
                          {record?.earlyLeave && <span style={{ display: "block", fontSize: 7, color: C.gold }}>Early leave</span>}
                        </button>
                      );
                    })}
                  </div>

                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      saveAttendance(selectedMember.id, attendanceForm.date, attendanceForm.status);
                    }}
                    style={{ display: "flex", alignItems: "end", gap: 8, flexWrap: "wrap", marginTop: 12 }}
                  >
                    <label style={{ ...labelStyle, flex: 1, minWidth: 170 }}>
                      Update {attendanceForm.date}
                      <select value={attendanceForm.status} onChange={(event) => setAttendanceForm((form) => ({ ...form, status: event.target.value }))} style={inputStyle}>
                        {ATTENDANCE_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
                      </select>
                    </label>
                    <button type="submit" disabled={busyId === "attendance" || attendanceForm.date > todayKey()} style={buttonStyle}>
                      {busyId === "attendance" ? "Saving..." : "Save status"}
                    </button>
                  </form>
                  {selectedDateRecord && (
                    <div style={{ marginTop: 6, color: C.gray, fontSize: 11 }}>
                      Current: {selectedDateRecord.status} · {selectedDateRecord.source === "gps" ? "GPS" : "Manual"}
                    </div>
                  )}

                  <h4 style={{ color: C.ink, margin: "20px 0 8px" }}>Salary payment history · {month}</h4>
                  {paymentHistory.length === 0
                    ? <div style={{ color: C.gray, fontSize: 12 }}>No salary payments recorded for this month.</div>
                    : paymentHistory.map((payment) => {
                      const cancelled = String(payment.status || "paid").toLowerCase() === "cancelled";
                      const paymentBusy = busyId === `cancel-payment-${payment.id}`;
                      return (
                        <div key={payment.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "8px 0", borderTop: `1px solid ${C.line}`, color: C.ink, fontSize: 12 }}>
                          <div>
                            <strong>{payment.date} · {formatCurrency(Number(payment.amount || 0))}</strong>
                            {payment.note && <div style={{ marginTop: 3, color: C.gray }}>{payment.note}</div>}
                            {cancelled && <small style={{ color: "#FCA5A5" }}>Cancelled</small>}
                          </div>
                          {!cancelled && (
                            <button type="button" disabled={paymentBusy} onClick={() => handleCancelSalaryPayment(payment)} style={{ ...buttonStyle, padding: "6px 9px", background: "#5B2630", color: "#FCA5A5" }}>
                              {paymentBusy ? "..." : "Cancel payment"}
                            </button>
                          )}
                        </div>
                      );
                    })}

                  <h4 style={{ color: C.ink, margin: "20px 0 8px" }}>Approved advances</h4>
                  {(approvedAdvancesByStaff.get(selectedMember.id) || []).length === 0
                    ? <div style={{ color: C.gray, fontSize: 12 }}>Is month mein approved advance nahi hai.</div>
                    : (approvedAdvancesByStaff.get(selectedMember.id) || []).map((advance) => (
                      <div key={`${advance.source}-${advance.id}`} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "8px 0", borderTop: `1px solid ${C.line}`, color: C.ink, fontSize: 12 }}>
                        <span>{advance.date || advance.month || (advance.createdAt ? new Date(typeof advance.createdAt.toDate === "function" ? advance.createdAt.toDate() : advance.createdAt).toLocaleDateString("en-CA") : "Date unavailable")}</span>
                        <strong>{formatCurrency(Number(advance.amount || 0))}</strong>
                      </div>
                    ))}
                </section>
              </div>
            );
          })()}

          {paymentMemberId && (() => {
            const paymentRow = payrollRows.find((entry) => entry.member.id === paymentMemberId);
            if (!paymentRow) return null;
            const amount = Number(paymentForm.amount);
            const remaining = Number.isFinite(amount) ? Math.max(0, paymentRow.balanceDue - amount) : paymentRow.balanceDue;
            return (
              <div
                role="presentation"
                onClick={() => setPaymentMemberId("")}
                style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.76)", display: "grid", placeItems: "center", padding: 14 }}
              >
                <form
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="salary-payment-title"
                  onSubmit={handleCreateSalaryPayment}
                  onClick={(event) => event.stopPropagation()}
                  style={{ ...cardStyle, width: "min(480px, 100%)", display: "grid", gap: 12, boxSizing: "border-box" }}
                >
                  <h3 id="salary-payment-title" style={{ margin: 0, color: C.ink }}>Salary payment · {displayStaffName(paymentRow.member)}</h3>
                  <label style={labelStyle}>
                    Payable amount (₹)
                    <input readOnly value={paymentRow.payable.toFixed(2)} style={inputStyle} />
                  </label>
                  <div style={{ color: C.gray, fontSize: 12 }}>Balance due before this payment: {formatCurrency(paymentRow.balanceDue)}</div>
                  <label style={labelStyle}>
                    Amount paying now (₹)
                    <input required type="number" min="0" max={paymentRow.balanceDue} step="0.01" value={paymentForm.amount} onChange={(event) => setPaymentForm((form) => ({ ...form, amount: event.target.value }))} style={inputStyle} />
                  </label>
                  <label style={labelStyle}>
                    Payment date
                    <input required type="date" value={paymentForm.date} onChange={(event) => setPaymentForm((form) => ({ ...form, date: event.target.value }))} style={inputStyle} />
                  </label>
                  <label style={labelStyle}>
                    Note (optional)
                    <input maxLength={500} value={paymentForm.note} onChange={(event) => setPaymentForm((form) => ({ ...form, note: event.target.value }))} style={inputStyle} />
                  </label>
                  {remaining > 0 && (
                    <label style={{ display: "flex", alignItems: "center", gap: 8, color: C.ink, fontSize: 13 }}>
                      <input type="checkbox" checked={paymentForm.carryForward} onChange={(event) => setPaymentForm((form) => ({ ...form, carryForward: event.target.checked }))} />
                      Carry forward balance ({formatCurrency(remaining)}) to {nextMonthKey(month)}
                    </label>
                  )}
                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="submit" disabled={busyId === "salary-payment"} style={buttonStyle}>
                      {busyId === "salary-payment" ? "Saving..." : "Save payment"}
                    </button>
                    <button type="button" onClick={() => setPaymentMemberId("")} style={{ ...buttonStyle, background: C.cardAlt, color: C.ink }}>Close</button>
                  </div>
                </form>
              </div>
            );
          })()}
        </section>
      )}
    </section>
  );
}
