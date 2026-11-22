import React, { useEffect, useMemo, useState } from "react";
import {
  browserLocalPersistence,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import { addDoc, collection, doc, getDoc, getDocs, onSnapshot, query, setDoc, updateDoc, where, writeBatch } from "firebase/firestore";
import { auth } from "./firebase";
import { db } from "./firebase";
import {
  ATTENDANCE_RADIUS_METERS,
  dateRangeInclusive,
  haversineDistanceMeters,
  isValidDateKey,
  RESTAURANT_LOCATION,
} from "./lib/staffPayroll";
import {
  autoStatus,
  calculateWorkedMinutes,
  DEFAULT_SHIFTS,
  formatIndiaTime,
  indiaDateKey,
  isShiftRestTime,
} from "./lib/staffShifts";
import "./AttendanceApp.css";
import { STAFF_ROLES } from "./lib/roles";

const STAFF_ROLE_SET = new Set(STAFF_ROLES);

function attendanceDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

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

export default function AttendanceApp({ currentUser: currentUserProp } = {}) {
  const [user, setUser] = useState(null);
  const [staff, setStaff] = useState(null);
  const [payroll, setPayroll] = useState(null);
  const [attendanceRecords, setAttendanceRecords] = useState([]);
  const [legacyAttendanceRecords, setLegacyAttendanceRecords] = useState([]);
  const [advanceRecords, setAdvanceRecords] = useState([]);
  const [legacyAdvanceRecords, setLegacyAdvanceRecords] = useState([]);
  const [leaveRequests, setLeaveRequests] = useState([]);
  const [shifts, setShifts] = useState(DEFAULT_SHIFTS);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [advanceAmount, setAdvanceAmount] = useState("");
  const [advanceReason, setAdvanceReason] = useState("");
  const [submittingAdvance, setSubmittingAdvance] = useState(false);
  const [leaveForm, setLeaveForm] = useState({
    fromDate: attendanceDate(new Date()),
    toDate: attendanceDate(new Date()),
    type: "Paid Leave",
    reason: "",
  });
  const [submittingLeave, setSubmittingLeave] = useState(false);
  const [cancellingLeaveId, setCancellingLeaveId] = useState("");
  const [loginError, setLoginError] = useState("");
  const [attendanceError, setAttendanceError] = useState("");
  const [profileError, setProfileError] = useState("");
  const [notice, setNotice] = useState("");
  const [optimisticAttendance, setOptimisticAttendance] = useState(null);
  const [checkingLocation, setCheckingLocation] = useState(false);
  const [attendanceRadius, setAttendanceRadius] = useState(ATTENDANCE_RADIUS_METERS);
  const [gpsSettingsLoading, setGpsSettingsLoading] = useState(true);
  const [gpsSettingsError, setGpsSettingsError] = useState("");
  const [now, setNow] = useState(() => new Date());
  const today = indiaDateKey(now);
  const staffUid = user?.uid
    || (currentUserProp?.uid && auth.currentUser?.uid === currentUserProp.uid ? currentUserProp.uid : null);
  const suppliedName = currentUserProp?.uid && currentUserProp.uid === staffUid ? currentUserProp.name : "";
  const displayName = staff?.name || suppliedName || user?.email?.split("@")[0] || "Staff";

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
  const totalPresentDays = attendanceHistory.reduce((total, record) => {
    const status = String(record.status || (record.action === "present" ? "Present" : "")).toLowerCase();
    if (status === "half day") return total + 0.5;
    if (status === "present" || status === "paid leave") return total + 1;
    return total;
  }, 0);
  const totalApprovedAdvances = advanceHistory.reduce((total, advance) => (
    String(advance.status || "").toLowerCase() === "approved"
      ? total + (Number.isFinite(Number(advance.amount)) ? Number(advance.amount) : 0)
      : total
  ), 0);
  const todayAttendance = optimisticAttendance?.date === today
    ? optimisticAttendance
    : attendanceHistory.find((record) => record.date === today) || null;

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
    let active = true;
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (!currentUser) {
        if (active) {
          setUser(null);
          setStaff(null);
          setPayroll(null);
          setAttendanceRecords([]);
          setLegacyAttendanceRecords([]);
          setAdvanceRecords([]);
          setLegacyAdvanceRecords([]);
          setLeaveRequests([]);
          setOptimisticAttendance(null);
          setProfileError("");
          setLoading(false);
        }
        return;
      }

      if (active) setLoading(true);
      if (active) {
        setAttendanceRecords([]);
        setLegacyAttendanceRecords([]);
        setAdvanceRecords([]);
        setLegacyAdvanceRecords([]);
        setLeaveRequests([]);
        setPayroll(null);
        setProfileError("");
      }
      try {
        const staffSnapshot = await getDoc(doc(db, "staff", currentUser.uid));
        const profile = staffSnapshot.exists() ? staffSnapshot.data() : null;
        const role = String(profile?.role || "").toLowerCase();
        if (!profile || profile.active === false || !STAFF_ROLE_SET.has(role)) {
          await signOut(auth);
          if (active) {
            setLoginError("Ye account active staff account nahi hai.");
            setLoading(false);
          }
          return;
        }
        if (active) {
          setUser(currentUser);
          setStaff(profile);
          setOptimisticAttendance(null);
          setLoginError("");
          setLoading(false);
        }
      } catch (error) {
        console.error("Attendance staff verification failed:", error);
        if (active) {
          setLoginError(`Staff account verify nahi hua: ${getErrorMessage(error)}`);
          setLoading(false);
        }
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => onSnapshot(doc(db, "settings", "restaurant"), (snapshot) => {
    if (!snapshot.exists()) {
      setAttendanceRadius(ATTENDANCE_RADIUS_METERS);
      setGpsSettingsError("");
      setGpsSettingsLoading(false);
      return;
    }

    const settings = snapshot.data();
    const validSettings = Number.isFinite(settings.lat)
      && settings.lat >= -90 && settings.lat <= 90
      && Number.isFinite(settings.lng)
      && settings.lng >= -180 && settings.lng <= 180
      && Number.isFinite(settings.radius)
      && settings.radius > 0 && settings.radius <= 10000;
    if (!validSettings) {
      setGpsSettingsError("Restaurant GPS settings invalid hain. Admin se settings update karwayein.");
      setGpsSettingsLoading(false);
      return;
    }
    setAttendanceRadius(settings.radius);
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
    if (!staffUid) return undefined;

    const unsubscribeAttendance = onSnapshot(
      query(collection(db, "attendance"), where("staffId", "==", staffUid)),
      (snapshot) => setAttendanceRecords(snapshot.docs.map((entry) => entry.data())),
      (error) => {
        console.error("Staff attendance history load failed:", error);
        setProfileError(`Attendance history load nahi hui: ${getErrorMessage(error)}`);
      },
    );
    const unsubscribeLegacyAttendance = onSnapshot(
      query(collection(db, "staffAttendance"), where("uid", "==", staffUid)),
      (snapshot) => setLegacyAttendanceRecords(snapshot.docs.map((entry) => entry.data())),
      (error) => {
        console.error("Legacy attendance history load failed:", error);
        setProfileError(`Attendance history load nahi hui: ${getErrorMessage(error)}`);
      },
    );
    const unsubscribeAdvances = onSnapshot(
      query(collection(db, "advances"), where("staffId", "==", staffUid)),
      (snapshot) => setAdvanceRecords(snapshot.docs.map((entry) => {
        const data = entry.data();
        return { id: entry.id, ...data, source: data.source || "request" };
      })),
      (error) => {
        console.error("Staff advance history load failed:", error);
        setProfileError(`Advance history load nahi hui: ${getErrorMessage(error)}`);
      },
    );
    const unsubscribeLegacyAdvances = onSnapshot(
      query(collection(db, "staffAdvances"), where("uid", "==", staffUid)),
      (snapshot) => setLegacyAdvanceRecords(snapshot.docs.map((entry) => {
        const data = entry.data();
        return { id: entry.id, ...data, source: data.source || "request" };
      })),
      (error) => {
        console.error("Legacy advance history load failed:", error);
        setProfileError(`Advance history load nahi hui: ${getErrorMessage(error)}`);
      },
    );
    const unsubscribePayroll = onSnapshot(doc(db, "staffPayroll", staffUid), (snapshot) => {
      setPayroll(snapshot.exists() ? snapshot.data() : null);
    }, (error) => {
      console.error("Staff salary load failed:", error);
      setProfileError(`Monthly salary load nahi hui: ${getErrorMessage(error)}`);
    });
    const unsubscribeLeaves = onSnapshot(
      query(collection(db, "leaveRequests"), where("staffId", "==", staffUid)),
      (snapshot) => setLeaveRequests(snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }))
        .sort((a, b) => String(b.fromDate).localeCompare(String(a.fromDate)))),
      (error) => {
        console.error("Staff leave requests load failed:", error);
        setProfileError(`Leave requests load nahi hui: ${getErrorMessage(error)}`);
      },
    );

    return () => {
      unsubscribeAttendance();
      unsubscribeLegacyAttendance();
      unsubscribeAdvances();
      unsubscribeLegacyAdvances();
      unsubscribePayroll();
      unsubscribeLeaves();
    };
  }, [staffUid]);

  const login = async (event) => {
    event.preventDefault();
    setLoginError("");
    setLoading(true);
    try {
      await setPersistence(auth, browserLocalPersistence);
      await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch (error) {
      console.error("Attendance login failed:", error);
      const message = error?.code === "auth/invalid-credential"
        || error?.code === "auth/user-not-found"
        || error?.code === "auth/wrong-password"
        ? "Email ya password galat hai."
        : getErrorMessage(error);
      setLoginError(message);
      setLoading(false);
    }
  };

  const markAttendance = async () => {
    if (!staffUid || checkingLocation) return;
    setCheckingLocation(true);
    setAttendanceError("");
    setNotice("");
    try {
      const settingsSnapshot = await getDoc(doc(db, "settings", "restaurant"));
      const settings = settingsSnapshot.exists() ? settingsSnapshot.data() : {
        lat: RESTAURANT_LOCATION.latitude,
        lng: RESTAURANT_LOCATION.longitude,
        radius: ATTENDANCE_RADIUS_METERS,
      };
      if (!Number.isFinite(settings.lat) || settings.lat < -90 || settings.lat > 90
        || !Number.isFinite(settings.lng) || settings.lng < -180 || settings.lng > 180
        || !Number.isFinite(settings.radius) || settings.radius <= 0 || settings.radius > 10000) {
        throw new Error("Restaurant GPS settings are invalid.");
      }
      const position = await new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
          reject(new Error("Location services are unavailable in this browser."));
          return;
        }
        const errorCallback = (error) => {
          console.error("Geolocation error callback:", {
            code: error.code,
            message: error.message,
          });
          if (error.code === 1) window.alert("Please allow location permission");
          reject(error);
        };
        console.log("Calling navigator.geolocation.getCurrentPosition", {
          secureContext: window.isSecureContext,
          highAccuracy: true,
        });
        navigator.geolocation.getCurrentPosition(
          resolve,
          errorCallback,
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
        );
      });
      const distance = haversineDistanceMeters(
        position.coords.latitude,
        position.coords.longitude,
        settings.lat,
        settings.lng,
      );
      if (distance > settings.radius) {
        window.alert("You are too far");
        return;
      }

      const currentDate = indiaDateKey(new Date());
      if (todayAttendance?.checkOutAt == null && todayAttendance?.checkInAt) {
        setNotice("Aaj check-in ho chuka hai. Ab Check out karein.");
        return;
      }
      const [attendanceSnapshot, legacySnapshot] = await Promise.all([
        getDocs(query(collection(db, "attendance"), where("staffId", "==", staffUid))),
        getDocs(query(collection(db, "staffAttendance"), where("uid", "==", staffUid))),
      ]);
      const alreadyMarked = [...attendanceSnapshot.docs, ...legacySnapshot.docs].some((entry) => {
        const record = entry.data();
        return record.date === currentDate
          && (record.status || record.action === "present");
      });
      if (alreadyMarked) {
        const canonical = attendanceSnapshot.docs.find((entry) => entry.id === `${staffUid}_${currentDate}`);
        const record = canonical?.data();
        if (record?.source === "manual") {
          setNotice("Admin ne aaj ki attendance manual override ki hai.");
        } else {
          setOptimisticAttendance(record || { status: "Present", date: currentDate });
          setNotice("Aaj ki attendance pehle hi mark ho chuki hai.");
        }
        return;
      }

      const checkInAt = Date.now();
      const shiftId = staff?.shiftId || "";
      const shift = shifts[shiftId];
      const result = shift ? autoStatus(checkInAt, shift) : null;
      const record = {
        staffId: staffUid,
        date: currentDate,
        status: result?.status || "Present",
        source: "gps",
        distanceMeters: Math.round(distance * 100) / 100,
        checkInAt,
        incomplete: result?.incomplete ?? true,
        late: result?.late ?? false,
        lateMinutes: result?.lateMinutes ?? 0,
        earlyLeave: false,
        ...(shiftId ? { shiftId, shiftName: shift.name } : {}),
      };
      await setDoc(doc(db, "attendance", `${staffUid}_${currentDate}`), record);
      setOptimisticAttendance(record);
      setNotice(result?.status === "Half Day"
        ? "Half Day mark hui: shift start se 30 minutes ya zyada late."
        : "Check-in successfully mark ho gaya.");
    } catch (error) {
      console.error("GPS attendance failed:", error);
      if (error?.code === 1) {
        setAttendanceError("Please allow location permission");
      } else if (error?.code === 2) {
        window.alert("Unable to get your location. Please check GPS.");
        setAttendanceError("Aapki current location nahi mil saki. GPS check karke phir try karein.");
      } else if (error?.code === 3) {
        window.alert("Location request timed out. Please try again.");
        setAttendanceError("GPS location lene mein time out hua. Phir try karein.");
      } else {
        window.alert(`Attendance mark nahi hui: ${getErrorMessage(error)}`);
        setAttendanceError(`Attendance mark nahi hui: ${getErrorMessage(error)}`);
      }
    } finally {
      setCheckingLocation(false);
    }
  };

  const markCheckout = async () => {
    if (!staffUid || checkingLocation || !todayAttendance?.checkInAt || todayAttendance?.checkOutAt) return;
    if (todayAttendance.source === "manual") {
      setNotice("Manual override wale record par staff check-out GPS se change nahi hoga.");
      return;
    }
    setCheckingLocation(true);
    setAttendanceError("");
    setNotice("");
    try {
      const settingsSnapshot = await getDoc(doc(db, "settings", "restaurant"));
      const settings = settingsSnapshot.exists() ? settingsSnapshot.data() : {
        lat: RESTAURANT_LOCATION.latitude,
        lng: RESTAURANT_LOCATION.longitude,
        radius: ATTENDANCE_RADIUS_METERS,
      };
      if (!Number.isFinite(settings.lat) || !Number.isFinite(settings.lng)
        || !Number.isFinite(settings.radius)) {
        throw new Error("Restaurant GPS settings are invalid.");
      }
      const position = await new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
          reject(new Error("Location services are unavailable in this browser."));
          return;
        }
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 15000,
          maximumAge: 0,
        });
      });
      const distance = haversineDistanceMeters(
        position.coords.latitude,
        position.coords.longitude,
        settings.lat,
        settings.lng,
      );
      if (distance > settings.radius) {
        window.alert("You are too far");
        return;
      }

      const checkOutAt = Date.now();
      const shift = shifts[todayAttendance.shiftId] || shifts.staff?.[todayAttendance.shiftId];
      const result = shift ? autoStatus(todayAttendance.checkInAt, shift, checkOutAt) : null;
      const updated = {
        ...todayAttendance,
        checkOutAt,
        incomplete: false,
        earlyLeave: result?.earlyLeave ?? false,
        status: todayAttendance.source === "manual" ? todayAttendance.status : (result?.status || todayAttendance.status),
        workedMinutes: shift ? calculateWorkedMinutes(todayAttendance.checkInAt, checkOutAt, shift) : null,
      };
      await setDoc(doc(db, "attendance", `${staffUid}_${today}`), updated, { merge: true });
      setOptimisticAttendance(updated);
      setNotice(result?.earlyLeave ? "Check-out ho gaya; Early leave flag lagi hai." : "Check-out successfully mark ho gaya.");
    } catch (error) {
      console.error("GPS check-out failed:", error);
      setAttendanceError(`Check-out nahi hua: ${getErrorMessage(error)}`);
    } finally {
      setCheckingLocation(false);
    }
  };

  const submitAdvanceRequest = async (event) => {
    event.preventDefault();
    const amount = Number(advanceAmount);
    const reason = advanceReason.trim();
    if (!staffUid || !Number.isFinite(amount) || amount <= 0 || !reason) {
      window.alert("Valid advance amount aur reason enter karein.");
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
      window.alert("Advance request submitted.");
    } catch (error) {
      console.error("Advance request submit failed:", error);
      const message = `Advance request submit nahi hui: ${getErrorMessage(error)}`;
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
      setProfileError("Valid leave dates, type, aur reason enter karein.");
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
      console.error("Leave request submit failed:", error);
      setProfileError(`Leave request submit nahi hui: ${getErrorMessage(error)}`);
    } finally {
      setSubmittingLeave(false);
    }
  };

  const cancelLeaveRequest = async (leave) => {
    if (!window.confirm("Pending leave request cancel karein?")) return;
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
      setProfileError(`Leave request cancel nahi hui: ${getErrorMessage(error)}`);
    } finally {
      setCancellingLeaveId("");
    }
  };

  const logout = async () => {
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

  if (loading) {
    return (
      <main className="attendance-app">
        <div className="attendance-loading"><span className="attendance-spinner" />Loading attendance...</div>
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
            <div className="attendance-eyebrow">STAFF CHECK-IN</div>
            <h1>Hajiri, ab<br />aasani se.</h1>
            <p>Apne staff account se sign in karke restaurant par pahunchne ke baad attendance mark karein.</p>
          </div>
          <form onSubmit={login} className="attendance-login-form">
            <label>
              Staff email
              <input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" required />
            </label>
            <label>
              Password
              <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Apna password" required />
            </label>
            {loginError && <div className="attendance-error" role="alert">{loginError}</div>}
            <button type="submit" className="attendance-primary-button">Sign in <span>→</span></button>
          </form>
          <div className="attendance-login-footer">Secure staff-only attendance · GPS verification required</div>
        </section>
      </main>
    );
  }

  return (
    <main className="attendance-app">
      <section className="attendance-dashboard">
        <header className="attendance-topbar">
          <div className="attendance-brand">
            <div className="attendance-brand-mark"><span>E<span>&</span>P</span></div>
            <div><strong>Eat & Park</strong><small>STAFF ATTENDANCE</small></div>
          </div>
          <button type="button" className="attendance-logout" onClick={logout}>Sign out</button>
        </header>

        <section className="attendance-welcome">
          <div className="attendance-eyebrow">YOUR SHIFT, YOUR CHECK-IN</div>
          <h1>Namaste, {displayName} 👋</h1>
          <p>Jab restaurant par pahunch jaayein, yahin se apni aaj ki hajiri lagayein.</p>
        </section>

        <section className="attendance-status-card">
          <div className="attendance-status-top">
            <div>
              <div className="attendance-eyebrow">TODAY</div>
              <h2>{now.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}</h2>
            </div>
            <div className="attendance-live-dot"><span /> LIVE</div>
          </div>
          <div className="attendance-clock">
            {now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true })}
          </div>
          <div className={`attendance-status-pill ${todayAttendance ? "is-marked" : ""}`}>
            <span>{todayAttendance ? "✓" : "•"}</span>
            {todayAttendance
              ? `${todayAttendance.status || "Present"}${todayAttendance.incomplete ? " · Incomplete" : ""}${todayAttendance.earlyLeave ? " · Early leave" : ""}`
              : "Not checked in yet"}
          </div>
          {todayAttendance?.late && (
            <div style={{ marginTop: 8, color: "#fbbf24", fontSize: 12 }}>
              Late by {todayAttendance.lateMinutes} minutes
            </div>
          )}
          {todayAttendance?.checkInAt && (
            <div style={{ marginTop: 8, color: "#9ba8ba", fontSize: 12 }}>
              In: {formatIndiaTime(todayAttendance.checkInAt)}
              {todayAttendance.checkOutAt ? ` · Out: ${formatIndiaTime(todayAttendance.checkOutAt)}` : ""}
              {todayAttendance.shiftName ? ` · ${todayAttendance.shiftName}` : ""}
            </div>
          )}
          {isShiftRestTime(now, shifts[todayAttendance?.shiftId] || {}) && (
            <div style={{ marginTop: 8, color: "#fb923c", fontSize: 12, fontWeight: 800 }}>Rest time · 15:00–17:00</div>
          )}
          <div className="attendance-divider" />
          <div className="attendance-location-row">
            <div className="attendance-location-icon">⌖</div>
            <div>
              <strong>Restaurant location</strong>
              <span>Check-in allowed within {attendanceRadius} meters</span>
            </div>
            <span className="attendance-location-check">GPS</span>
          </div>

          <button
            type="button"
            className="attendance-primary-button attendance-checkin-button"
            onClick={todayAttendance?.checkInAt && !todayAttendance?.checkOutAt ? markCheckout : markAttendance}
            disabled={checkingLocation || (Boolean(todayAttendance?.checkOutAt)) || gpsSettingsLoading || Boolean(gpsSettingsError)}
          >
            {gpsSettingsLoading
              ? <>Loading restaurant GPS settings...</>
              : checkingLocation
              ? <><span className="attendance-spinner" />Checking your location...</>
              : todayAttendance?.checkOutAt
                ? <>Checked out for today <span>✓</span></>
                : todayAttendance?.checkInAt
                ? <>Check out via GPS <span>→</span></>
                : <>Mark today&apos;s attendance via GPS <span>→</span></>}
          </button>
          <div className="attendance-gps-note">📍 Location permission on rakhein; attendance ke liye GPS verify hoga. Allowed radius: {attendanceRadius} meters.</div>
          {gpsSettingsError && <div className="attendance-error" role="alert">{gpsSettingsError}</div>}
          {notice && <div className="attendance-success" role="status">{notice}</div>}
          {attendanceError && <div className="attendance-error" role="alert">{attendanceError}</div>}
        </section>

        <section style={{ ...panelStyle, marginTop: 16 }} aria-label="Staff profile">
          <div className="attendance-eyebrow">MY PROFILE</div>
          <h2 style={{ margin: "8px 0 14px", fontSize: 20 }}>{displayName}</h2>
          {profileError && <div className="attendance-error" role="alert">{profileError}</div>}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
            {[
              ["Role", staff.role || "staff"],
              ["Monthly salary", formatCurrency(Number(staff.monthlySalary ?? payroll?.monthlySalary ?? 0))],
              ["Present days", String(totalPresentDays)],
              ["Approved advances", formatCurrency(totalApprovedAdvances)],
            ].map(([label, value]) => (
              <div key={label} style={{ padding: 12, borderRadius: 12, background: "rgba(255,255,255,0.04)" }}>
                <div style={{ color: "#9ba8ba", fontSize: 11, marginBottom: 5 }}>{label}</div>
                <strong style={{ color: "#f5f7fb", fontSize: 14 }}>{value}</strong>
              </div>
            ))}
          </div>
        </section>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))", gap: 14, marginTop: 14 }}>
          <section style={panelStyle} aria-label="Attendance history">
            <h2 style={{ margin: "0 0 12px", fontSize: 17 }}>Attendance history</h2>
            {attendanceHistory.length === 0
              ? <div style={{ color: "#9ba8ba", fontSize: 13 }}>No attendance records yet.</div>
              : attendanceHistory.map((record) => (
                <div key={record.date} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "10px 0", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                  <div>
                    <span>{new Date(`${record.date}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</span>
                    <div style={{ color: "#9ba8ba", fontSize: 10, marginTop: 4 }}>
                      {record.checkInAt ? `In ${formatIndiaTime(record.checkInAt)}` : "In —"}
                      {record.checkOutAt ? ` · Out ${formatIndiaTime(record.checkOutAt)}` : ""}
                      {record.shiftName ? ` · ${record.shiftName}` : ""}
                      {record.lateMinutes ? ` · Late ${record.lateMinutes}m` : ""}
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <strong style={{ display: "block", color: record.status?.toLowerCase() === "present" || record.action === "present" ? "#34d399" : "#fbbf24" }}>
                      {record.status || "Present"}
                    </strong>
                    {record.incomplete && <small style={{ display: "block", color: "#FCA5A5" }}>Incomplete</small>}
                    {record.earlyLeave && <small style={{ display: "block", color: "#FBBF24" }}>Early leave</small>}
                  </div>
                </div>
              ))}
          </section>

          <section style={{ display: "grid", gap: 14, alignContent: "start" }}>
            <form onSubmit={submitAdvanceRequest} style={{ ...panelStyle, display: "grid", gap: 11 }}>
              <h2 style={{ margin: 0, fontSize: 17 }}>Request an advance</h2>
              <label style={{ display: "grid", gap: 7, color: "#c4ccda", fontSize: 12, fontWeight: 750 }}>
                Amount (₹)
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
                {submittingAdvance ? "Submitting..." : "Submit request"}
              </button>
            </form>

            <form onSubmit={submitLeaveRequest} style={{ ...panelStyle, display: "grid", gap: 11 }}>
              <h2 style={{ margin: 0, fontSize: 17 }}>Request leave</h2>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 }}>
                <label style={{ display: "grid", gap: 7, color: "#c4ccda", fontSize: 12, fontWeight: 750 }}>
                  From date
                  <input type="date" required value={leaveForm.fromDate} onChange={(event) => setLeaveForm((form) => ({ ...form, fromDate: event.target.value }))} style={dashboardInputStyle} />
                </label>
                <label style={{ display: "grid", gap: 7, color: "#c4ccda", fontSize: 12, fontWeight: 750 }}>
                  To date
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
                  Warning: selected dates overlap an existing pending/approved leave request.
                </div>
              )}
              <button type="submit" disabled={submittingLeave} style={dashboardButtonStyle}>
                {submittingLeave ? "Submitting..." : "Submit leave request"}
              </button>
            </form>

            <section style={panelStyle} aria-label="Leave request history">
              <h2 style={{ margin: "0 0 12px", fontSize: 17 }}>Leave request history</h2>
              {leaveRequests.length === 0
                ? <div style={{ color: "#9ba8ba", fontSize: 13 }}>No leave requests yet.</div>
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
                        <strong style={{ color, fontSize: 12 }}>{status}</strong>
                        {status === "pending" && (
                          <button type="button" disabled={cancellingLeaveId === leave.id} onClick={() => cancelLeaveRequest(leave)} style={{ ...dashboardButtonStyle, minHeight: 32, padding: "0 9px", fontSize: 11 }}>
                            {cancellingLeaveId === leave.id ? "Cancelling..." : "Cancel"}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
            </section>

            <section style={panelStyle} aria-label="Advance history">
              <h2 style={{ margin: "0 0 12px", fontSize: 17 }}>Advance history</h2>
              {advanceHistory.length === 0
                ? <div style={{ color: "#9ba8ba", fontSize: 13 }}>No advance requests yet.</div>
                : advanceHistory.map((advance, index) => {
                  const key = `${advance.source || "advance"}-${advance.id || index}`;
                  const status = String(advance.status || "Pending");
                  const approved = status.toLowerCase() === "approved";
                  return (
                    <div key={key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "10px 0", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                      <div>
                        <strong>{formatCurrency(Number(advance.amount || 0))}</strong>
                        {advance.reason && <div style={{ marginTop: 3, color: "#9ba8ba", fontSize: 11 }}>{advance.reason}</div>}
                        <div style={{ marginTop: 3, color: "#9ba8ba", fontSize: 10 }}>{advance.date || advance.month || ""} · {advance.source || "request"}</div>
                      </div>
                      <strong style={{ color: approved ? "#34d399" : status.toLowerCase() === "rejected" ? "#fb7185" : "#fbbf24", fontSize: 12 }}>{status}</strong>
                    </div>
                  );
                })}
            </section>
          </section>
        </div>

        <footer className="attendance-footer">
          <span>{staff.role || "Staff"}</span>
          <span>Eat & Park · Staff portal</span>
        </footer>
      </section>
    </main>
  );
}
