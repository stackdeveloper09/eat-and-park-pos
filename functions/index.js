const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();

exports.setStaffRole = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Login required");
  }

  const requester = await admin.firestore().collection("staff").doc(context.auth.uid).get();
  const requesterRole = requester.exists ? requester.data().role : null;
  if (
    !requester.exists ||
    requester.data().active === false ||
    !["admin", "owner", "manager"].includes(requesterRole)
  ) {
    throw new functions.https.HttpsError("permission-denied", "Sirf active admin hi role assign kar sakta hai");
  }

  const { uid, role } = data || {};
  if (!uid || !["admin", "owner", "manager", "staff", "waiter", "delivery"].includes(role)) {
    throw new functions.https.HttpsError("invalid-argument", "uid ya role invalid hai");
  }

  await admin.auth().setCustomUserClaims(uid, { role });
  await admin.firestore().collection("staff").doc(uid).set(
    { role, updatedAt: Date.now() },
    { merge: true }
  );

  return { ok: true, uid, role };
});

exports.createStaffAccount = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Login required");
  }

  const requester = await admin.firestore().collection("staff").doc(context.auth.uid).get();
  const requesterRole = requester.exists ? requester.data().role : null;
  if (
    !requester.exists ||
    requester.data().active === false ||
    !["admin", "owner", "manager"].includes(requesterRole)
  ) {
    throw new functions.https.HttpsError("permission-denied", "Only an active admin can create staff accounts.");
  }

  const { email, password, name, role, monthlySalary, active, shiftId } = data || {};
  const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  const normalizedName = typeof name === "string" ? name.trim() : "";
  const validRoles = ["admin", "owner", "manager", "chef", "cashier", "waiter", "delivery", "staff"];
  const privilegedRoles = ["admin", "owner", "manager"];

  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) ||
    normalizedEmail.length > 254 ||
    normalizedName.length < 1 ||
    normalizedName.length > 80 ||
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 128 ||
    !validRoles.includes(role) ||
    (requesterRole === "manager" && privilegedRoles.includes(role)) ||
    typeof monthlySalary !== "number" ||
    !Number.isFinite(monthlySalary) ||
    monthlySalary < 0 ||
    monthlySalary > 100000000 ||
    typeof active !== "boolean" ||
    typeof shiftId !== "string" ||
    shiftId.length > 80
  ) {
    throw new functions.https.HttpsError("invalid-argument", "Staff account details are invalid.");
  }

  let userRecord;
  try {
    userRecord = await admin.auth().createUser({
      email: normalizedEmail,
      password,
      displayName: normalizedName,
    });
  } catch (error) {
    if (error.code === "auth/email-already-exists") {
      throw new functions.https.HttpsError("already-exists", "A Firebase Auth account already uses this email.");
    }
    if (error.code === "auth/invalid-password") {
      throw new functions.https.HttpsError("invalid-argument", "Temporary password must be at least 12 characters.");
    }
    console.error("Firebase Auth staff account creation failed:", error);
    throw new functions.https.HttpsError("internal", "Firebase Auth account could not be created.");
  }

  try {
    await admin.firestore().collection("staff").doc(userRecord.uid).create({
      email: normalizedEmail,
      name: normalizedName,
      role,
      monthlySalary,
      active,
      shiftId,
    });
  } catch (error) {
    try {
      await admin.auth().deleteUser(userRecord.uid);
    } catch (cleanupError) {
      console.error("Failed to roll back Firebase Auth staff account:", cleanupError);
    }
    console.error("Staff profile creation failed:", error);
    throw new functions.https.HttpsError("internal", "Staff profile could not be created.");
  }

  return { uid: userRecord.uid };
});

exports.health = functions.https.onRequest((req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});
