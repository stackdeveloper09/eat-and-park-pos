const functions = require("firebase-functions");
const admin = require("firebase-admin");
const crypto = require("node:crypto");
const nodemailer = require("nodemailer");
const { defineSecret } = require("firebase-functions/params");
const { onSchedule } = require("firebase-functions/v2/scheduler");

admin.initializeApp();

const smtpHost = defineSecret("SMTP_HOST");
const smtpPort = defineSecret("SMTP_PORT");
const smtpUser = defineSecret("SMTP_USER");
const smtpPassword = defineSecret("SMTP_PASSWORD");
const smtpFrom = defineSecret("SMTP_FROM");
const welcomeEmailSecrets = [smtpHost, smtpPort, smtpUser, smtpPassword, smtpFrom];

function toHttpsError(error, code = "internal") {
  if (error instanceof functions.https.HttpsError) return error;
  const message = error && typeof error.message === "string" && error.message.trim()
    ? error.message
    : "An unexpected error occurred.";
  return new functions.https.HttpsError(code, message);
}

async function requireAdminOrOwner(uid) {
  const requester = await admin.firestore().collection("staff").doc(uid).get();
  const role = requester.exists ? String(requester.data().role || "").toLowerCase() : "";
  if (!requester.exists || requester.data().active === false || !["admin", "owner"].includes(role)) {
    throw new functions.https.HttpsError("permission-denied", "Only an active admin or owner can manage staff accounts.");
  }
}

async function sendWelcomeEmail({ email, name, temporaryPassword, requiresPasswordChange }) {
  const port = Number(smtpPort.value());
  const transporter = nodemailer.createTransport({
    host: smtpHost.value(),
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: {
      user: smtpUser.value(),
      pass: smtpPassword.value(),
    },
  });
  const message = [
    `Namaste ${name},`,
    "",
    "Aapka Eat & Park staff account ready hai.",
    `Login ID: ${email}`,
    ...(temporaryPassword ? [`Temporary password: ${temporaryPassword}`] : []),
    "Login link: https://eatndpark.vercel.app/staff",
    temporaryPassword || requiresPasswordChange
      ? "Pehli baar login karne par apna naya password set karna hoga"
      : "Apne existing password se login karein. Password email mein include nahi kiya gaya hai.",
    "",
    "- Team Eat & Park",
  ].join("\n");
  await transporter.sendMail({
    from: smtpFrom.value(),
    to: email,
    subject: "Eat & Park me aapka swagat hai",
    text: message,
  });
}

function getTodayIST(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function attendanceCloseUpdates(record, checkOutAt) {
  return {
    checkOutAt,
    autoCheckout: true,
    incomplete: admin.firestore.FieldValue.delete(),
    checkOutMissed: admin.firestore.FieldValue.delete(),
    ...(String(record.status || "").toLowerCase() === "checkout_missed"
      ? { status: "Present" }
      : {}),
  };
}

exports.autoCloseStaffAttendance = onSchedule({
  schedule: "0 22 * * *",
  timeZone: "Asia/Kolkata",
  region: "asia-south1",
}, async () => {
  const today = getTodayIST();
  const attendanceSnapshot = await admin.firestore()
    .collection("attendance")
    .where("date", "==", today)
    .get();
  const openRecords = attendanceSnapshot.docs.filter((entry) => {
    const record = entry.data();
    return record.checkInAt && !record.checkOutAt;
  });
  const checkOutAt = admin.firestore.Timestamp.fromMillis(
    Date.UTC(...today.split("-").map(Number).map((part, index) => index === 1 ? part - 1 : part), 16, 30),
  );

  for (let offset = 0; offset < openRecords.length; offset += 400) {
    const batch = admin.firestore().batch();
    openRecords.slice(offset, offset + 400).forEach((entry) => {
      batch.update(entry.ref, attendanceCloseUpdates(entry.data(), checkOutAt));
    });
    await batch.commit();
  }

  console.info("Auto-closed staff attendance", { date: today, count: openRecords.length });
});

exports.setStaffRole = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Login required");
  }

  const requester = await admin.firestore().collection("staff").doc(context.auth.uid).get();
  const requesterRole = requester.exists ? String(requester.data().role || "").toLowerCase() : null;
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

exports.createStaffAccount = functions.runWith({
  secrets: welcomeEmailSecrets,
}).https.onCall(async (data, context) => {
  let userRecord;
  try {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Login required");
    }

    await requireAdminOrOwner(context.auth.uid);

    const { email, name, phone, role, monthlySalary, active, shiftId } = data || {};
    const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
    const normalizedName = typeof name === "string" ? name.trim() : "";
    const normalizedPhone = typeof phone === "string" ? phone.trim() : "";
    const validRoles = ["admin", "owner", "manager", "chef", "cashier", "waiter", "delivery", "staff"];

    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) ||
      normalizedEmail.length > 254 ||
      normalizedName.length < 1 ||
      normalizedName.length > 80 ||
      !/^\+[1-9]\d{9,14}$/.test(normalizedPhone) ||
      !validRoles.includes(role) ||
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

    const temporaryPassword = crypto.randomBytes(10).toString("base64url").slice(0, 10);
    userRecord = await admin.auth().createUser({
      email: normalizedEmail,
      password: temporaryPassword,
      displayName: normalizedName,
    });

    try {
      await admin.firestore().collection("staff").doc(userRecord.uid).create({
        email: normalizedEmail,
        name: normalizedName,
        phone: normalizedPhone,
        role,
        monthlySalary,
        active,
        shiftId,
        mustChangePassword: true,
      });
    } catch (error) {
      try {
        await admin.auth().deleteUser(userRecord.uid);
      } catch (cleanupError) {
        console.error("Failed to roll back Firebase Auth staff account:", cleanupError?.code || "cleanup-failed");
      }
      throw error;
    }

    let emailSent = true;
    try {
      await sendWelcomeEmail({
        email: normalizedEmail,
        name: normalizedName,
        temporaryPassword,
        requiresPasswordChange: true,
      });
    } catch (error) {
      emailSent = false;
      console.error("Welcome email send failed:", error?.code || "smtp-error");
    }

    return {
      uid: userRecord.uid,
      email: normalizedEmail,
      name: normalizedName,
      phone: normalizedPhone,
      temporaryPassword,
      emailSent,
    };
  } catch (error) {
    if (error?.code === "auth/email-already-exists") {
      throw toHttpsError(error, "already-exists");
    }
    if (error?.code === "auth/weak-password" || error?.code === "auth/invalid-password") {
      throw toHttpsError(error, "invalid-argument");
    }
    throw toHttpsError(error);
  }
});

exports.completeStaffPasswordChange = functions.https.onCall(async (data, context) => {
  try {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Login required.");
    }

    const newPassword = data && data.newPassword;
    if (typeof newPassword !== "string" || newPassword.length < 8 || newPassword.length > 128) {
      throw new functions.https.HttpsError("invalid-argument", "Password must be between 8 and 128 characters.");
    }

    const staffRef = admin.firestore().collection("staff").doc(context.auth.uid);
    const staffSnapshot = await staffRef.get();
    const profile = staffSnapshot.exists ? staffSnapshot.data() : null;
    if (!profile || profile.active === false) {
      throw new functions.https.HttpsError("permission-denied", "Active staff account required.");
    }
    if (profile.mustChangePassword !== true) {
      throw new functions.https.HttpsError("failed-precondition", "Password setup is not required for this account.");
    }

    await admin.auth().updateUser(context.auth.uid, { password: newPassword });
    await staffRef.update({ mustChangePassword: false, passwordChangedAt: Date.now() });
    return { ok: true };
  } catch (error) {
    if (error?.code === "auth/weak-password") {
      throw toHttpsError(error, "invalid-argument");
    }
    throw toHttpsError(error);
  }
});

exports.recordStaffAttendance = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Login required");
  }

  const { action } = data || {};
  if (!["login", "logout"].includes(action)) {
    throw new functions.https.HttpsError("invalid-argument", "Attendance action is invalid.");
  }

  try {
    const uid = context.auth.uid;
    const staffSnapshot = await admin.firestore().collection("staff").doc(uid).get();
    const profile = staffSnapshot.exists ? staffSnapshot.data() : null;
    const role = String(profile?.role || "").toLowerCase();
    const allowedRoles = ["admin", "owner", "manager", "chef", "cashier", "waiter", "delivery", "staff"];
    if (!profile || profile.active === false || !allowedRoles.includes(role)) {
      throw new functions.https.HttpsError("permission-denied", "Active staff account required.");
    }

    const now = Date.now();
    const dateParts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(now)).map(({ type, value }) => [type, value]));
    const date = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
    const attendanceRef = admin.firestore().collection("staffAttendance").doc(`${uid}_${date}`);

    await admin.firestore().runTransaction(async (transaction) => {
      const attendanceSnapshot = await transaction.get(attendanceRef);
      if (action === "login") {
        if (attendanceSnapshot.exists()) {
          transaction.update(attendanceRef, { lastSeen: now });
          return;
        }
        transaction.set(attendanceRef, {
          uid,
          name: String(profile.name || "Staff"),
          role,
          action: "login",
          at: now,
          date,
          firstLoginAt: now,
          lastSeen: now,
        });
        return;
      }

      if (attendanceSnapshot.exists()) {
        transaction.update(attendanceRef, { lastLogoutAt: now });
      } else {
        transaction.set(attendanceRef, {
          uid,
          name: String(profile.name || "Staff"),
          role,
          action: "logout",
          at: now,
          date,
          lastLogoutAt: now,
        });
      }
    });

    return { ok: true, date };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error("Staff attendance record failed:", error);
    throw new functions.https.HttpsError("internal", "Attendance record could not be saved.");
  }
});

exports.health = functions.https.onRequest((req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});
