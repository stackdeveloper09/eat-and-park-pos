import React, { useState, useEffect, useRef } from "react";
import { db } from "./firebase";
import { collection, onSnapshot, addDoc, doc } from "firebase/firestore";

const C = {
  bg: "#fff", card: "#fff", cardAlt: "#F4F4F5", line: "#EEEEEE",
  ink: "#1F1F1F", gray: "#6B6B6B", gold: "#C2410C", green: "#15803D"
};

export default function CustomerMenu() {
  const [menu, setMenu] = useState([]);
  const [cart, setCart] = useState({});
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [customerName, setCustomerName] = useState("");
  const [activeCat, setActiveCat] = useState("All");
  const [ordered, setOrdered] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [loading, setLoading] = useState(true);
  const placingRef = useRef(false);

  useEffect(() => {
    const unsub = onSnapshot(doc(db, "settings", "menu"), (snap) => {
      if (snap.exists()) {
        const data = snap.data() || {};
        setMenu(Array.isArray(data.list) ? data.list : Array.isArray(data.items) ? data.items : []);
      } else {
        setMenu([]);
      }
      setLoading(false);
    }, (error) => {
      console.error("Customer menu listener:", error);
      setMenu([]);
      setLoading(false);
    });
    return () => unsub();
  }, []);

  const addToCart = (item) => {
    setCart(prev => ({ ...prev, [item.id]: { ...item, qty: (prev[item.id]?.qty || 0) + 1 } }));
  };
  const removeFromCart = (item) => {
    setCart(prev => {
      const newCart = { ...prev };
      if (newCart[item.id]?.qty > 1) newCart[item.id].qty -= 1;
      else delete newCart[item.id];
      return newCart;
    });
  };

  const total = Object.values(cart).reduce((s, i) => s + (Number(i?.price) || 0) * (Number(i?.qty) || 0), 0);
  const totalItems = Object.values(cart).reduce((s, i) => s + (Number(i?.qty) || 0), 0);

  const placeOrder = async () => {
    if (placing || placingRef.current) return;
    if (!customerName.trim()) return alert("Kripya apna naam daalein");
    if (Object.keys(cart).length === 0) return alert("Aapne kuch order nahi kiya");

    placingRef.current = true;
    setPlacing(true);
    try {
      const orderItems = Object.values(cart).map(i => ({
        itemId: i.id, name: i.name, price: Number(i.price), qty: i.qty,
      }));

      await addDoc(collection(db, "orders"), {
        customerName,
        table: 0,
        orderType: "parcel",
        status: "new", paid: false, items: orderItems,
        subtotal: total, finalTotal: total, createdAt: Date.now(),
        createdBy: "customer_qr", paymentStatus: "pending"
      });
      setOrdered(true);
    } catch (e) {
      const message = e?.code === "permission-denied"
        ? "Permission issue hai. Staff se contact karein."
        : e?.code === "unavailable"
          ? "Internet issue hai. Dobara try karein."
          : "Order fail hua. Dobara try karein.";
      alert(message);
    } finally {
      placingRef.current = false;
      setPlacing(false);
    }
  };

  if (loading) return <div className="ep-customer-menu" style={{ padding: 50, textAlign: "center", color: C.ink, background: C.bg, minHeight: "100dvh", colorScheme: "light", fontFamily: "Poppins, system-ui, sans-serif" }}>Loading...</div>;

  if (ordered) return (
    <div className="ep-customer-menu" style={{ padding: "24px 20px", textAlign: "center", color: C.ink, background: C.bg, minHeight: "100dvh", boxSizing: "border-box", colorScheme: "light", fontFamily: "Poppins, system-ui, sans-serif" }}>
      <style>{"@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap');"}</style>
      <div style={{ width: 72, height: 72, margin: "0 auto 14px", borderRadius: "50%", background: C.green, display: "grid", placeItems: "center" }}>
        <svg aria-hidden="true" viewBox="0 0 24 24" width="40" height="40" fill="none"><path d="m5 12.5 4.5 4.5L19 7" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </div>
      <h1 style={{ margin: 0, color: C.green, fontSize: 18, fontWeight: 600 }}>Order Placed!</h1>
      <div style={{ marginTop: 10, color: C.ink, fontSize: 32, fontWeight: 700 }}>₹{total}</div>
      <p style={{ margin: "8px 0 20px", color: C.gray, fontSize: 12 }}>Your takeaway order is on its way to the counter.</p>
      <div style={{ background: "#FFF3EA", borderRadius: 16, padding: 18, marginBottom: 20, textAlign: "left" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", fontSize: 13 }}><span style={{ color: C.gray }}>Type</span><strong style={{ color: C.ink }}>Takeaway</strong></div>
        {customerName.trim() && <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", fontSize: 13 }}><span style={{ color: C.gray }}>Customer</span><strong style={{ color: C.ink }}>{customerName}</strong></div>}
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", fontSize: 13 }}><span style={{ color: C.gray }}>Total</span><strong style={{ color: C.ink }}>₹{total}</strong></div>
      </div>
      <button type="button" onClick={() => { setOrdered(false); setCheckoutOpen(false); }} style={{ width: "100%", height: 56, minHeight: 56, border: 0, borderRadius: 14, background: C.gold, color: "#fff", fontSize: 16, fontWeight: 600, cursor: "pointer" }}>Back to Menu</button>
    </div>
  );

  const categories = ["All", ...Array.from(new Set(menu.map(m => m.category || m.cat || "Main")))];
  const filteredMenu = menu.filter(m => activeCat === "All" || (m.category || m.cat || "Main") === activeCat);

  return (
    <div className="ep-customer-menu" style={{ background: C.bg, minHeight: "100dvh", color: C.ink, paddingBottom: totalItems ? 110 : 28, fontFamily: "Poppins, system-ui, sans-serif", colorScheme: "light" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap');
        .ep-customer-menu { color-scheme: light; }
        .ep-customer-menu input, .ep-customer-menu button { font-family: Poppins, system-ui, sans-serif; }
        .ep-customer-menu input { color-scheme: light; }
        .ep-customer-menu input::placeholder { color: #6B6B6B; opacity: 1; }
        .ep-customer-menu button { min-height: 44px; }
        .ep-customer-menu input:focus { outline: 2px solid #C2410C; outline-offset: 0; border-color: #C2410C; }
        .ep-customer-menu-scroll { color-scheme: light; scrollbar-width: thin; }
      `}</style>

      <header style={{ position: "sticky", top: 0, zIndex: 10, background: "#fff", padding: "16px", borderBottom: "1px solid #EEEEEE" }}>
        <h1 style={{ margin: 0, color: C.ink, fontSize: 18, fontWeight: 600, textAlign: "center" }}>Eat & Park · Takeaway</h1>
      </header>

      <nav aria-label="Menu categories" className="ep-customer-menu-scroll" style={{ display: "flex", gap: 10, padding: "14px 16px", overflowX: "auto" }}>
        {categories.map((category, index) => {
          const pastel = ["#E8F5E9", "#FFF3EA", "#EAF2FF", "#FFF6D6"][index % 4];
          const selected = activeCat === category;
          return (
            <button type="button" key={category} onClick={() => setActiveCat(category)} aria-pressed={selected} style={{ minWidth: 88, minHeight: 56, padding: "8px 14px", borderRadius: 16, border: `1px solid ${selected ? C.gold : C.line}`, background: selected ? "#FFF3EA" : pastel, color: selected ? C.gold : C.ink, fontWeight: 600, fontSize: 13, whiteSpace: "nowrap", cursor: "pointer" }}>{category}</button>
          );
        })}
      </nav>

      <main style={{ padding: "0 16px 24px", display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 12 }}>
        {filteredMenu.length === 0 ? (
          <div style={{ padding: 28, textAlign: "center", background: "#fff", border: "1px solid #EEEEEE", borderRadius: 16, color: C.gray }}>No menu items available.</div>
        ) : filteredMenu.map((item) => (
          <article key={item.id} style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0, padding: 12, background: "#fff", border: "1px solid #EEEEEE", borderRadius: 16, color: C.ink }}>
            <div style={{ position: "relative", width: 96, height: 96, flex: "0 0 96px", display: "grid", placeItems: "center", borderRadius: 14, overflow: "hidden", background: "#F4F4F5", fontSize: 30 }}>
              {item.image ? <img src={item.image} alt={item.name || "Menu item"} loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={(e) => { e.currentTarget.style.display = "none"; }} /> : <span>🍽️</span>}
              {item.veg !== undefined && <span aria-label={item.veg ? "Vegetarian" : "Non-vegetarian"} style={{ position: "absolute", top: 7, left: 7, width: 12, height: 12, borderRadius: "50%", border: `2px solid ${item.veg ? "#15803D" : "#B91C1C"}`, background: item.veg ? "#15803D" : "#B91C1C", boxShadow: "0 0 0 2px #fff" }} />}
            </div>
            <div style={{ flex: 1, minWidth: 0, minHeight: 96, display: "flex", flexDirection: "column", justifyContent: "center" }}>
              <div style={{ display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, overflow: "hidden", color: C.ink, fontSize: 14, fontWeight: 600, lineHeight: 1.35 }}>{item.name}</div>
              {item.description && <div style={{ display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, overflow: "hidden", marginTop: 4, color: C.gray, fontSize: 12, lineHeight: 1.4 }}>{item.description}</div>}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: "auto", paddingTop: 6 }}>
                <span style={{ color: C.gold, fontSize: 14, fontWeight: 600 }}>₹{item.price}</span>
                {cart[item.id] ? (
                  <div role="group" aria-label={`${item.name} quantity`} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <button type="button" aria-label={`Remove ${item.name}`} onClick={() => removeFromCart(item)} style={{ width: 44, height: 44, minHeight: 44, borderRadius: "50%", border: "1.5px solid #C2410C", background: "#fff", color: C.gold, fontSize: 20, cursor: "pointer" }}>−</button>
                    <span style={{ width: 20, textAlign: "center", color: C.ink, fontWeight: 600 }}>{cart[item.id].qty}</span>
                    <button type="button" aria-label={`Add ${item.name}`} onClick={() => addToCart(item)} style={{ width: 44, height: 44, minHeight: 44, borderRadius: "50%", border: "1.5px solid #C2410C", background: "#fff", color: C.gold, fontSize: 20, cursor: "pointer" }}>+</button>
                  </div>
                ) : (
                  <button type="button" aria-label={`Add ${item.name}`} onClick={() => addToCart(item)} style={{ width: 44, height: 44, minHeight: 44, flex: "0 0 44px", borderRadius: "50%", border: "1.5px solid #C2410C", background: "#fff", color: C.gold, fontSize: 22, cursor: "pointer" }}>+</button>
                )}
              </div>
            </div>
          </article>
        ))}
      </main>

      {totalItems > 0 && (
        <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 20, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "12px 16px calc(12px + env(safe-area-inset-bottom))", borderTop: "1px solid #EEEEEE", background: "#fff", colorScheme: "light" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ color: C.gray, fontSize: 12, fontWeight: 500 }}>{totalItems} items</div>
            <div style={{ color: C.ink, fontSize: 18, fontWeight: 600 }}>Total: ₹{total}</div>
          </div>
          <button type="button" onClick={() => setCheckoutOpen(true)} style={{ height: 56, minHeight: 56, flex: "0 0 auto", padding: "0 18px", border: 0, borderRadius: 14, background: C.gold, color: "#fff", fontSize: 15, fontWeight: 600, whiteSpace: "nowrap", cursor: "pointer" }}>View Cart</button>
        </div>
      )}

      {checkoutOpen && (
        <div role="presentation" onClick={() => setCheckoutOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "flex-end", justifyContent: "center", background: "rgba(0,0,0,0.4)", colorScheme: "light" }}>
          <section role="dialog" aria-modal="true" aria-label="My Order" onClick={(e) => e.stopPropagation()} style={{ display: "flex", flexDirection: "column", width: "100%", maxWidth: 480, height: "min(85dvh, 760px)", maxHeight: "85dvh", minHeight: 0, overflow: "hidden", borderRadius: "20px 20px 0 0", background: "#fff", color: C.ink, boxSizing: "border-box", fontFamily: "Poppins, system-ui, sans-serif", colorScheme: "light" }}>
            <header style={{ flexShrink: 0, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: "1px solid #EEEEEE", background: "#fff" }}>
              <div>
                <div style={{ color: C.ink, fontSize: 18, fontWeight: 600 }}>My Order</div>
                <div style={{ marginTop: 2, color: C.gray, fontSize: 12 }}>Takeaway</div>
              </div>
              <button type="button" onClick={() => setCheckoutOpen(false)} aria-label="Close cart" style={{ width: 44, height: 44, minHeight: 44, border: 0, borderRadius: "50%", background: "#F4F4F5", color: C.ink, fontSize: 18, cursor: "pointer" }}>×</button>
            </header>
            <div className="ep-customer-menu-scroll" style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: 16 }}>
              <label style={{ display: "block", marginBottom: 12, color: C.ink, fontSize: 13, fontWeight: 600 }}>
                Your name
                <input placeholder="Aapka Naam (Zaroori hai)" value={customerName} onChange={(e) => setCustomerName(e.target.value)} style={{ display: "block", width: "100%", height: 48, marginTop: 6, padding: "0 14px", border: "1px solid #EEEEEE", borderRadius: 14, background: "#F4F4F5", color: C.ink, fontSize: 16, boxSizing: "border-box" }} />
              </label>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {Object.values(cart).map((item) => (
                  <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: 12, border: "1px solid #EEEEEE", borderRadius: 16, background: "#fff" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: C.ink, fontSize: 14, fontWeight: 600 }}>{item.name}</div>
                      <div style={{ marginTop: 4, color: C.gold, fontSize: 13, fontWeight: 600 }}>₹{item.price}</div>
                    </div>
                    <button type="button" aria-label={`Remove ${item.name}`} onClick={() => removeFromCart(item)} style={{ width: 44, height: 44, minHeight: 44, border: "1.5px solid #C2410C", borderRadius: "50%", background: "#fff", color: C.gold, fontSize: 20 }}>−</button>
                    <span style={{ width: 20, textAlign: "center", color: C.ink, fontWeight: 600 }}>{item.qty}</span>
                    <button type="button" aria-label={`Add ${item.name}`} onClick={() => addToCart(item)} style={{ width: 44, height: 44, minHeight: 44, border: "1.5px solid #C2410C", borderRadius: "50%", background: "#fff", color: C.gold, fontSize: 20 }}>+</button>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16, paddingTop: 12, borderTop: "1px dashed #D4D4D8", color: C.ink, fontSize: 14, fontWeight: 600 }}><span>Total</span><span style={{ color: C.gold }}>₹{total}</span></div>
            </div>
            <footer style={{ flexShrink: 0, padding: "12px 16px calc(12px + env(safe-area-inset-bottom))", borderTop: "1px solid #EEEEEE", background: "#fff" }}>
              <button type="button" onClick={placeOrder} disabled={placing} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%", height: 56, minHeight: 56, border: 0, borderRadius: 14, background: C.gold, color: "#fff", fontSize: 16, fontWeight: 600, cursor: placing ? "wait" : "pointer", opacity: placing ? 0.65 : 1 }}>{placing ? "Placing Order..." : `Place Order · ₹${total}`}</button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}
