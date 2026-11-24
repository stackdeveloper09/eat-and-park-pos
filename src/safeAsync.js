export function firestoreErrorMessage(error) {
  const code = error?.code || "";
  if (code === "permission-denied" || code === "insufficient-permissions") {
    return "Permission issue hai. Account/Firestore access check karke dobara try karein.";
  }
  if (code === "unavailable" || code === "deadline-exceeded") {
    return "Internet ya server slow hai. Dobara try karein.";
  }
  if (code === "unauthenticated") {
    return "Login session expire ho gaya. Dobara login karein.";
  }
  return "Network issue hai. Dobara try karein.";
}

export async function safeAsync(fn, { fallback = null, onError = null } = {}) {
  try {
    return await fn();
  } catch (error) {
    console.error("[safeAsync]", error);
    const message = firestoreErrorMessage(error);
    if (typeof onError === "function") onError(message, error);
    return fallback;
  }
}

export function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function safeArray(value) {
  return Array.isArray(value) ? value : [];
}
