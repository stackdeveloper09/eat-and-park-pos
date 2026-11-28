const statusStyles = {
  table: {
    available: ["available", "Available"],
    occupied: ["occupied", "Occupied"],
    reserved: ["reserved", "Reserved"],
    cleaning: ["cleaning", "Cleaning"],
  },
  order: {
    new: ["pending", "New"],
    preparing: ["preparing", "Preparing"],
    pending: ["pending", "Pending"],
    ready: ["ready", "Ready"],
    completed: ["completed", "Completed"],
    cancelled: ["cancelled", "Cancelled"],
  },
};

const typeStyles = {
  "dine-in": ["dine-in", "Dine In"],
  "take-away": ["take-away", "Take Away"],
  delivery: ["delivery", "Delivery"],
  table: ["table", "Table"],
};

function normalize(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
}

function joinClasses(base, className) {
  return [base, className].filter(Boolean).join(" ");
}

export function Chip({ active = false, className = "", type = "button", ...props }) {
  return (
    <button
      {...props}
      type={type}
      className={joinClasses("ep-ds-chip", className)}
      aria-pressed={active}
    />
  );
}

export function StatusBadge({ status, kind = "order", className = "" }) {
  const key = normalize(status);
  const styles = statusStyles[kind] || statusStyles.order;
  const [tone, label] = styles[key] || ["neutral", String(status ?? "")];

  return (
    <span className={joinClasses(`ep-ds-status-badge ep-ds-status--${tone}`, className)}>
      {label}
    </span>
  );
}

export function TypeBadge({ type, className = "" }) {
  const [tone, label] = typeStyles[normalize(type)] || ["neutral", String(type ?? "")];

  return (
    <span className={joinClasses(`ep-ds-type-badge ep-ds-type--${tone}`, className)}>
      {label}
    </span>
  );
}

export function KpiCard({ label, value, trend, icon, className = "" }) {
  return (
    <article className={joinClasses("ep-ds-kpi-card", className)}>
      <span className="ep-ds-kpi-card__label">{label}</span>
      {icon != null && <span className="ep-ds-kpi-card__icon" aria-hidden="true">{icon}</span>}
      <p className="ep-ds-kpi-card__value">{value}</p>
      {trend != null && <span className="ep-ds-kpi-card__trend">{trend}</span>}
    </article>
  );
}

export function PrimaryButton({ className = "", type = "button", ...props }) {
  return <button {...props} type={type} className={joinClasses("ep-ds-primary-button", className)} />;
}

export function SecondaryButton({ className = "", type = "button", ...props }) {
  return <button {...props} type={type} className={joinClasses("ep-ds-secondary-button", className)} />;
}

export function IconButton({ className = "", type = "button", ...props }) {
  return <button {...props} type={type} className={joinClasses("ep-ds-icon-button", className)} />;
}
