import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { assertFails, assertSucceeds, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, setDoc, updateDoc } from "firebase/firestore";

let env;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-eatpark",
    firestore: { rules: readFileSync("firestore.rules", "utf8") },
  });
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "staff/delivery"), { role: "delivery" });
    await setDoc(doc(db, "orders/parcelNew"), {
      orderType: "parcel",
      status: "new",
      paid: false,
    });
    await setDoc(doc(db, "orders/parcelOut"), {
      orderType: "parcel",
      status: "out_for_delivery",
      paid: false,
    });
  });
});

afterAll(async () => {
  await env.cleanup();
});

describe("delivery order transitions", () => {
  test("delivery staff cannot mark an order served before dispatch", async () => {
    const db = env.authenticatedContext("delivery").firestore();
    await assertFails(updateDoc(doc(db, "orders/parcelNew"), { status: "served", paid: true }));
  });

  test("delivery staff can mark a dispatched order served", async () => {
    const db = env.authenticatedContext("delivery").firestore();
    await assertSucceeds(updateDoc(doc(db, "orders/parcelOut"), { status: "served", paid: true }));
  });
});
