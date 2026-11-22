import React, { useState, useEffect, useRef, useMemo } from "react";
import { db, auth } from "./firebase";
import { isDeliveryOrder } from "./lib/orderRules";
import { signInWithEmailAndPassword, signOut, onAuthStateChanged, setPersistence, browserLocalPersistence } from "firebase/auth";
import { collection, query, onSnapshot, doc, updateDoc, getDoc, limit } from "firebase/firestore";

const timeAgo = (ts) => {
  if (!ts) return "";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
};

const toMillis = (value) => {
  if (typeof value === "number") return value;
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value && typeof value.seconds === "number") return value.seconds * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

let alertAudio = null;
try {
  alertAudio = new Audio("https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3");
  alertAudio.volume = 1.0;
} catch (e) {
  alertAudio = null;
}

const playAlert = () => {
  try {
    if (!alertAudio) return;
    alertAudio.currentTime = 0;
    alertAudio.play().catch(() => {});
    if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 500]);
  } catch (e) {
    /* ignore */
  }
};

const statusLabel = (o) => {
  if (o.status === "out_for_delivery") return "ON THE WAY";
  if (o.status === "ready") return "READY TO PICK";
  if (o.status === "preparing") return "COOKING";
  if (o.status === "served") return "DELIVERED";
  return "NEW ORDER";
};

const inputStyle = {
  width: "100%",
  padding: 14,
  marginBottom: 10,
  borderRadius: 10,
  border: "1px solid #273449",
  background: "#0B111A",
  color: "#fff",
  boxSizing: "border-box",
};

const navStyle = (active, color) => ({
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: 14,
  background: active ? "#273449" : "transparent",
  border: "none",
  borderRadius: 10,
  color: color || (active ? "#F59E0B" : "#fff"),
  fontWeight: 700,
  fontSize: 14,
  cursor: "pointer",
  textAlign: "left",
});

export default function DeliveryApp() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");

  const [activeOrders, setActiveOrders] = useState([]);
  const [servedOrders, setServedOrders] = useState([]);

  const [page, setPage] = useState("orders"); // orders | dashboard | history
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [busyId, setBusyId] = useState("");

  const prevOrdersRef = useRef([]);
  const prevStatusMapRef = useRef({});
  const isFirstLoad = useRef(true);

  // Trigger re-render every minute to update "timeAgo"
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 60000);
    return () => clearInterval(interval);
  }, []);

  const myId = user ? user.uid : "";

  // Unlock audio on first user interaction
  useEffect(() => {
    const cleanup = () => {
      document.removeEventListener("click", unlock);
      document.removeEventListener("touchstart", unlock);
    };
    const unlock = () => {
      if (alertAudio) {
        alertAudio.play().then(() => {
          alertAudio.pause();
          alertAudio.currentTime = 0;
          cleanup();
        }).catch(() => {});
      } else {
        cleanup();
      }
    };
    document.addEventListener("click", unlock);
    document.addEventListener("touchstart", unlock);
    return () => cleanup();
  }, []);

  // Auth check
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        setUser(null);
        setLoading(false);
        setPage("orders");
        setMenuOpen(false);
        setSelectedOrder(null);
        return;
      }
      try {
        const s = await getDoc(doc(db, "staff", u.uid));
        const data = s.exists() ? s.data() : null;
        if (data && data.role === "delivery" && data.active !== false) {
          setUser(u);
          setLoginError("");
        } else {
          await signOut(auth);
          setLoginError("Ye account delivery boy ka nahi hai.");
        }
      } catch (e) {
        console.error("Delivery staff verify failed:", e);
        await signOut(auth).catch(() => {});
        setLoginError("Account verify nahi hua: " + (e.code || e.message));
      } finally {
        setLoading(false);
      }
    });
    return () => unsub();
  }, []);

  // Fetch orders
  useEffect(() => {
    if (!user) {
      setActiveOrders([]);
      setServedOrders([]);
      setSelectedOrder(null);
      prevOrdersRef.current = [];
      prevStatusMapRef.current = {};
      isFirstLoad.current = true;
      return undefined;
    }
    prevOrdersRef.current = [];
    prevStatusMapRef.current = {};
    isFirstLoad.current = true;

    // Limit 300 to keep the app fast. Filter in JS so we don't miss variations like "Parcel", "parcel", etc.
    const q = query(collection(db, "orders"), limit(300));
    
    const unsub = onSnapshot(q, (snap) => {
      const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      
      // Loose filter for orderType to ensure all parcel/delivery orders are caught
      const validOrders = all.filter((o) => {
        const type = String(o.orderType || "").toLowerCase();
        const isParcel = type.includes("parcel") || type.includes("delivery") || type.includes("home");
        return o.status !== "cancelled" && isParcel;
      });

      const active = validOrders
        .filter((o) => o.status !== "served")
        .sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));

      if (!isFirstLoad.current) {
        let hasNew = false;
        let becameReady = false;
        
        active.forEach((o) => {
          if (!prevOrdersRef.current.includes(o.id)) hasNew = true;
          if (o.status === "ready" && prevStatusMapRef.current[o.id] !== "ready") becameReady = true;
        });

        if (hasNew || becameReady) playAlert();
      }

      const newStatusMap = {};
      active.forEach((o) => { newStatusMap[o.id] = o.status; });
      
      prevStatusMapRef.current = newStatusMap;
      prevOrdersRef.current = active.map((o) => o.id);
      isFirstLoad.current = false;
      setActiveOrders(active);

      const served = validOrders
        .filter((o) => o.status === "served")
        .sort((a, b) => toMillis(b.deliveredAt || b.createdAt) - toMillis(a.deliveredAt || a.createdAt));
      
      setServedOrders(served);
    }, (err) => {
      console.error("Delivery orders listener:", err.code, err.message);
      alert("Orders load nahi ho rahe: " + (err.code || err.message));
    });
    return () => unsub();
  }, [user]);

  // Keep open modal in sync with live order data
  useEffect(() => {
    if (!selectedOrder) return;
    const fresh = [...activeOrders, ...servedOrders].find((o) => o.id === selectedOrder.id);
    if (fresh) {
      setSelectedOrder(fresh);
    } else {
      setSelectedOrder(null); // Close modal if order gets deleted
    }
  }, [activeOrders, servedOrders, selectedOrder?.id]);

  const historyOrders = useMemo(() => servedOrders.slice(0, 50), [servedOrders]);

  // Dashboard stats: sirf is delivery boy ki aaj ki deliveries
  const stats = useMemo(() => {
    const startOfDay = new Date().setHours(0, 0, 0, 0);
    const mine = servedOrders.filter((o) => o.deliveredBy === myId && toMillis(o.deliveredAt) >= startOfDay);
    const total = mine.reduce((s, o) => s + (Number(o.finalTotal) || 0), 0);
    return { count: mine.length, total };
  }, [servedOrders, myId]);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginError("");
    try {
      await setPersistence(auth, browserLocalPersistence);
      await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch (err) {
      const msg =
        err.code === "auth/network-request-failed" ? "Internet check karo" :
        err.code === "auth/too-many-requests" ? "Bahut try ho gaye, thodi der baad" :
        err.code === "auth/invalid-email" ? "Email format galat hai" :
        "Email ya password galat hai.";
      setLoginError(msg);
    }
  };

  const markOutForDelivery = async (orderId) => {
    if (busyId) return;
    if (!window.confirm("Kya aapne restaurant se order pick up kar liya hai?")) return;
    setBusyId(orderId);
    try {
      await updateDoc(doc(db, "orders", orderId), { status: "out_for_delivery" });
    } catch (e) {
      alert("Error: " + (e.code || e.message));
    } finally {
      setBusyId("");
    }
  };

  const markDelivered = async (orderId) => {
    if (busyId) return;
    if (!window.confirm("Kya aapne order deliver kar diya aur paisa collect kar liya?")) return;
    setBusyId(orderId);
    try {
      await updateDoc(doc(db, "orders", orderId), {
        status: "served",
        paid: true,
        paymentStatus: "paid",
        deliveredAt: Date.now(),
        deliveredBy: myId,
      });
      setSelectedOrder(null);
      alert("Order delivered successfully! 🎉");
    } catch (e) {
      alert("Error: " + (e.code || e.message));
    } finally {
      setBusyId("");
    }
  };

  if (loading) {
    return <div style={{ padding: 50, textAlign: "center", color: "#fff", background: "#0B111A", minHeight: "100vh" }}>Loading...</div>;
  }

  if (!user) {
    return (
      <div style={{ minHeight: "100vh", background: "#0B111A", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
        <div style={{ background: "#161F2F", padding: 30, borderRadius: 20, width: "100%", maxWidth: 400, border: "1px solid #273449" }}>
          <div style={{ textAlign: "center", marginBottom: 20 }}>
            <div style={{ fontSize: 50 }}>🛵</div>
            <h2 style={{ color: "#fff", margin: "10px 0" }}>Delivery Partner</h2>
          </div>
          <form onSubmit={handleLogin}>
            <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} style={inputStyle} required />
            <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} style={inputStyle} required />
            {loginError && <div style={{ color: "#EF4444", fontSize: 13, marginBottom: 10 }}>{loginError}</div>}
            <button type="submit" style={{ width: "100%", padding: 14, borderRadius: 10, background: "#F59E0B", color: "#fff", border: "none", fontWeight: 800, fontSize: 16, cursor: "pointer" }}>Login</button>
          </form>
        </div>
      </div>
    );
  }

  const ordersToShow = page === "history" ? historyOrders : activeOrders;
  const userName = (user.email || "delivery").split("@")[0];

  return (
    <div style={{ minHeight: "100vh", background: "#0B111A", color: "#fff", paddingBottom: 20 }}>

      {/* HEADER */}
      <div style={{ background: "#F59E0B", padding: "15px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", position: "sticky", top: 0, zIndex: 10, boxShadow: "0 4px 12px rgba(0,0,0,0.2)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 15 }}>
          <button onClick={() => setMenuOpen(true)} style={{ background: "transparent", border: "none", color: "#fff", fontSize: 24, cursor: "pointer", padding: 0 }}>☰</button>
          <div style={{ fontWeight: 900, fontSize: 18 }}>Delivery Panel</div>
        </div>
        <div style={{ fontSize: 12, background: "rgba(0,0,0,0.15)", padding: "6px 12px", borderRadius: 8, fontWeight: 700 }}>{userName}</div>
      </div>

      {/* SIDEBAR */}
      {menuOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 100, display: "flex" }} onClick={() => setMenuOpen(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: 260, background: "#161F2F", height: "100%", display: "flex", flexDirection: "column", padding: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 30, paddingBottom: 20, borderBottom: "1px solid #273449" }}>
              <div style={{ width: 45, height: 45, background: "#F59E0B", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, color: "#fff" }}>🛵</div>
              <div>
                <div style={{ fontWeight: 800, fontSize: 15 }}>{userName}</div>
                <div style={{ fontSize: 11, color: "#8B9BB4" }}>Delivery Partner</div>
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button onClick={() => { setPage("orders"); setMenuOpen(false); }} style={navStyle(page === "orders")}>
                <span style={{ fontSize: 18 }}>📦</span> Active Orders ({activeOrders.length})
              </button>
              <button onClick={() => { setPage("history"); setMenuOpen(false); }} style={navStyle(page === "history")}>
                <span style={{ fontSize: 18 }}>🕘</span> Order History
              </button>
              <button onClick={() => { setPage("dashboard"); setMenuOpen(false); }} style={navStyle(page === "dashboard")}>
                <span style={{ fontSize: 18 }}>📊</span> Dashboard
              </button>

              <div style={{ borderTop: "1px solid #273449", margin: "10px 0" }} />

              <button onClick={() => signOut(auth)} style={navStyle(false, "#EF4444")}>
                <span style={{ fontSize: 18 }}>🚪</span> Logout
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MAIN CONTENT */}
      <div style={{ padding: 15, maxWidth: 600, margin: "0 auto" }}>

        {page === "dashboard" && (
          <div>
            <h2 style={{ fontSize: 20, marginBottom: 20 }}>Today's Stats</h2>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 15 }}>
              <div style={{ background: "#161F2F", padding: 20, borderRadius: 16, border: "1px solid #273449" }}>
                <div style={{ fontSize: 28, marginBottom: 5 }}>✅</div>
                <div style={{ fontSize: 12, color: "#8B9BB4", fontWeight: 700 }}>Deliveries Done</div>
                <div style={{ fontSize: 28, fontWeight: 900, color: "#10B981" }}>{stats.count}</div>
              </div>
              <div style={{ background: "#161F2F", padding: 20, borderRadius: 16, border: "1px solid #273449" }}>
                <div style={{ fontSize: 28, marginBottom: 5 }}>💵</div>
                <div style={{ fontSize: 12, color: "#8B9BB4", fontWeight: 700 }}>Order Value</div>
                <div style={{ fontSize: 24, fontWeight: 900, color: "#F59E0B", marginTop: 4 }}>₹{stats.total}</div>
              </div>
            </div>
          </div>
        )}

        {page !== "dashboard" && (
          <>
            <h2 style={{ fontSize: 18, marginBottom: 15, color: "#fff" }}>
              {page === "orders" ? "Active Orders" : "Recent Deliveries"}
            </h2>

            {ordersToShow.length === 0 && (
              <div style={{ textAlign: "center", padding: 50, color: "#8B9BB4" }}>
                <div style={{ fontSize: 40, marginBottom: 10 }}>😴</div>
                <div>{page === "orders" ? "Koi naya order nahi hai." : "Abhi tak kuch deliver nahi kiya."}</div>
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {ordersToShow.map((o) => (
                <div key={o.id} onClick={() => setSelectedOrder(o)} style={{ background: "#161F2F", border: "1px solid #273449", padding: 14, borderRadius: 14, cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      <span style={{ fontWeight: 900, color: "#F59E0B", fontSize: 15 }}>#{o.id.slice(1, 5).toUpperCase()}</span>
                      <span style={{ fontSize: 10, color: "#8B9BB4", background: "#273449", padding: "2px 6px", borderRadius: 4 }}>{statusLabel(o)}</span>
                      <span style={{ fontSize: 10, color: "#8B9BB4" }}>
                        {page === "history" ? timeAgo(toMillis(o.deliveredAt || o.createdAt)) : timeAgo(toMillis(o.createdAt))}
                      </span>
                    </div>
                    <div style={{ fontWeight: 700, fontSize: 15, color: "#fff", marginBottom: 4 }}>{o.customer?.name}</div>
                    <div style={{ fontSize: 12, color: "#8B9BB4", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 220 }}>
                      📍 {o.customer?.exactAddress || o.customer?.address}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", marginLeft: 10 }}>
                    {/* FIXED: ₹0 fallback */}
                    <div style={{ fontWeight: 900, fontSize: 18, color: o.paid ? "#10B981" : "#F59E0B" }}>₹{Number(o.finalTotal || 0)}</div>
                    <div style={{ fontSize: 9, color: o.paid ? "#10B981" : "#F59E0B", marginTop: 2, fontWeight: 700, background: o.paid ? "rgba(16,185,129,0.15)" : "rgba(245,158,11,0.15)", padding: "2px 6px", borderRadius: 4 }}>
                      {/* FIXED: PAID / UNPAID */}
                      {o.paid ? "PAID" : "UNPAID"}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* ORDER DETAILS MODAL */}
      {selectedOrder && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 100, display: "flex", alignItems: "flex-end" }}>
          <div style={{ background: "#161F2F", width: "100%", maxWidth: 600, margin: "0 auto", borderRadius: "24px 24px 0 0", padding: 20, maxHeight: "92vh", overflowY: "auto" }}>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 15 }}>
              <div style={{ fontSize: 20, fontWeight: 900 }}>Order #{selectedOrder.id.slice(1, 5).toUpperCase()}</div>
              <button onClick={() => setSelectedOrder(null)} style={{ background: "#273449", border: "none", color: "#fff", width: 32, height: 32, borderRadius: 16, fontSize: 16, cursor: "pointer" }}>✕</button>
            </div>

            {/* CUSTOMER */}
            <div style={{ background: "#0B111A", padding: 15, borderRadius: 12, marginBottom: 15 }}>
              <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 5 }}>{selectedOrder.customer?.name}</div>
              <div style={{ color: "#8B9BB4", marginBottom: 10, fontWeight: 700 }}>📞 {selectedOrder.customer?.phone}</div>
              <div style={{ color: "#fff", marginBottom: 15, lineHeight: 1.4, fontSize: 14 }}>
                📍 {selectedOrder.customer?.exactAddress || selectedOrder.customer?.address}
                {selectedOrder.customer?.pincode ? " (PIN: " + selectedOrder.customer.pincode + ")" : ""}
              </div>

              <div style={{ display: "flex", gap: 10 }}>
                {selectedOrder.customer?.address?.includes("Lat:") && (
                  <button onClick={() => {
                    const match = selectedOrder.customer.address.match(/Lat: ([\d.-]+), Lng: ([\d.-]+)/);
                    if (match) window.open("https://www.google.com/maps/search/?api=1&query=" + match[1] + "," + match[2], "_blank");
                  }} style={{ flex: 1, padding: 12, background: "#3B82F6", color: "#fff", border: "none", borderRadius: 8, fontWeight: 800, fontSize: 14, cursor: "pointer" }}>
                    🗺️ Open Maps
                  </button>
                )}
                <a href={"tel:" + (selectedOrder.customer?.phone || "")} style={{ flex: 1, padding: 12, background: "#10B981", color: "#fff", borderRadius: 8, fontWeight: 800, fontSize: 14, textAlign: "center", textDecoration: "none" }}>
                  📞 Call Customer
                </a>
              </div>
            </div>

            {/* ITEMS */}
            <div style={{ background: "#0B111A", padding: 15, borderRadius: 12, marginBottom: 20 }}>
              <div style={{ fontWeight: 800, marginBottom: 10, color: "#8B9BB4", fontSize: 12 }}>ORDER ITEMS</div>
              {selectedOrder.items?.map((it, idx) => (
                <div key={idx} style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, fontSize: 14 }}>
                  <span>{it.qty}x {it.name}</span>
                  <span style={{ fontWeight: 700 }}>₹{(it.price || 0) * (it.qty || 1)}</span>
                </div>
              ))}
              <div style={{ borderTop: "1px dashed #273449", margin: "10px 0", paddingTop: 10, display: "flex", justifyContent: "space-between", fontWeight: 900, fontSize: 18 }}>
                <span>Total</span>
                <span style={{ color: selectedOrder.paid ? "#10B981" : "#F59E0B" }}>₹{Number(selectedOrder.finalTotal || 0)}</span>
              </div>
            </div>

            {/* ACTIONS */}
            {selectedOrder.status !== "served" ? (
              <>
                {selectedOrder.status === "ready" && (
                  <button disabled={Boolean(busyId)} onClick={() => markOutForDelivery(selectedOrder.id)} style={{ width: "100%", padding: 16, background: "#F59E0B", color: "#fff", border: "none", borderRadius: 12, fontWeight: 900, fontSize: 16, cursor: "pointer", marginBottom: 10, opacity: busyId ? 0.6 : 1 }}>
                    {busyId === selectedOrder.id ? "Please wait..." : "🛵 Mark Out for Delivery"}
                  </button>
                )}

                {selectedOrder.status === "out_for_delivery" && (
                  <button disabled={Boolean(busyId)} onClick={() => markDelivered(selectedOrder.id)} style={{ width: "100%", padding: 16, background: "#10B981", color: "#fff", border: "none", borderRadius: 12, fontWeight: 900, fontSize: 16, cursor: "pointer", opacity: busyId ? 0.6 : 1 }}>
                    {busyId === selectedOrder.id ? "Please wait..." : "✅ Delivered & Collected ₹" + Number(selectedOrder.finalTotal || 0)}
                  </button>
                )}

                {(selectedOrder.status === "new" || selectedOrder.status === "preparing") && (
                  <div style={{ textAlign: "center", padding: 16, background: "rgba(245, 158, 11, 0.1)", border: "1px dashed #F59E0B", color: "#F59E0B", borderRadius: 12, fontWeight: 800, fontSize: 14 }}>
                    👨‍🍳 Kitchen me khana ban raha hai... Ready hone ka wait karein.
                  </div>
                )}
              </>
            ) : (
              <div style={{ textAlign: "center", padding: 15, background: "#0A2A20", color: "#10B981", borderRadius: 12, fontWeight: 800 }}>
                ✅ Ye order successfully deliver ho chuka hai
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}