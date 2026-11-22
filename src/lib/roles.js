export const ROLES = Object.freeze([
  Object.freeze({ value: "admin", label: "Admin" }),
  Object.freeze({ value: "owner", label: "Owner" }),
  Object.freeze({ value: "manager", label: "Manager" }),
  Object.freeze({ value: "chef", label: "Chef" }),
  Object.freeze({ value: "cashier", label: "Cashier" }),
  Object.freeze({ value: "waiter", label: "Waiter" }),
  Object.freeze({ value: "delivery", label: "Delivery" }),
  Object.freeze({ value: "staff", label: "Staff" }),
]);

export const ROLE_VALUES = Object.freeze(ROLES.map((role) => role.value));
export const ROLE_LABELS = Object.freeze(Object.fromEntries(
  ROLES.map((role) => [role.value, role.label]),
));
export const ADMIN_ROLES = Object.freeze(["admin", "owner", "manager"]);
export const STAFF_ROLES = Object.freeze([
  "admin",
  "owner",
  "manager",
  "chef",
  "cashier",
  "waiter",
  "delivery",
  "staff",
]);

export function normalizeRole(role) {
  const normalized = String(role || "").trim().toLowerCase();
  return ROLE_VALUES.includes(normalized) ? normalized : "staff";
}

export function roleLabel(role) {
  return ROLE_LABELS[normalizeRole(role)] || "Staff";
}
