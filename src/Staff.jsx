import React, { useEffect, useMemo, useState } from "react";
import { auth, db } from "./firebase";
import {
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
  calculateStaffSalary,
  daysInMonth,
  RESTAURANT_LOCATION,
} from "./lib/staffPayroll";

const STAFF_ROLES = ["admin", "owner", "manager", "staff", "waiter", "cashier", "chef", "delivery"];
const ATTENDANCE_STATUSES = ["Present", "Half Day", "Absent", "Paid Leave"];
const TABS = [
  { id: "staff", label: "Staff Management" },
  { id: "gps", label: "GPS Settings" },
  { id: "advances", label: "Advance Requests" },
  { id: "payroll", label: "Payroll & Attendance" },
];

const currentMonthKey = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
};

const todayKey = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

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

export default function Staff({ C, isMobile }) {
  const [activeTab, setActiveTab] = useState("staff");
  const [month, setMonth] = useState(currentMonthKey);
  const [members, setMembers] = useState([]);
  const [staffDrafts, setStaffDrafts] = useState({});
  const [staffSaveStates, setStaffSaveStates] = useState({});
  const [selectedMemberId, setSelectedMemberId] = useState("");
  const [legacyPayroll, setLegacyPayroll] = useState({});
  const [advanceRequests, setAdvanceRequests] = useState([]);
  const [legacyAdvances, setLegacyAdvances] = useState([]);
  const [manualAttendance, setManualAttendance] = useState([]);
  const [gpsAttendance, setGpsAttendance] = useState([]);
  const [gpsAttendanceLoading, setGpsAttendanceLoading] = useState(true);
  const [manualAttendanceLoading, setManualAttendanceLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [newStaff, setNewStaff] = useState({
    uid: "",
    name: "",
    role: "staff",
    monthlySalary: "",
    active: true,
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
  });

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
      setLoadError("");
    }, (error) => {
      console.error("Staff list load failed:", error);
      setLoadError(`Staff list load nahi hui: ${getErrorMessage(error)}`);
    });
    return unsubscribe;
  }, []);

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
    const advanceQuery = (collectionName) => query(
      collection(db, collectionName),
      where("status", "in", ["Pending", "pending", "Approved", "approved"]),
    );
    const unsubscribeRequests = onSnapshot(advanceQuery("advances"), (snapshot) => {
      setAdvanceRequests(snapshot.docs.map((entry) => ({
        id: entry.id,
        source: "advances",
        ...entry.data(),
      })));
    }, (error) => {
      console.error("Advance requests load failed:", error);
      setLoadError(`Advance requests load nahi hui: ${getErrorMessage(error)}`);
    });
    const unsubscribeLegacy = onSnapshot(advanceQuery("staffAdvances"), (snapshot) => {
      setLegacyAdvances(snapshot.docs.map((entry) => ({
        id: entry.id,
        source: "staffAdvances",
        ...entry.data(),
      })));
    }, (error) => {
      console.error("Legacy staff advances load failed:", error);
      setLoadError(`Payroll advances load nahi hui: ${getErrorMessage(error)}`);
    });
    return () => {
      unsubscribeRequests();
      unsubscribeLegacy();
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
      if (!current || (current.source === "gps" && normalized.source === "manual")) {
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

  const pendingRequests = useMemo(
    () => [...advanceRequests, ...legacyAdvances]
      .filter((advance) => String(advance.status || "").toLowerCase() === "pending")
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)),
    [advanceRequests, legacyAdvances],
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
    const uid = newStaff.uid.trim();
    const name = newStaff.name.trim();
    const monthlySalary = Number(newStaff.monthlySalary);
    if (!uid || !name || !Number.isFinite(monthlySalary) || monthlySalary < 0) {
      setActionError("Firebase Auth UID, name, aur valid non-negative salary required hain.");
      return;
    }
    setBusyId("add-staff");
    try {
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
        });
      });
      setNewStaff({ uid: "", name: "", role: "staff", monthlySalary: "", active: true });
    } catch (error) {
      setActionError(`Staff member add nahi hua: ${getErrorMessage(error)}`);
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
      await setDoc(doc(db, "settings", "restaurant"), { lat, lng, radius });
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

  const handleApproveAdvance = async (advance) => {
    const adminUid = auth.currentUser?.uid;
    if (!adminUid) {
      window.alert("Admin session expire ho gaya. Dobara sign in karein.");
      return;
    }
    setActionError("");
    setBusyId(`advance-${advance.source}-${advance.id}`);
    try {
      await updateDoc(doc(db, advance.source, advance.id), {
        status: "Approved",
        approvedBy: adminUid,
        approvedAt: Date.now(),
      });
    } catch (error) {
      reportError("Advance approve nahi hua", error);
    } finally {
      setBusyId("");
    }
  };

  const saveAttendance = async (staffId, date, status) => {
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
      const batch = writeBatch(db);
      batch.set(attendanceRef, {
        staffId,
        date,
        status,
        markedBy: "Admin",
        source: "manual",
      });
      manualSnapshot.docs.forEach((entry) => {
        if (entry.id !== attendanceRef.id && getStaffId(entry.data()) === staffId) {
          batch.delete(entry.ref);
        }
      });
      await batch.commit();
      setMonth(date.slice(0, 7));
      setAttendanceForm((form) => ({ ...form, staffId, date, status }));
      setActionError("");
    } catch (error) {
      reportError("Attendance mark nahi hui", error);
    } finally {
      setBusyId("");
    }
  };

  const handleMarkAttendance = (event) => {
    event.preventDefault();
    return saveAttendance(attendanceForm.staffId, attendanceForm.date, attendanceForm.status);
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
      } else if (field === "role" && !STAFF_ROLES.includes(value)) {
        throw new Error("Valid staff role select karein.");
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
            onClick={() => setActiveTab(tab.id)}
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

      {activeTab === "staff" && (
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "minmax(280px, 360px) 1fr", gap: 14 }}>
          <form onSubmit={handleAddStaff} style={{ ...cardStyle, display: "grid", alignContent: "start", gap: 12 }}>
            <h3 style={{ margin: 0, color: C.ink, fontSize: 16 }}>Add staff profile</h3>
            <div style={{ color: C.gray, fontSize: 12 }}>
              Firebase Authentication account pehle banayein; yahan uska UID use karein.
            </div>
            <label style={labelStyle}>
              Firebase Auth UID
              <input required value={newStaff.uid} onChange={(event) => setNewStaff((form) => ({ ...form, uid: event.target.value }))} style={inputStyle} />
            </label>
            <label style={labelStyle}>
              Name
              <input required maxLength={80} value={newStaff.name} onChange={(event) => setNewStaff((form) => ({ ...form, name: event.target.value }))} style={inputStyle} />
            </label>
            <label style={labelStyle}>
              Role
              <select value={newStaff.role} onChange={(event) => setNewStaff((form) => ({ ...form, role: event.target.value }))} style={inputStyle}>
                {STAFF_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
              </select>
            </label>
            <label style={labelStyle}>
              Monthly salary (₹)
              <input required type="number" min="0" step="0.01" value={newStaff.monthlySalary} onChange={(event) => setNewStaff((form) => ({ ...form, monthlySalary: event.target.value }))} style={inputStyle} />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 9, color: C.ink, fontSize: 13, fontWeight: 700 }}>
              <input type="checkbox" checked={newStaff.active} onChange={(event) => setNewStaff((form) => ({ ...form, active: event.target.checked }))} />
              Active staff
            </label>
            <button type="submit" disabled={busyId === "add-staff"} style={buttonStyle}>
              {busyId === "add-staff" ? "Adding..." : "Add staff"}
            </button>
          </form>

          <section style={cardStyle}>
            <h3 style={{ margin: "0 0 12px", color: C.ink, fontSize: 16 }}>Existing staff ({members.length})</h3>
            {members.length === 0
              ? <div style={{ color: C.gray, fontSize: 13 }}>No staff profiles found.</div>
              : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760, color: C.ink, fontSize: 13 }}>
                    <thead>
                      <tr style={{ color: C.gray, textAlign: "left" }}>
                        {["Name", "Role", "Monthly salary", "Status", "Auth UID"].map((heading) => (
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
                            <select
                              aria-label={`Role for ${member.id}`}
                              value={staffDrafts[member.id]?.role ?? member.role ?? "staff"}
                              onChange={(event) => setStaffDrafts((current) => ({ ...current, [member.id]: { ...current[member.id], role: event.target.value } }))}
                              onBlur={() => handleSaveStaffField(member, "role")}
                              style={{ ...inputStyle, minWidth: 110, padding: "7px 8px" }}
                            >
                              {STAFF_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
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
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </section>
        </div>
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
        <section style={cardStyle}>
          <h3 style={{ margin: "0 0 12px", color: C.ink, fontSize: 16 }}>Pending advance requests ({pendingRequests.length})</h3>
          {pendingRequests.length === 0
            ? <div style={{ color: C.gray, fontSize: 13 }}>No pending advance requests.</div>
            : (
              <div style={{ display: "grid", gap: 10 }}>
                {pendingRequests.map((advance) => {
                  const staffId = getStaffId(advance);
                  const member = members.find((entry) => entry.id === staffId);
                  const requestBusy = busyId === `advance-${advance.source}-${advance.id}`;
                  return (
                    <article key={`${advance.source}-${advance.id}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, padding: 13, border: `1px solid ${C.line}`, borderRadius: 11 }}>
                      <div>
                        <div style={{ color: C.ink, fontWeight: 800 }}>{member?.name || advance.staffName || advance.name || staffId || "Unknown staff"}</div>
                        <div style={{ color: C.gray, fontSize: 12, marginTop: 4 }}>
                          {advance.reason || "No reason provided"}
                          {advance.month ? ` · ${advance.month}` : ""}
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <strong style={{ color: C.gold }}>{formatCurrency(Number(advance.amount || 0))}</strong>
                        <button type="button" disabled={requestBusy} onClick={() => handleApproveAdvance(advance)} style={buttonStyle}>
                          {requestBusy ? "Approving..." : "Approve"}
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
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

          <form onSubmit={handleMarkAttendance} style={{ ...cardStyle, display: "grid", gridTemplateColumns: isMobile ? "1fr" : "minmax(180px, 1fr) minmax(150px, 190px) minmax(140px, 180px) auto", gap: 10, alignItems: "end", marginBottom: 14 }}>
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
                  {["Staff", "Present days", "Paid leave", "Earned leaves", "Paid days", "Monthly salary", "Per day", "Gross salary", "Approved advances", "Carry forward advance", "Final payable"].map((heading) => (
                    <th key={heading} style={{ padding: 11, borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap" }}>{heading}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {payrollMembers.map((member) => {
                  const stats = attendanceStatsByStaff.get(member.id) || { presentDays: 0, paidLeaveDays: 0 };
                  const { presentDays, paidLeaveDays } = stats;
                  const approvedAdvance = approvedAdvanceTotals.get(member.id) || 0;
                  const monthlySalary = Number(legacyPayroll[member.id]?.monthlySalary ?? member.monthlySalary ?? 0);
                  const salary = calculateStaffSalary({
                    monthlySalary,
                    presentDays,
                    paidLeaveDays,
                    totalApprovedAdvance: approvedAdvance,
                    daysInPayPeriod: daysInMonth(month),
                  });
                  const dateValue = presentDays.toLocaleString("en-IN", { maximumFractionDigits: 1 });
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
                      <td style={{ padding: 10, borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap", color: salary.carryForwardAdvance > 0 ? "#FCA5A5" : C.gray }}>{formatCurrency(salary.carryForwardAdvance)}</td>
                      <td style={{ padding: 10, borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap", color: C.gold, fontWeight: 900 }}>{formatCurrency(salary.finalPayable)}</td>
                    </tr>
                  );
                })}
                {!payrollMembers.length && (
                  <tr><td colSpan={11} style={{ padding: 18, color: C.gray, textAlign: "center" }}>No active staff with monthly salary above ₹0.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {selectedMember && (() => {
            const stats = attendanceStatsByStaff.get(selectedMember.id) || { presentDays: 0, paidLeaveDays: 0 };
            const approvedAdvance = approvedAdvanceTotals.get(selectedMember.id) || 0;
            const monthlySalary = Number(legacyPayroll[selectedMember.id]?.monthlySalary ?? selectedMember.monthlySalary ?? 0);
            const salary = calculateStaffSalary({
              monthlySalary,
              presentDays: stats.presentDays,
              paidLeaveDays: stats.paidLeaveDays,
              totalApprovedAdvance: approvedAdvance,
              daysInPayPeriod: daysInMonth(month),
            });
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
                      ["Final payable", salary.finalPayable],
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
                          title={status ? `${status} · ${record.source === "gps" ? "GPS" : "Manual"}` : "Not marked"}
                          style={{ minWidth: 0, padding: "6px 2px", border: `1px solid ${date === attendanceForm.date ? C.gold : C.line}`, borderRadius: 7, background: C.bg, color: date > todayKey() ? C.gray : color, cursor: date > todayKey() ? "not-allowed" : "pointer", opacity: date > todayKey() ? 0.45 : 1 }}
                        >
                          <span style={{ display: "block", fontSize: 12, fontWeight: 800 }}>{day}</span>
                          <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", fontSize: 8 }}>{status || "—"}</span>
                          {record && <span style={{ display: "block", fontSize: 7 }}>{record.source === "gps" ? "GPS" : "Manual"}</span>}
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
        </section>
      )}
    </section>
  );
}
