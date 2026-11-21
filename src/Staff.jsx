import React, { useEffect, useMemo, useState } from "react";
import { auth, db } from "./firebase";
import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  query,
  setDoc,
  where,
} from "firebase/firestore";
import { calculateStaffSalary } from "./lib/staffPayroll";

const currentMonthKey = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
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

function getErrorMessage(error) {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

export default function Staff({ C, isMobile }) {
  const [month, setMonth] = useState(currentMonthKey);
  const [members, setMembers] = useState([]);
  const [payroll, setPayroll] = useState({});
  const [advances, setAdvances] = useState([]);
  const [attendance, setAttendance] = useState([]);
  const [salaryInputs, setSalaryInputs] = useState({});
  const [advanceInputs, setAdvanceInputs] = useState({});
  const [busyUid, setBusyUid] = useState("");
  const [loading, setLoading] = useState(true);
  const [attendanceLoading, setAttendanceLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const fail = (err) => {
      console.error("Staff payroll data load failed:", err);
      setError(getErrorMessage(err));
      setLoading(false);
    };
    const unsubscribers = [
      onSnapshot(collection(db, "staff"), (snapshot) => {
        setMembers(snapshot.docs.map((staffDoc) => ({ id: staffDoc.id, ...staffDoc.data() }))
          .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""))));
        setLoading(false);
      }, fail),
      onSnapshot(collection(db, "staffPayroll"), (snapshot) => {
        setPayroll(Object.fromEntries(snapshot.docs.map((payrollDoc) => [payrollDoc.id, payrollDoc.data()])));
      }, fail),
      onSnapshot(collection(db, "staffAdvances"), (snapshot) => {
        setAdvances(snapshot.docs.map((advanceDoc) => ({ id: advanceDoc.id, ...advanceDoc.data() })));
      }, fail),
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, []);

  useEffect(() => {
    const endMonth = nextMonthKey(month);
    const attendanceQuery = query(
      collection(db, "staffAttendance"),
      where("date", ">=", `${month}-01`),
      where("date", "<", `${endMonth}-01`),
    );
    return onSnapshot(attendanceQuery, (snapshot) => {
      setAttendance(snapshot.docs.map((attendanceDoc) => attendanceDoc.data()));
      setAttendanceLoading(false);
    }, (err) => {
      console.error("Monthly attendance load failed:", err);
      setError(getErrorMessage(err));
      setAttendanceLoading(false);
    });
  }, [month]);

  const presentDaysByUid = useMemo(() => {
    const daysByUid = new Map();
    attendance.forEach((record) => {
      if (record.action !== "present" || !record.uid || !record.date?.startsWith(`${month}-`)) return;
      if (!daysByUid.has(record.uid)) daysByUid.set(record.uid, new Set());
      daysByUid.get(record.uid).add(record.date);
    });
    return daysByUid;
  }, [attendance, month]);

  const approvedAdvancesByUid = useMemo(() => {
    const totalByUid = new Map();
    advances.forEach((advance) => {
      if (advance.status !== "approved" || advance.month !== month || !Number.isFinite(advance.amount)) return;
      totalByUid.set(advance.uid, (totalByUid.get(advance.uid) || 0) + advance.amount);
    });
    return totalByUid;
  }, [advances, month]);

  const saveSalary = async (member) => {
    const salaryValue = salaryInputs[member.id] ?? payroll[member.id]?.monthlySalary ?? member.monthlySalary ?? "";
    const monthlySalary = Number(salaryValue);
    if (salaryValue === "" || !Number.isFinite(monthlySalary) || monthlySalary < 0) {
      setError("Monthly salary must be a valid non-negative amount.");
      return;
    }
    if (!auth.currentUser?.uid) {
      setError("Admin session expired. Sign in again to save salary.");
      return;
    }
    setBusyUid(member.id);
    setError("");
    try {
      await setDoc(doc(db, "staffPayroll", member.id), {
        uid: member.id,
        monthlySalary,
        updatedAt: Date.now(),
        updatedBy: auth.currentUser.uid,
      }, { merge: true });
    } catch (err) {
      console.error("Staff salary save failed:", err);
      setError(getErrorMessage(err));
    } finally {
      setBusyUid("");
    }
  };

  const addApprovedAdvance = async (member) => {
    const amount = Number(advanceInputs[member.id] || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("Advance amount must be greater than zero.");
      return;
    }
    if (!auth.currentUser?.uid) {
      setError("Admin session expired. Sign in again to record an advance.");
      return;
    }
    setBusyUid(member.id);
    setError("");
    try {
      await addDoc(collection(db, "staffAdvances"), {
        uid: member.id,
        amount,
        month,
        status: "approved",
        createdAt: Date.now(),
        approvedBy: auth.currentUser.uid,
      });
      setAdvanceInputs((current) => ({ ...current, [member.id]: "" }));
    } catch (err) {
      console.error("Staff advance save failed:", err);
      setError(getErrorMessage(err));
    } finally {
      setBusyUid("");
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

  return (
    <section style={{ marginTop: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
        <div>
          <h2 style={{ margin: 0, color: C.ink, fontSize: isMobile ? 18 : 22 }}>Staff Payroll</h2>
          <div style={{ marginTop: 4, color: C.gray, fontSize: 12 }}>Paid leaves and approved advances are included in payable salary.</div>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, color: C.gray, fontSize: 12, fontWeight: 700 }}>
          Salary month
          <input
            type="month"
            value={month}
            onChange={(event) => {
              if (/^\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value)) {
                setAttendanceLoading(true);
                setMonth(event.target.value);
              }
            }}
            style={{ ...inputStyle, width: 170 }}
          />
        </label>
      </div>

      {error && <div role="alert" style={{ marginBottom: 12, padding: 12, color: "#FCA5A5", background: "#451A1A", borderRadius: 10, fontSize: 13 }}>{error}</div>}
      {(loading || attendanceLoading) && <div style={{ color: C.gray, padding: 16 }}>Staff payroll load ho raha hai...</div>}
      {!loading && members.length === 0 && <div style={{ color: C.gray, padding: 16 }}>Koi staff profile nahi mila.</div>}

      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fit, minmax(320px, 1fr))", gap: 12 }}>
        {members.map((member) => {
          const presentDays = presentDaysByUid.get(member.id)?.size || 0;
          const totalApprovedAdvance = approvedAdvancesByUid.get(member.id) || 0;
          const monthlySalary = Number(payroll[member.id]?.monthlySalary ?? member.monthlySalary ?? 0);
          const salary = calculateStaffSalary({ monthlySalary, presentDays, totalApprovedAdvance });
          const salaryInput = salaryInputs[member.id] ?? payroll[member.id]?.monthlySalary ?? member.monthlySalary ?? "";
          const isBusy = busyUid === member.id;
          return (
            <article key={member.id} style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start", marginBottom: 12 }}>
                <div>
                  <div style={{ color: C.ink, fontWeight: 800, fontSize: 15 }}>{member.name || member.email || member.id}</div>
                  <div style={{ color: C.gray, fontSize: 11, marginTop: 3 }}>{member.role || "staff"}{member.active === false ? " · Inactive" : ""}</div>
                </div>
                <div style={{ textAlign: "right", color: C.gray, fontSize: 11 }}>
                  Present <b style={{ color: C.ink }}>{presentDays}</b>
                  <br />Paid leave <b style={{ color: C.ink }}>{salary.earnedLeaves}</b>
                </div>
              </div>

              <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  aria-label={`Monthly salary for ${member.name || member.id}`}
                  placeholder="Monthly salary"
                  value={salaryInput}
                  onChange={(event) => setSalaryInputs((current) => ({ ...current, [member.id]: event.target.value }))}
                  style={inputStyle}
                />
                <button type="button" disabled={isBusy} onClick={() => saveSalary(member)} style={{ flexShrink: 0, border: 0, borderRadius: 9, padding: "0 14px", background: C.gold, color: "#0B111A", fontWeight: 800, cursor: isBusy ? "wait" : "pointer" }}>
                  Save
                </button>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "7px 12px", color: C.gray, fontSize: 12, borderTop: `1px solid ${C.line}`, paddingTop: 12 }}>
                <span>Per day (monthly ÷ 30)</span><b style={{ color: C.ink }}>{formatCurrency(salary.perDaySalary)}</b>
                <span>Total paid days ({presentDays} + {salary.earnedLeaves})</span><b style={{ color: C.ink }}>{salary.totalPaidDays}</b>
                <span>Gross salary</span><b style={{ color: C.ink }}>{formatCurrency(salary.grossSalary)}</b>
                <span>Approved advances</span><b style={{ color: C.ink }}>− {formatCurrency(totalApprovedAdvance)}</b>
                <strong style={{ color: C.ink, fontSize: 13 }}>Final payable</strong><strong style={{ color: C.gold, fontSize: 15 }}>{formatCurrency(salary.finalPayable)}</strong>
              </div>

              <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  aria-label={`Approved advance for ${member.name || member.id}`}
                  placeholder={`Add approved advance for ${month}`}
                  value={advanceInputs[member.id] || ""}
                  onChange={(event) => setAdvanceInputs((current) => ({ ...current, [member.id]: event.target.value }))}
                  style={inputStyle}
                />
                <button type="button" disabled={isBusy} onClick={() => addApprovedAdvance(member)} style={{ flexShrink: 0, border: `1px solid ${C.line}`, borderRadius: 9, padding: "0 12px", background: C.cardAlt, color: C.ink, fontWeight: 800, cursor: isBusy ? "wait" : "pointer" }}>
                  Add advance
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
