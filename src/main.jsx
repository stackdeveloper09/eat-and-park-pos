import "./recover";
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './theme.css'
import App from './App.jsx'
import StaffApp from './StaffApp.jsx'
import AttendanceApp from './AttendanceApp.jsx'

const path = window.location.pathname.replace(/\/+$/, '') || '/';
const isAttendanceUrl = path === '/attendance' || path.startsWith('/attendance/');
const isStaffUrl = path === '/staff' || path.startsWith('/staff/');

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {isAttendanceUrl ? <AttendanceApp /> : isStaffUrl ? <StaffApp /> : <App />}
  </StrictMode>,
)
