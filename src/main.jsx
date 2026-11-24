import "./recover";
import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './theme.css'
import App from './App.jsx'
import ErrorBoundary from './ErrorBoundary.jsx'

const StaffApp = lazy(() => import('./StaffApp.jsx'))
const AttendanceApp = lazy(() => import('./AttendanceApp.jsx'))
const DeliveryApp = lazy(() => import('./DeliveryApp.jsx'))
const QRGenerator = lazy(() => import('./QRGenerator.jsx'))

function RouteLoadingFallback() {
  return (
    <div role="status" aria-label="Loading screen" style={{ minHeight: "100dvh", display: "grid", placeItems: "center", background: "#fff", colorScheme: "light" }}>
      <style>{"@keyframes route-spinner { to { transform: rotate(360deg); } }"}</style>
      <span style={{ width: 30, height: 30, border: "3px solid #FFF3EA", borderTopColor: "#C2410C", borderRadius: "50%", animation: "route-spinner 0.8s linear infinite" }} />
    </div>
  )
}

const path = window.location.pathname.replace(/\/+$/, '') || '/';
const isAttendanceUrl = path === '/attendance' || path.startsWith('/attendance/');
const isStaffUrl = path === '/staff' || path.startsWith('/staff/');
const isDeliveryUrl = path === '/delivery' || path.startsWith('/delivery/');
const isQrUrl = new URLSearchParams(window.location.search).get("view") === "qr";

const routeName = isAttendanceUrl ? "attendance" : isStaffUrl ? "staff" : isDeliveryUrl ? "delivery" : isQrUrl ? "qr" : "main";

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary key={routeName}>
      <Suspense fallback={<RouteLoadingFallback />}>
        {isAttendanceUrl ? <AttendanceApp /> : isStaffUrl ? <StaffApp /> : isDeliveryUrl ? <DeliveryApp /> : isQrUrl ? <QRGenerator /> : <App />}
      </Suspense>
    </ErrorBoundary>
  </StrictMode>,
)
