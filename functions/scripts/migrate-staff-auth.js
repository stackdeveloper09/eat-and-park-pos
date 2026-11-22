const { randomBytes } = require("node:crypto");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const admin = require("firebase-admin");

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? "" : process.argv[index + 1] || "";
}

async function getUserByUid(uid) {
  try {
    return await admin.auth().getUser(uid);
  } catch (error) {
    if (error.code === "auth/user-not-found") return null;
    throw error;
  }
}

async function getUserByEmail(email) {
  try {
    return await admin.auth().getUserByEmail(email);
  } catch (error) {
    if (error.code === "auth/user-not-found") return null;
    throw error;
  }
}

async function migrateOneStaffRecord(entry, firestore) {
  const uid = typeof entry?.uid === "string" ? entry.uid.trim() : "";
  const email = typeof entry?.email === "string" ? entry.email.trim().toLowerCase() : "";
  if (!uid || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Each mapping needs a valid uid and email.");
  }

  const staffRef = firestore.collection("staff").doc(uid);
  const staffSnapshot = await staffRef.get();
  if (!staffSnapshot.exists) {
    throw new Error(`No staff/${uid} Firestore profile exists.`);
  }
  const staff = staffSnapshot.data();
  if (staff.active === false) {
    return { uid, email, status: "skipped-inactive" };
  }
  if (!["admin", "owner", "manager", "chef", "cashier", "waiter", "delivery", "staff"].includes(staff.role)) {
    throw new Error(`staff/${uid} has an unsupported role; fix the profile before migration.`);
  }
  if (staff.email && String(staff.email).toLowerCase() !== email) {
    throw new Error(`staff/${uid} already has a different email; review the mapping first.`);
  }

  let userRecord = await getUserByUid(uid);
  let createdUser = false;
  if (userRecord) {
    if (String(userRecord.email || "").toLowerCase() !== email) {
      throw new Error(`Firebase Auth UID ${uid} already belongs to a different email.`);
    }
    if (userRecord.disabled) {
      throw new Error(`Firebase Auth account ${uid} is disabled; review it before migration.`);
    }
  } else {
    const emailOwner = await getUserByEmail(email);
    if (emailOwner && emailOwner.uid !== uid) {
      throw new Error(`Email ${email} is already assigned to a different Firebase Auth UID.`);
    }
    userRecord = await admin.auth().createUser({
      uid,
      email,
      password: randomBytes(32).toString("base64url"),
      displayName: String(staff.name || "").trim() || undefined,
    });
    createdUser = true;
  }

  try {
    await staffRef.set({ email }, { merge: true });
  } catch (error) {
    if (createdUser) {
      try {
        await admin.auth().deleteUser(userRecord.uid);
      } catch (cleanupError) {
        console.error(`Failed to remove incomplete Firebase Auth account ${uid}:`, cleanupError);
      }
    }
    throw error;
  }

  const passwordResetLink = await admin.auth().generatePasswordResetLink(email);
  return { uid, email, passwordResetLink, status: createdUser ? "created" : "already-existed" };
}

async function main() {
  const inputPath = readOption("--input");
  const outputPath = readOption("--output");
  if (!inputPath || !outputPath) {
    throw new Error(
      "Usage: node scripts/migrate-staff-auth.js --input staff-auth-migration.json --output staff-auth-reset-links.json",
    );
  }
  if (existsSync(outputPath)) {
    throw new Error(`Refusing to overwrite existing output file: ${outputPath}`);
  }

  const mappings = JSON.parse(readFileSync(inputPath, "utf8"));
  if (!Array.isArray(mappings) || mappings.length === 0) {
    throw new Error("Input must be a non-empty JSON array of { uid, email } mappings.");
  }
  const uids = mappings.map((entry) => String(entry?.uid || "").trim());
  const emails = mappings.map((entry) => String(entry?.email || "").trim().toLowerCase());
  if (new Set(uids).size !== uids.length || new Set(emails).size !== emails.length) {
    throw new Error("Input contains duplicate UID or email mappings.");
  }

  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT;
  const appOptions = { credential: admin.credential.applicationDefault() };
  if (projectId) appOptions.projectId = projectId;
  admin.initializeApp(appOptions);
  const firestore = admin.firestore();
  const migrated = [];
  const failures = [];

  for (const entry of mappings) {
    try {
      migrated.push(await migrateOneStaffRecord(entry, firestore));
    } catch (error) {
      const uid = String(entry?.uid || "").trim();
      failures.push({ uid, error: error.message });
      console.error(`Staff Auth migration failed for ${uid || "(missing uid)"}: ${error.message}`);
    }
  }

  const resolvedOutputPath = path.resolve(outputPath);
  writeFileSync(resolvedOutputPath, JSON.stringify({ migrated, failures }, null, 2), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  console.log(`Migration results written to ${resolvedOutputPath}. Keep reset links private.`);

  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
