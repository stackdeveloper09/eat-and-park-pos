import React, { useEffect, useState } from "react";
import {
  browserLocalPersistence,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import { addDoc, collection, doc, getDoc, getDocs, onSnapshot, query, where } from "firebase/firestore";
import { auth, db } from "./firebase";
import {
  ATTENDANCE_RADIUS_METERS,
  haversineDistanceMeters,
  RESTAURANT_LOCATION,
} from "./lib/staffPayroll";
import "./AttendanceApp.css";

const STAFF_ROLES = new Set(["admin", "owner", "manager", "staff", "waiter", "cashier", "chef", "delivery"]);

function attendanceDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

export default function AttendanceApp() {
  const [user, setUser] = useState(null);
  const [staff, setStaff] = useState(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [attendanceError, setAttendanceError] = useState("");
  const [notice, setNotice] = useState("");
  const [todayAttendance, setTodayAttendance] = useState(null);
  const [checkingLocation, setCheckingLocation] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const today = attendanceDate(now);
  const displayName = staff?.name || user?.email?.split("@")[0] || "Staff";

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
          setTodayAttendance(null);
          setLoading(false);
        }
        return;
      }

      if (active) setLoading(true);
      try {
        const staffSnapshot = await getDoc(doc(db, "staff", currentUser.uid));
        const profile = staffSnapshot.exists() ? staffSnapshot.data() : null;
        const role = String(profile?.role || "").toLowerCase();
        if (!profile || profile.active === false || !STAFF_ROLES.has(role)) {
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
          setTodayAttendance(null);
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

  useEffect(() => {
    if (!user?.uid) {
      return undefined;
    }
    return onSnapshot(query(collection(db, "staffAttendance"), where("uid", "==", user.uid)), (snapshot) => {
      const record = snapshot.docs
        .map((attendanceDoc) => attendanceDoc.data())
        .find((entry) => entry.action === "present" && entry.date === today);
      setTodayAttendance(record || null);
      setAttendanceError("");
    }, (error) => {
      console.error("Attendance status load failed:", error);
      setAttendanceError(`Attendance status load nahi hui: ${getErrorMessage(error)}`);
    });
  }, [user?.uid, today]);

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
    if (!user?.uid || checkingLocation || todayAttendance) return;
    setCheckingLocation(true);
    setAttendanceError("");
    setNotice("");
    try {
      const position = await new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
          reject(new Error("Is browser mein GPS location available nahi hai."));
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
        RESTAURANT_LOCATION.latitude,
        RESTAURANT_LOCATION.longitude,
      );
      if (distance > ATTENDANCE_RADIUS_METERS) {
        window.alert("आप रेस्टोरेंट से दूर हैं, हाजिरी नहीं लग सकती।");
        return;
      }

      const currentDate = attendanceDate(new Date());
      const attendanceSnapshot = await getDocs(query(collection(db, "staffAttendance"), where("uid", "==", user.uid)));
      const alreadyMarked = attendanceSnapshot.docs.some((attendanceDoc) => {
        const record = attendanceDoc.data();
        return record.action === "present" && record.date === currentDate;
      });
      if (alreadyMarked) {
        setTodayAttendance({ action: "present", date: currentDate });
        setNotice("Aaj ki attendance pehle hi mark ho chuki hai.");
        return;
      }

      const record = {
        uid: user.uid,
        name: displayName,
        role: staff?.role || "staff",
        action: "present",
        at: Date.now(),
        date: currentDate,
        distanceMeters: Math.round(distance * 100) / 100,
      };
      await addDoc(collection(db, "staffAttendance"), record);
      setTodayAttendance(record);
      setNotice("Aaj ki attendance successfully mark ho gayi.");
    } catch (error) {
      console.error("GPS attendance failed:", error);
      if (error?.code === 1) setAttendanceError("Attendance mark karne ke liye location permission allow karein.");
      else if (error?.code === 2) setAttendanceError("Aapki current location nahi mil saki. GPS check karke phir try karein.");
      else if (error?.code === 3) setAttendanceError("GPS location lene mein time out hua. Phir try karein.");
      else setAttendanceError(`Attendance mark nahi hui: ${getErrorMessage(error)}`);
    } finally {
      setCheckingLocation(false);
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

  if (loading) {
    return (
      <main className="attendance-app">
        <div className="attendance-loading"><span className="attendance-spinner" />Loading attendance...</div>
      </main>
    );
  }

  if (!user || !staff) {
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
            {todayAttendance ? "Attendance marked" : "Not checked in yet"}
          </div>
          <div className="attendance-divider" />
          <div className="attendance-location-row">
            <div className="attendance-location-icon">⌖</div>
            <div>
              <strong>Restaurant location</strong>
              <span>Check-in allowed within {ATTENDANCE_RADIUS_METERS} meters</span>
            </div>
            <span className="attendance-location-check">GPS</span>
          </div>

          <button
            type="button"
            className="attendance-primary-button attendance-checkin-button"
            onClick={markAttendance}
            disabled={checkingLocation || Boolean(todayAttendance)}
          >
            {checkingLocation
              ? <><span className="attendance-spinner" />Checking your location...</>
              : todayAttendance ? <>Checked in for today <span>✓</span></> : <>Mark today&apos;s attendance <span>→</span></>}
          </button>
          <div className="attendance-gps-note">📍 Location permission on rakhein; attendance ke liye GPS verify hoga.</div>
          {notice && <div className="attendance-success" role="status">{notice}</div>}
          {attendanceError && <div className="attendance-error" role="alert">{attendanceError}</div>}
        </section>

        <footer className="attendance-footer">
          <span>{staff.role || "Staff"}</span>
          <span>Eat & Park · Staff portal</span>
        </footer>
      </section>
    </main>
  );
}
