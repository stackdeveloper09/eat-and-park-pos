import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  browserLocalPersistence,
  EmailAuthProvider,
  onAuthStateChanged,
  reauthenticateWithCredential,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
  updatePassword,
} from "firebase/auth";
import { addDoc, collection, doc, getDoc, getDocs, onSnapshot, query, serverTimestamp, setDoc, updateDoc, where, writeBatch } from "firebase/firestore";
import { auth } from "./firebase";
import { db } from "./firebase";
import {
  ATTENDANCE_RADIUS_METERS,
  attendanceDayValue,
  calculateSalaryBalance,
  calculateStaffSalary,
  dateRangeInclusive,
  daysInMonth,
  haversineDistanceMeters,
  isValidDateKey,
  RESTAURANT_LOCATION,
} from "./lib/staffPayroll";
import {
  autoStatus,
  DEFAULT_SHIFTS,
  formatIndiaTime,
  getTodayIST,
  isShiftRestTime,
} from "./lib/staffShifts";
import { fetchFirebaseServerTime, getIndiaMinutes } from "./lib/attendanceServerTime";
import "./AttendanceApp.css";
import { STAFF_ROLES } from "./lib/roles";
import { ATTENDANCE_STRINGS } from "./lib/attendanceStrings";
import StaffPasswordChange from "./StaffPasswordChange";

const STAFF_ROLE_SET = new Set(STAFF_ROLES);

function getErrorMessage(error) {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

function formatCurrency(value) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(value);
}

function timestampMillis(value) {
  if (typeof value === "number") return value;
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (typeof value?.toDate === "function") return value.toDate().getTime();
  return 0;
}

function logFirestoreAccessError(label, error, expectedUid) {
  const currentUser = auth.currentUser;
  console.error(label, error, {
    projectId: db.app.options.projectId,
    authUserPresent: Boolean(currentUser),
    authUserAnonymous: currentUser?.isAnonymous ?? null,
    authUidMatchesStaffUid: Boolean(currentUser?.uid && currentUser.uid === expectedUid),
  });
}

function clearStaleAttendanceStorage(todayIST) {
  try {
    [localStorage, sessionStorage].forEach((storage) => {
      Object.keys(storage).forEach((key) => {
        if (key.toLowerCase().includes("attendance")
          && key !== "attendance_language"
          && /\d{4}-\d{2}-\d{2}/.test(key)
          && !key.includes(todayIST)) {
          storage.removeItem(key);
        }
      });
    });
  } catch (error) {
    console.log("Attendance stale storage cleanup skipped", error);
  }
}

const ATTENDANCE_START_MINUTES = 9 * 60 + 30;
const ATTENDANCE_END_MINUTES = 22 * 60;
const MAX_GEOFENCE_TOLERANCE_METERS = 100;
const PENDING_APPROVAL_ACCURACY_METERS = 300;

function geolocationErrorMessage(error) {
  if (error?.code === 1) return "Location ON karo: Chrome/Safari me Location allow aur Precise/Exact location chalu karo.";
  if (error?.code === 2) return "GPS location unavailable hai. Location ON karo aur GPS/network check karo.";
  if (error?.code === 3) return "GPS timeout hua. Thodi der GPS open rakhkar dobara try karo.";
  if (error?.message === "secure-context") return "GPS ke liye HTTPS connection zaroori hai.";
  if (error?.message === "geolocation-unavailable") return "Is browser mein Location/GPS available nahi hai. Browser settings check karo.";
  return error?.message || "Location nahi mil saki. Location ON karke dobara try karein.";
}

function buildPayslipPdf(items) {
  const esc = (s) => String(s ?? "").replace(/[^\x20-\x7E]/g, "?").replace(/([\\()])/g, "\\$1");
  let content = "";
  items.forEach((item) => {
    if (item.line) {
      content += `0.6 w 50 ${item.line} m 545 ${item.line} l S\n`;
      return;
    }
    const size = item.size || 11;
    content += `BT /${item.bold ? "F2" : "F1"} ${size} Tf ${item.x} ${item.y} Td (${esc(item.text)}) Tj ET\n`;
  });
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((obj, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
    + offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")
    + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return new Blob([pdf], { type: "application/pdf" });
}

export default function AttendanceApp({ currentUser: currentUserProp } = {}) {
  const [user, setUser] = useState(null);
  const [staff, setStaff] = useState(null);
  const [authInitialized, setAuthInitialized] = useState(false);
  const [payroll, setPayroll] = useState(null);
  const [salaryPayments, setSalaryPayments] = useState([]);
  const [salaryCarryForwards, setSalaryCarryForwards] = useState([]);
  const [attendanceRecords, setAttendanceRecords] = useState([]);
  const [todayAttendanceRecord, setTodayAttendanceRecord] = useState(null);
  const [todayAttendanceLoadedDate, setTodayAttendanceLoadedDate] = useState("");
  const [todayAttendanceLoadError, setTodayAttendanceLoadError] = useState("");
  const [legacyAttendanceRecords, setLegacyAttendanceRecords] = useState([]);
  const [advanceRecords, setAdvanceRecords] = useState([]);
  const [legacyAdvanceRecords, setLegacyAdvanceRecords] = useState([]);
  const [leaveRequests, setLeaveRequests] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [staffNotifications, setStaffNotifications] = useState([]);
  const [restaurantSettings, setRestaurantSettings] = useState({});
  const [shifts, setShifts] = useState(DEFAULT_SHIFTS);
  const [activeSection, setActiveSection] = useState("home");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [markingAllNotifications, setMarkingAllNotifications] = useState(false);
  const [notificationActionError, setNotificationActionError] = useState("");
  const notificationReadLock = useRef(false);
  const [selectedMonthDraft, setSelectedMonth] = useState("");
  const [language, setLanguage] = useState(() => {
    try { return localStorage.getItem("attendance_language") === "hi" ? "hi" : "en"; } catch { return "en"; }
  });
  const languageRef = useRef(language);
  const [phoneDraft, setPhoneDraft] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState("");
  const [selectedAttendanceDetail, setSelectedAttendanceDetail] = useState(null);
  const [dataLoaded, setDataLoaded] = useState({
    attendance: false,
    legacyAttendance: false,
    advances: false,
    legacyAdvances: false,
    payroll: false,
    payments: false,
    carryForwards: false,
    leaves: false,
    notifications: false,
    staffNotifications: false,
  });
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [advanceAmount, setAdvanceAmount] = useState("");
  const [advanceReason, setAdvanceReason] = useState("");
  const [submittingAdvance, setSubmittingAdvance] = useState(false);
  const [leaveForm, setLeaveForm] = useState({
    fromDate: "",
    toDate: "",
    type: "Paid Leave",
    reason: "",
  });
  const [submittingLeave, setSubmittingLeave] = useState(false);
  const [cancellingLeaveId, setCancellingLeaveId] = useState("");
  const [cancellingAdvanceId, setCancellingAdvanceId] = useState("");
  const [loginError, setLoginError] = useState("");
  const [attendanceError, setAttendanceError] = useState("");
  const [profileError, setProfileError] = useState("");
  const [notice, setNotice] = useState("");
  const [attendanceWriteFailed, setAttendanceWriteFailed] = useState(false);
  const [optimisticAttendance, setOptimisticAttendance] = useState(null);
  const [checkingLocation, setCheckingLocation] = useState(false);
  const [gpsWarmupState, setGpsWarmupState] = useState("searching");
  const [gpsAccuracy, setGpsAccuracy] = useState(null);
  const [gpsWaitSeconds, setGpsWaitSeconds] = useState(0);
  const [gpsPermissionDenied, setGpsPermissionDenied] = useState(false);
  const [pendingAttendanceDraft, setPendingAttendanceDraft] = useState(null);
  const bestGpsPositionRef = useRef(null);
  const gpsWatchIdRef = useRef(null);
  const gpsWaiterRef = useRef(null);
  const [gpsRetryKey, setGpsRetryKey] = useState(0);
  const [attendanceRadius, setAttendanceRadius] = useState(ATTENDANCE_RADIUS_METERS);
  const [gpsSettingsLoading, setGpsSettingsLoading] = useState(true);
  const [gpsSettingsError, setGpsSettingsError] = useState("");
  const [now, setNow] = useState(() => new Date());
  const [serverNow, setServerNow] = useState(null);
  const [serverTimeError, setServerTimeError] = useState("");
  const serverTimeAnchor = useRef(null);
  const displayNow = new Date(serverNow || now);
  const today = getTodayIST(displayNow);
  const selectedMonth = selectedMonthDraft || today.slice(0, 7);
  const effectiveCheckOutLabel = (record) => {
    if (record?.checkOutAt) return formatIndiaTime(record.checkOutAt);
    if (!record?.checkInAt || !record?.date) return null;
    const dateClosed = record.date < today
      || (record.date === today && serverIndiaMinutes != null && serverIndiaMinutes >= ATTENDANCE_END_MINUTES);
    return dateClosed ? "10:00 PM" : null;
  };
  const todayAttendanceLoaded = todayAttendanceLoadedDate === today;
  const serverTimeReady = serverNow != null;
  const serverIndiaMinutes = serverNow == null ? null : getIndiaMinutes(serverNow);
  const attendanceTimeAllowed = serverIndiaMinutes != null
    && serverIndiaMinutes >= ATTENDANCE_START_MINUTES
    && serverIndiaMinutes < ATTENDANCE_END_MINUTES;
  const attendanceTimeClosed = serverIndiaMinutes != null && serverIndiaMinutes >= ATTENDANCE_END_MINUTES;
  const staffUid = user?.uid || null;
  const suppliedName = currentUserProp?.uid && currentUserProp.uid === staffUid ? currentUserProp.name : "";
  const displayName = staff?.name || suppliedName || user?.email?.split("@")[0] || "Staff";
  const t = (key) => ATTENDANCE_STRINGS[language][key] || key;
  const locale = language === "hi" ? "hi-IN" : "en-IN";
  const localizeAttendanceStatus = (status) => ({
    Present: t("present"),
    "Half Day": t("halfDay"),
    Absent: t("absent"),
    "Paid Leave": t("paidLeave"),
    "Unpaid Leave": t("unpaidLeave"),
  })[status] || status;
  const localizeRequestStatus = (status) => ({
    pending: t("pendingStatus"),
    approved: t("approvedStatus"),
    rejected: t("rejectedStatus"),
    cancelled: t("cancelledStatus"),
  })[String(status || "").toLowerCase()] || status;
  const markDataLoaded = (key) => setDataLoaded((current) => ({ ...current, [key]: true }));
  const staffShift = shifts[staff?.shiftId] || null;
  const currentUserNotifications = useMemo(() => [
    ...notifications
      .filter((notification) => notification.userId === staffUid)
      .map((notification) => ({ ...notification, collectionName: "notifications" })),
    ...staffNotifications
      .filter((notification) => notification.toStaffId === staffUid)
      .map((notification) => ({ ...notification, userId: notification.toStaffId, collectionName: "staffNotifications" })),
  ].sort((a, b) => timestampMillis(b.createdAt) - timestampMillis(a.createdAt)), [
    notifications,
    staffNotifications,
    staffUid,
  ]);
  const unreadNotifications = currentUserNotifications.filter((notification) => notification.read !== true).length;

  const attendanceHistory = useMemo(() => {
    const recordsByDate = new Map();
    attendanceRecords.forEach((record) => {
      if (!record.date) return;
      const current = recordsByDate.get(record.date);
      const source = record.source || (record.distanceMeters != null ? "gps" : "manual");
      const normalized = { ...record, source };
      const sourcePriority = { gps: 0, manual: 1, leave: 2 };
      if (!current || sourcePriority[source] > sourcePriority[current.source]) {
        recordsByDate.set(record.date, normalized);
      }
    });
    legacyAttendanceRecords.forEach((record) => {
      if (record.date && record.action === "present" && !recordsByDate.has(record.date)) {
        recordsByDate.set(record.date, { ...record, status: "Present", source: "gps" });
      }
    });
    return [...recordsByDate.values()]
      .filter((record) => record.status || record.action === "present")
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [attendanceRecords, legacyAttendanceRecords]);

  const advanceHistory = useMemo(
    () => [...advanceRecords, ...legacyAdvanceRecords]
      .sort((a, b) => timestampMillis(b.createdAt) - timestampMillis(a.createdAt)),
    [advanceRecords, legacyAdvanceRecords],
  );
  const overlappingLeaveRequests = leaveRequests.filter((leave) => (
    ["pending", "approved"].includes(String(leave.status || "").toLowerCase())
    && leave.fromDate <= leaveForm.toDate
    && leave.toDate >= leaveForm.fromDate
  ));
  const todayAttendance = optimisticAttendance?.date === today
    ? optimisticAttendance
    : todayAttendanceRecord?.date === today ? todayAttendanceRecord : null;
  const todayAttendanceMarked = Boolean(
    todayAttendance?.checkInAt
    && String(todayAttendance.status || "").toLowerCase() !== "pending_approval",
  );
  const adminAttendanceBlocksCheckIn = Boolean(
    todayAttendance
    && !todayAttendance.checkInAt
    && ["present", "leave", "paid leave"].includes(String(todayAttendance.status || "").toLowerCase())
    && (String(todayAttendance.markedBy || "").toLowerCase() === "admin"
      || todayAttendance.source === "manual"),
  );
  const buttonShown = !todayAttendanceLoaded
    ? "loading"
    : todayAttendanceMarked
      ? "present"
      : adminAttendanceBlocksCheckIn
        ? "admin-override"
        : todayAttendance?.checkInAt
          ? String(todayAttendance.status || "").toLowerCase() === "pending_approval" ? "pending" : "present"
          : attendanceTimeClosed ? "closed"
            : serverIndiaMinutes != null && serverIndiaMinutes < ATTENDANCE_START_MINUTES ? "too-early"
              : "checkin";
  useEffect(() => {
    console.log("attendance state", { todayIST: today, todayRecord: todayAttendance, buttonShown });
  }, [today, todayAttendance, buttonShown]);
  const selectedMonthRecords = attendanceHistory.filter((record) => record.date?.startsWith(`${selectedMonth}-`));
  const selectedMonthLeaves = leaveRequests.filter((leave) => (
    String(leave.status || "").toLowerCase() === "approved"
    && leave.fromDate <= `${selectedMonth}-${String(daysInMonth(selectedMonth)).padStart(2, "0")}`
    && leave.toDate >= `${selectedMonth}-01`
  ));
  const attendanceByDate = new Map(selectedMonthRecords.map((record) => [record.date, record]));
  selectedMonthLeaves.forEach((leave) => {
    dateRangeInclusive(leave.fromDate, leave.toDate)
      .filter((date) => date.startsWith(`${selectedMonth}-`) && !attendanceByDate.has(date))
      .forEach((date) => attendanceByDate.set(date, {
        date,
        status: leave.type === "Paid Leave" ? "Paid Leave" : leave.type === "Half Day" ? "Half Day" : "Unpaid Leave",
        source: "leave",
        leaveRequestId: leave.id,
      }));
  });
  const attendanceSummary = [...attendanceByDate.values()].reduce((summary, record) => {
    const status = String(record.status || (record.action === "present" ? "Present" : "")).toLowerCase();
    if (status === "present" || status === "late") summary.present += 1;
    else if (["half day", "half-day", "half_day"].includes(status)) summary.halfDay += 1;
    else if (status === "absent") summary.absent += 1;
    else if (["paid leave", "unpaid leave", "leave"].includes(status)) summary.leave += 1;
    if (record.late === true || status === "late" || Number(record.lateMinutes || 0) > 0) summary.late += 1;
    return summary;
  }, { present: 0, halfDay: 0, absent: 0, leave: 0, late: 0 });
  const selectedPresentDays = selectedMonthRecords.reduce((total, record) => (
    total + (record.status === "Paid Leave" ? 0
      : attendanceDayValue(record.status || (record.action === "present" ? "Present" : "")))
  ), 0);
  const selectedPaidLeaveDays = selectedMonthRecords.filter((record) => record.status === "Paid Leave").length;
  const salaryMonthlyAmount = Number(staff?.monthlySalary ?? payroll?.monthlySalary ?? 0);
  const salaryCalculation = calculateStaffSalary({
    monthlySalary: salaryMonthlyAmount,
    presentDays: selectedPresentDays,
    paidLeaveDays: selectedPaidLeaveDays,
    totalApprovedAdvance: advanceHistory
      .filter((advance) => String(advance.status || "").toLowerCase() === "approved"
        && (advance.month === selectedMonth || String(advance.date || "").startsWith(`${selectedMonth}-`)))
      .reduce((total, advance) => total + Math.max(0, Number(advance.amount || 0)), 0),
    daysInPayPeriod: daysInMonth(selectedMonth),
  });
  const salaryCarryIn = salaryCarryForwards
    .filter((entry) => entry.month === selectedMonth && String(entry.status || "active").toLowerCase() === "active")
    .reduce((total, entry) => total + Math.max(0, Number(entry.amount || 0)), 0);
  const selectedMonthPayments = salaryPayments
    .filter((payment) => payment.month === selectedMonth && String(payment.status || "paid").toLowerCase() !== "cancelled")
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const salaryHistoryMonths = [...new Set([
    ...salaryPayments.map((payment) => payment.month),
    ...attendanceHistory.map((record) => record.date?.slice(0, 7)),
    ...advanceHistory.map((advance) => advance.month || String(advance.date || "").slice(0, 7)),
    ...salaryCarryForwards.map((entry) => entry.month),
    ...leaveRequests.flatMap((leave) => [leave.fromDate?.slice(0, 7), leave.toDate?.slice(0, 7)]),
  ].filter((month) => month && month <= today.slice(0, 7)))]
    .sort((a, b) => b.localeCompare(a));
  const salaryPaid = selectedMonthPayments.reduce((total, payment) => total + Math.max(0, Number(payment.amount || 0)), 0);
  const salaryPayable = salaryCalculation.finalPayable + salaryCarryIn;
  const { balanceDue: salaryBalance } = calculateSalaryBalance(salaryPayable, salaryPaid);
  const salaryStatus = salaryBalance <= 0 ? "Paid" : salaryPaid > 0 ? "Partial" : "Unpaid";
  const overallAdvances = advanceHistory
    .filter((advance) => String(advance.status || "").toLowerCase() === "approved")
    .reduce((total, advance) => total + Math.max(0, Number(advance.amount || 0)), 0);
  const calendarDays = daysInMonth(selectedMonth);
  const calendarFirstDay = new Date(`${selectedMonth}-01T00:00:00Z`).getUTCDay();

  useEffect(() => {
    document.title = "Eat & Park Attendance";
    const manifestLink = document.querySelector('link[rel="manifest"]');
    if (manifestLink) manifestLink.href = "/attendance-manifest.json";
    const touchIcon = document.querySelector('link[rel="apple-touch-icon"]');
    if (touchIcon) touchIcon.href = "/icons/staff-180.png";
    const appTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    if (appTitle) appTitle.content = "Eat & Park Attendance";
  }, []);

  useEffect(() => {
    languageRef.current = language;
  }, [language]);

  useEffect(() => {
    const active = { value: true };
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (active.value) setAuthInitialized(true);
      if (!currentUser) {
        if (active.value) {
          setUser(null);
          setStaff(null);
          setPayroll(null);
          setSalaryPayments([]);
          setSalaryCarryForwards([]);
          setAttendanceRecords([]);
          setLegacyAttendanceRecords([]);
          setAdvanceRecords([]);
          setLegacyAdvanceRecords([]);
          setLeaveRequests([]);
          setNotifications([]);
          setStaffNotifications([]);
          setNotificationsOpen(false);
          setNotificationActionError("");
          setDataLoaded({
            attendance: false,
            legacyAttendance: false,
            advances: false,
            legacyAdvances: false,
            payroll: false,
            payments: false,
            carryForwards: false,
            leaves: false,
            notifications: false,
            staffNotifications: false,
          });
          setOptimisticAttendance(null);
          setProfileError("");
          setLoading(false);
        }
        return;
      }

      if (active.value) setLoading(true);
      if (active.value) {
        setUser(null);
        setStaff(null);
        setAttendanceRecords([]);
        setLegacyAttendanceRecords([]);
        setAdvanceRecords([]);
        setLegacyAdvanceRecords([]);
        setLeaveRequests([]);
        setNotifications([]);
        setStaffNotifications([]);
        setNotificationsOpen(false);
        setNotificationActionError("");
        setPayroll(null);
        setProfileError("");
        setDataLoaded({
          attendance: false,
          legacyAttendance: false,
          advances: false,
          legacyAdvances: false,
          payroll: false,
          payments: false,
          carryForwards: false,
          leaves: false,
          notifications: false,
          staffNotifications: false,
        });
      }
      try {
        const staffSnapshot = await getDoc(doc(db, "staff", currentUser.uid));
        const profile = staffSnapshot.exists() ? staffSnapshot.data() : null;
        const role = String(profile?.role || "").toLowerCase();
        if (!profile || profile.active === false || !STAFF_ROLE_SET.has(role)) {
          await signOut(auth);
          if (active.value) {
            setLoginError(ATTENDANCE_STRINGS[languageRef.current].profileVerifyError);
            setLoading(false);
          }
          return;
        }
        if (active.value) {
          setUser(currentUser);
          setStaff(profile);
          setPhoneDraft(String(profile.phone || ""));
          setOptimisticAttendance(null);
          setLoginError("");
          setLoading(false);
        }
      } catch (error) {
        console.error("Attendance staff verification failed:", error);
        if (active.value) {
          setLoginError(`Staff account verify nahi hua: ${getErrorMessage(error)}`);
          setLoading(false);
        }
      }
    });
    return () => {
      active.value = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!staffUid || !staff || staff.mustChangePassword === true) return undefined;
    let active = true;
    const synchronizeServerTime = async () => {
      try {
        const timestamp = await fetchFirebaseServerTime(staffUid);
        if (!active) return;
        serverTimeAnchor.current = { timestamp, monotonicTime: performance.now() };
        setServerNow(timestamp);
        setServerTimeError("");
      } catch (error) {
        console.error("Firebase server time sync failed:", error);
        if (active) setServerTimeError(getErrorMessage(error));
      }
    };
    void synchronizeServerTime();
    const clockTimer = window.setInterval(() => {
      const anchor = serverTimeAnchor.current;
      if (anchor) setServerNow(anchor.timestamp + performance.now() - anchor.monotonicTime);
    }, 1000);
    const refreshTimer = window.setInterval(() => void synchronizeServerTime(), 30000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void synchronizeServerTime();
    };
    window.addEventListener("focus", synchronizeServerTime);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      active = false;
      window.clearInterval(clockTimer);
      window.clearInterval(refreshTimer);
      window.removeEventListener("focus", synchronizeServerTime);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      serverTimeAnchor.current = null;
      setServerNow(null);
    };
  }, [staffUid, staff?.mustChangePassword]);

  useEffect(() => {
    if (!selectedMonthDraft) setSelectedMonth(today.slice(0, 7));
    setLeaveForm((form) => ({
      ...form,
      fromDate: form.fromDate || today,
      toDate: form.toDate || today,
    }));
    setOptimisticAttendance((current) => current?.date === today ? current : null);
    setTodayAttendanceRecord((current) => current?.date === today ? current : null);
    setTodayAttendanceLoadedDate("");
    setTodayAttendanceLoadError("");
    setSelectedAttendanceDetail(null);
    clearStaleAttendanceStorage(today);
  }, [selectedMonthDraft, today]);

  useEffect(() => {
    if (!staffUid || staff?.mustChangePassword === true || todayAttendance?.checkInAt) return undefined;
    if (typeof window !== "undefined" && !window.isSecureContext) {
      setGpsWarmupState("searching");
      return undefined;
    }
    if (!navigator.geolocation) {
      setGpsWarmupState("searching");
      return undefined;
    }

    let active = true;
    let watchErrorReported = false;
    const watchId = navigator.geolocation.watchPosition((position) => {
      if (!active) return;
      const accuracy = Number(position.coords.accuracy);
      if (Number.isFinite(accuracy)
        && (!bestGpsPositionRef.current || accuracy < bestGpsPositionRef.current.accuracy)) {
        bestGpsPositionRef.current = { position, accuracy, receivedAt: performance.now() };
        setGpsAccuracy(accuracy);
        setGpsWarmupState("ready");
      }
      gpsWaiterRef.current?.onPosition(position);
    }, (error) => {
      if (!active) return;
      if (error.code === 1) setGpsPermissionDenied(true);
      if (!watchErrorReported) {
        watchErrorReported = true;
        gpsWaiterRef.current?.onError(error);
      }
    }, { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 });
    gpsWatchIdRef.current = watchId;
    return () => {
      active = false;
      navigator.geolocation.clearWatch(watchId);
      if (gpsWatchIdRef.current === watchId) gpsWatchIdRef.current = null;
    };
  }, [gpsRetryKey, staffUid, staff?.mustChangePassword, today, todayAttendance?.checkInAt]);

  useEffect(() => {
    if (
      !authInitialized
      || !staffUid
      || !staff
      || !serverTimeReady
      || staff.mustChangePassword === true
      || auth.currentUser?.uid !== staffUid
    ) {
      setTodayAttendanceRecord(null);
      setTodayAttendanceLoadedDate("");
      setTodayAttendanceLoadError("");
      return undefined;
    }

    setTodayAttendanceRecord(null);
    setTodayAttendanceLoadedDate("");
    setTodayAttendanceLoadError("");
    const todayRef = doc(db, "attendance", `${staffUid}_${today}`);
    return onSnapshot(todayRef, (snapshot) => {
      setTodayAttendanceRecord(snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null);
      setTodayAttendanceLoadedDate(today);
      setTodayAttendanceLoadError("");
    }, (error) => {
      console.error("Today's attendance load failed:", error);
      setProfileError(`Aaj ki attendance load nahi hui: ${getErrorMessage(error)}`);
      setTodayAttendanceLoadError(getErrorMessage(error));
    });
  }, [authInitialized, staffUid, staff?.mustChangePassword, serverTimeReady, today]);

  useEffect(() => onSnapshot(doc(db, "settings", "restaurant"), (snapshot) => {
    if (!snapshot.exists()) {
      setAttendanceRadius(ATTENDANCE_RADIUS_METERS);
      setGpsSettingsError("");
      setGpsSettingsLoading(false);
      return;
    }

    const settings = snapshot.data();
    const lat = Number.parseFloat(settings.lat);
    const lng = Number.parseFloat(settings.lng);
    const radius = Number.parseFloat(settings.radius);
    const validSettings = Number.isFinite(lat)
      && lat >= -90 && lat <= 90
      && Number.isFinite(lng)
      && lng >= -180 && lng <= 180
      && Number.isFinite(radius)
      && radius > 0 && radius <= 10000;
    if (!validSettings) {
      setGpsSettingsError("Restaurant GPS settings invalid hain. Admin se settings update karwayein.");
      setGpsSettingsLoading(false);
      return;
    }
    setAttendanceRadius(radius);
    setGpsSettingsError("");
    setGpsSettingsLoading(false);
  }, (error) => {
    console.error("Restaurant GPS settings load failed:", error);
    setGpsSettingsError(`GPS settings load nahi hui: ${getErrorMessage(error)}`);
    setGpsSettingsLoading(false);
  }), []);

  useEffect(() => onSnapshot(doc(db, "settings", "shifts"), (snapshot) => {
    const saved = snapshot.exists() ? snapshot.data()?.shifts : null;
    setShifts(saved && typeof saved === "object" ? saved : DEFAULT_SHIFTS);
  }, (error) => {
    console.error("Shift settings load failed:", error);
    setProfileError(`Shift settings load nahi hui: ${getErrorMessage(error)}`);
  }), []);

  useEffect(() => {
    if (
      !authInitialized ||
      !user?.uid ||
      !staff ||
      staff.mustChangePassword === true ||
      auth.currentUser?.uid !== user.uid ||
      staffUid !== user.uid
    ) return undefined;

    const unsubscribeAttendance = onSnapshot(
      query(collection(db, "attendance"), where("staffId", "==", staffUid)),
      (snapshot) => {
        setAttendanceRecords(snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() })));
        markDataLoaded("attendance");
      },
      (error) => {
        markDataLoaded("attendance");
        console.error("Staff attendance history load failed:", error);
        setProfileError(`Attendance history load nahi hui: ${getErrorMessage(error)}`);
      },
    );
    const unsubscribeLegacyAttendance = onSnapshot(
      query(collection(db, "staffAttendance"), where("uid", "==", staffUid)),
      (snapshot) => {
        setLegacyAttendanceRecords(snapshot.docs.map((entry) => entry.data()));
        markDataLoaded("legacyAttendance");
      },
      (error) => {
        markDataLoaded("legacyAttendance");
        console.error("Legacy attendance history load failed:", error);
        setProfileError(`Attendance history load nahi hui: ${getErrorMessage(error)}`);
      },
    );
    const unsubscribeAdvances = onSnapshot(
      query(collection(db, "advances"), where("staffId", "==", staffUid)),
      (snapshot) => {
        setAdvanceRecords(snapshot.docs.map((entry) => {
          const data = entry.data();
          return { id: entry.id, ...data, source: data.source || "request" };
        }));
        markDataLoaded("advances");
      },
      (error) => {
        markDataLoaded("advances");
        console.error("Staff advance history load failed:", error);
        setProfileError(`Advance history load nahi hui: ${getErrorMessage(error)}`);
      },
    );
    const unsubscribeLegacyAdvances = onSnapshot(
      query(collection(db, "staffAdvances"), where("uid", "==", staffUid)),
      (snapshot) => {
        setLegacyAdvanceRecords(snapshot.docs.map((entry) => {
          const data = entry.data();
          return { id: entry.id, ...data, source: data.source || "request" };
        }));
        markDataLoaded("legacyAdvances");
      },
      (error) => {
        markDataLoaded("legacyAdvances");
        console.error("Legacy advance history load failed:", error);
        setProfileError(`Advance history load nahi hui: ${getErrorMessage(error)}`);
      },
    );
    const unsubscribePayroll = onSnapshot(doc(db, "staffPayroll", staffUid), (snapshot) => {
      setPayroll(snapshot.exists() ? snapshot.data() : null);
      markDataLoaded("payroll");
    }, (error) => {
      markDataLoaded("payroll");
      console.error("Staff salary load failed:", error);
      setProfileError(`Monthly salary load nahi hui: ${getErrorMessage(error)}`);
    });
    const unsubscribeSalaryPayments = onSnapshot(
      query(collection(db, "salaryPayments"), where("staffId", "==", staffUid)),
      (snapshot) => {
        setSalaryPayments(snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() })));
        markDataLoaded("payments");
      },
      (error) => {
        markDataLoaded("payments");
        logFirestoreAccessError("Staff salary payment history load failed:", error, staffUid);
        setProfileError(`Salary payments load nahi hue: ${getErrorMessage(error)}`);
      },
    );
    const unsubscribeCarryForwards = onSnapshot(
      query(collection(db, "salaryCarryForwards"), where("staffId", "==", staffUid)),
      (snapshot) => {
        setSalaryCarryForwards(snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() })));
        markDataLoaded("carryForwards");
      },
      (error) => {
        markDataLoaded("carryForwards");
        logFirestoreAccessError("Staff carry-forward load failed:", error, staffUid);
        setProfileError(`Carry-forward load nahi hua: ${getErrorMessage(error)}`);
      },
    );
    const unsubscribeLeaves = onSnapshot(
      query(collection(db, "leaveRequests"), where("staffId", "==", staffUid)),
      (snapshot) => {
        setLeaveRequests(snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }))
          .sort((a, b) => String(b.fromDate).localeCompare(String(a.fromDate))));
        markDataLoaded("leaves");
      },
      (error) => {
        markDataLoaded("leaves");
        logFirestoreAccessError("Staff leave requests load failed:", error, staffUid);
        setProfileError(`Leave requests load nahi hui: ${getErrorMessage(error)}`);
      },
    );
    const notificationsCollection = collection(db, "notifications");
    const canReadAllNotifications = ["admin", "owner"]
      .includes(String(staff.role || "").toLowerCase());
    const notificationsQuery = canReadAllNotifications
      ? notificationsCollection
      : query(notificationsCollection, where("userId", "==", staffUid));
    const unsubscribeNotifications = onSnapshot(
      notificationsQuery,
      (snapshot) => {
        setNotifications(snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }))
          .sort((a, b) => timestampMillis(b.createdAt) - timestampMillis(a.createdAt)));
        markDataLoaded("notifications");
      },
      (error) => {
        markDataLoaded("notifications");
        logFirestoreAccessError("Staff notifications load failed:", error, staffUid);
        setProfileError(`Notifications load nahi hui: ${getErrorMessage(error)}`);
      },
    );
    const unsubscribeStaffNotifications = onSnapshot(
      query(collection(db, "staffNotifications"), where("toStaffId", "==", staffUid)),
      (snapshot) => {
        setStaffNotifications(snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() })));
        markDataLoaded("staffNotifications");
      },
      (error) => {
        markDataLoaded("staffNotifications");
        logFirestoreAccessError("Staff notification load failed:", error, staffUid);
        setProfileError(`Staff notifications load nahi hui: ${getErrorMessage(error)}`);
      },
    );

    return () => {
      unsubscribeAttendance();
      unsubscribeLegacyAttendance();
      unsubscribeAdvances();
      unsubscribeLegacyAdvances();
      unsubscribePayroll();
      unsubscribeSalaryPayments();
      unsubscribeCarryForwards();
      unsubscribeLeaves();
      unsubscribeNotifications();
      unsubscribeStaffNotifications();
    };
  }, [authInitialized, staff, staffUid, user]);

  useEffect(() => onSnapshot(doc(db, "settings", "restaurant"), (snapshot) => {
    setRestaurantSettings(snapshot.exists() ? snapshot.data() : {});
  }, (error) => {
    console.error("Restaurant contact settings load failed:", error);
    setProfileError(`Restaurant settings load nahi hui: ${getErrorMessage(error)}`);
  }), []);



  const downloadPayslip = async () => {
    const money = (v) => `Rs. ${Number(v || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const items = [
      { text: "Eat & Park", x: 50, y: 790, size: 22, bold: true },
      { text: `Salary Slip - ${selectedMonth}`, x: 50, y: 768, size: 12 },
      { line: 755 },
    ];
    let y = 733;
    const addRow = (label, value, bold = false) => {
      const valueText = String(value);
      items.push({ text: label, x: 50, y, size: 12, bold });
      items.push({ text: valueText, x: 545 - valueText.length * 6.2, y, size: 12, bold });
      y -= 22;
    };
    addRow("Name", displayName);
    addRow("Role", staff?.role || "staff");
    addRow("Monthly salary", money(salaryMonthlyAmount));
    items.push({ line: y + 10 });
    y -= 10;
    addRow("Per day salary", money(salaryCalculation.perDaySalary));
    addRow("Present days", selectedPresentDays);
    addRow("Paid leave days", selectedPaidLeaveDays);
    addRow("Gross salary", money(salaryCalculation.grossSalary));
    addRow("Advance (approved)", `- ${money(salaryCalculation.totalApprovedAdvance)}`);
    addRow("Carry forward", money(salaryCarryIn));
    addRow("Net payable", money(salaryPayable), true);
    addRow("Paid", money(salaryPaid));
    addRow("Balance", money(salaryBalance), true);
    addRow("Status", salaryStatus);
    items.push({ line: y + 10 });
    y -= 14;
    items.push({ text: "Payments", x: 50, y, size: 13, bold: true });
    y -= 22;
    if (selectedMonthPayments.length === 0) {
      items.push({ text: "No payments", x: 50, y, size: 11 });
    } else {
      selectedMonthPayments.slice(0, 15).forEach((payment) => {
        addRow(`${payment.date || "-"}${payment.note ? ` - ${payment.note}` : ""}`.slice(0, 50), money(payment.amount));
      });
    }
    items.push({ text: `Generated on ${new Date().toLocaleDateString("en-IN")}`, x: 50, y: 40, size: 9 });

    try {
      const blob = buildPayslipPdf(items);
      const fileName = `Payslip_${selectedMonth}.pdf`;
      const file = new File([blob], fileName, { type: "application/pdf" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: fileName });
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) {
      if (error?.name === "AbortError") return;
      console.error("Payslip download failed:", error);
      setProfileError(`Payslip download nahi hua: ${getErrorMessage(error)}`);
    }
  };

  const login = async (event) => {
    event.preventDefault();
    setLoginError("");
    setLoading(true);
    try {
      setUser(null);
      setStaff(null);
      if (auth.currentUser) await signOut(auth);
      await setPersistence(auth, browserLocalPersistence);
      await signInWithEmailAndPassword(auth, email.trim().toLowerCase(), password);
    } catch (error) {
      console.error("Attendance login failed:", error);
      const loginErrorMessages = {
        "auth/invalid-credential": t("emailPasswordError"),
        "auth/user-not-found": t("accountNotFoundError"),
        "auth/wrong-password": t("wrongPasswordError"),
        "auth/operation-not-allowed": t("emailPasswordProviderDisabled"),
        "auth/too-many-requests": t("tooManyLoginAttempts"),
        "auth/network-request-failed": t("loginNetworkError"),
      };
      const message = loginErrorMessages[error?.code] || getErrorMessage(error);
      setLoginError(message);
      setLoading(false);
    }
  };

  const getAttendanceContext = async () => {
    const checkInAt = await fetchFirebaseServerTime(staffUid);
    serverTimeAnchor.current = { timestamp: checkInAt, monotonicTime: performance.now() };
    setServerNow(checkInAt);
    setServerTimeError("");
    const minutes = getIndiaMinutes(checkInAt);
    if (minutes < ATTENDANCE_START_MINUTES) {
      throw new Error("Attendance 9:30 AM ke baad hi lag sakti hai");
    }
    if (minutes >= ATTENDANCE_END_MINUTES) {
      throw new Error("Aaj ki attendance band ho chuki hai. Kal subah 9:30 baje se lagegi.");
    }

    const date = getTodayIST(new Date(checkInAt));
    const currentDaySnapshot = await getDoc(doc(db, "attendance", `${staffUid}_${date}`));
    const existing = currentDaySnapshot.exists() ? currentDaySnapshot.data() : null;
    if (existing?.checkInAt) throw new Error("Aaj ki attendance already lag chuki hai");
    const existingStatus = String(existing?.status || "").trim().toLowerCase();
    const adminMarked = ["admin", "admin_approved"].includes(String(existing?.markedBy || "").toLowerCase())
      || (existing?.source === "manual" && String(existing?.markedBy || "").toLowerCase() !== "staff");
    if (adminMarked && ["present", "leave", "paid leave"].includes(existingStatus)) {
      throw new Error("Admin ne aaj ki attendance set ki hai");
    }
    return { checkInAt, date, existing };
  };

  const waitForGpsPosition = async () => {
    const cached = bestGpsPositionRef.current;
    if (cached && performance.now() - cached.receivedAt < 60000
      && Number(cached.accuracy) <= PENDING_APPROVAL_ACCURACY_METERS) {
      return cached.position;
    }
    if (typeof window !== "undefined" && !window.isSecureContext) {
      throw new Error("secure-context");
    }
    if (!navigator.geolocation) throw new Error("geolocation-unavailable");

    setGpsWaitSeconds(0);
    const startedAt = performance.now();
    const progressTimer = window.setInterval(
      () => setGpsWaitSeconds(Math.floor((performance.now() - startedAt) / 1000)),
      1000,
    );
    try {
      return await new Promise((resolve, reject) => {
        let lastError = null;
        let settled = false;
        let lowAccuracyAttempts = 0;
        let retryAttempts = 0;
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(overallTimeout);
          gpsWaiterRef.current = null;
          callback(value);
        };
        const rememberPosition = (position) => {
          const accuracy = Number(position.coords.accuracy);
          if (Number.isFinite(accuracy)
            && (!bestGpsPositionRef.current || accuracy < bestGpsPositionRef.current.accuracy)) {
            bestGpsPositionRef.current = { position, accuracy, receivedAt: performance.now() };
            setGpsAccuracy(accuracy);
            setGpsWarmupState("ready");
          }
          return accuracy;
        };
        const acceptPosition = (position) => {
          const accuracy = rememberPosition(position);
          if (Number.isFinite(accuracy) && accuracy > PENDING_APPROVAL_ACCURACY_METERS
            && lowAccuracyAttempts < 1
            && performance.now() - startedAt < 15000) {
            lowAccuracyAttempts += 1;
            navigator.geolocation.getCurrentPosition(
              acceptPosition,
              fail,
              { enableHighAccuracy: false, maximumAge: 0, timeout: 5000 },
            );
            return;
          }
          finish(resolve, position);
        };
        const fail = (error) => {
          lastError = error;
          if (error?.code === 1) {
            setGpsPermissionDenied(true);
            finish(reject, error);
            return;
          }
          if ((error?.code === 2 || error?.code === 3) && retryAttempts < 1
            && performance.now() - startedAt < 15000) {
            retryAttempts += 1;
            navigator.geolocation.getCurrentPosition(
              acceptPosition,
              fail,
              { enableHighAccuracy: false, maximumAge: 60000, timeout: 5000 },
            );
            return;
          }
          finish(reject, error);
        };
        const overallTimeout = window.setTimeout(
          () => finish(reject, lastError || { code: 3 }),
          15000,
        );
        gpsWaiterRef.current = { onPosition: acceptPosition, onError: fail };
        navigator.geolocation.getCurrentPosition(
          acceptPosition,
          fail,
          { enableHighAccuracy: false, maximumAge: 60000, timeout: 5000 },
        );
      });
    } finally {
      window.clearInterval(progressTimer);
    }
  };

  const saveAttendanceRecord = async ({
    context,
    status = "present",
    verified,
    verifyReason = "",
    position = null,
    distance = null,
    accuracy = null,
    skipGeofence = false,
  }) => {
    const shiftId = staff?.shiftId || "";
    const shift = shifts[shiftId];
    const result = shift ? autoStatus(context.checkInAt, shift) : null;
    const coords = position ? {
      latitude: Number.parseFloat(position.coords.latitude),
      longitude: Number.parseFloat(position.coords.longitude),
      accuracy: Number.parseFloat(position.coords.accuracy),
    } : null;
    const record = {
      staffId: staffUid,
      date: context.date,
      status,
      source: skipGeofence ? "manual" : "gps",
      markedBy: "staff",
      verified,
      checkInAt: context.checkInAt,
      late: result?.late ?? false,
      lateMinutes: result?.lateMinutes ?? 0,
      earlyLeave: false,
      ...(verifyReason ? { verifyReason } : {}),
      ...(coords ? { lastKnownCoords: { ...coords, ...(Number.isFinite(distance) ? { distanceMeters: distance } : {}) } } : {}),
      ...(Number.isFinite(distance) ? { distanceMeters: distance } : {}),
      ...(Number.isFinite(accuracy) ? { accuracyMeters: accuracy } : {}),
      ...(shiftId && shift ? { shiftId, shiftName: shift.name } : {}),
    };
    try {
      await setDoc(doc(db, "attendance", `${staffUid}_${context.date}`), record);
    } catch (error) {
      setAttendanceWriteFailed(true);
      throw error;
    }
    setAttendanceWriteFailed(false);
    setOptimisticAttendance(record);
    setPendingAttendanceDraft(null);
    setGpsPermissionDenied(false);
    setNotice(status === "pending_approval"
      ? "GPS verify nahi ho paya. Aapki attendance admin approval ke liye bhej di gayi hai."
      : t("gpsCheckinSaved"));
  };

  const submitPendingAttendance = async () => {
    if (!staffUid || checkingLocation || !pendingAttendanceDraft) return;
    setCheckingLocation(true);
    setAttendanceError("");
    try {
      const context = await getAttendanceContext();
      await saveAttendanceRecord({
        context,
        status: "pending_approval",
        verified: false,
        verifyReason: pendingAttendanceDraft.reason,
        position: pendingAttendanceDraft.position,
        distance: pendingAttendanceDraft.distance,
        accuracy: pendingAttendanceDraft.accuracy,
      });
    } catch (error) {
      console.error("Pending attendance submit failed:", error);
      setAttendanceError(getErrorMessage(error));
    } finally {
      setCheckingLocation(false);
    }
  };

  const markAttendance = async () => {
    if (!staffUid || checkingLocation) return;
    setCheckingLocation(true);
    setAttendanceWriteFailed(false);
    setAttendanceError("");
    setNotice("");
    setGpsPermissionDenied(false);
    try {
      const context = await getAttendanceContext();
      const skipGeofence = staff?.skipGeofence === true;
      if (skipGeofence) {
        await saveAttendanceRecord({ context, verified: true, skipGeofence: true });
        return;
      }

      const settingsSnapshot = await getDoc(doc(db, "settings", "restaurant"));
      const settings = settingsSnapshot.exists() ? settingsSnapshot.data() : {
        lat: RESTAURANT_LOCATION.latitude,
        lng: RESTAURANT_LOCATION.longitude,
        radius: ATTENDANCE_RADIUS_METERS,
      };
      const restaurantLat = Number.parseFloat(settings.lat);
      const restaurantLng = Number.parseFloat(settings.lng);
      const radiusMeters = Number.parseFloat(settings.radius);
      if (!Number.isFinite(restaurantLat) || restaurantLat < -90 || restaurantLat > 90
        || !Number.isFinite(restaurantLng) || restaurantLng < -180 || restaurantLng > 180
        || !Number.isFinite(radiusMeters) || radiusMeters <= 0 || radiusMeters > 10000) {
        throw new Error("Restaurant GPS settings are invalid.");
      }

      let position;
      try {
        position = await waitForGpsPosition();
      } catch (gpsError) {
        const reason = geolocationErrorMessage(gpsError);
        const reading = bestGpsPositionRef.current?.position || null;
        const pending = {
          reason,
          position: reading,
          accuracy: reading ? Number(reading.coords.accuracy) : null,
        };
        console.log({
          distance: null,
          accuracy: pending.accuracy,
          source: "gps",
          case: "pending",
          todayIST: context.date,
          recordDate: context.date,
        });
        if (gpsError?.code === 1 || gpsError?.message === "secure-context") {
          setPendingAttendanceDraft(pending);
          setGpsPermissionDenied(true);
          setAttendanceError(reason);
          return;
        }
        await saveAttendanceRecord({
          context,
          status: "pending_approval",
          verified: false,
          verifyReason: reason,
          position: reading,
          accuracy: pending.accuracy,
        });
        return;
      }

      const userLat = Number.parseFloat(position.coords.latitude);
      const userLng = Number.parseFloat(position.coords.longitude);
      const accuracy = Number.parseFloat(position.coords.accuracy);
      let distance = null;
      try {
        distance = haversineDistanceMeters(userLat, userLng, restaurantLat, restaurantLng);
      } catch (error) {
        console.error("Attendance coordinates invalid:", error);
      }

      let geofenceCase = "pending";
      if (Number.isFinite(distance) && Number.isFinite(accuracy)
        && distance - accuracy > radiusMeters) {
        geofenceCase = "outside";
      } else if (!Number.isFinite(accuracy) || accuracy > PENDING_APPROVAL_ACCURACY_METERS) {
        geofenceCase = "pending";
      } else if (Number.isFinite(distance)
        && distance <= radiusMeters + Math.min(accuracy, MAX_GEOFENCE_TOLERANCE_METERS)) {
        geofenceCase = "inside";
      }
      console.log({
        distance,
        accuracy,
        source: "gps",
        case: geofenceCase,
        todayIST: context.date,
        recordDate: context.date,
        restaurant: { latitude: restaurantLat, longitude: restaurantLng },
        user: { latitude: userLat, longitude: userLng },
      });

      if (geofenceCase === "outside") {
        setAttendanceError(`Aap restaurant se door ho (${Math.round(distance)} meter)`);
      } else if (geofenceCase === "pending") {
        await saveAttendanceRecord({
          context,
          status: "pending_approval",
          verified: false,
          verifyReason: !Number.isFinite(accuracy) || accuracy > PENDING_APPROVAL_ACCURACY_METERS
            ? `GPS accuracy ${Number.isFinite(accuracy) ? Math.round(accuracy) : "unknown"}m`
            : "GPS location boundary verify nahi ho saki",
          position,
          distance,
          accuracy,
        });
      } else {
        await saveAttendanceRecord({ context, verified: true, position, distance, accuracy });
      }
    } catch (error) {
      console.error("GPS attendance failed:", error);
      if (error.message === "Firebase server time verify nahi ho saka.") {
        setServerTimeError(error.message);
      }
      setAttendanceError(getErrorMessage(error));
    } finally {
      setCheckingLocation(false);
    }
  };

  const submitAdvanceRequest = async (event) => {
    event.preventDefault();
    const amount = Number(advanceAmount);
    const reason = advanceReason.trim();
    if (!staffUid || !Number.isFinite(amount) || amount <= 0 || !reason) {
      window.alert(t("validAdvance"));
      return;
    }

    setSubmittingAdvance(true);
    setProfileError("");
    try {
      await addDoc(collection(db, "advances"), {
        staffId: staffUid,
        staffName: displayName,
        amount,
        reason,
        note: reason,
        date: today,
        source: "request",
        status: "Pending",
        createdAt: Date.now(),
        month: today.slice(0, 7),
      });
      setAdvanceAmount("");
      setAdvanceReason("");
      window.alert(t("advanceSubmitted"));
    } catch (error) {
      console.error("Advance request submit failed:", error);
      const message = `${t("advanceSubmitError")} ${getErrorMessage(error)}`;
      setProfileError(message);
      window.alert(message);
    } finally {
      setSubmittingAdvance(false);
    }
  };

  const submitLeaveRequest = async (event) => {
    event.preventDefault();
    const reason = leaveForm.reason.trim();
    if (!staffUid || !isValidDateKey(leaveForm.fromDate) || !isValidDateKey(leaveForm.toDate)
      || leaveForm.fromDate > leaveForm.toDate
      || !["Paid Leave", "Unpaid Leave", "Half Day"].includes(leaveForm.type)
      || !reason || reason.length > 500) {
      setProfileError(t("validLeave"));
      return;
    }
    setSubmittingLeave(true);
    setProfileError("");
    try {
      await addDoc(collection(db, "leaveRequests"), {
        staffId: staffUid,
        staffName: displayName,
        fromDate: leaveForm.fromDate,
        toDate: leaveForm.toDate,
        type: leaveForm.type,
        reason,
        status: "pending",
        createdAt: Date.now(),
      });
      setLeaveForm((form) => ({ ...form, reason: "" }));
    } catch (error) {
      logFirestoreAccessError("Leave request submit failed:", error, staffUid);
      setProfileError(`Leave request submit nahi hui: ${getErrorMessage(error)}`);
    } finally {
      setSubmittingLeave(false);
    }
  };

  const cancelLeaveRequest = async (leave) => {
    if (!window.confirm(t("cancelLeaveConfirm"))) return;
    setCancellingLeaveId(leave.id);
    setProfileError("");
    try {
      const deleteRefs = [];
      const requestedDates = new Set(dateRangeInclusive(leave.fromDate, leave.toDate));
      const snapshot = await getDocs(query(collection(db, "attendance"), where("staffId", "==", staffUid)));
      snapshot.docs.forEach((entry) => {
        const record = entry.data();
        if (requestedDates.has(record.date)
          && record.source === "leave"
          && record.leaveRequestId === leave.id) deleteRefs.push(entry.ref);
      });
      for (let offset = 0; offset < deleteRefs.length; offset += 450) {
        const batch = writeBatch(db);
        deleteRefs.slice(offset, offset + 450).forEach((ref) => batch.delete(ref));
        await batch.commit();
      }
      await updateDoc(doc(db, "leaveRequests", leave.id), {
        status: "cancelled",
        cancelledAt: Date.now(),
      });
    } catch (error) {
      console.error("Leave request cancel failed:", error);
      setProfileError(`${t("leaveCancelledError")} ${getErrorMessage(error)}`);
    } finally {
      setCancellingLeaveId("");
    }
  };

  const savePhone = async (event) => {
    event.preventDefault();
    const phone = phoneDraft.trim();
    if (phone && !/^[+0-9()\-\s]{7,20}$/.test(phone)) {
      setSettingsMessage(t("validPhone"));
      return;
    }
    setSettingsBusy(true);
    setSettingsMessage("");
    try {
      await updateDoc(doc(db, "staff", staffUid), { phone });
      setStaff((current) => ({ ...current, phone }));
      setSettingsMessage(t("phoneSaved"));
    } catch (error) {
      console.error("Staff phone update failed:", error);
      setSettingsMessage(`Phone save nahi hua: ${getErrorMessage(error)}`);
    } finally {
      setSettingsBusy(false);
    }
  };

  const changeAccountPassword = async (event) => {
    event.preventDefault();
    if (!auth.currentUser?.email || newPassword.length < 6) {
      setSettingsMessage(t("validNewPassword"));
      return;
    }
    setSettingsBusy(true);
    setSettingsMessage("");
    try {
      const credential = EmailAuthProvider.credential(auth.currentUser.email, currentPassword);
      await reauthenticateWithCredential(auth.currentUser, credential);
      await updatePassword(auth.currentUser, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setSettingsMessage(t("passwordChanged"));
    } catch (error) {
      console.error("Staff password update failed:", error);
      setSettingsMessage(`Password change nahi hua: ${getErrorMessage(error)}`);
    } finally {
      setSettingsBusy(false);
    }
  };

  const markNotificationRead = async (notification) => {
    const isOwned = notification.collectionName === "staffNotifications"
      ? notification.toStaffId === staffUid
      : notification.userId === staffUid;
    if (notification.read === true || !isOwned) return;
    try {
      await updateDoc(
        doc(db, notification.collectionName || "notifications", notification.id),
        notification.collectionName === "staffNotifications"
          ? { read: true, readAt: serverTimestamp() }
          : { read: true },
      );
    } catch (error) {
      console.error("Notification read update failed:", error);
      setProfileError(`Notification update nahi hui: ${getErrorMessage(error)}`);
    }
  };

  const markAllNotificationsRead = async () => {
    if (notificationReadLock.current) return;
    const unread = currentUserNotifications.filter((notification) => notification.read !== true);
    if (!unread.length) return;
    notificationReadLock.current = true;
    setMarkingAllNotifications(true);
    setNotificationActionError("");
    try {
      for (let offset = 0; offset < unread.length; offset += 450) {
        const batch = writeBatch(db);
        unread.slice(offset, offset + 450).forEach((notification) => {
          const ref = doc(db, notification.collectionName, notification.id);
          batch.update(ref, notification.collectionName === "staffNotifications"
            ? { read: true, readAt: serverTimestamp() }
            : { read: true });
        });
        await batch.commit();
      }
    } catch (error) {
      console.error("Mark all notifications read failed:", error);
      setNotificationActionError(`Sab notifications read nahi hui: ${getErrorMessage(error)}`);
    } finally {
      notificationReadLock.current = false;
      setMarkingAllNotifications(false);
    }
  };

  const logout = async () => {
    if (!window.confirm(t("logoutConfirm"))) return;
    setAttendanceError("");
    try {
      await signOut(auth);
      setNotice("");
    } catch (error) {
      console.error("Attendance logout failed:", error);
      setAttendanceError(`Logout nahi hua: ${getErrorMessage(error)}`);
    }
  };

  const panelStyle = {
    padding: 18,
    border: "1px solid rgba(255,255,255,0.09)",
    borderRadius: 18,
    background: "rgba(21,27,43,0.94)",
  };
  const dashboardInputStyle = {
    width: "100%",
    minHeight: 44,
    boxSizing: "border-box",
    padding: "10px 12px",
    border: "1px solid #30394c",
    borderRadius: 10,
    outline: "none",
    background: "#101827",
    color: "#f5f7fb",
    font: "inherit",
  };
  const dashboardButtonStyle = {
    minHeight: 44,
    padding: "0 16px",
    border: 0,
    borderRadius: 10,
    background: "linear-gradient(145deg, #f47b48, #d94f30)",
    color: "#fff",
    font: "inherit",
    fontWeight: 800,
    cursor: "pointer",
  };

  if (staff?.mustChangePassword === true) {
    return (
      <StaffPasswordChange
        onComplete={() => setStaff((current) => current ? { ...current, mustChangePassword: false } : current)}
      />
    );
  }

  if (loading || (staff && Object.values(dataLoaded).some((loaded) => !loaded))) {
    return (
      <main className="attendance-app">
        <div className="attendance-loading"><span className="attendance-spinner" />{t("loading")}</div>
      </main>
    );
  }

  if ((!user && !staffUid) || !staff) {
    return (
      <main className="attendance-app">
        <section className="attendance-login">
          <div className="attendance-brand">
            <div className="attendance-brand-mark"><span>E<span>&</span>P</span></div>
            <div><strong>Eat & Park</strong><small>STAFF ATTENDANCE</small></div>
          </div>
          <div className="attendance-login-copy">
            <div className="attendance-eyebrow">{t("staffCheckin")}</div>
            <h1>{t("loginTitle")}</h1>
            <p>{t("signInPrompt")}</p>
          </div>
          <form onSubmit={login} className="attendance-login-form">
            <label>
              {t("staffEmail")}
              <input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" required />
            </label>
            <label>
              {t("staffPassword")}
              <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={t("passwordPlaceholder")} required />
            </label>
            {loginError && <div className="attendance-error" role="alert">{loginError}</div>}
            <button type="submit" className="attendance-primary-button">{t("signIn")} <span>→</span></button>
          </form>
          <div className="attendance-login-footer">{t("loginSecure")}</div>
        </section>
      </main>
    );
  }

  return (
    <main className="attendance-app">
      <section className="attendance-dashboard">
        <header className="attendance-topbar">
          <button
            type="button"
            className="attendance-menu-button"
            aria-label={t("menuOpen")}
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
          >☰</button>
          <div className="attendance-brand">
            <div className="attendance-brand-mark"><span>E<span>&</span>P</span></div>
            <div><strong>Eat & Park</strong><small>STAFF ATTENDANCE</small></div>
          </div>
          <div className="attendance-topbar-actions">
            <span className="attendance-topbar-role">{staff.role || "Staff"}</span>
            <button
              type="button"
              className="attendance-notification-bell"
              aria-label={`Notifications${unreadNotifications ? `, ${unreadNotifications} unread` : ""}`}
              aria-expanded={notificationsOpen}
              onClick={() => setNotificationsOpen((open) => !open)}
            >
              <span aria-hidden="true">🔔</span>
              {unreadNotifications > 0 && <b>{unreadNotifications > 99 ? "99+" : unreadNotifications}</b>}
            </button>
          </div>
        </header>

        {notificationsOpen && (
          <section className="attendance-notification-popover" aria-label="Notifications">
            <header>
              <strong>Notifications{unreadNotifications ? ` · ${unreadNotifications} unread` : ""}</strong>
              <button
                type="button"
                onClick={markAllNotificationsRead}
                disabled={!unreadNotifications || markingAllNotifications}
              >
                {markingAllNotifications ? "Saving..." : "Sab read karo"}
              </button>
            </header>
            {notificationActionError && <div className="attendance-error" role="alert">{notificationActionError}</div>}
            {currentUserNotifications.length === 0
              ? <div className="attendance-notification-empty">Abhi koi notification nahi</div>
              : currentUserNotifications.slice(0, 50).map((notification) => {
                const type = notification.type || "Info";
                return (
                  <button
                    type="button"
                    key={`${notification.collectionName}-${notification.id}`}
                    onClick={() => markNotificationRead(notification)}
                    className={`attendance-notification attendance-notification-popover-item ${notification.read ? "" : "is-unread"}`}
                  >
                    <span>
                      <strong>{notification.title}</strong>
                      <small>{notification.message}</small>
                      <em className={`attendance-notification-type type-${type.toLowerCase()}`}>{type}</em>
                    </span>
                    <time>{new Date(timestampMillis(notification.createdAt)).toLocaleString(locale, { timeZone: "Asia/Kolkata" })}</time>
                  </button>
                );
              })}
          </section>
        )}

        {drawerOpen && (
          <div className="attendance-drawer-overlay" onClick={() => setDrawerOpen(false)}>
            <nav className="attendance-drawer" aria-label={t("appCaption")} onClick={(event) => event.stopPropagation()}>
              <header className="attendance-drawer-profile">
                <button type="button" aria-label={t("menuClose")} onClick={() => setDrawerOpen(false)}>×</button>
                <strong>{displayName}</strong>
                <span>{staff.role || "Staff"}{staffShift ? ` · ${staffShift.name}` : ""}</span>
              </header>
              {[
                ["home", "⌂", "home"],
                ["profile", "◉", "profile"],
                ["history", "▦", "history"],
                ["salary", "₹", "salary"],
                ["advance", "+", "advance"],
                ["leave", "◇", "leave"],
                ["shift", "◷", "shift"],
                ["notifications", "♧", "notifications"],
                ["settings", "⚙", "settings"],
                ["help", "?", "help"],
                ["logout", "↪", "logout"],
              ].map(([section, icon, key]) => (
                <button
                  type="button"
                  key={section}
                  className={`attendance-drawer-item ${activeSection === section ? "is-active" : ""}`}
                  onClick={() => {
                    if (section === "logout") {
                      setDrawerOpen(false);
                      logout();
                      return;
                    }
                    setActiveSection(section);
                    setDrawerOpen(false);
                  }}
                >
                  <span>{icon}</span>{t(key)}
                  {section === "notifications" && unreadNotifications > 0 && <b>{unreadNotifications}</b>}
                </button>
              ))}
            </nav>
          </div>
        )}

        {profileError && <div className="attendance-error" role="alert">{profileError}</div>}

        {activeSection === "home" &&         <section className="attendance-welcome">
          <div className="attendance-eyebrow">{t("home")}</div>
          <h1>{t("greetingTitle")}, {displayName} 👋</h1>
          <p>{t("arrivalPrompt")}</p>
        </section>}

        {activeSection === "home" && <section className="attendance-status-card">
          <div className="attendance-status-top">
            <div>
              <div className="attendance-eyebrow">{t("today")}</div>
              <h2>{displayNow.toLocaleDateString(locale, { timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "long" })}</h2>
            </div>
            <div className="attendance-live-dot"><span /> {t("live")}</div>
          </div>
          <div className="attendance-clock">
            {displayNow.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: true })}
          </div>
          <div className={`attendance-status-pill ${todayAttendance ? "is-marked" : ""}`}>
            <span>{todayAttendance ? "✓" : "•"}</span>
            {todayAttendance
              ? String(todayAttendance.status || "").toLowerCase() === "pending_approval"
                ? "Pending approval"
                : todayAttendance.checkInAt ? `${t("present")} · In: ${formatIndiaTime(todayAttendance.checkInAt)}`
                  : todayAttendance.status || t("present")
              : t("notCheckedIn")}
          </div>
          {todayAttendance?.late && (
            <div style={{ marginTop: 8, color: "#fbbf24", fontSize: 12 }}>
              {t("lateBy")} {todayAttendance.lateMinutes} {language === "hi" ? "मिनट" : "minutes"}
            </div>
          )}
          {todayAttendance?.checkInAt && (
            <div style={{ marginTop: 8, color: "#9ba8ba", fontSize: 12 }}>
              Auto check-out at 10:00 PM
              {todayAttendance.shiftName ? ` · ${todayAttendance.shiftName}` : ""}
            </div>
          )}
          {isShiftRestTime(displayNow, shifts[todayAttendance?.shiftId] || staffShift || {}) && (
            <div style={{ marginTop: 8, color: "#fb923c", fontSize: 12, fontWeight: 800 }}>{t("restWindow")}</div>
          )}
          <div className="attendance-divider" />
          <div className="attendance-location-row">
            <div className="attendance-location-icon">⌖</div>
            <div>
              <strong>{t("restaurantLocation")}</strong>
              <span>{t("checkinAllowed")} {attendanceRadius} {language === "hi" ? "मीटर" : "meters"}</span>
            </div>
            <span className="attendance-location-check">{t("gps")}</span>
          </div>

          {!todayAttendanceLoaded
            ? <div className={todayAttendanceLoadError ? "attendance-error" : "attendance-gps-note"} role={todayAttendanceLoadError ? "alert" : "status"}>
              {todayAttendanceLoadError
                ? `Aaj ki attendance load nahi hui: ${todayAttendanceLoadError}`
                : "Aaj ki attendance load ho rahi hai..."}
            </div>
            : todayAttendance?.checkInAt
              ? String(todayAttendance.status || "").toLowerCase() === "pending_approval"
                ? <div className="attendance-gps-note" role="status">Attendance admin approval ke liye pending hai.</div>
                : <div className="attendance-success" role="status">Aaj ki attendance lag chuki hai.</div>
              : adminAttendanceBlocksCheckIn
                ? <div className="attendance-error" role="status">Admin ne aaj ki attendance set ki hai</div>
                : attendanceTimeClosed
                  ? <div className="attendance-error" role="status">Aaj ki attendance band ho chuki hai. Kal subah 9:30 baje se lagegi.</div>
                  : !attendanceTimeAllowed && serverNow != null
                    ? <div className="attendance-error" role="status">Attendance 9:30 AM ke baad hi lag sakti hai</div>
                    : <button
                  type="button"
                  className="attendance-primary-button attendance-checkin-button"
                  onClick={markAttendance}
                  disabled={checkingLocation
                    || !attendanceTimeAllowed
                    || Boolean(serverTimeError)
                    || (staff?.skipGeofence !== true && (gpsSettingsLoading || Boolean(gpsSettingsError)))}
                >
                  {gpsSettingsLoading && staff?.skipGeofence !== true
                    ? <>{t("gpsSettingsLoading")}</>
                    : checkingLocation
                      ? <><span className="attendance-spinner" />GPS dhundh rahe hain... ({gpsWaitSeconds} sec)</>
                      : serverTimeError
                        ? <>Server time verify nahi hua</>
                        : serverNow == null
                          ? <>Server time verify ho raha hai</>
                          : <>{t("checkinGps")} <span>→</span></>}
                </button>}
          {serverTimeError && !todayAttendance?.checkInAt && !adminAttendanceBlocksCheckIn
            && <div className="attendance-error" role="alert">
              Server time verify nahi hua: {serverTimeError}
              <button type="button" onClick={async () => {
                try {
                  const timestamp = await fetchFirebaseServerTime(staffUid);
                  serverTimeAnchor.current = { timestamp, monotonicTime: performance.now() };
                  setServerNow(timestamp);
                  setServerTimeError("");
                } catch (error) {
                  setServerTimeError(getErrorMessage(error));
                }
              }} style={{ marginLeft: 8 }}>Retry</button>
            </div>}
          {!todayAttendance?.checkInAt && !adminAttendanceBlocksCheckIn && todayAttendanceLoaded
            && staff?.skipGeofence !== true
            && <div className="attendance-gps-note" role="status">
              {gpsWarmupState === "ready" && Number.isFinite(gpsAccuracy)
                ? `GPS ready (±${Math.round(gpsAccuracy)}m)`
                : "GPS dhundh rahe hain..."}
            </div>}
          {checkingLocation && <div className="attendance-gps-note" role="status">GPS dhundh rahe hain... ({gpsWaitSeconds} sec)</div>}
          <div className="attendance-gps-note">📍 {t("gpsRadiusNote")} {attendanceRadius} {language === "hi" ? "मीटर" : "meters"}.</div>
          {gpsSettingsError && <div className="attendance-error" role="alert">{gpsSettingsError}</div>}
          {gpsPermissionDenied && (
            <div className="attendance-error" role="alert">
              Chrome &gt; Site settings &gt; Location &gt; Allow + Precise location on karein. {attendanceError}
              <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                <button type="button" onClick={() => {
                  setGpsPermissionDenied(false);
                  setAttendanceError("");
                  setGpsWarmupState("searching");
                  setGpsRetryKey((key) => key + 1);
                  void markAttendance();
                }}>Dobara try karo</button>
                {pendingAttendanceDraft && (
                  <button type="button" disabled={checkingLocation} onClick={submitPendingAttendance}>
                    Admin ko bhejo
                  </button>
                )}
              </div>
            </div>
          )}
          {notice && <div className="attendance-success" role="status">{notice}</div>}
          {attendanceError && !gpsPermissionDenied && (
            <div className="attendance-error" role="alert">
              {attendanceError}
              {attendanceWriteFailed && (
                <button type="button" onClick={() => void markAttendance()} style={{ marginLeft: 8 }}>
                  Dobara try karo
                </button>
              )}
            </div>
          )}
        </section>}

        {activeSection === "profile" && <section style={{ ...panelStyle, marginTop: 16 }} aria-label="Staff profile">
          <div className="attendance-eyebrow">{t("profile")}</div>
          <h2 style={{ margin: "8px 0 14px", fontSize: 20 }}>{displayName}</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
            {[
              [t("role"), staff.role || "staff"],
              [t("shiftName"), staffShift?.name || "—"],
              [t("joiningDate"), staff.joiningDate || staff.joinedAt || "—"],
              [t("email"), user?.email || "—"],
              ...(restaurantSettings.showStaffSalary !== false
                ? [[t("monthlySalary"), formatCurrency(Number(staff.monthlySalary ?? payroll?.monthlySalary ?? 0))]]
                : []),
            ].map(([label, value]) => (
              <div key={label} style={{ padding: 12, borderRadius: 12, background: "rgba(255,255,255,0.04)" }}>
                <div style={{ color: "#9ba8ba", fontSize: 11, marginBottom: 5 }}>{label}</div>
                <strong style={{ color: "#f5f7fb", fontSize: 14 }}>{value}</strong>
              </div>
            ))}
          </div>
          <form onSubmit={savePhone} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 8, marginTop: 12 }}>
            <label style={{ display: "grid", gap: 6, color: "#c4ccda", fontSize: 12 }}>
              {t("phone")}
              <input value={phoneDraft} onChange={(event) => setPhoneDraft(event.target.value)} style={dashboardInputStyle} />
            </label>
            <button type="submit" disabled={settingsBusy} style={{ ...dashboardButtonStyle, alignSelf: "end" }}>{t("save")}</button>
          </form>
          {settingsMessage && <div role="status" style={{ color: "#9ba8ba", fontSize: 12, marginTop: 8 }}>{settingsMessage}</div>}
        </section>}

        {activeSection === "history" && <section style={{ ...panelStyle, marginTop: 14 }} aria-label="Attendance history">
            <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <h2 style={{ margin: 0, fontSize: 17 }}>{t("history")}</h2>
              <input
                type="month"
                max={today.slice(0, 7)}
                value={selectedMonth}
                onChange={(event) => {
                  setSelectedMonth(event.target.value);
                  setSelectedAttendanceDetail(null);
                }}
                style={{ ...dashboardInputStyle, width: 170 }}
              />
            </header>
            <div className="attendance-month-summary">
              {[
                [t("presentDays"), attendanceSummary.present],
                [t("halfDays"), attendanceSummary.halfDay],
                [t("absentDays"), attendanceSummary.absent],
                [t("leaveDays"), attendanceSummary.leave],
                [t("lateDays"), attendanceSummary.late],
              ].map(([label, value]) => <div key={label}><small>{label}</small><strong>{value}</strong></div>)}
            </div>
            {attendanceByDate.size === 0
              ? <div style={{ color: "#9ba8ba", fontSize: 13 }}>{t("noRecords")}</div>
              : (
                <div className="attendance-calendar">
                  {t("weekdays").map((day) => <strong key={day}>{day}</strong>)}
                  {Array.from({ length: calendarFirstDay }, (_, index) => <span key={`blank-${index}`} />)}
                  {Array.from({ length: calendarDays }, (_, index) => {
                    const date = `${selectedMonth}-${String(index + 1).padStart(2, "0")}`;
                    const record = attendanceByDate.get(date);
                    const label = record?.status || "";
                    return (
                      <button
                        type="button"
                        key={date}
                        className={record ? `attendance-calendar-day status-${String(label).toLowerCase().replace(/\s+/g, "-")}` : "attendance-calendar-day"}
                        title={record ? `${label} · ${record.source || "manual"}` : date}
                        aria-label={`${date}${label ? `, ${label}` : ""}`}
                        onClick={() => setSelectedAttendanceDetail(record || null)}
                      >
                        <span>{index + 1}</span>
                        <small>{record ? localizeAttendanceStatus(label) : "—"}</small>
                      </button>
                    );
                  })}
                </div>
              )}
            {selectedAttendanceDetail && (
              <div className="attendance-detail-card" role="status">
                <strong>{selectedAttendanceDetail.date} · {localizeAttendanceStatus(selectedAttendanceDetail.status || "Present")}</strong>
                <span>{t("in")}: {selectedAttendanceDetail.checkInAt ? formatIndiaTime(selectedAttendanceDetail.checkInAt) : "—"}</span>
                <span>{t("out")}: {effectiveCheckOutLabel(selectedAttendanceDetail) || "—"}</span>
                <span>{t("worked")}: {selectedAttendanceDetail.workedMinutes != null
                  ? `${Math.floor(selectedAttendanceDetail.workedMinutes / 60)}h ${selectedAttendanceDetail.workedMinutes % 60}m`
                  : "—"}</span>
                <span>{t("late")}: {selectedAttendanceDetail.lateMinutes || 0}m · {t("source")}: {selectedAttendanceDetail.source || "manual"}</span>
                {selectedAttendanceDetail.earlyLeave && <span>{t("earlyLeave")}</span>}
              </div>
            )}
            <div style={{ marginTop: 14 }}>
              {selectedMonthRecords.map((record) => (
                <div key={record.date} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "10px 0", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                  <div>
                    <span>{new Date(`${record.date}T00:00:00Z`).toLocaleDateString(locale, { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" })}</span>
                    <div style={{ color: "#9ba8ba", fontSize: 10, marginTop: 4 }}>
                      {record.checkInAt ? `In ${formatIndiaTime(record.checkInAt)}` : "In —"}
                      {effectiveCheckOutLabel(record) ? ` · Out ${effectiveCheckOutLabel(record)}` : ""}
                      {record.shiftName ? ` · ${record.shiftName}` : ""}
                      {record.lateMinutes ? ` · Late ${record.lateMinutes}m` : ""}
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <strong style={{ display: "block", color: record.status?.toLowerCase() === "present" || record.action === "present" ? "#34d399" : "#fbbf24" }}>
                      {localizeAttendanceStatus(record.status || "Present")}
                    </strong>
                    {record.earlyLeave && <small style={{ display: "block", color: "#FBBF24" }}>Early leave</small>}
                  </div>
                </div>
              ))}
            </div>
          </section>}

        {["advance", "leave"].includes(activeSection) && <section style={{ display: "grid", gap: 14, alignContent: "start", marginTop: 14 }}>
            {activeSection === "advance" && <form onSubmit={submitAdvanceRequest} style={{ ...panelStyle, display: "grid", gap: 11 }}>
              <h2 style={{ margin: 0, fontSize: 17 }}>{t("requestAdvanceTitle")}</h2>
              <label style={{ display: "grid", gap: 7, color: "#c4ccda", fontSize: 12, fontWeight: 750 }}>
                {t("amountRupees")}
                <input
                  type="number"
                  min="1"
                  max="10000000"
                  step="0.01"
                  required
                  value={advanceAmount}
                  onChange={(event) => setAdvanceAmount(event.target.value)}
                  style={dashboardInputStyle}
                />
              </label>
              <label style={{ display: "grid", gap: 7, color: "#c4ccda", fontSize: 12, fontWeight: 750 }}>
                Reason
                <textarea
                  required
                  maxLength={500}
                  rows={3}
                  value={advanceReason}
                  onChange={(event) => setAdvanceReason(event.target.value)}
                  style={{ ...dashboardInputStyle, resize: "vertical" }}
                />
              </label>
              <button type="submit" disabled={submittingAdvance} style={dashboardButtonStyle}>
                {submittingAdvance ? t("submitting") : t("submitRequest")}
              </button>
            </form>}

            {activeSection === "leave" && <form onSubmit={submitLeaveRequest} style={{ ...panelStyle, display: "grid", gap: 11 }}>
              <h2 style={{ margin: 0, fontSize: 17 }}>{t("requestLeaveTitle")}</h2>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 }}>
                <label style={{ display: "grid", gap: 7, color: "#c4ccda", fontSize: 12, fontWeight: 750 }}>
                  {t("fromDate")}
                  <input type="date" required value={leaveForm.fromDate} onChange={(event) => setLeaveForm((form) => ({ ...form, fromDate: event.target.value }))} style={dashboardInputStyle} />
                </label>
                <label style={{ display: "grid", gap: 7, color: "#c4ccda", fontSize: 12, fontWeight: 750 }}>
                  {t("toDate")}
                  <input type="date" required min={leaveForm.fromDate} value={leaveForm.toDate} onChange={(event) => setLeaveForm((form) => ({ ...form, toDate: event.target.value }))} style={dashboardInputStyle} />
                </label>
              </div>
              <label style={{ display: "grid", gap: 7, color: "#c4ccda", fontSize: 12, fontWeight: 750 }}>
                Type
                <select value={leaveForm.type} onChange={(event) => setLeaveForm((form) => ({ ...form, type: event.target.value }))} style={dashboardInputStyle}>
                  {["Paid Leave", "Unpaid Leave", "Half Day"].map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </label>
              <label style={{ display: "grid", gap: 7, color: "#c4ccda", fontSize: 12, fontWeight: 750 }}>
                Reason
                <textarea required maxLength={500} rows={2} value={leaveForm.reason} onChange={(event) => setLeaveForm((form) => ({ ...form, reason: event.target.value }))} style={{ ...dashboardInputStyle, resize: "vertical" }} />
              </label>
              {overlappingLeaveRequests.length > 0 && (
                <div role="status" style={{ color: "#fbbf24", fontSize: 12 }}>
                  {t("overlapWarning")}
                </div>
              )}
              <button type="submit" disabled={submittingLeave} style={dashboardButtonStyle}>
                {submittingLeave ? t("submitting") : t("submitLeave")}
              </button>
            </form>}

            {activeSection === "leave" && <section style={panelStyle} aria-label="Leave request history">
              <h2 style={{ margin: "0 0 12px", fontSize: 17 }}>{t("leaveHistory")}</h2>
              {leaveRequests.length === 0
                ? <div style={{ color: "#9ba8ba", fontSize: 13 }}>{t("noLeaveRequests")}</div>
                : leaveRequests.map((leave) => {
                  const status = String(leave.status || "pending").toLowerCase();
                  const color = status === "approved" ? "#34d399"
                    : status === "rejected" || status === "cancelled" ? "#fb7185" : "#fbbf24";
                  return (
                    <div key={leave.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "10px 0", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                      <div style={{ minWidth: 0 }}>
                        <strong>{leave.type}</strong>
                        <div style={{ marginTop: 3, color: "#9ba8ba", fontSize: 11 }}>{leave.fromDate} – {leave.toDate} · {leave.reason}</div>
                        {leave.adminNote && <div style={{ marginTop: 3, color: "#c4ccda", fontSize: 11 }}>Admin: {leave.adminNote}</div>}
                      </div>
                      <div style={{ display: "grid", justifyItems: "end", gap: 5 }}>
                        <strong style={{ color, fontSize: 12 }}>{localizeRequestStatus(status)}</strong>
                        {status === "pending" && (
                          <button type="button" disabled={cancellingLeaveId === leave.id} onClick={() => cancelLeaveRequest(leave)} style={{ ...dashboardButtonStyle, minHeight: 32, padding: "0 9px", fontSize: 11 }}>
                            {cancellingLeaveId === leave.id ? "Cancelling..." : "Cancel"}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
            </section>}

            {activeSection === "advance" && <section style={panelStyle} aria-label="Advance history">
              <h2 style={{ margin: "0 0 12px", fontSize: 17 }}>{t("advanceHistory")}</h2>
              <div style={{ color: "#c4ccda", fontSize: 12, marginBottom: 8 }}>
                {t("approvedThisMonth")} {formatCurrency(advanceHistory
                  .filter((advance) => String(advance.status || "").toLowerCase() === "approved"
                    && (advance.month === today.slice(0, 7) || String(advance.date || "").startsWith(`${today.slice(0, 7)}-`)))
                  .reduce((sum, advance) => sum + Number(advance.amount || 0), 0))}
                {" · "}{t("overall")} {formatCurrency(overallAdvances)}
              </div>
              {advanceHistory.length === 0
                ? <div style={{ color: "#9ba8ba", fontSize: 13 }}>{t("noAdvanceRequests")}</div>
                : advanceHistory.map((advance, index) => {
                  const key = `${advance.source || "advance"}-${advance.id || index}`;
                  const status = String(advance.status || "Pending");
                  const approved = status.toLowerCase() === "approved";
                  return (
                    <div key={key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "10px 0", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                      <div>
                        <strong>{formatCurrency(Number(advance.amount || 0))}</strong>
                        {(advance.adminNote || advance.reason) && <div style={{ marginTop: 3, color: "#9ba8ba", fontSize: 11 }}>{advance.adminNote || advance.reason}</div>}
                        <div style={{ marginTop: 3, color: "#9ba8ba", fontSize: 10 }}>{advance.date || advance.month || ""} · {advance.source || "request"}</div>
                      </div>
                      <div style={{ display: "grid", justifyItems: "end", gap: 5 }}>
                        <strong style={{ color: approved ? "#34d399" : status.toLowerCase() === "rejected" ? "#fb7185" : "#fbbf24", fontSize: 12 }}>{localizeRequestStatus(status)}</strong>
                        {status.toLowerCase() === "pending" && advance.id && (
                          <button type="button" disabled={cancellingAdvanceId === advance.id} onClick={async () => {
                            if (!window.confirm(t("cancelAdvanceConfirm"))) return;
                            setCancellingAdvanceId(advance.id);
                            try {
                              await updateDoc(doc(db, "advances", advance.id), { status: "Cancelled", cancelledAt: Date.now() });
                            } catch (error) {
                              console.error("Advance request cancel failed:", error);
                              setProfileError(`${t("advanceCancelledError")} ${getErrorMessage(error)}`);
                            } finally {
                              setCancellingAdvanceId("");
                            }
                          }} style={{ ...dashboardButtonStyle, minHeight: 32, padding: "0 9px", fontSize: 11 }}>
                            {cancellingAdvanceId === advance.id ? t("submitting") : t("cancel")}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
            </section>}
          </section>}

        {activeSection === "salary" && <section style={{ ...panelStyle, marginTop: 14 }}>
          <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h2 style={{ margin: 0, fontSize: 17 }}>{t("salary")}</h2>
            <input type="month" max={today.slice(0, 7)} value={selectedMonth} onChange={(event) => setSelectedMonth(event.target.value)} style={{ ...dashboardInputStyle, width: 170 }} />
          </header>
          {restaurantSettings.showStaffSalary !== false
            ? <div className="attendance-month-summary salary-summary">
              {[
                [t("perDay"), salaryCalculation.perDaySalary],
                [t("presentDays"), selectedPresentDays],
                [t("gross"), salaryCalculation.grossSalary],
                [t("advances"), salaryCalculation.totalApprovedAdvance],
                [t("paid"), salaryPaid],
                [t("balance"), salaryBalance],
              ].map(([label, amount]) => (
                <div key={label}><small>{label}</small><strong>{label === t("presentDays") ? amount : formatCurrency(amount)}</strong></div>
              ))}
            </div>
            : <div style={{ color: "#9ba8ba", marginTop: 14 }}>{t("salaryHidden")}</div>}
          {restaurantSettings.showStaffSalary !== false && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
              <span className={`attendance-salary-badge status-${salaryStatus.toLowerCase()}`}>{t(`salaryStatus${salaryStatus}`)}</span>
              <span style={{ color: "#9ba8ba", fontSize: 12 }}>{selectedMonth}</span>
            </div>
          )}
          {restaurantSettings.showStaffSalary !== false && (
            <button type="button" onClick={downloadPayslip} style={{ ...dashboardButtonStyle, marginTop: 14, width: "100%" }}>
              Payslip download (PDF)
            </button>
          )}
          <h3 style={{ fontSize: 14, margin: "20px 0 8px" }}>{t("paymentHistory")} · {selectedMonth}</h3>
          {selectedMonthPayments.length === 0
            ? <div style={{ color: "#9ba8ba", fontSize: 13 }}>{t("noRecords")}</div>
            : selectedMonthPayments.map((payment) => (
              <div key={payment.id} className="attendance-list-row">
                <span>{payment.date || "—"}{payment.note ? ` · ${payment.note}` : ""}</span>
                <strong>{formatCurrency(Number(payment.amount || 0))}</strong>
              </div>
            ))}
          <h3 style={{ fontSize: 14, margin: "20px 0 8px" }}>{t("previousSalaryMonths")}</h3>
          {salaryHistoryMonths
            .filter((month) => month !== selectedMonth)
            .map((month) => (
              <button type="button" key={month} className="attendance-list-row attendance-month-link" onClick={() => setSelectedMonth(month)}>
                <span>{month}</span>
                <strong>{formatCurrency(salaryPayments
                  .filter((payment) => payment.month === month && String(payment.status || "paid").toLowerCase() !== "cancelled")
                  .reduce((sum, payment) => sum + Number(payment.amount || 0), 0))}</strong>
              </button>
            ))}
        </section>}

        {activeSection === "shift" && <section style={{ ...panelStyle, marginTop: 14 }}>
          <h2 style={{ margin: "0 0 14px", fontSize: 17 }}>{t("shift")}</h2>
          {staffShift
            ? <>
              <h3 style={{ color: "#f2a271", margin: "0 0 12px" }}>{staffShift.name}</h3>
              <div className="attendance-shift-grid">
                <div><small>{t("start")}</small><strong>{staffShift.startTime}</strong></div>
                <div><small>{t("end")}</small><strong>{staffShift.endTime}</strong></div>
                <div><small>{t("rest")}</small><strong>{staffShift.breakStart && staffShift.breakEnd ? `${staffShift.breakStart}–${staffShift.breakEnd}` : t("noBreak")}</strong></div>
              </div>
              <p style={{ color: "#c4ccda", fontSize: 13, lineHeight: 1.6 }}>
                {Number(staffShift.halfDayLateMinutes ?? 30)} min or more late = {t("halfDay")}.
                {" "}{t("lateBadgeAfter")} {Number(staffShift.lateGraceMinutes ?? 10)} min.
              </p>
            </>
            : <div style={{ color: "#fbbf24" }}>{t("noShift")}</div>}
        </section>}

        {activeSection === "notifications" && <section style={{ ...panelStyle, marginTop: 14 }}>
          <h2 style={{ margin: "0 0 12px", fontSize: 17 }}>{t("notifications")}{unreadNotifications ? ` · ${unreadNotifications} ${t("unread")}` : ""}</h2>
          {notificationActionError && <div className="attendance-error" role="alert">{notificationActionError}</div>}
          {unreadNotifications > 0 && (
            <button type="button" onClick={markAllNotificationsRead} disabled={markingAllNotifications} style={dashboardButtonStyle}>
              {markingAllNotifications ? "Saving..." : "Sab read karo"}
            </button>
          )}
          {currentUserNotifications.length === 0
            ? <div className="attendance-notification-empty">Abhi koi notification nahi</div>
            : currentUserNotifications.map((notification) => {
              const type = notification.type || "Info";
              return (
              <button
                type="button"
                key={`${notification.collectionName}-${notification.id}`}
                onClick={() => markNotificationRead(notification)}
                className={`attendance-notification ${notification.read ? "" : "is-unread"}`}
              >
                <span>
                  <strong>{notification.title}</strong>
                  <small>{notification.message}</small>
                  <em className={`attendance-notification-type type-${type.toLowerCase()}`}>{type}</em>
                </span>
                <time>{new Date(timestampMillis(notification.createdAt)).toLocaleString(locale, { timeZone: "Asia/Kolkata" })}</time>
              </button>
              );
            })}
        </section>}

        {activeSection === "settings" && <section style={{ ...panelStyle, marginTop: 14 }}>
          <h2 style={{ margin: "0 0 14px", fontSize: 17 }}>{t("settings")}</h2>
          <label style={{ display: "grid", gap: 6, color: "#c4ccda", fontSize: 12 }}>
            {t("language")}
            <select value={language} onChange={(event) => {
              const nextLanguage = event.target.value;
              setLanguage(nextLanguage);
              try { localStorage.setItem("attendance_language", nextLanguage); } catch (error) { console.error("Language preference could not be saved:", error); }
            }} style={dashboardInputStyle}>
              <option value="en">English</option>
              <option value="hi">हिन्दी</option>
            </select>
          </label>
          <form onSubmit={changeAccountPassword} style={{ display: "grid", gap: 10, marginTop: 18 }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>{t("changePassword")}</h3>
            <input type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} placeholder={t("currentPassword")} style={dashboardInputStyle} />
            <input type="password" autoComplete="new-password" minLength={6} required value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder={t("newPassword")} style={dashboardInputStyle} />
            <button type="submit" disabled={settingsBusy} style={dashboardButtonStyle}>{t("save")}</button>
          </form>
          <p style={{ color: "#9ba8ba", fontSize: 12 }}>{t("installHint")}</p>
          {settingsMessage && <div role="status" style={{ color: "#f2a271", fontSize: 12 }}>{settingsMessage}</div>}
        </section>}

        {activeSection === "help" && <section style={{ ...panelStyle, marginTop: 14 }}>
          <h2 style={{ margin: "0 0 12px", fontSize: 17 }}>{t("help")}</h2>
          {restaurantSettings.contactPhone && (
            <a className="attendance-contact-link" href={`https://wa.me/${String(restaurantSettings.contactPhone).replace(/\D/g, "")}`} target="_blank" rel="noreferrer">
              {t("whatsappAdmin")} · {restaurantSettings.contactPhone}
            </a>
          )}
          {!restaurantSettings.contactPhone && <div style={{ color: "#9ba8ba", fontSize: 13 }}>{t("noRecords")}</div>}
        </section>}

        <footer className="attendance-footer">
          <span>{staff.role || "Staff"}</span>
          <span>Eat & Park · {t("appCaption")}</span>
        </footer>
      </section>
    </main>
  );
}
