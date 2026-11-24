const RELOAD_FLAG = "ep_fs_recover_ts";
const RELOAD_COOLDOWN_MS = 60_000;
const FS_ERROR_PATTERN = /INTERNAL ASSERTION FAILED|isCorePipeline|getTargetData/i;

function isFirestoreCrash(err) {
  if (!err) return false;
  const reasonMsg = err.reason && typeof err.reason === "object" && err.reason.message;
  const msg = String(err.message || reasonMsg || err.reason || err);
  return FS_ERROR_PATTERN.test(msg);
}

async function wipeFirestoreIndexedDB() {
  if (typeof indexedDB === "undefined") return;
  try {
    const dbs = indexedDB.databases ? await indexedDB.databases() : [];
    await Promise.all(
      dbs.filter((d) => d.name && d.name.toLowerCase().includes("firestore"))
        .map((d) => new Promise((res) => {
          const r = indexedDB.deleteDatabase(d.name);
          r.onsuccess = r.onerror = r.onblocked = () => res();
        }))
    );
  } catch (e) { console.warn("[recover] IDB wipe failed:", e); }
}

export async function tryRecover(err) {
  if (!isFirestoreCrash(err)) return false;
  try {
    const last = Number(sessionStorage.getItem(RELOAD_FLAG) || 0);
    if (Date.now() - last < RELOAD_COOLDOWN_MS) return false;
    sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
  } catch (_) {}
  console.warn("[recover] Firestore crash → wipe cache + reload");
  await wipeFirestoreIndexedDB();
  window.location.reload();
  return true;
}

function showRuntimeBanner(message) {
  try {
    let banner = document.getElementById("ep-runtime-banner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "ep-runtime-banner";
      banner.setAttribute("role", "status");
      Object.assign(banner.style, {
        position: "fixed", left: "12px", right: "12px", bottom: "12px", zIndex: "100000",
        maxWidth: "420px", margin: "0 auto", padding: "10px 12px", borderRadius: "10px",
        background: "#451A1A", color: "#FCA5A5", fontSize: "12px", fontWeight: "800",
        boxSizing: "border-box", textAlign: "center", boxShadow: "0 8px 24px rgba(0,0,0,.25)",
      });
      document.body.appendChild(banner);
    }
    banner.textContent = message;
    window.clearTimeout(window.__epRuntimeBannerTimer);
    window.__epRuntimeBannerTimer = window.setTimeout(() => banner?.remove(), 7000);
  } catch (_) {}
}

if (typeof window !== "undefined") {
  window.addEventListener("error", (e) => {
    tryRecover(e.error || e.message);
    showRuntimeBanner("Kuch galat hua. Page ab bhi chalega; dobara try karein.");
  });
  window.addEventListener("unhandledrejection", (e) => {
    tryRecover(e.reason);
    showRuntimeBanner("Network ya app action fail hua. Dobara try karein.");
  });
}
