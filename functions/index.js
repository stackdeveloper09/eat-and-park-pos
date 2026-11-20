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

exports.health = functions.https.onRequest((req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});
