import React, { useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase";

export default function StaffPasswordChange({ onComplete }) {
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");
    if (newPassword.length < 8) {
      setError("Naya password kam se kam 8 characters ka hona chahiye.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Dono password match nahi kar rahe.");
      return;
    }

    setSaving(true);
    try {
      await httpsCallable(functions, "completeStaffPasswordChange")({ newPassword });
      setNewPassword("");
      setConfirmPassword("");
      onComplete();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Password save nahi hua. Dobara try karein.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <main style={{
      minHeight: "100vh",
      display: "grid",
      placeItems: "center",
      padding: 20,
      boxSizing: "border-box",
      background: "#0B111A",
      color: "#F5F7FB",
      fontFamily: "system-ui, sans-serif",
    }}>
      <section style={{
        width: "100%",
        maxWidth: 430,
        padding: 28,
        boxSizing: "border-box",
        border: "1px solid #273449",
        borderRadius: 18,
        background: "#161F2F",
      }}>
        <div style={{ color: "#F59E0B", fontSize: 12, fontWeight: 800, letterSpacing: 1 }}>EAT & PARK</div>
        <h1 style={{ margin: "10px 0 6px", fontSize: 25 }}>Naya password set karo</h1>
        <p style={{ margin: "0 0 22px", color: "#AAB4C5", fontSize: 14, lineHeight: 1.5 }}>
          Pehli baar login ke liye apna naya password set karna zaroori hai.
        </p>
        <form onSubmit={handleSubmit}>
          <label style={{ display: "block", marginBottom: 14, fontSize: 13, fontWeight: 700 }}>
            Naya password
            <input
              type="password"
              autoComplete="new-password"
              minLength={8}
              maxLength={128}
              required
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              style={{
                display: "block",
                width: "100%",
                boxSizing: "border-box",
                marginTop: 7,
                padding: 13,
                border: "1px solid #273449",
                borderRadius: 9,
                background: "#0B111A",
                color: "#fff",
                font: "inherit",
              }}
            />
          </label>
          <label style={{ display: "block", marginBottom: 18, fontSize: 13, fontWeight: 700 }}>
            Naya password dobara likhein
            <input
              type="password"
              autoComplete="new-password"
              minLength={8}
              maxLength={128}
              required
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              style={{
                display: "block",
                width: "100%",
                boxSizing: "border-box",
                marginTop: 7,
                padding: 13,
                border: "1px solid #273449",
                borderRadius: 9,
                background: "#0B111A",
                color: "#fff",
                font: "inherit",
              }}
            />
          </label>
          {error && <div role="alert" style={{ marginBottom: 14, color: "#FCA5A5", fontSize: 13 }}>{error}</div>}
          <button
            type="submit"
            disabled={saving}
            style={{
              width: "100%",
              minHeight: 46,
              border: 0,
              borderRadius: 10,
              background: "#F59E0B",
              color: "#fff",
              font: "inherit",
              fontWeight: 800,
              cursor: saving ? "wait" : "pointer",
            }}
          >
            {saving ? "Saving..." : "Password save karo"}
          </button>
        </form>
      </section>
    </main>
  );
}
