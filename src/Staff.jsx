import React, { useEffect, useMemo, useState } from "react";
import { auth, db } from "./firebase";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import {
  ATTENDANCE_RADIUS_METERS,
  calculateStaffSalary,
  RESTAURANT_LOCATION,
} from "./lib/staffPayroll";

const STAFF_ROLES = ["admin", "owner", "manager", "staff", "waiter", "cashier", "chef", "delivery"];
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
  const [salaryInputs, setSalaryInputs] = useState({});
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
  const [attendanceForm, setAttendanceForm] = useState({
    staffId: "",
    date: todayKey(),
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
      setManualAttendance(snapshot.docs.map((entry) => entry.data()));
      setManualAttendanceLoading(false);
    }, (error) => {
      console.error("Monthly manual attendance load failed:", error);
      setLoadError(`Monthly attendance load nahi hui: ${getErrorMessage(error)}`);
      setManualAttendanceLoading(false);
    });
    const unsubscribeGps = onSnapshot(gpsQuery, (snapshot) => {
      setGpsAttendance(snapshot.docs.map((entry) => entry.data()));
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

  const presentDatesByStaff = useMemo(() => {
    const datesByStaff = new Map();
    const allRecords = [...manualAttendance, ...gpsAttendance];
    allRecords.forEach((record) => {
      const staffId = getStaffId(record);
      const date = record.date;
      const isPresent = record.status?.toLowerCase() === "present"
        || record.action === "present";
      if (!staffId || !date?.startsWith(`${month}-`) || !isPresent) return;
      if (!datesByStaff.has(staffId)) datesByStaff.set(staffId, new Set());
      datesByStaff.get(staffId).add(date);
    });
    return datesByStaff;
  }, [gpsAttendance, manualAttendance, month]);

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
      window.alert("Firebase Auth UID, name, and a valid non-negative salary are required.");
      return;
    }
    setBusyId("add-staff");
    try {
      const staffRef = doc(db, "staff", uid);
      if ((await getDoc(staffRef)).exists()) {
        window.alert("A staff profile with this Firebase Auth UID already exists.");
        return;
      }
      await setDoc(staffRef, {
        name,
        role: newStaff.role,
        monthlySalary,
        active: newStaff.active,
      });
      setNewStaff({ uid: "", name: "", role: "staff", monthlySalary: "", active: true });
    } catch (error) {
      reportError("Staff member add nahi hua", error);
    } finally {
      setBusyId("");
    }
  };

  const handleSaveGps = async (event) => {
    event.preventDefault();
    setActionError("");
    const lat = Number(gpsForm.lat);
    const lng = Number(gpsForm.lng);
    const radius = Number(gpsForm.radius);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90
      || !Number.isFinite(lng) || lng < -180 || lng > 180
      || !Number.isFinite(radius) || radius <= 0 || radius > 10000) {
      window.alert("Valid latitude, longitude, and radius (1–10,000 meters) enter karein.");
      return;
    }
    setBusyId("gps");
    try {
      await setDoc(doc(db, "settings", "restaurant"), { lat, lng, radius });
      window.alert("Restaurant GPS settings save ho gayi.");
    } catch (error) {
      reportError("GPS settings save nahi hui", error);
    } finally {
      setBusyId("");
    }
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

  const handleMarkAttendance = async (event) => {
    event.preventDefault();
    setActionError("");
    if (!attendanceForm.staffId || !/^\d{4}-\d{2}-\d{2}$/.test(attendanceForm.date)) {
      window.alert("Staff member aur valid attendance date select karein.");
      return;
    }
    setBusyId("attendance");
    try {
      const [manualSnapshot, gpsSnapshot] = await Promise.all([
        getDocs(query(collection(db, "attendance"), where("date", "==", attendanceForm.date))),
        getDocs(query(collection(db, "staffAttendance"), where("date", "==", attendanceForm.date))),
      ]);
      const alreadyMarked = [...manualSnapshot.docs, ...gpsSnapshot.docs].some((entry) => {
        const record = entry.data();
        return getStaffId(record) === attendanceForm.staffId
          && (record.status?.toLowerCase() === "present" || record.action === "present");
      });
      if (alreadyMarked) {
        window.alert("Is staff ki attendance is date par pehle se marked hai.");
        return;
      }
      await addDoc(collection(db, "attendance"), {
        staffId: attendanceForm.staffId,
        date: attendanceForm.date,
        status: "Present",
        markedBy: "Admin",
      });
      window.alert("Attendance successfully mark ho gayi.");
    } catch (error) {
      reportError("Attendance mark nahi hui", error);
    } finally {
      setBusyId("");
    }
  };

  const handleSaveSalary = async (member) => {
    const rawSalary = salaryInputs[member.id] ?? member.monthlySalary ?? legacyPayroll[member.id]?.monthlySalary ?? "";
    const monthlySalary = Number(rawSalary);
    const adminUid = auth.currentUser?.uid;
    if (rawSalary === "" || !Number.isFinite(monthlySalary) || monthlySalary < 0 || !adminUid) {
      window.alert("Valid salary aur active admin session required hai.");
      return;
    }
    setActionError("");
    setBusyId(`salary-${member.id}`);
    try {
      await setDoc(doc(db, "staffPayroll", member.id), {
        uid: member.id,
        monthlySalary,
        updatedAt: Date.now(),
        updatedBy: adminUid,
      }, { merge: true });
      setSalaryInputs((current) => ({ ...current, [member.id]: String(monthlySalary) }));
    } catch (error) {
      reportError("Salary save nahi hui", error);
    } finally {
      setBusyId("");
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
                  <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 520, color: C.ink, fontSize: 13 }}>
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
                          <td style={{ padding: "10px 8px", borderBottom: `1px solid ${C.line}`, fontWeight: 700 }}>{member.name || "—"}</td>
                          <td style={{ padding: "10px 8px", borderBottom: `1px solid ${C.line}` }}>{member.role || "staff"}</td>
                          <td style={{ padding: "10px 8px", borderBottom: `1px solid ${C.line}` }}>{formatCurrency(Number(legacyPayroll[member.id]?.monthlySalary ?? member.monthlySalary ?? 0))}</td>
                          <td style={{ padding: "10px 8px", borderBottom: `1px solid ${C.line}`, color: member.active === false ? C.gray : C.green }}>{member.active === false ? "Inactive" : "Active"}</td>
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
          <button type="submit" disabled={busyId === "gps"} style={{ ...buttonStyle, justifySelf: "start" }}>
            {busyId === "gps" ? "Saving..." : "Save GPS settings"}
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

          <form onSubmit={handleMarkAttendance} style={{ ...cardStyle, display: "grid", gridTemplateColumns: isMobile ? "1fr" : "minmax(180px, 1fr) minmax(160px, 220px) auto", gap: 10, alignItems: "end", marginBottom: 14 }}>
            <label style={labelStyle}>
              Staff member
              <select required value={attendanceForm.staffId} onChange={(event) => setAttendanceForm((form) => ({ ...form, staffId: event.target.value }))} style={inputStyle}>
                <option value="">Select staff</option>
                {activeMembers.map((member) => <option key={member.id} value={member.id}>{member.name || member.id}</option>)}
              </select>
            </label>
            <label style={labelStyle}>
              Attendance date
              <input required type="date" value={attendanceForm.date} onChange={(event) => setAttendanceForm((form) => ({ ...form, date: event.target.value }))} style={inputStyle} />
            </label>
            <button type="submit" disabled={busyId === "attendance" || !activeMembers.length} style={buttonStyle}>
              {busyId === "attendance" ? "Saving..." : "Mark Present"}
            </button>
          </form>

          {(gpsAttendanceLoading || manualAttendanceLoading) && (
            <div style={{ color: C.gray, padding: 12 }}>Attendance data load ho raha hai...</div>
          )}
          <div style={{ overflowX: "auto", ...cardStyle, padding: 0 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 850, color: C.ink, fontSize: 12 }}>
              <thead>
                <tr style={{ background: C.cardAlt, textAlign: "left", color: C.gray }}>
                  {["Staff", "Present days", "Earned leaves", "Paid days", "Monthly salary", "Per day", "Gross salary", "Approved advances", "Final payable"].map((heading) => (
                    <th key={heading} style={{ padding: 11, borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap" }}>{heading}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {members.map((member) => {
                  const presentDays = presentDatesByStaff.get(member.id)?.size || 0;
                  const approvedAdvance = approvedAdvanceTotals.get(member.id) || 0;
                  const salaryValue = salaryInputs[member.id] ?? legacyPayroll[member.id]?.monthlySalary ?? member.monthlySalary ?? 0;
                  const monthlySalary = Number(salaryValue);
                  const safeSalary = Number.isFinite(monthlySalary) && monthlySalary >= 0 ? monthlySalary : 0;
                  const salary = calculateStaffSalary({
                    monthlySalary: safeSalary,
                    presentDays,
                    totalApprovedAdvance: approvedAdvance,
                  });
                  const salaryBusy = busyId === `salary-${member.id}`;
                  return (
                    <tr key={member.id} style={{ opacity: member.active === false ? 0.6 : 1 }}>
                      <td style={{ padding: 10, borderBottom: `1px solid ${C.line}`, fontWeight: 800, whiteSpace: "nowrap" }}>{member.name || member.id}</td>
                      <td style={{ padding: 10, borderBottom: `1px solid ${C.line}` }}>{presentDays}</td>
                      <td style={{ padding: 10, borderBottom: `1px solid ${C.line}` }}>{salary.earnedLeaves}</td>
                      <td style={{ padding: 10, borderBottom: `1px solid ${C.line}` }}>{salary.totalPaidDays}</td>
                      <td style={{ padding: 8, borderBottom: `1px solid ${C.line}`, minWidth: 150 }}>
                        <div style={{ display: "flex", gap: 6 }}>
                          <input type="number" min="0" step="0.01" aria-label={`Monthly salary for ${member.name || member.id}`} value={salaryValue} onChange={(event) => setSalaryInputs((current) => ({ ...current, [member.id]: event.target.value }))} style={{ ...inputStyle, minWidth: 100, padding: "7px 8px" }} />
                          <button type="button" disabled={salaryBusy} onClick={() => handleSaveSalary(member)} style={{ ...buttonStyle, padding: "7px 9px" }}>{salaryBusy ? "..." : "Save"}</button>
                        </div>
                      </td>
                      <td style={{ padding: 10, borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap" }}>{formatCurrency(salary.perDaySalary)}</td>
                      <td style={{ padding: 10, borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap" }}>{formatCurrency(salary.grossSalary)}</td>
                      <td style={{ padding: 10, borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap" }}>− {formatCurrency(approvedAdvance)}</td>
                      <td style={{ padding: 10, borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap", color: C.gold, fontWeight: 900 }}>{formatCurrency(salary.finalPayable)}</td>
                    </tr>
                  );
                })}
                {!members.length && (
                  <tr><td colSpan={9} style={{ padding: 18, color: C.gray, textAlign: "center" }}>No staff profiles found.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </section>
  );
}
