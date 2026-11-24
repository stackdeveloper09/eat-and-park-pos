import "./recover";
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './theme.css'
import App from './App.jsx'
import StaffApp from './StaffApp.jsx'
import AttendanceApp from './AttendanceApp.jsx'
import DeliveryApp from './DeliveryApp.jsx'
import QRGenerator from './QRGenerator.jsx'
import ErrorBoundary from './ErrorBoundary.jsx'

const path = window.location.pathname.replace(/\/+$/, '') || '/';
const isAttendanceUrl = path === '/attendance' || path.startsWith('/attendance/');
const isStaffUrl = path === '/staff' || path.startsWith('/staff/');
const isDeliveryUrl = path === '/delivery' || path.startsWith('/delivery/');
const isQrUrl = new URLSearchParams(window.location.search).get("view") === "qr";

const routeName = isAttendanceUrl ? "attendance" : isStaffUrl ? "staff" : isDeliveryUrl ? "delivery" : isQrUrl ? "qr" : "main";

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary key={routeName}>
      {isAttendanceUrl ? <AttendanceApp /> : isStaffUrl ? <StaffApp /> : isDeliveryUrl ? <DeliveryApp /> : isQrUrl ? <QRGenerator /> : <App />}
    </ErrorBoundary>
  </StrictMode>,
)
