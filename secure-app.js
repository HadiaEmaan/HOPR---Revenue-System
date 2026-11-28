'use strict';

const roleViews = {
  admin: { title: 'Clinic overview', subtitle: 'Your clinic operations and financial snapshot.', nav: ['Overview', 'Appointments', 'Patients', 'New patients', 'Membership requests', 'Clinical records', 'Billing & expenses', 'Staff & shifts', 'Inventory', 'Reports & audit'] },
  manager: { title: 'Clinic Manager', subtitle: 'Coordinate appointments, patient flow, and daily clinic operations.', nav: ['Overview', 'Live queue', 'Appointments', 'Patients', 'New patients', 'Patient check-in', 'Invoices', 'Inventory', 'Daily tasks', 'Follow-ups', 'Compliance'] },
  doctor: { title: 'My clinic day', subtitle: 'Appointments and patients assigned to your care.', nav: ['Overview', 'My appointments', 'My patients', 'Clinical notes', 'Exercise plans'] },
  gymkhana: { title: 'Clinic overview', subtitle: 'Aggregated operating and compliance information.', nav: ['Overview', 'Footfall', 'Compliance', 'Operating hours'] }
};

let currentUser = null;
let dashboardData = null;
let currentView = 'Overview';
let currentWorkspace = null;
let currentClinicalRecordsMonth = '';
let selectedScheduleDate = null;
let scheduleMode = 'day';
let toastTimer;
let refreshTimer;
const $ = selector => document.querySelector(selector);
const text = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const initialsFor = name => String(name || '').split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
function profileAvatarFor(user) {
  if (user.role === 'admin') return initialsFor(user.name);
  if (user.role === 'manager') return 'M';
  if (user.role === 'doctor') {
    const name = String(user.name || '').replace(/^\s*(?:dr\.?|doctor)\s+/i, '').trim();
    return `D${name.charAt(0).toUpperCase()}`;
  }
  return initialsFor(user.name).charAt(0) || 'G';
}
function profileNameFor(user) {
  if (user.role !== 'doctor') return user.name;
  const name = String(user.name || '').replace(/^\s*(?:(?:dr\.?|doctor)\s*)+/i, '').trim();
  return name ? `Dr. ${name}` : 'Doctor';
}

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.error || `Request failed (${response.status})`), { status: response.status });
  return payload;
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
}

function displayError(selector, message) {
  const element = $(selector);
  element.textContent = message;
  element.hidden = !message;
}

function setAuthenticated(user) {
  currentUser = user;
  $('#loginScreen').hidden = Boolean(user);
  $('#appShell').hidden = !user;
  $('#changePasswordButton').hidden = !user || user.role !== 'admin';
  clearInterval(refreshTimer);
  if (user) {
    currentView = 'Overview';
    $('#profileAvatar').textContent = profileAvatarFor(user);
    $('#profileName').textContent = profileNameFor(user);
    $('#profileRole').textContent = user.roleLabel;
    $('#roleLabel').textContent = user.roleLabel;
    loadDashboard();
    refreshTimer = setInterval(loadDashboard, 15000);
  }
}

function syncRegistrationMode() {
  const form = $('#checkinForm');
  const appointmentOnly = form.elements.registrationMode.value === 'appointment';
  $('#sessionsPrescribedField').hidden = !['admin', 'manager'].includes(currentUser?.role);
  const membershipField = $('#membershipField');
  membershipField.hidden = appointmentOnly;
  $('#appointmentIdField').hidden = !appointmentOnly;
  form.elements.appointmentIdPreview.value = '';
  form.elements.membershipId.required = !appointmentOnly;
  $('#appointmentOnlyNotice').hidden = !appointmentOnly;
  if (appointmentOnly) resetMemberLookup();
}

function renderNavigation() {
  const view = roleViews[currentUser.role];
  $('#navigation').innerHTML = view.nav.map((item, index) => {
    const section = item === 'Invoices' ? 'Receipts' : item;
    return `<button class="nav-item ${section === currentView ? 'active' : ''}" type="button" data-section="${text(section)}"><span class="nav-icon">${['▦', '◷', '♧', '▤', '✚', '♙', '▥'][index % 7]}</span><span>${text(item)}</span></button>`;
  }).join('');
  $('#navigation').querySelectorAll('.nav-item').forEach(button => button.addEventListener('click', () => {
    closeMobileNavigation();
    const section = button.dataset.section;
    if (section === 'Patient check-in') return openCheckin();
    if (section === 'Overview') {
      currentView = 'Overview';
      return renderDashboard(dashboardData);
    }
    openWorkspace(section);
  }));
}

function closeMobileNavigation() {
  $('#sidebar').classList.remove('open');
  $('#menuToggle').setAttribute('aria-expanded', 'false');
  $('#menuToggle').setAttribute('aria-label', 'Open navigation');
}

function renderMetrics(data) {
  const role = currentUser.role;
  const metrics = role === 'admin'
    ? [[data.schedule.mode === 'week' ? 'Visits this week' : 'Visits on selected day', data.metrics.visitsToday, 'Clinic-wide', '♧'], [data.schedule.mode === 'week' ? 'Revenue this week' : 'Revenue on selected day', `Rs ${(data.metrics.revenuePaisa / 100).toLocaleString()}`, 'Paid receipts', '↗'], ['Waiting now', data.metrics.waiting, 'Today’s live queue', '◷'], ['Active staff', data.metrics.staffOnDuty, 'Enabled accounts', '♙']]
    : role === 'manager'
      ? [[data.schedule.mode === 'week' ? 'Appointments this week' : 'Appointments on selected day', data.metrics.visitsToday, 'Clinic-wide', '▦'], ['Waiting now', data.metrics.waiting, 'Today’s live queue', '◷'], ['Assigned doctors', data.doctors.length, 'Active clinicians', '♙']]
          : role === 'doctor'
          ? [[data.schedule.mode === 'week' ? 'My visits this week' : 'My visits on selected day', data.metrics.visitsToday, 'Assigned to you', '▦'], ['My waiting patients', data.metrics.waiting, 'Today’s live queue', '◷']]
          : [[data.schedule.mode === 'week' ? 'Visits this week' : 'Visits on selected day', data.metrics.visitsToday, 'Aggregated count', '♧'], ['Visits this month', data.metrics.visitsMonth, 'Aggregated count', '▦']];
  $('#metrics').innerHTML = metrics.map(([label, value, caption, icon]) => `<article class="metric-card"><div class="metric-top"><span>${text(label)}</span><span class="metric-symbol">${icon}</span></div><div class="metric-value">${text(value)}</div><small class="metric-caption">${text(caption)}</small></article>`).join('');
}

function statusClass(status) { return String(status).toLowerCase().replaceAll(' ', '-'); }
function statusLabel(status) { return status === 'In session' ? 'In progress' : status; }

function clinicToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());
}

function shiftScheduleDate(date, days) {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function shortDate(date) {
  return new Intl.DateTimeFormat('en', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00.000Z`));
}

function scheduleLabel(schedule) {
  if (schedule.mode === 'day') return schedule.selectedDate === clinicToday() ? `Today · ${shortDate(schedule.selectedDate)}` : shortDate(schedule.selectedDate);
  return `${shortDate(schedule.startDate)} – ${shortDate(schedule.endDate)}`;
}

function renderVisits(data) {
  $('#primaryTitle').textContent = `${currentUser.role === 'doctor' ? 'My appointments' : currentUser.role === 'gymkhana' ? 'Clinic activity' : 'Appointments'} · ${scheduleLabel(data.schedule)}`;
  const visits = data.visits || [];
  if (currentUser.role === 'gymkhana') {
    $('#appointmentList').innerHTML = visits.length ? visits.map(visit => `<div class="appointment-row"><span class="appointment-time">${text(visit.time)}</span><div class="patient-main"><span class="avatar" aria-hidden="true">•</span><div class="patient-info"><b>${text(visit.name)}</b><small>Physiotherapy visit</small></div></div><div class="appointment-meta"><span class="status ${statusClass(visit.status)}">${text(statusLabel(visit.status))}</span></div></div>`).join('') : '<div class="empty-state">No visits recorded for this period.</div>';
    return;
  }
  $('#appointmentList').innerHTML = visits.length ? visits.map(visit => {
    const detail = currentUser.role === 'manager' ? visit.doctor : visit.area || 'Assessment pending';
    const timeLabel = data.schedule.mode === 'week' ? `${shortDate(visit.date)} · ${visit.time}` : visit.time;
    const appointmentReference = visit.appointmentNumber ? ` · Appointment #${visit.appointmentNumber}` : '';
    const doctorActions = currentUser.role === 'doctor' && visit.status !== 'Completed'
      ? `${visit.status !== 'In session' ? `<button type="button" class="complete-appointment-button" data-action="start-appointment" data-id="${text(visit.id)}">In progress</button>` : ''}<button type="button" class="complete-appointment-button" data-action="complete-appointment" data-id="${text(visit.id)}">Mark complete</button>`
      : '';
    return `<div class="appointment-row"><span class="appointment-time">${text(timeLabel)}</span><div class="patient-main"><span class="avatar">${text(initialsFor(visit.name))}</span><div class="patient-info"><b>${text(visit.name)}</b><small>${text(visit.visit)} · ${text(detail)}${text(appointmentReference)}</small></div></div><div class="appointment-meta"><span class="status ${statusClass(visit.status)}">${text(statusLabel(visit.status))}</span><small>${currentUser.role === 'doctor' ? '' : text(visit.doctor)}</small>${doctorActions}</div></div>`;
  }).join('') : '<div class="empty-state">No appointments are scheduled for today.</div>';
}

function renderQueue(data) {
  if (currentUser.role === 'gymkhana') {
    const visits = (data.queue || []).slice(0, 4);
    $('#queueCount').textContent = String(visits.length).padStart(2, '0');
    $('#queueList').innerHTML = visits.map(visit => `<div class="queue-person"><span class="avatar">${text(initialsFor(visit.name))}</span><div class="queue-details"><b>${text(visit.name)}</b><small>${text(visit.time)}</small></div><span class="queue-wait">${text(statusLabel(visit.status))}</span></div>`).join('') || '<div class="empty-state">No patients are currently waiting.</div>';
    return;
  }
  const visits = (data.queue || []).slice(0, 4);
  $('#queueCount').textContent = String(visits.length).padStart(2, '0');
  $('#queueList').innerHTML = visits.map(visit => `<div class="queue-person"><span class="avatar">${text(initialsFor(visit.name))}</span><div class="queue-details"><b>${text(visit.name)}</b><small>${text(visit.doctor)} · ${text(visit.time)}</small></div><span class="queue-wait">${text(statusLabel(visit.status))}</span></div>`).join('') || '<div class="empty-state">No patients in the queue.</div>';
}

function renderSummary(data) {
  const role = currentUser.role;
  const rangeLabel = data.schedule.mode === 'week' ? 'this week' : 'on selected day';
  $('#insightEyebrow').textContent = role === 'gymkhana' ? 'AGGREGATED FOOTFALL' : role === 'doctor' ? 'MY SCHEDULE' : 'TODAY AT HOPR';
  $('#insightTitle').textContent = role === 'doctor' ? 'My appointments' : 'Appointments';
  $('#chartTotal').textContent = role === 'gymkhana' ? data.metrics.visitsMonth : data.metrics.visitsToday;
  $('#chartTrend').textContent = 'Live count';
  $('#chartCaption').textContent = role === 'gymkhana' ? 'visits this month' : `appointments ${rangeLabel}`;
  $('#chart').innerHTML = `<span class="chart-bar current" style="height:${Math.min(100, Math.max(8, data.metrics.visitsToday * 5))}%"></span>`;
  $('#secondaryEyebrow').textContent = role === 'gymkhana' ? 'PRIVACY' : role === 'doctor' ? 'CLINICAL WORKSPACE' : 'CLINIC STATUS';
  $('#secondaryTitle').textContent = role === 'gymkhana' ? 'Attendance oversight' : role === 'doctor' ? 'Assigned patient records' : 'Clinic overview';
  $('#secondaryAction').textContent = role === 'gymkhana' ? 'Limited access' : role === 'doctor' ? 'My patients' : 'Live data';
  const appointmentsLabel = data.schedule.mode === 'week' ? 'This week’s appointments' : 'Selected-day appointments';
  $('#secondaryContent').innerHTML = role === 'gymkhana'
    ? '<div class="empty-state">Attendance names, visit times and statuses are available. Contact, clinical, membership and payment details remain private.</div>'
    : role === 'doctor'
      ? `<div class="utilisation-list">${(data.assignedPatients || []).map(patient => `<div class="utilisation-row"><span class="utilisation-name">${text(patient.name)} · ${text(patient.condition || 'No condition recorded')}</span><span></span><span class="utilisation-value">${text(patient.lastVisit)}</span></div>`).join('') || '<div class="empty-state">No patients are assigned to your account yet.</div>'}</div>`
      : `<div class="utilisation-list"><div class="utilisation-row"><span class="utilisation-name">${appointmentsLabel}</span><div class="progress-track"><div class="progress-fill" style="width:${Math.min(100, data.metrics.visitsToday * 3)}%"></div></div><span class="utilisation-value">${data.metrics.visitsToday}</span></div><div class="utilisation-row"><span class="utilisation-name">Current waiting</span><div class="progress-track"><div class="progress-fill high" style="width:${Math.min(100, data.metrics.waiting * 15)}%"></div></div><span class="utilisation-value">${data.metrics.waiting}</span></div></div>`;
  if (role === 'gymkhana') {
    const recentVisits = [...(data.visits || [])].reverse().slice(0, 5);
    $('#activityList').innerHTML = recentVisits.map(visit => `<div class="activity-row"><span class="activity-mark">↻</span><p>${text(statusLabel(visit.status))} · ${text(visit.name)}</p><small>${text(visit.date)} · ${text(visit.time)}</small></div>`).join('') || '<div class="empty-state">No visit activity for this period.</div>';
  } else if (role === 'doctor') {
    const recentVisits = [...(data.visits || [])].reverse().slice(0, 5);
    $('#activityList').innerHTML = recentVisits.map(visit => `<div class="activity-row"><span class="activity-mark">↻</span><p>${text(statusLabel(visit.status))} · ${text(visit.name)}</p><small>${text(visit.date)} · ${text(visit.time)}</small></div>`).join('') || '<div class="empty-state">No recent visit updates for this period.</div>';
  } else {
    const activity = 'Clinic schedule updated';
    $('#activityList').innerHTML = `<div class="activity-row"><span class="activity-mark">↻</span><p>${text(activity)}</p><small>Just now</small></div>`;
  }
}

function renderDashboard(data) {
  if (!data) return;
  dashboardData = data;
  $('#profileName').textContent = profileNameFor(currentUser);
  currentView = 'Overview';
  $('#workspaceView').hidden = true;
  $('#metrics').hidden = false;
  $('.content-grid').hidden = false;
  $('.bottom-grid').hidden = false;
  const view = roleViews[currentUser.role];
  $('#dateLabel').textContent = new Intl.DateTimeFormat('en', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Asia/Karachi' }).format(new Date()).toUpperCase();
  $('#pageTitle').innerHTML = `${text(view.title)}<span class="wave">.</span>`;
  $('#pageSubtitle').textContent = view.subtitle;
  $('#headingActions').innerHTML = currentUser.role === 'manager'
    ? '<button class="button primary-button" id="newVisitButton">＋ &nbsp; Patient check-in</button>'
    : currentUser.role === 'admin'
      ? '<button class="button secondary-button" id="newUserButton">＋ &nbsp; Add staff</button><button class="button primary-button" id="newVisitButton">＋ &nbsp; New appointment</button>'
      : currentUser.role === 'doctor'
          ? '<button class="button primary-button" id="newVisitButton">＋ &nbsp; Add session note</button>'
          : '';
  renderNavigation();
  renderMetrics(data);
  renderVisits(data);
  renderQueue(data);
  renderSummary(data);
  $('#scheduleDateLabel').textContent = scheduleLabel(data.schedule);
  $('#previousSchedule').setAttribute('aria-label', data.schedule.mode === 'week' ? 'Previous week' : 'Previous day');
  $('#nextSchedule').setAttribute('aria-label', data.schedule.mode === 'week' ? 'Next week' : 'Next day');
  $('#dayViewButton').classList.toggle('selected', data.schedule.mode === 'day');
  $('#weekViewButton').classList.toggle('selected', data.schedule.mode === 'week');
  $('#dayViewButton').setAttribute('aria-pressed', String(data.schedule.mode === 'day'));
  $('#weekViewButton').setAttribute('aria-pressed', String(data.schedule.mode === 'week'));
  $('#newVisitButton')?.addEventListener('click', () => {
    if (currentUser.role === 'doctor') return openNoteForm();
    openCheckin();
  });
  $('#newUserButton')?.addEventListener('click', createStaffAccount);
  $('#appointmentList').querySelectorAll('[data-action="complete-appointment"]').forEach(button => button.addEventListener('click', () => markAppointmentComplete(button.dataset.id)));
  populateDoctors(data.doctors || []);
}

const workspaceHeadings = {
  'Appointments': 'Appointments', 'My appointments': 'My appointments', 'Live queue': 'Live waiting room',
  'Patients': 'Patient directory', 'New patients': 'New patients', 'Membership requests': 'Patients missing membership IDs', 'My patients': 'My assigned patients', 'Clinical records': 'Clinical records', 'Clinical archive': 'Clinical record archive',
  'Clinical notes': 'Clinical notes', 'Exercise plans': 'Exercise plans', 'Billing & expenses': 'Billing & expenses',
  'Receipts': 'Invoices', 'Staff & shifts': 'Staff & shifts', 'Daily tasks': 'Daily task tracker',
  'Follow-ups': 'Follow-up schedule', 'Reports & audit': 'Reports & audit log', 'Footfall': 'Gymkhana Footfall',
  'Compliance': 'Compliance checklist', 'Operating hours': 'Operating hours', 'Inventory': 'Clinic inventory'
};

function workspaceColumns(view) {
  const columns = {
    'Appointments': [['appointmentNumber', 'Appointment ID'], ['sessionNumber', 'Session'], ['sessionsPrescribed', 'Sessions prescribed'], ['date', 'Date'], ['time', 'Time'], ['name', 'Patient'], ['membershipId', 'Membership / Appointment ID'], ['phone', 'Phone'], ['doctor', 'Doctor'], ['visit', 'Visit'], ['status', 'Appointment status'], ['paymentMode', 'Payment method'], ['amountPaisa', 'Amount'], ['paymentStatus', 'Payment status']],
    'My appointments': [['appointmentNumber', 'Appointment ID'], ['date', 'Date'], ['time', 'Time'], ['name', 'Patient'], ['membershipId', 'Membership ID'], ['condition', 'Condition'], ['visit', 'Visit'], ['status', 'Status']],
    'New patients': [['appointmentNumber', 'Appointment ID'], ['date', 'Date'], ['time', 'Time'], ['name', 'Patient'], ['membershipId', 'Membership ID'], ['condition', 'Condition'], ['visit', 'Visit'], ['status', 'Status'], ['assessmentStatus', 'History status']],
    'Live queue': [['time', 'Time'], ['name', 'Patient'], ['doctor', 'Doctor'], ['status', 'Status']],
    'Patients': [['name', 'Patient'], ['membershipId', 'Membership / Admin ID'], ['appointmentNumber', 'Appointment ID'], ['patientStatus', 'Appointment status'], ['sessionsPrescribed', 'Sessions prescribed'], ['phone', 'Phone'], ['age', 'Age'], ['condition', 'Condition'], ['lastVisit', 'Last visit']],
    'Membership requests': [['name', 'Patient'], ['phone', 'Phone'], ['age', 'Age'], ['appointmentNumber', 'Appointment ID'], ['lastVisit', 'Last visit'], ['visitCount', 'Visits']],
    'My patients': [['name', 'Patient'], ['membershipId', 'Membership ID'], ['age', 'Age'], ['phone', 'Phone'], ['condition', 'Condition'], ['lastVisit', 'Last visit']],
    'Staff & shifts': [['name', 'Name'], ['email', 'Email'], ['role', 'Role'], ['active', 'Account'], ['joined', 'Added']],
    'Receipts': [['date', 'Date'], ['time', 'Time'], ['patient', 'Patient'], ['paymentMode', 'Payment method'], ['amountPaisa', 'Amount'], ['paymentStatus', 'Payment status']],
    'Billing & expenses': [['date', 'Date'], ['time', 'Time'], ['patient', 'Receipt'], ['paymentMode', 'Payment method'], ['amountPaisa', 'Amount'], ['clubSharePaisa', 'Club share'], ['paymentStatus', 'Payment status']],
    'Expenses': [['date', 'Date'], ['category', 'Category'], ['description', 'Description'], ['amountPaisa', 'Amount']],
    'Daily tasks': [['title', 'Task'], ['date', 'Due date'], ['status', 'Status']],
    'Inventory': [['name', 'Item'], ['category', 'Category'], ['quantity', 'Quantity'], ['unit', 'Unit'], ['reorderAt', 'Reorder level']],
    'Follow-ups': [['appointmentNumber', 'Appointment ID'], ['membershipId', 'Membership / Appointment ID'], ['date', 'Date'], ['time', 'Time'], ['name', 'Patient'], ['doctor', 'Doctor'], ['visit', 'Visit']],
    'Clinical records': [['time', 'Time'], ['appointmentNumber', 'Appointment ID'], ['sessionNumber', 'Session'], ['sessionsPrescribed', 'Sessions prescribed'], ['patient', 'Patient'], ['membershipId', 'Membership / Appointment ID'], ['doctor', 'Doctor'], ['visitCategory', 'Visit type'], ['status', 'Status'], ['note', 'Session note'], ['treatmentPlan', 'Plan'], ['nextVisit', 'Next visit']],
    'Clinical archive': [['month', 'Month'], ['count', 'Patient visits']],
    'Clinical notes': [['appointmentNumber', 'Appointment ID'], ['createdAt', 'Date'], ['patient', 'Patient'], ['membershipId', 'Membership ID'], ['note', 'Session note'], ['treatmentPlan', 'Plan'], ['nextVisit', 'Next visit']],
    'Exercise plans': [['appointmentNumber', 'Appointment ID'], ['createdAt', 'Date'], ['patient', 'Patient'], ['membershipId', 'Membership ID'], ['treatmentPlan', 'Exercise plan'], ['nextVisit', 'Next visit']],
    'Reports & audit': [['createdAt', 'Date'], ['staff', 'Staff'], ['action', 'Action'], ['entity', 'Record type'], ['detailsJson', 'Financial change (paisa)']],
    'Compliance': [['checkedOn', 'Checked'], ['checkName', 'Checklist item'], ['status', 'Result'], ['notes', 'Notes']],
    'Footfall': [['date', 'Date'], ['visits', 'Patient visits'], ['revenuePaisa', 'Revenue'], ['clubSharePaisa', 'Club share']],
    'Footfall detail': [['date', 'Date'], ['appointmentNumber', 'Appointment ID'], ['name', 'Patient name'], ['membershipId', 'Membership ID'], ['phone', 'Contact number'], ['age', 'Age'], ['issue', 'Issue'], ['sessionNumber', 'Session done'], ['sessionsPrescribed', 'Sessions prescribed'], ['time', 'Session time'], ['status', 'Status'], ['amountPaisa', 'Total payment'], ['paymentStatus', 'Payment status'], ['clubSharePaisa', 'Club share']],
    'Operating hours': [['day', 'Day'], ['hours', 'Hours'], ['adherence', 'Adherence']]
  };
  return columns[view] || [];
}

function formatCell(key, value) {
  if (value === null || value === undefined || value === '') return '—';
  if (key === 'amountPaisa' || key === 'revenuePaisa' || key === 'clubSharePaisa') return `Rs ${(value / 100).toLocaleString()}`;
  if (key === 'month') return formatMonthLabel(value);
  if (key === 'active') return value ? 'Active' : 'Disabled';
  if (key === 'createdAt') return new Date(`${value.replace(' ', 'T')}Z`).toLocaleString();
  return value;
}

function renderRowAction(view, row) {
  if (view === 'Clinical archive') return `<button type="button" data-action="open-clinical-month" data-month="${text(row.month)}">Open</button>`;
  if (view === 'Footfall') return `<button type="button" data-action="open-footfall-date" data-date="${text(row.date)}">Open</button>`;
  if (view === 'New patients') return `<button type="button" data-action="print-assessment" data-id="${text(row.id)}">Print</button>`;
  if (view === 'My appointments' && currentUser.role === 'doctor') {
    const printAction = row.visit === 'New patient' ? `<button type="button" data-action="print-assessment" data-id="${text(row.id)}">Print</button>` : '';
    const visitActions = row.status === 'Completed' ? '<span class="status completed">Completed</span>' : `${row.status !== 'In session' ? `<button type="button" data-action="start-appointment" data-id="${text(row.id)}">In progress</button>` : ''}<button type="button" data-action="complete-appointment" data-id="${text(row.id)}">Mark complete</button>`;
    return `${printAction}${visitActions}`;
  }
  if (['Appointments', 'Live queue'].includes(view)) {
    const scheduleAction = currentUser.role === 'admin' ? `<button type="button" data-action="edit-appointment" data-id="${text(row.id)}" data-date="${text(row.date)}" data-time="${text(row.time)}" data-doctor="${text(row.doctorId || '')}" data-status="${text(row.status)}">Update appointment</button>` : '';
    const paymentAction = currentUser.role === 'manager'
      ? `<select aria-label="Update payment status for ${text(row.name)}" data-action="payment-status" data-id="${text(row.id)}"><option value="Paid" ${row.paymentStatus === 'Paid' ? 'selected' : ''}>Paid</option><option value="Unpaid" ${row.paymentStatus === 'Unpaid' ? 'selected' : ''}>Unpaid</option></select>`
      : currentUser.role === 'admin' ? `<button type="button" data-action="edit-payment" data-id="${text(row.id)}" data-mode="${text(row.paymentMode)}" data-amount="${text(row.amountPaisa)}" data-payment-status="${text(row.paymentStatus)}">Correct payment</button>` : '';
    return `${scheduleAction}${paymentAction}`;
  }
  if (view === 'Receipts') {
    if (currentUser.role === 'manager') return `<select aria-label="Update payment status for ${text(row.patient)}" data-action="payment-status" data-id="${text(row.appointmentId)}"><option value="Paid" ${row.paymentStatus === 'Paid' ? 'selected' : ''}>Paid</option><option value="Unpaid" ${row.paymentStatus === 'Unpaid' ? 'selected' : ''}>Unpaid</option></select>`;
    if (currentUser.role === 'admin') return `<button type="button" data-action="edit-payment" data-id="${text(row.appointmentId)}" data-mode="${text(row.paymentMode)}" data-amount="${text(row.amountPaisa)}" data-payment-status="${text(row.paymentStatus)}">Correct payment</button>`;
  }
  if (view === 'Patients') return `<button type="button" data-action="edit-patient" data-id="${text(row.id)}" data-name="${text(row.name)}" data-phone="${text(row.phone)}" data-age="${text(row.age ?? '')}" data-condition="${text(row.condition)}">Correct</button>`;
  if (view === 'Membership requests') return `<button type="button" data-action="assign-membership" data-id="${text(row.id)}" data-name="${text(row.name)}">Assign admin ID</button>`;
  if (view === 'Inventory') return `<button type="button" data-action="update-stock" data-id="${text(row.id)}" data-name="${text(row.name)}" data-quantity="${text(row.quantity)}">Adjust stock</button>`;
  if (view === 'Staff & shifts') {
    if (row.role === 'admin') return '<span class="status in-session">Protected</span>';
    const active = Boolean(row.active);
    return `<div class="staff-actions"><button type="button" data-action="reset-staff-password" data-id="${text(row.id)}" data-name="${text(row.name)}">Reset password</button><button type="button" data-action="toggle-staff" data-id="${text(row.id)}" data-name="${text(row.name)}" data-active="${active}">${active ? 'Restrict' : 'Restore'}</button><button class="danger-button" type="button" data-action="delete-staff" data-id="${text(row.id)}" data-name="${text(row.name)}">Delete</button></div>`;
  }
  if (view === 'Daily tasks') return `<select aria-label="Update ${text(row.title)} status" data-action="task-status" data-id="${text(row.id)}">${['Pending', 'In progress', 'Completed'].map(status => `<option ${row.status === status ? 'selected' : ''}>${status}</option>`).join('')}</select>`;
  return '';
}

function renderWorkspaceTable(view, rows, tableId = 'workspaceTable') {
  const footfallDetail = view === 'Footfall detail' && currentUser.role === 'gymkhana';
  const columns = workspaceColumns(view).filter(([key]) => !(view === 'Compliance' && currentUser.role === 'gymkhana' && key === 'notes') && !(view === 'My patients' && currentUser.role === 'doctor' && key === 'phone') && !(key === 'patientStatus' && !['admin', 'manager'].includes(currentUser.role)) && !(key === 'membershipId' && !['admin', 'manager', 'doctor'].includes(currentUser.role) && !footfallDetail) && !(key === 'phone' && !['admin', 'manager'].includes(currentUser.role) && !footfallDetail) && !(key === 'sessionNumber' && !['admin', 'manager', 'doctor'].includes(currentUser.role) && !footfallDetail) && !(key === 'sessionsPrescribed' && !['admin', 'manager'].includes(currentUser.role) && !footfallDetail) && !(['paymentMode', 'amountPaisa', 'paymentStatus', 'clubSharePaisa'].includes(key) && !['admin', 'manager'].includes(currentUser.role) && !footfallDetail));
  if (!rows.length) return '<div class="empty-state">No records found.</div>';
  const canManageAppointments = ['Appointments', 'Live queue'].includes(view) && ['admin', 'manager'].includes(currentUser.role);
  const canManagePayments = view === 'Receipts' && ['admin', 'manager'].includes(currentUser.role);
  const canDoctorComplete = view === 'My appointments' && currentUser.role === 'doctor';
  const canEditPatients = ['Patients', 'Membership requests'].includes(view) && currentUser.role === 'admin';
  const canAdjustInventory = view === 'Inventory' && ['admin', 'manager'].includes(currentUser.role);
  const canManageStaff = view === 'Staff & shifts' && currentUser.role === 'admin';
  const actionHeader = canManageAppointments || canManagePayments || canDoctorComplete || canEditPatients || canAdjustInventory || canManageStaff || view === 'Daily tasks' || view === 'Clinical archive' || view === 'Footfall' || view === 'New patients';
  const invoiceColumn = ['Appointments', 'Receipts'].includes(view) && ['admin', 'manager'].includes(currentUser.role);
  const deletePatientColumn = ['Patients', 'Appointments', 'New patients', 'Clinical records', 'Follow-ups'].includes(view) && currentUser.role === 'admin';
  const deletePatientRecordColumn = view === 'Patients' && currentUser.role === 'admin';
  const patientFullRecordColumn = view === 'Clinical records' && currentUser.role === 'admin';
  return `<div class="workspace-table-wrap"><table class="workspace-table" id="${tableId}">
    <thead><tr>${columns.map(([, label]) => `<th>${text(label)}</th>`).join('')}${invoiceColumn ? '<th>Invoice</th>' : ''}${patientFullRecordColumn ? '<th>Patient full record</th>' : ''}${deletePatientColumn ? `<th>${deletePatientRecordColumn ? 'Delete options (by Appointment ID)' : 'Delete appointment'}</th>` : ''}${actionHeader ? '<th>Actions</th>' : ''}</tr></thead>
    <tbody>${rows.map(row => `<tr data-club-share-paisa="${Number(row.clubSharePaisa) || 0}" data-search="${text(Object.values(row).join(' ').toLowerCase())}">
      ${columns.map(([key]) => `<td>${renderWorkspaceCell(view, row, key)}</td>`).join('')}
      ${invoiceColumn ? `<td><button type="button" data-action="open-invoice" data-id="${text(view === 'Receipts' ? row.appointmentId : row.id)}">Invoice</button></td>` : ''}
      ${patientFullRecordColumn ? `<td><button type="button" data-action="open-patient-full-record" data-id="${text(row.patientId)}">Open</button></td>` : ''}
      ${deletePatientColumn ? `<td>${deletePatientRecordColumn ? renderPatientDeleteOptions(row) : `<button class="danger-button" type="button" data-action="delete-patient-appointment" data-id="${text(row.id)}" data-appointment-number="${text(row.appointmentNumber ?? '')}" data-name="${text(row.patient || row.name)}" data-date="${text(row.date || row.recordDate || row.lastVisit || '')}" data-time="${text(row.time || '')}" ${row.appointmentNumber ? '' : 'disabled'}>Delete appointment</button>`}</td>` : ''}
      ${actionHeader ? `<td>${renderRowAction(view, row)}</td>` : ''}
    </tr>`).join('')}</tbody></table></div>`;
}

function renderWorkspaceCell(view, row, key) {
  if (key === 'patientStatus' && ['admin', 'manager'].includes(currentUser.role)) return renderPatientStatusControl(row);
  if (key === 'status') return text(statusLabel(row[key]));
  if (key === 'sessionNumber' && ['admin', 'manager'].includes(currentUser.role)) {
    return `<input class="session-number-input" type="number" min="1" step="1" aria-label="Session number for ${text(row.patient || row.name)}" value="${text(row.sessionNumber)}" data-action="update-session" data-id="${text(row.id)}">`;
  }
  if (key === 'sessionsPrescribed' && (currentUser.role === 'admin' || currentUser.role === 'manager' && !row.sessionsReceptionUpdated)) {
    return `<input class="session-number-input" type="number" min="1" max="100" step="1" aria-label="Update prescribed sessions for ${text(row.patient || row.name)}" value="${text(row[key] ?? '')}" placeholder="Not set" data-action="update-prescribed-sessions" data-id="${text(row.patientId || row.id)}">`;
  }
  if (key === 'amountPaisa' && currentUser.role === 'manager' && ['Appointments', 'Live queue', 'Receipts'].includes(view) && !row.amountManagerUpdated) {
    return `<input class="session-number-input payment-amount-input" type="number" min="0" step="0.01" aria-label="Edit payment amount once for ${text(row.patient || row.name)}" value="${text(((row.amountPaisa || 0) / 100).toFixed(2))}" data-action="update-payment-amount" data-id="${text(row.appointmentId || row.id)}">`;
  }
  if (key === 'clubSharePaisa' && view === 'Billing & expenses' && currentUser.role === 'admin') {
    return `<input class="session-number-input" type="number" min="0" step="0.01" aria-label="Club share for ${text(row.patient)}" value="${text(((row.clubSharePaisa || 0) / 100).toFixed(2))}" data-action="update-club-share" data-id="${text(row.appointmentId)}">`;
  }
  return text(formatCell(key, row[key]));
}

function renderPatientDeleteOptions(row) {
  const appointments = JSON.parse(row.appointmentOptionsJson || '[]');
  const selectedNumber = String(row.appointmentNumber ?? '');
  const options = appointments.map(appointment => {
    const visitDate = appointment.date ? `${appointment.date}${appointment.time ? ` · ${appointment.time}` : ''}` : '';
    return `<option value="${text(appointment.number)}" data-date="${text(appointment.date || '')}" data-time="${text(appointment.time || '')}" ${String(appointment.number) === selectedNumber ? 'selected' : ''}>Appointment #${text(appointment.number)}${visitDate ? ` · ${text(visitDate)}` : ''}</option>`;
  }).join('');
  const disabled = appointments.length ? '' : 'disabled';
  return `<div class="patient-delete-options"><select aria-label="Choose appointment ID for ${text(row.name)}" data-action="select-patient-appointment">${options}</select><div class="patient-delete-actions"><button class="danger-button" type="button" data-action="delete-patient-record" data-id="${text(row.id)}" data-appointment-number="${text(selectedNumber)}" data-name="${text(row.name)}" ${disabled}>Delete patient record</button><button class="danger-button" type="button" data-action="delete-patient-appointment" data-id="${text(row.id)}" data-appointment-number="${text(selectedNumber)}" data-name="${text(row.name)}" ${disabled}>Delete appointment</button></div></div>`;
}

function renderPatientStatusControl(row) {
  const appointments = JSON.parse(row.appointmentOptionsJson || '[]');
  const selectedNumber = String(row.appointmentNumber ?? '');
  const options = appointments.map(appointment => {
    const visitDate = appointment.date ? `${appointment.date}${appointment.time ? ` · ${appointment.time}` : ''}` : '';
    return `<option value="${text(appointment.id)}" data-number="${text(appointment.number)}" data-date="${text(appointment.date || '')}" data-time="${text(appointment.time || '')}" data-status="${text(appointment.status)}" ${String(appointment.number) === selectedNumber ? 'selected' : ''}>Appointment #${text(appointment.number)}${visitDate ? ` · ${text(visitDate)}` : ''}</option>`;
  }).join('');
  const selectedAppointment = appointments.find(appointment => String(appointment.number) === selectedNumber);
  const editableStatuses = currentUser.role === 'admin'
    ? ['Confirmed', 'Waiting', 'In session', 'Completed', 'Cancelled']
    : ['Waiting', 'In session', 'Completed'];
  const statusOptions = editableStatuses.map(status => `<option value="${text(status)}" ${selectedAppointment?.status === status ? 'selected' : ''}>${text(statusLabel(status))}</option>`).join('');
  const currentStatus = selectedAppointment?.status || '';
  const currentStatusOption = currentStatus && !editableStatuses.includes(currentStatus)
    ? `<option value="" selected>Current: ${text(statusLabel(currentStatus))}</option>`
    : '<option value="">Choose status</option>';
  const disabled = appointments.length ? '' : 'disabled';
  return `<div class="patient-status-controls"><select aria-label="Choose appointment ID for status update for ${text(row.name)}" data-action="select-patient-status-appointment" ${disabled}>${options}</select><select aria-label="Change appointment status for ${text(row.name)}" data-action="update-patient-status" data-id="${text(selectedAppointment?.id || '')}" data-appointment-number="${text(selectedAppointment?.number || '')}" ${disabled}>${currentStatusOption}${statusOptions}</select></div>`;
}

function syncPatientAppointmentControls(selector) {
  const row = selector.closest('tr');
  const selected = selector.selectedOptions[0];
  if (!row || !selected) return;
  const statusAppointment = row.querySelector('[data-action="select-patient-status-appointment"]');
  const deleteAppointment = row.querySelector('[data-action="select-patient-appointment"]');
  if (statusAppointment && selector !== statusAppointment) statusAppointment.value = selected.dataset.id || selected.value;
  if (deleteAppointment && selector !== deleteAppointment) deleteAppointment.value = selected.dataset.number || selected.value;

  const statusControl = row.querySelector('[data-action="update-patient-status"]');
  if (statusControl) {
    const appointment = statusAppointment?.selectedOptions[0];
    statusControl.dataset.id = appointment?.value || selected.dataset.id || selected.value;
    statusControl.dataset.appointmentNumber = appointment?.dataset.number || selected.dataset.number || selected.value;
    const status = appointment?.dataset.status || selected.dataset.status || '';
    statusControl.value = [...statusControl.options].some(option => option.value === status) ? status : '';
    const placeholder = statusControl.options[0];
    if (placeholder) placeholder.textContent = status ? `Current: ${statusLabel(status)}` : 'Choose status';
  }
  const deleteNumber = statusAppointment?.selectedOptions[0]?.dataset.number || selected.dataset.number || selected.value;
  const deleteDate = statusAppointment?.selectedOptions[0]?.dataset.date || selected.dataset.date || '';
  const deleteTime = statusAppointment?.selectedOptions[0]?.dataset.time || selected.dataset.time || '';
  row.querySelectorAll('[data-action="delete-patient-appointment"], [data-action="delete-patient-record"]').forEach(button => {
    button.dataset.appointmentNumber = deleteNumber;
    button.dataset.date = deleteDate;
    button.dataset.time = deleteTime;
  });
}

async function updatePatientAppointmentStatus(control) {
  const { id, appointmentNumber } = control.dataset;
  const status = control.value;
  if (!id || !status) return;
  control.disabled = true;
  try {
    await api(`/api/appointments/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status })
    });
    await loadDashboard();
    showToast(`Appointment #${appointmentNumber} status changed to ${statusLabel(status)}.`);
  } catch (error) {
    showToast(error.message);
    await loadDashboard();
  } finally {
    control.disabled = false;
  }
}

function workspaceActions(view) {
  const actions = [];
  if (view === 'Footfall' && currentUser.role === 'gymkhana') actions.push(`<label class="footfall-month-picker">Month <input id="footfallMonthPicker" type="month" value="${clinicToday().slice(0, 7)}"></label><button class="button secondary-button" data-action="open-footfall-records">All records</button>`);
  if (['Appointments', 'My appointments', 'Live queue'].includes(view) && ['admin', 'manager'].includes(currentUser.role)) actions.push('<button class="button primary-button" data-action="new-appointment">＋ &nbsp; New appointment</button>');
  if (view === 'Staff & shifts') actions.push('<button class="button primary-button" data-action="add-staff">＋ &nbsp; Add staff</button>');
  if (view === 'Daily tasks') actions.push('<button class="button primary-button" data-action="add-task">＋ &nbsp; Add task</button>');
  if (view === 'Clinical records' && currentUser.role === 'admin') actions.push('<button class="button secondary-button" data-action="open-clinical-archive">All records</button>');
  if (view === 'Clinical archive') actions.push('<button class="button secondary-button" data-action="open-current-clinical-records">Current month</button>');
  if (view === 'Compliance' && ['admin', 'manager'].includes(currentUser.role)) actions.push('<button class="button primary-button" data-action="add-compliance">＋ &nbsp; Record check</button>');
  if (view === 'Billing & expenses') actions.push('<button class="button primary-button" data-action="add-expense">＋ &nbsp; Record expense</button>');
  if (view === 'Inventory') actions.push('<button class="button primary-button" data-action="add-inventory">＋ &nbsp; Add item</button>');
  return actions.join('');
}

function showFootfallRecordModal(title, rows) {
  $('#footfallRecordModal')?.remove();
  const dialog = document.createElement('dialog');
  dialog.id = 'footfallRecordModal';
  dialog.className = 'modal footfall-record-modal';
  dialog.setAttribute('aria-labelledby', 'footfallRecordTitle');
  const totalClubShare = rows.reduce((total, row) => total + (Number(row.clubSharePaisa) || 0), 0);
  dialog.innerHTML = `<div class="modal-header"><div><p class="eyebrow">GYMKHANA FOOTFALL</p><h2 id="footfallRecordTitle">${text(title)}</h2></div><button class="icon-button" type="button" id="closeFootfallRecords" aria-label="Back to footfall">×</button></div><p class="modal-copy">Patient visit and payment records. Use the cross or Escape to go back.</p><div class="footfall-modal-toolbar"><input class="workspace-search footfall-record-search" id="footfallRecordSearch" type="search" placeholder="Search records" aria-label="Search records"><div class="footfall-club-share-total"><span>Total club share:  </span><strong id="footfallRecordClubShareTotal">Rs ${(totalClubShare / 100).toLocaleString()}</strong></div></div>${renderWorkspaceTable('Footfall detail', rows, 'footfallRecordTable')}`;
  document.body.append(dialog);
  const close = () => dialog.close();
  $('#closeFootfallRecords').addEventListener('click', close);
  $('#footfallRecordSearch').addEventListener('input', event => {
    const query = event.target.value.trim().toLowerCase();
    dialog.querySelectorAll('tbody tr').forEach(row => { row.hidden = !row.dataset.search.includes(query); });
    updateFootfallClubShareTotal(dialog, '#footfallRecordClubShareTotal');
  });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.showModal();
}

function showPatientFullRecord(record) {
  $('#patientFullRecordDialog')?.remove();
  const { patient, visits } = record;
  const dialog = document.createElement('dialog');
  dialog.id = 'patientFullRecordDialog';
  dialog.className = 'modal patient-full-record-dialog';
  dialog.setAttribute('aria-labelledby', 'patientFullRecordTitle');
  const visitContent = visits.length ? visits.map(visit => {
    const notes = visit.notes.length ? visit.notes.map(note => `
      <section class="patient-history-note">
        <p class="eyebrow">SESSION NOTE · ${text(note.doctor)}${note.createdAt ? ` · ${text(note.createdAt)}` : ''}</p>
        <p><strong>Clinical notes</strong><br>${text(note.note)}</p>
        ${note.treatmentPlan ? `<p><strong>Treatment plan</strong><br>${text(note.treatmentPlan)}</p>` : ''}
        ${note.nextVisit ? `<p><strong>Next session prescribed for</strong><br>${text(note.nextVisit)} · ${text(note.nextVisitAppointmentStatus || 'Not booked')}${note.nextVisitAppointmentNumber ? ` · Appointment #${text(note.nextVisitAppointmentNumber)}` : ''}</p>` : ''}
      </section>`).join('') : '<p class="patient-history-muted">No session note recorded.</p>';
    const assessment = visit.assessment
      ? `<details class="patient-history-assessment"><summary>Patient history &amp; assessment · ${text(visit.assessment.status)}</summary><dl>${assessmentFormFields.map(([key, label]) => hasAssessmentAnswer(visit.assessment.answers[key]) ? `<div><dt>${text(label)}</dt><dd>${text(visit.assessment.answers[key])}</dd></div>` : '').join('')}</dl></details>`
      : '';
    return `<article class="patient-history-visit">
      <header><div><p class="eyebrow">SESSION ${text(visit.sessionNumber)}${patient.sessionsPrescribed ? ` OF ${text(patient.sessionsPrescribed)} PRESCRIBED` : ''} · ${text(visit.visit)}</p><h3>${text(visit.date)} · ${text(visit.time)}</h3></div><span class="status">${text(statusLabel(visit.status))}</span></header>
      <div class="patient-history-visit-meta"><span><strong>Appointment ID:</strong> ${text(visit.appointmentNumber)}</span><span><strong>Patient ID:</strong> ${text(visit.membershipOrAppointmentId)}</span><span><strong>Doctor:</strong> ${text(visit.doctor)}</span></div>
      ${notes}${assessment}
    </article>`;
  }).join('') : '<div class="empty-state">No appointments or sessions recorded for this patient.</div>';
  dialog.innerHTML = `<div class="modal-header"><div><p class="eyebrow">ADMIN · COMPLETE PATIENT TIMELINE</p><h2 id="patientFullRecordTitle">${text(patient.name)}</h2></div><button class="icon-button" type="button" data-action="close-patient-full-record" aria-label="Close patient record">×</button></div>
    <div class="patient-full-record-summary"><span><strong>Age:</strong> ${text(patient.age ?? '—')}</span><span><strong>Membership / patient ID:</strong> ${text(patient.membershipId || `Appointment #${visits[0]?.appointmentNumber || '—'}`)}</span><span><strong>Condition:</strong> ${text(patient.condition || '—')}</span><span><strong>Sessions prescribed:</strong> ${text(patient.sessionsPrescribed ?? '—')}</span><span><strong>Sessions completed:</strong> ${text(patient.sessionsCompleted)}</span><span><strong>Total appointments:</strong> ${text(visits.length)}</span></div>
    <div class="patient-full-record-timeline">${visitContent}</div>`;
  document.body.append(dialog);
  dialog.querySelector('[data-action="close-patient-full-record"]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.showModal();
}

function invoiceAmount(value) {
  return (Number(value || 0) / 100).toFixed(2);
}

function invoiceLineMarkup(item = {}) {
  return `<tr><td><input class="invoice-description" maxlength="120" required value="${text(item.description || '')}" aria-label="Item description"></td><td><input class="invoice-quantity" type="number" min="1" max="10000" step="1" required value="${text(item.quantity || 1)}" aria-label="Quantity"></td><td><input class="invoice-unit-price" type="number" min="0" step="0.01" required value="${invoiceAmount(item.unitPricePaisa)}" aria-label="Unit price"></td><td class="invoice-line-amount">Rs ${Number(invoiceAmount(item.amountPaisa)).toLocaleString()}</td><td><button class="invoice-remove-item" type="button" aria-label="Remove item">×</button></td></tr>`;
}

function invoicePaisaFromInput(value) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const [rupees, paisa = ''] = value.split('.');
  const total = Number(rupees) * 100 + Number(paisa.padEnd(2, '0'));
  return Number.isSafeInteger(total) ? total : null;
}

function showInvoiceEditor(data) {
  $('#invoiceDialog')?.remove();
  const { appointment, invoice } = data;
  const advancePaisa = appointment.paymentStatus === 'Paid' ? Number(appointment.recordedAmountPaisa) || 0 : 0;
  const lineItems = invoice?.lineItems?.length
    ? invoice.lineItems
    : [{ description: appointment.visit, quantity: 1, unitPricePaisa: appointment.recordedAmountPaisa || 0, amountPaisa: appointment.recordedAmountPaisa || 0 }];
  const dialog = document.createElement('dialog');
  dialog.id = 'invoiceDialog';
  dialog.className = 'modal invoice-dialog';
  dialog.innerHTML = `<div class="invoice-dialog-header"><div><p class="eyebrow">HOPR CLINIC · INVOICE</p><h2>Create invoice</h2></div><button class="icon-button" type="button" data-action="close-invoice" aria-label="Close invoice">×</button></div>
    <form id="invoiceForm" class="invoice-form">
      <div class="invoice-details-grid">
        <label>Invoice reference<input value="${text(invoice?.invoiceNumber || `INV-${String(appointment.appointmentNumber).padStart(6, '0')}`)}" readonly></label>
        <label>Invoice date<input name="invoiceDate" type="date" value="${text(invoice?.invoiceDate || appointment.appointmentDate)}" required></label>
        <label>Patient name<input value="${text(appointment.patientName)}" readonly></label>
        <label>Membership / appointment ID<input value="${text(appointment.membershipId)}" readonly></label>
        <label>Appointment date<input value="${text(appointment.appointmentDate)}" readonly></label>
        <label>Contact number<input value="${text(appointment.patientPhone || '—')}" readonly></label>
      </div>
      <div class="invoice-items-heading"><h3>Invoice items</h3><button class="button secondary-button" type="button" data-action="add-invoice-item">＋ Add item</button></div>
      <div class="workspace-table-wrap invoice-items-wrap"><table class="workspace-table invoice-items-table"><thead><tr><th>Description</th><th>Qty</th><th>Unit price (Rs)</th><th>Amount</th><th></th></tr></thead><tbody id="invoiceItems">${lineItems.map(invoiceLineMarkup).join('')}</tbody></table></div>
      <div class="invoice-totals">
        <div><span>Subtotal</span><strong id="invoiceSubtotal">Rs 0.00</strong></div>
        <label><span>Collected advance (Rs)</span><output id="invoiceAdvance" data-paisa="${advancePaisa}">Rs ${invoiceAmount(advancePaisa)}</output></label>
        <div class="invoice-balance"><span>Balance due</span><strong id="invoiceBalance">Rs 0.00</strong></div>
      </div>
      <p class="invoice-form-error" id="invoiceFormError" role="alert" hidden></p>
      <div class="invoice-dialog-actions"><button class="button secondary-button" type="button" data-action="close-invoice">Cancel</button><button class="button primary-button" type="submit">Save invoice</button></div>
    </form>`;
  document.body.append(dialog);
  const close = () => dialog.close();
  dialog.querySelectorAll('[data-action="close-invoice"]').forEach(button => button.addEventListener('click', close));
  dialog.querySelector('[data-action="add-invoice-item"]').addEventListener('click', () => {
    const items = $('#invoiceItems');
    if (items.rows.length >= 6) return showToast('This invoice template supports up to 6 line items.');
    items.insertAdjacentHTML('beforeend', invoiceLineMarkup({}));
    updateInvoiceTotals(dialog);
  });
  dialog.querySelector('#invoiceItems').addEventListener('click', event => {
    if (event.target.closest('.invoice-remove-item')) {
      const body = $('#invoiceItems');
      if (body.rows.length > 1) event.target.closest('tr').remove();
      else {
        const row = body.rows[0];
        row.querySelector('.invoice-description').value = '';
        row.querySelector('.invoice-quantity').value = '1';
        row.querySelector('.invoice-unit-price').value = '0.00';
      }
      updateInvoiceTotals(dialog);
    }
  });
  dialog.querySelector('#invoiceForm').addEventListener('input', () => updateInvoiceTotals(dialog));
  dialog.querySelector('#invoiceForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const lines = [...dialog.querySelectorAll('#invoiceItems tr')].map(row => ({
      description: row.querySelector('.invoice-description').value.trim(),
      quantity: Number(row.querySelector('.invoice-quantity').value),
      unitPricePaisa: invoicePaisaFromInput(row.querySelector('.invoice-unit-price').value)
    }));
    const advancePaisa = Number($('#invoiceAdvance').dataset.paisa);
    const error = $('#invoiceFormError');
    const subtotalPaisa = lines.reduce((total, item) => total + item.quantity * item.unitPricePaisa, 0);
    if (!form.reportValidity()) return;
    if (lines.length > 6
      || lines.some(item => !item.description || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 10000 || item.unitPricePaisa === null)
      || lines.some(item => !Number.isSafeInteger(item.quantity * item.unitPricePaisa))
      || !Number.isSafeInteger(subtotalPaisa)
      || !Number.isSafeInteger(advancePaisa)
      || advancePaisa > subtotalPaisa) {
      error.textContent = Number.isSafeInteger(advancePaisa) && advancePaisa > subtotalPaisa
        ? 'Invoice subtotal cannot be less than the amount already recorded as collected.'
        : 'Check each description, quantity, price, and advance amount.';
      error.hidden = false;
      return;
    }
    error.hidden = true;
    try {
      const result = await api(`/api/appointments/${encodeURIComponent(appointment.appointmentId)}/invoice`, {
        method: 'PUT',
        body: JSON.stringify({ invoiceDate: form.elements.invoiceDate.value, lineItems: lines })
      });
      dialog.close();
      showInvoicePreview(appointment, result.invoice);
      showToast('Invoice saved.');
    } catch (requestError) {
      error.textContent = requestError.message;
      error.hidden = false;
    }
  });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  updateInvoiceTotals(dialog);
  dialog.showModal();
}

function updateInvoiceTotals(dialog) {
  let subtotal = 0;
  dialog.querySelectorAll('#invoiceItems tr').forEach(row => {
    const quantity = Number(row.querySelector('.invoice-quantity').value);
    const unitPrice = invoicePaisaFromInput(row.querySelector('.invoice-unit-price').value);
    const amount = Number.isSafeInteger(quantity) && quantity > 0 && unitPrice !== null ? quantity * unitPrice : 0;
    subtotal += amount;
    row.querySelector('.invoice-line-amount').textContent = `Rs ${(amount / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  });
  const advance = Number(dialog.querySelector('#invoiceAdvance').dataset.paisa) || 0;
  dialog.querySelector('#invoiceSubtotal').textContent = `Rs ${(subtotal / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  dialog.querySelector('#invoiceBalance').textContent = `Rs ${((subtotal - advance) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function showInvoicePreview(appointment, invoice) {
  $('#invoiceDialog')?.remove();
  const dialog = document.createElement('dialog');
  dialog.id = 'invoiceDialog';
  dialog.className = 'modal invoice-dialog invoice-preview-dialog';
  const money = value => (value / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  dialog.innerHTML = `<div class="invoice-template-page" id="printableInvoice">
    <img class="invoice-template-image" src="/invoice.png" alt="HOPR Clinic invoice template">
    <button class="icon-button invoice-template-close" type="button" data-action="close-invoice" aria-label="Close invoice">×</button>
    <span class="invoice-template-field invoice-template-reference">${text(invoice.invoiceNumber)}</span>
    <span class="invoice-template-field invoice-template-patient">${text(appointment.patientName)}</span>
    <span class="invoice-template-field invoice-template-date">${text(invoice.invoiceDate)}</span>
    <div class="invoice-template-items" style="--invoice-item-count:${invoice.lineItems.length}">${invoice.lineItems.map(item => `<div class="invoice-template-item"><span>${text(item.description)}</span><span>${text(item.quantity)}</span><span>${money(item.unitPricePaisa)}</span><span>${money(item.amountPaisa)}</span></div>`).join('')}</div>
    <span class="invoice-template-field invoice-template-subtotal">${money(invoice.subtotalPaisa)}</span>
    <span class="invoice-template-field invoice-template-advance">${money(invoice.advancePaisa)}</span>
    <span class="invoice-template-field invoice-template-balance">${money(invoice.balancePaisa)}</span>
    <span class="invoice-template-field invoice-template-total">${money(invoice.subtotalPaisa)}</span>
  </div>
  <div class="invoice-dialog-actions"><button class="button secondary-button" type="button" data-action="edit-invoice">Edit invoice</button><button class="button primary-button" type="button" data-action="print-invoice">Print</button></div>`;
  document.body.append(dialog);
  dialog.querySelector('[data-action="edit-invoice"]').addEventListener('click', () => {
    dialog.close();
    openInvoice(appointment.appointmentId, true);
  });
  dialog.querySelector('[data-action="print-invoice"]').addEventListener('click', async event => {
    const printButton = event.currentTarget;
    printButton.disabled = true;
    try {
      const result = await api(`/api/appointments/${encodeURIComponent(appointment.appointmentId)}/invoice`, { method: 'POST' });
      window.print();
      showToast('Printed invoice copy saved for Admin.');
      return result;
    } catch (error) {
      showToast(error.message);
    } finally {
      printButton.disabled = false;
    }
  });
  dialog.querySelector('.invoice-template-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.showModal();
}

async function openInvoice(appointmentId, reopenEditor = false) {
  try {
    const data = await api(`/api/appointments/${encodeURIComponent(appointmentId)}/invoice`);
    if (reopenEditor || !data.invoice) showInvoiceEditor({ ...data, invoice: data.draftInvoice || data.invoice });
    else showInvoicePreview(data.appointment, data.invoice);
  } catch (error) {
    showToast(error.message);
  }
}

function updateFootfallClubShareTotal(container, selector) {
  const total = [...container.querySelectorAll('tbody tr:not([hidden])')]
    .reduce((sum, row) => sum + (Number(row.dataset.clubSharePaisa) || 0), 0);
  const target = container.querySelector(selector);
  if (target) target.textContent = `Rs ${(total / 100).toLocaleString()}`;
}

function formatMonthLabel(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '')) return month || '';
  return new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T12:00:00.000Z`));
}

function renderClinicalRecordsByDate(rows) {
  const recordsByDate = new Map();
  for (const row of rows) {
    if (!recordsByDate.has(row.recordDate)) recordsByDate.set(row.recordDate, []);
    recordsByDate.get(row.recordDate).push(row);
  }
  if (!recordsByDate.size) return '<div class="empty-state">No patient visits recorded for this month.</div>';
  return [...recordsByDate].map(([date, records]) => {
    const dateLabel = new Intl.DateTimeFormat('en', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00.000Z`));
    return `<section><div class="workspace-toolbar"><p>${text(dateLabel)} · ${records.length} ${records.length === 1 ? 'visit' : 'visits'}</p></div>${renderWorkspaceTable('Clinical records', records, `clinicalRecords-${text(date)}`)}</section>`;
  }).join('');
}

const assessmentFormFields = [
  ['patientName', 'Patient name', 'text'], ['age', 'Age', 'number'], ['gender', 'Gender', 'select'],
  ['contactNumber', 'Contact no.', 'tel'], ['assessmentDate', 'Date of assessment', 'date'],
  ['presentingComplaint', 'Presenting complaint'], ['currentSymptoms', 'Current signs & symptoms'],
  ['painSeverity', 'Pain level (VAS scale 0–10)', 'pain'], ['aggravatingFactors', 'Aggravating factors'],
  ['relievingFactors', 'Relieving factors'], ['sleepNightPain', 'Sleep / night pain'],
  ['previousInjuriesSurgeries', 'Previous injuries / surgeries related to presenting complaint'],
  ['comorbidConditions', 'Comorbid conditions'], ['currentMedications', 'Current medications'],
  ['allergies', 'Allergies'], ['posture', 'Posture'], ['gait', 'Gait'], ['swellingDeformity', 'Swelling / deformity'],
  ['observation', 'Observation'], ['activeRom', 'Active range of motion (ROM)'],
  ['passiveRom', 'Passive range of motion (ROM)'], ['muscleStrengthMmt', 'Muscle strength (MMT)'],
  ['specialTests', 'Special tests'], ['provisionalDiagnosis', 'Provisional diagnosis'],
  ['treatmentPlan', 'Treatment plan'], ['homeExercisePlan', 'Home exercise plan'],
  ['adviceEducation', 'Advice and education']
];

function assessmentControl([key, label, type], value) {
  const safeValue = text(value ?? '');
  if (type === 'select') {
    return `<select id="assessment-${key}" name="${key}" data-assessment-field="${key}"><option value="">Select</option>${['Female', 'Male', 'Other', 'Prefer not to say'].map(option => `<option value="${option}" ${value === option ? 'selected' : ''}>${option}</option>`).join('')}</select>`;
  }
  if (type === 'number') return `<input id="assessment-${key}" name="${key}" type="number" min="0" max="130" step="1" value="${safeValue}" data-assessment-field="${key}">`;
  if (type === 'pain') return `<input id="assessment-${key}" name="${key}" type="number" min="0" max="10" step="1" value="${safeValue}" data-assessment-field="${key}">`;
  if (type === 'date') return `<input id="assessment-${key}" name="${key}" type="date" value="${safeValue}" data-assessment-field="${key}">`;
  if (type === 'text' || type === 'tel') return `<input id="assessment-${key}" name="${key}" type="${type}" maxlength="8000" value="${safeValue}" data-assessment-field="${key}">`;
  return `<textarea id="assessment-${key}" name="${key}" rows="2" maxlength="8000" data-assessment-field="${key}">${safeValue}</textarea>`;
}

function hasAssessmentAnswer(value) {
  return value !== undefined && value !== null && value !== '';
}

function readAssessmentAnswers(dialog) {
  return Object.fromEntries([...dialog.querySelectorAll('[data-assessment-field]')].map(field => [field.dataset.assessmentField, field.value]));
}

function setAssessmentSaveState(dialog, message) {
  const state = dialog.querySelector('#assessmentSaveState');
  if (state) state.textContent = message;
}

async function saveAssessmentState(dialog) {
  const state = dialog.assessmentState;
  clearTimeout(state.timer);
  if (state.inFlight) {
    await state.inFlight;
    return state.savedRevision < state.revision ? saveAssessmentState(dialog) : true;
  }
  if (state.savedRevision >= state.revision) return true;
  const revision = state.revision;
  const answers = readAssessmentAnswers(dialog);
  setAssessmentSaveState(dialog, 'Saving…');
  state.inFlight = api(`/api/appointments/${encodeURIComponent(state.appointmentId)}/assessment`, {
    method: 'PUT',
    body: JSON.stringify({ answers })
  }).then(result => {
    state.savedRevision = revision;
    state.status = result.status;
    setAssessmentSaveState(dialog, `Saved · ${result.status}`);
    return true;
  }).catch(error => {
    setAssessmentSaveState(dialog, `Save failed: ${error.message}`);
    return false;
  }).finally(() => { state.inFlight = null; });
  const saved = await state.inFlight;
  return saved && state.savedRevision < state.revision ? saveAssessmentState(dialog) : saved;
}

function closeAssessmentDialog(dialog) {
  saveAssessmentState(dialog).then(saved => {
    if (saved) dialog.close();
  });
}

function showAssessmentEditor(data) {
  $('#assessmentDialog')?.remove();
  const startInPreview = Boolean(data.hasAssessment);
  const dialog = document.createElement('dialog');
  dialog.id = 'assessmentDialog';
  dialog.className = 'modal assessment-dialog';
  dialog.innerHTML = `<div class="assessment-dialog-header"><div><p class="eyebrow">NEW PATIENT ASSESSMENT · APPOINTMENT #${text(data.appointment.appointmentNumber)}</p><h2>Patient history & assessment</h2><p class="assessment-appointment-meta">${text(data.appointment.patientName)} · ${text(data.appointment.appointmentDate)} · ${text(data.appointment.membershipId || 'No membership ID')}</p></div><button class="icon-button" type="button" data-action="close-assessment" aria-label="Close assessment">×</button></div>
    <div class="assessment-editor-pane" ${startInPreview ? 'hidden' : ''}><div class="assessment-toolbar"><span>Changes save automatically</span><span id="assessmentSaveState" role="status" aria-live="polite">${data.status === 'Submitted' ? 'Submitted' : 'Draft · not saved'}</span></div>
      <div class="assessment-fields">${assessmentFormFields.map(field => `<label class="assessment-field" for="assessment-${field[0]}"><span>${text(field[1])}</span>${assessmentControl(field, data.answers[field[0]])}</label>`).join('')}</div>
      <div class="assessment-actions"><button class="button secondary-button" type="button" data-action="preview-assessment">Save &amp; preview PDF</button><button class="button primary-button" type="button" data-action="submit-assessment" ${currentUser.role === 'doctor' ? '' : 'hidden'}>Submit assessment</button></div>
    </div>
    <div class="assessment-preview-pane" ${startInPreview ? '' : 'hidden'}><div class="assessment-preview-toolbar"><button class="button secondary-button" type="button" data-action="edit-assessment">Edit form</button><span class="assessment-preview-status">${data.status === 'Submitted' ? 'Submitted assessment' : 'Saved draft'}</span><a class="button secondary-button" data-action="open-assessment-pdf" target="_blank" rel="noopener noreferrer">Open full PDF</a><button class="button secondary-button" type="button" data-action="print-assessment-pdf" disabled>Print</button><button class="button primary-button" type="button" data-action="submit-assessment" ${currentUser.role === 'doctor' && data.status !== 'Submitted' ? '' : 'hidden'}>Submit assessment</button></div><iframe title="Filled patient assessment PDF" class="assessment-pdf-frame"></iframe></div>`;
  dialog.assessmentState = { appointmentId: data.appointment.id, revision: 0, savedRevision: data.hasAssessment ? 0 : -1, timer: null, inFlight: null, status: data.status };
  document.body.append(dialog);
  const closeButton = dialog.querySelector('[data-action="close-assessment"]');
  closeButton.addEventListener('click', () => closeAssessmentDialog(dialog));
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    closeAssessmentDialog(dialog);
  });
  dialog.addEventListener('close', () => {
    clearTimeout(dialog.assessmentState.timer);
    dialog.remove();
  }, { once: true });
  dialog.querySelectorAll('[data-assessment-field]').forEach(field => {
    const grow = () => {
      if (field.tagName === 'TEXTAREA') {
        field.style.height = 'auto';
        field.style.height = `${field.scrollHeight}px`;
      }
    };
    grow();
    field.addEventListener('input', () => {
      grow();
      dialog.assessmentState.revision += 1;
      setAssessmentSaveState(dialog, 'Unsaved changes');
      clearTimeout(dialog.assessmentState.timer);
      dialog.assessmentState.timer = setTimeout(() => { saveAssessmentState(dialog); }, 700);
    });
    field.addEventListener('change', () => {
      if (field.type !== 'textarea') {
        dialog.assessmentState.revision += 1;
        setAssessmentSaveState(dialog, 'Unsaved changes');
        clearTimeout(dialog.assessmentState.timer);
        dialog.assessmentState.timer = setTimeout(() => { saveAssessmentState(dialog); }, 700);
      }
    });
  });
  dialog.querySelectorAll('[data-action="preview-assessment"]').forEach(button => button.addEventListener('click', async () => {
    if (!await saveAssessmentState(dialog)) return;
    const previewPane = dialog.querySelector('.assessment-preview-pane');
    dialog.querySelector('.assessment-editor-pane').hidden = true;
    previewPane.hidden = false;
    loadAssessmentPdf(dialog);
  }));
  dialog.querySelectorAll('[data-action="edit-assessment"]').forEach(button => button.addEventListener('click', () => {
    dialog.querySelector('.assessment-preview-pane').hidden = true;
    dialog.querySelector('.assessment-editor-pane').hidden = false;
  }));
  dialog.querySelector('[data-action="print-assessment-pdf"]').addEventListener('click', () => printAssessmentPdf(dialog));
  dialog.querySelectorAll('[data-action="submit-assessment"]').forEach(button => button.addEventListener('click', async () => {
    if (currentUser.role !== 'doctor') return;
    if (!await saveAssessmentState(dialog)) return;
    try {
      const result = await api(`/api/appointments/${encodeURIComponent(dialog.assessmentState.appointmentId)}/assessment`, {
        method: 'POST',
        body: JSON.stringify({ answers: readAssessmentAnswers(dialog) })
      });
      dialog.assessmentState.status = result.status;
      dialog.assessmentState.savedRevision = dialog.assessmentState.revision;
      setAssessmentSaveState(dialog, 'Submitted');
      dialog.querySelectorAll('.assessment-preview-status').forEach(status => { status.textContent = 'Submitted assessment'; });
      dialog.querySelectorAll('[data-action="submit-assessment"]').forEach(submit => { submit.hidden = true; });
      dialog.querySelector('.assessment-preview-pane').hidden = false;
      dialog.querySelector('.assessment-editor-pane').hidden = true;
      loadAssessmentPdf(dialog);
      showToast('Assessment submitted.');
    } catch (error) {
      setAssessmentSaveState(dialog, `Submit failed: ${error.message}`);
    }
  }));
  if (startInPreview) loadAssessmentPdf(dialog);
  dialog.showModal();
}

function loadAssessmentPdf(dialog) {
  const frame = dialog.querySelector('.assessment-pdf-frame');
  const printButton = dialog.querySelector('[data-action="print-assessment-pdf"]');
  const pdfUrl = `/api/appointments/${encodeURIComponent(dialog.assessmentState.appointmentId)}/assessment.pdf`;
  printButton.disabled = true;
  frame.onload = () => { printButton.disabled = false; };
  dialog.querySelector('[data-action="open-assessment-pdf"]').href = pdfUrl;
  frame.src = `${pdfUrl}#toolbar=1&navpanes=0`;
}

function printAssessmentPdf(dialog) {
  try {
    const pdfWindow = dialog.querySelector('.assessment-pdf-frame').contentWindow;
    if (!pdfWindow) throw new Error('The assessment preview is not ready yet.');
    pdfWindow.focus();
    pdfWindow.print();
  } catch (error) {
    showToast(error.message || 'Unable to open the print dialog.');
  }
}

async function openAssessmentPreview(appointmentId) {
  try {
    const data = await api(`/api/appointments/${encodeURIComponent(appointmentId)}/assessment`);
    if (!data.hasAssessment && currentUser.role !== 'doctor') {
      showToast('There is no saved assessment to print yet.');
      return;
    }
    showAssessmentEditor(data);
  } catch (error) {
    showToast(error.message);
  }
}

function renderWorkspace(view, data) {
  currentWorkspace = data;
  const title = workspaceHeadings[view] || view;
  $('#workspaceView').hidden = false;
  $('#workspaceView').classList.toggle('gymkhana-footfall-workspace', view === 'Footfall' && currentUser.role === 'gymkhana');
  $('#metrics').hidden = true;
  $('.content-grid').hidden = true;
  $('.bottom-grid').hidden = true;
  $('#pageTitle').innerHTML = view === 'Footfall' && currentUser.role === 'gymkhana'
    ? `<span class="footfall-title"><img src="/gymkhana.png" alt="Gymkhana logo"><span>${text(title)}<span class="wave">.</span></span></span>`
    : `${text(title)}<span class="wave">.</span>`;
  $('#pageSubtitle').textContent = view === 'Footfall' ? 'Daily clinic visits and collected revenue. Open a date to review its visit details.' : view === 'Operating hours' ? 'Aggregated inspection information.' : `Records available to your ${text(currentUser.roleLabel.toLowerCase())} account.`;
  $('#breadcrumbCurrent').textContent = view;
  const summaryLabels = { revenuePaisa: 'Revenue', expensesPaisa: 'Expense', netPaisa: 'Net' };
  const summary = data.summary ? `<div class="workspace-stat-grid">${Object.entries(data.summary).map(([key, value]) => `<div class="workspace-stat"><span>${text(view === 'Billing & expenses' ? summaryLabels[key] || key : key.replace(/[A-Z]/g, letter => ` ${letter.toLowerCase()}`))}</span><b>${key.toLowerCase().includes('paisa') ? `Rs ${(value / 100).toLocaleString()}` : text(value)}</b></div>`).join('')}</div>` : '';
  const extraTables = view === 'Billing & expenses' ? `<section class="panel bottom-panel"><div class="panel-heading compact"><div><p class="eyebrow">EXPENSE LEDGER</p><h2>Recorded expenses</h2></div></div>${renderWorkspaceTable('Expenses', data.expenses || [], 'expenseTable')}</section>` : '';
  const expenseColumns = view === 'Billing & expenses' ? renderWorkspaceTable(view, data.rows || []) : '';
  const table = view === 'Billing & expenses'
    ? expenseColumns
    : view === 'Clinical records'
      ? renderClinicalRecordsByDate(data.rows || [])
      : renderWorkspaceTable(view, data.rows || []);
  const clinicalMonthLabel = view === 'Clinical records' ? formatMonthLabel(data.month) : '';
  const note = view === 'Compliance' && currentUser.role === 'gymkhana' ? '<div class="workspace-note">Inspection view is limited to checklist results. Patient contact details and clinical notes are not shown.</div>' : '';
  const recordCountLabel = view === 'Clinical records' ? `${text(clinicalMonthLabel)} · ${(data.rows || []).length} patient visits` : `${(data.rows || []).length} records`;
  const clubShareTotal = view === 'Footfall' && currentUser.role === 'gymkhana'
    ? `<div class="footfall-club-share-total"><span>Total club share:  </span><strong id="workspaceClubShareTotal">Rs ${((data.rows || []).reduce((total, row) => total + (Number(row.clubSharePaisa) || 0), 0) / 100).toLocaleString()}</strong></div>`
    : '';
  $('#workspaceView').innerHTML = `${summary}<div class="workspace-toolbar"><p>${recordCountLabel}</p><div class="workspace-toolbar-actions"><input class="workspace-search" id="workspaceSearch" type="search" placeholder="Search this page" aria-label="Search records">${workspaceActions(view)}${clubShareTotal}</div></div>${note}${table}${extraTables}`;
  $('#workspaceSearch').addEventListener('input', event => {
    const query = event.target.value.trim().toLowerCase();
    $('#workspaceView').querySelectorAll('tbody tr').forEach(row => { row.hidden = !row.dataset.search.includes(query); });
    if (view === 'Footfall' && currentUser.role === 'gymkhana') updateFootfallClubShareTotal($('#workspaceView'), '#workspaceClubShareTotal');
  });
  $('#workspaceView').querySelectorAll('[data-action]').forEach(element => {
    if (element.dataset.action === 'update-club-share') element.addEventListener('change', () => updateClubShare(element, view));
    else if (element.dataset.action === 'update-payment-amount') element.addEventListener('change', () => updatePaymentAmountOnce(element, view));
    else if (['select-patient-appointment', 'select-patient-status-appointment'].includes(element.dataset.action)) {
      element.addEventListener('change', () => syncPatientAppointmentControls(element));
    }
    else if (element.dataset.action === 'update-patient-status') element.addEventListener('change', () => updatePatientAppointmentStatus(element));
    else if (element.tagName === 'SELECT') element.addEventListener('change', () => element.dataset.action === 'payment-status' ? updatePaymentStatus(element.dataset.id, element.value, view) : updateTask(element.dataset.id, element.value));
    else if (element.dataset.action === 'update-session') element.addEventListener('change', () => updateSessionNumber(element, view));
    else if (element.dataset.action === 'update-prescribed-sessions') element.addEventListener('change', () => updatePrescribedSessions(element, view));
    else element.addEventListener('click', () => handleWorkspaceAction(element, view));
  });
}

async function openWorkspace(view, month = '') {
  closeMobileNavigation();
  currentView = view;
  if (view === 'Clinical records') currentClinicalRecordsMonth = month;
  renderNavigation();
  $('#workspaceView').hidden = false;
  $('#metrics').hidden = true;
  $('.content-grid').hidden = true;
  $('.bottom-grid').hidden = true;
  $('#workspaceView').innerHTML = '<div class="panel empty-state">Loading records…</div>';
  try {
    const query = new URLSearchParams({ view });
    if (view === 'Clinical records' && month) query.set('month', month);
    const data = await api(`/api/workspace?${query}`);
    if (currentView === view) renderWorkspace(view, data);
  } catch (error) {
    $('#workspaceView').innerHTML = `<div class="panel empty-state">${text(error.message)}</div>`;
  }
}

async function handleWorkspaceAction(button, view) {
  const { action, id } = button.dataset;
  if (action === 'print-assessment') return openAssessmentPreview(id);
  if (action === 'start-appointment') return updateDoctorAppointmentStatus(id, 'In session');
  if (action === 'open-patient-full-record') {
    try {
      const record = await api(`/api/patients/${encodeURIComponent(id)}/full-record`);
      showPatientFullRecord(record);
    } catch (error) {
      showToast(error.status === 404 && error.message === 'Not found.'
        ? 'Patient history is not available on this server yet. Restart PMS, then reload the page.'
        : error.message);
    }
    return;
  }
  if (action === 'delete-patient-appointment') {
    const selectedOption = button.closest('td')?.querySelector('[data-action="select-patient-appointment"]')?.selectedOptions?.[0];
    const appointmentNumber = selectedOption?.value || button.dataset.appointmentNumber;
    if (!appointmentNumber) return showToast('No appointment ID is available for this patient.');
    const appointmentDate = selectedOption?.dataset.date || button.dataset.date;
    const appointmentTime = selectedOption?.dataset.time || button.dataset.time;
    const visitDate = appointmentDate ? ` on ${appointmentDate}${appointmentTime ? ` at ${appointmentTime}` : ''}` : '';
    if (!confirm(`Delete only ${button.dataset.name}'s appointment #${appointmentNumber}${visitDate}, including its billing, assessment, and session notes? Other appointments and patient history will be kept.`)) return;
    try {
      const result = await api(`/api/appointments/by-number/${encodeURIComponent(appointmentNumber)}`, { method: 'DELETE' });
      await openWorkspace(view);
      showToast(result.patientRemoved
        ? `Appointment #${appointmentNumber} and its duplicate patient record were deleted.`
        : `Appointment #${appointmentNumber} was deleted. The patient's other records were kept.`);
    } catch (error) { showToast(error.message); }
    return;
  }
  if (action === 'delete-patient-record') {
    const selectedOption = button.closest('td')?.querySelector('[data-action="select-patient-appointment"]')?.selectedOptions?.[0];
    const appointmentNumber = selectedOption?.value || button.dataset.appointmentNumber;
    if (!appointmentNumber) return showToast('No appointment ID is available for this patient record.');
    if (!confirm(`Delete the patient record for ${button.dataset.name}, selected by appointment #${appointmentNumber}, and all appointments, billing, assessments, and clinical notes attached to that patient record? Other separately registered patient records will be kept.`)) return;
    try {
      const result = await api(`/api/patients/by-appointment/${encodeURIComponent(appointmentNumber)}`, { method: 'DELETE' });
      await openWorkspace(view);
      showToast(`Patient record selected by appointment #${appointmentNumber} deleted with ${result.deletedAppointments} appointment(s). Other patient records were kept.`);
    } catch (error) { showToast(error.message); }
    return;
  }
  if (action === 'open-invoice') return openInvoice(id);
  if (action === 'open-clinical-archive') return openWorkspace('Clinical archive');
  if (action === 'open-current-clinical-records') return openWorkspace('Clinical records');
  if (action === 'open-clinical-month') return openWorkspace('Clinical records', button.dataset.month);
  if (action === 'open-footfall-date') {
    try {
      const query = new URLSearchParams({ view: 'Footfall', date: button.dataset.date });
      const data = await api(`/api/workspace?${query}`);
      if (currentView === view) showFootfallRecordModal(button.dataset.date, data.detailRows || []);
    } catch (error) { showToast(error.message); }
    return;
  }
  if (action === 'open-footfall-records') {
    const month = $('#footfallMonthPicker')?.value || '';
    if (!month) return showToast('Choose a month to view records.');
    try {
      const query = new URLSearchParams({ view: 'Footfall', month });
      const data = await api(`/api/workspace?${query}`);
      if (currentView === view) showFootfallRecordModal(formatMonthLabel(month), data.detailRows || []);
    } catch (error) { showToast(error.message); }
    return;
  }
  if (action === 'new-appointment') return openCheckin();
  if (action === 'complete-appointment') return markAppointmentComplete(id);
  if (action === 'add-staff') return createStaffAccount();
  if (action === 'assign-membership') {
    const membershipId = prompt(`Admin-issued ID for ${button.dataset.name}:`);
    if (!membershipId) return;
    try {
      await api(`/api/patients/${encodeURIComponent(id)}/membership`, { method: 'PATCH', body: JSON.stringify({ membershipId }) });
      await openWorkspace(view);
      showToast('Admin-issued ID assigned. The patient stays a separate record.');
    } catch (error) { showToast(error.message); }
  }
  if (action === 'toggle-staff') {
    const active = button.dataset.active === 'true';
    const change = active ? 'restrict access for' : 'restore access for';
    if (!confirm(`Are you sure you want to ${change} ${button.dataset.name}?`)) return;
    try {
      await api(`/api/users/${encodeURIComponent(id)}/access`, { method: 'PATCH', body: JSON.stringify({ active: !active }) });
      await openWorkspace(view);
      showToast(active ? 'Staff access restricted. Their active sessions were closed.' : 'Staff access restored.');
    } catch (error) { showToast(error.message); }
  }
  if (action === 'reset-staff-password') {
    $('#resetStaffPasswordTarget').textContent = `Set a new password for ${button.dataset.name}.`;
    $('#resetStaffPasswordForm').dataset.userId = id;
    displayError('#staffPasswordResetError', '');
    $('#resetStaffPasswordModal').showModal();
  }
  if (action === 'delete-staff') {
    if (!confirm(`Permanently delete ${button.dataset.name}'s login account? Their linked clinic records will be kept with staff attribution anonymized.`)) return;
    try {
      await api(`/api/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await openWorkspace(view);
      showToast('Staff login deleted. Historical clinic records were preserved.');
    } catch (error) { showToast(error.message); }
  }
  if (action === 'add-task') {
    const title = prompt('Task name:');
    if (!title) return;
    const dueDate = prompt('Due date (YYYY-MM-DD):', new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date()));
    if (!dueDate) return;
    await saveWorkspaceRecord('/api/tasks', { title, dueDate }, view);
  }
  if (action === 'add-compliance') {
    const checkName = prompt('Hygiene or equipment check:');
    if (!checkName) return;
    const status = prompt('Result: Passed or Needs attention', 'Passed');
    if (!status) return;
    const notes = prompt('Short note (optional):', '') || '';
    await saveWorkspaceRecord('/api/compliance', { checkName, status, notes }, view);
  }
  if (action === 'add-expense') {
    const category = prompt('Expense category:');
    if (!category) return;
    const description = prompt('Description:');
    if (!description) return;
    const amount = Number(prompt('Amount in PKR:'));
    if (!Number.isFinite(amount) || amount <= 0) return showToast('Enter a valid positive amount.');
    await saveWorkspaceRecord('/api/expenses', { category, description, amountPaisa: Math.round(amount * 100) }, view);
  }
  if (action === 'add-inventory') {
    const name = prompt('Item name:');
    if (!name) return;
    const category = prompt('Category (equipment or consumable):', 'Consumable');
    if (!category) return;
    const quantity = Number(prompt('Current quantity:', '0'));
    const unit = prompt('Unit (pieces, boxes, bottles):', 'pieces');
    const reorderAt = Number(prompt('Alert when stock reaches:', '2'));
    if (!Number.isInteger(quantity) || !Number.isInteger(reorderAt) || !unit) return showToast('Enter whole-number quantities and a unit.');
    await saveWorkspaceRecord('/api/inventory', { name, category, quantity, unit, reorderAt }, view);
  }
  if (action === 'update-stock') {
    const quantity = Number(prompt(`New stock count for ${button.dataset.name}:`, button.dataset.quantity));
    if (!Number.isInteger(quantity) || quantity < 0) return showToast('Enter a non-negative whole-number stock count.');
    try {
      await api(`/api/inventory/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ quantity }) });
      await openWorkspace(view);
      showToast('Inventory quantity updated.');
    } catch (error) { showToast(error.message); }
  }
  if (action === 'edit-appointment') {
    const date = prompt('Appointment date (YYYY-MM-DD):', button.dataset.date);
    if (!date) return;
    const time = prompt('Appointment time (HH:MM):', button.dataset.time);
    if (!time) return;
    const status = prompt('Status: Confirmed, Waiting, In session, Completed, or Cancelled', button.dataset.status);
    if (!status) return;
    try {
      await api(`/api/appointments/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ date, time, status }) });
      await openWorkspace(view);
      showToast('Appointment updated.');
    } catch (error) { showToast(error.message); }
  }
  if (action === 'edit-payment') {
    const paymentMode = prompt('Payment method: Cash, Online, or POS', ['Cash', 'Online', 'POS'].includes(button.dataset.mode) ? button.dataset.mode : 'Cash');
    if (!paymentMode) return;
    const amount = Number(prompt('Correct amount in PKR:', String(Number(button.dataset.amount || 0) / 100)));
    if (!Number.isFinite(amount) || amount < 0) return showToast('Enter a valid non-negative amount.');
    const paymentStatus = prompt('Payment status: Paid or Unpaid', button.dataset.paymentStatus || 'Paid');
    if (!paymentStatus) return;
    try {
      await api(`/api/appointments/${encodeURIComponent(id)}/payment`, { method: 'PATCH', body: JSON.stringify({ paymentMode: paymentMode.trim(), amountPaisa: Math.round(amount * 100), paymentStatus: paymentStatus.trim() }) });
      await openWorkspace(view);
      showToast('Payment record corrected.');
    } catch (error) { showToast(error.message); }
  }
  if (action === 'edit-patient') {
    const name = prompt('Patient name:', button.dataset.name);
    if (!name) return;
    const phone = prompt('Phone number:', button.dataset.phone);
    if (!phone) return;
    const condition = prompt('Condition:', button.dataset.condition);
    const ageValue = prompt('Age (optional):', button.dataset.age);
    const age = ageValue ? Number(ageValue) : null;
    try {
      await api(`/api/patients/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name, phone, condition: condition || '', age: Number.isInteger(age) ? age : null }) });
      await openWorkspace(view);
      showToast('Patient record corrected.');
    } catch (error) { showToast(error.message); }
  }
}

async function saveWorkspaceRecord(url, body, view) {
  try {
    await api(url, { method: 'POST', body: JSON.stringify(body) });
    await openWorkspace(view);
    showToast('Record saved.');
  } catch (error) { showToast(error.message); }
}

async function updatePaymentStatus(id, paymentStatus, view) {
  try {
    await api(`/api/appointments/${encodeURIComponent(id)}/payment`, { method: 'PATCH', body: JSON.stringify({ paymentStatus }) });
    await openWorkspace(view);
    showToast('Payment status updated.');
  } catch (error) {
    showToast(error.message);
    await openWorkspace(view);
  }
}

async function updatePaymentAmountOnce(input, view) {
  const amount = Number(input.value);
  const amountPaisa = Math.round(amount * 100);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(amountPaisa)) {
    showToast('Enter a valid non-negative payment amount.');
    input.value = input.defaultValue;
    return;
  }
  try {
    await api(`/api/appointments/${encodeURIComponent(input.dataset.id)}/payment`, {
      method: 'PATCH',
      body: JSON.stringify({ amountPaisa })
    });
    await openWorkspace(view);
    showToast('Payment amount updated. Managers can edit it only once.');
  } catch (error) {
    showToast(error.message);
    input.value = input.defaultValue;
  }
}

async function updateClubShare(input, view) {
  const amount = Number(input.value);
  const amountPaisa = Math.round(amount * 100);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(amountPaisa)) {
    showToast('Enter a valid non-negative club share amount.');
    input.value = input.defaultValue;
    return;
  }
  try {
    await api(`/api/appointments/${encodeURIComponent(input.dataset.id)}/payment`, { method: 'PATCH', body: JSON.stringify({ clubSharePaisa: amountPaisa }) });
    await openWorkspace(view);
    showToast('Club share saved.');
  } catch (error) {
    showToast(error.message);
    input.value = input.defaultValue;
  }
}

async function updateSessionNumber(input, view) {
  const sessionNumber = Number(input.value);
  if (!Number.isSafeInteger(sessionNumber) || sessionNumber < 1) {
    showToast('Session must be a positive whole number.');
    input.value = input.defaultValue;
    return;
  }
  try {
    await api(`/api/appointments/${encodeURIComponent(input.dataset.id)}/session`, { method: 'PATCH', body: JSON.stringify({ sessionNumber }) });
    showToast('Session number updated.');
    await openWorkspace(view, view === 'Clinical records' ? currentClinicalRecordsMonth : '');
  } catch (error) {
    showToast(error.message);
    input.value = input.defaultValue;
  }
}

async function updatePrescribedSessions(input, view) {
  const sessionsPrescribed = input.value === '' ? null : Number(input.value);
  if (sessionsPrescribed !== null && (!Number.isSafeInteger(sessionsPrescribed) || sessionsPrescribed < 1 || sessionsPrescribed > 100)) {
    showToast('Prescribed sessions must be a whole number from 1 to 100.');
    input.value = input.defaultValue;
    return;
  }
  try {
    await api(`/api/patients/${encodeURIComponent(input.dataset.id)}/sessions`, { method: 'PATCH', body: JSON.stringify({ sessionsPrescribed }) });
    showToast('Prescribed session count updated.');
    await openWorkspace(view, view === 'Clinical records' ? currentClinicalRecordsMonth : '');
  } catch (error) {
    showToast(error.message);
    input.value = input.defaultValue;
  }
}

async function updateTask(id, status) {
  try {
    await api(`/api/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ status }) });
    showToast('Task status updated.');
  } catch (error) { showToast(error.message); }
}

function populateDoctors(doctors) {
  const select = $('#checkinForm select[name="doctor"]');
  if (!doctors.length) {
    select.innerHTML = '<option value="">No clinician accounts available</option>';
    return;
  }
  select.innerHTML = doctors.map(doctor => `<option value="${text(doctor.id)}">${text(doctor.name)}</option>`).join('');
}

function openNoteForm() {
  const form = $('#noteForm');
  form.reset();
  form.elements.lookupType.value = 'appointment';
  form.elements.appointmentId.value = '';
  $('#noteLookupLabel').childNodes[0].nodeValue = 'Appointment ID';
  $('#noteAppointmentNumber').placeholder = 'Enter appointment ID, e.g. 1278';
  $('#memberAppointmentField').hidden = true;
  $('#memberAppointmentSelect').innerHTML = '';
  $('#appointmentNoteHistory').hidden = true;
  $('#appointmentNoteHistory').innerHTML = '';
  $('#noteModal').showModal();
  $('#noteAppointmentNumber').focus();
}

let appointmentLookupSequence = 0;

async function lookupAppointmentNoteHistory() {
  const form = $('#noteForm');
  const lookupType = form.elements.lookupType.value;
  const lookupNumber = form.elements.lookupNumber.value.trim();
  const appointmentIdField = form.elements.appointmentId;
  const panel = $('#appointmentNoteHistory');
  const sequence = ++appointmentLookupSequence;
  appointmentIdField.value = '';
  if (!lookupNumber) {
    panel.hidden = true;
    panel.innerHTML = '';
    return;
  }
  if (lookupType === 'membership') $('#memberAppointmentSelect').innerHTML = '';
  panel.hidden = false;
  panel.innerHTML = `<div class="member-history-empty">Looking up ${lookupType === 'membership' ? 'member and previous notes' : 'appointment and previous notes'}…</div>`;
  try {
    const result = lookupType === 'membership'
      ? await api(`/api/members/${encodeURIComponent(lookupNumber)}`)
      : await api(`/api/appointment-lookup/${encodeURIComponent(lookupNumber)}`);
    if (sequence !== appointmentLookupSequence || form.elements.lookupNumber.value.trim() !== lookupNumber || form.elements.lookupType.value !== lookupType) return;
    const appointment = lookupType === 'membership' ? null : result.appointment;
    if (lookupType === 'appointment') appointmentIdField.value = appointment.id;
    else {
      const visits = result.visits.filter(visit => visit.status !== 'Cancelled');
      $('#memberAppointmentField').hidden = false;
      $('#memberAppointmentSelect').innerHTML = visits.map(visit => `<option value="${text(visit.id)}">#${text(visit.appointmentNumber)} · ${text(visit.date)} ${text(visit.time)} · ${text(visit.status)}</option>`).join('');
      if (visits.length) appointmentIdField.value = visits[0].id;
      else panel.innerHTML = '<div class="member-history-empty">No usable appointments found for this member.</div>';
    }
    const priorNotes = result.notes.map(note => `<article class="appointment-note-history-item"><div class="member-history-heading"><span>Appointment #${text(note.appointmentNumber ?? '—')} · ${text(note.createdAt)}</span><small>${text(note.doctor)}</small></div><p>${text(note.note)}</p>${note.treatmentPlan ? `<small>Plan: ${text(note.treatmentPlan)}</small>` : ''}${note.nextVisit ? `<small>Next visit: ${text(note.nextVisit)}</small>` : ''}</article>`).join('');
    const heading = lookupType === 'membership'
      ? `<div class="member-history-heading"><span>Member · ${text(result.member.membershipId)} · ${text(result.member.name)}</span><small>${text(result.visitCount)} assigned visits</small></div>`
      : `<div class="member-history-heading"><span>Appointment #${text(appointment.appointmentNumber)} · ${text(appointment.patient)}</span><small>${text(appointment.date)} · ${text(appointment.time)} · ${text(statusLabel(appointment.status))}</small></div>`;
    panel.innerHTML = `${heading}<div class="member-history-list">${priorNotes || '<div class="member-history-empty">No previous session notes for this patient.</div>'}</div>`;
  } catch (error) {
    if (sequence !== appointmentLookupSequence) return;
    $('#memberAppointmentField').hidden = true;
    $('#memberAppointmentSelect').innerHTML = '';
    panel.innerHTML = `<div class="member-history-empty member-lookup-error">${text(error.message)}</div>`;
  }
}

async function loadDashboard() {
  try {
    selectedScheduleDate ||= clinicToday();
    const query = new URLSearchParams({ date: selectedScheduleDate, mode: scheduleMode });
    const data = await api(`/api/dashboard?${query}`);
    dashboardData = data;
    selectedScheduleDate = data.schedule.selectedDate;
    if (currentView === 'Overview') renderDashboard(data);
    else {
      if ($('#assessmentDialog[open]')) return;
      if ($('#footfallRecordModal[open]')) return;
      const view = currentView;
      const query = new URLSearchParams({ view });
      if (view === 'Clinical records' && currentClinicalRecordsMonth) query.set('month', currentClinicalRecordsMonth);
      const workspace = await api(`/api/workspace?${query}`);
      if (currentView === view) renderWorkspace(view, workspace);
    }
  } catch (error) {
    if (error.status === 401) return setAuthenticated(null);
    showToast(error.message);
  }
}

async function markAppointmentComplete(appointmentId) {
  return updateDoctorAppointmentStatus(appointmentId, 'Completed');
}

async function updateDoctorAppointmentStatus(appointmentId, status) {
  try {
    await api(`/api/appointments/${encodeURIComponent(appointmentId)}`, { method: 'PATCH', body: JSON.stringify({ status }) });
    await loadDashboard();
    showToast(status === 'Completed' ? 'Appointment marked completed. All clinic views are updated.' : 'Appointment marked in progress. The clinic queue is updated.');
  } catch (error) { showToast(error.message); }
}

function openCheckin() {
  closeMobileNavigation();
  const form = $('#checkinForm');
  form.reset();
  resetMemberLookup();
  syncRegistrationMode();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());
  form.elements.date.value = today;
  form.elements.time.value = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  $('#checkinModal').showModal();
}

let memberLookupSequence = 0;
let resolvedMembershipId = '';

function resetMemberLookup() {
  resolvedMembershipId = '';
  const form = $('#checkinForm');
  for (const fieldName of ['name', 'phone', 'age']) {
    form.elements[fieldName].readOnly = false;
    form.elements[fieldName].value = '';
  }
  form.elements.sessionsPrescribed.readOnly = false;
  form.elements.sessionsPrescribed.value = '';
  $('#memberHistory').hidden = true;
  $('#memberHistory').innerHTML = '';
}

async function lookupGymkhanaMember() {
  const form = $('#checkinForm');
  if (form.elements.registrationMode.value !== 'membership') return;
  const membershipId = form.elements.membershipId.value.trim();
  const panel = $('#memberHistory');
  const sequence = ++memberLookupSequence;
  if (!membershipId) {
    resetMemberLookup();
    return;
  }
  if (resolvedMembershipId && resolvedMembershipId.toLowerCase() !== membershipId.toLowerCase()) resetMemberLookup();
  panel.hidden = false;
  panel.innerHTML = '<div class="member-history-empty">Checking Gymkhana membership…</div>';
  try {
    const result = await api(`/api/members/${encodeURIComponent(membershipId)}`);
    if (sequence !== memberLookupSequence || form.elements.membershipId.value.trim().toLowerCase() !== membershipId.toLowerCase()) return;
    resolvedMembershipId = membershipId;
    form.elements.name.value = result.member.name;
    form.elements.phone.value = result.member.phone;
    form.elements.age.value = result.member.age ?? '';
    form.elements.sessionsPrescribed.value = result.member.sessionsPrescribed ?? '';
    form.elements.sessionsPrescribed.readOnly = true;
    for (const fieldName of ['name', 'phone', 'age']) form.elements[fieldName].readOnly = true;
    form.elements.visit.value = 'Follow-up';
    const visits = result.visits.map(visit => `<div class="member-history-row"><span>${text(visit.date)} · ${text(visit.time)}</span><span>${text(visit.visit)}</span><span>${text(visit.doctor)}</span><span>${text(statusLabel(visit.status))}</span></div>`).join('');
    panel.innerHTML = `<div class="member-history-heading"><span>Member found · ${text(result.member.membershipId)}</span><small>${result.visitCount} previous ${result.visitCount === 1 ? 'visit' : 'visits'}</small></div><div class="member-history-list">${visits || '<div class="member-history-empty">No previous appointments found.</div>'}</div>`;
  } catch (error) {
    if (sequence !== memberLookupSequence) return;
    resolvedMembershipId = '';
    for (const fieldName of ['name', 'phone', 'age']) form.elements[fieldName].readOnly = false;
    form.elements.sessionsPrescribed.readOnly = false;
    if (error.status === 404) panel.innerHTML = '<div class="member-history-empty">No existing member found. Enter the new member details below.</div>';
    else panel.innerHTML = `<div class="member-history-empty member-lookup-error">${text(error.message)}</div>`;
  }
}

async function createStaffAccount() {
  const email = prompt('New staff work email:');
  if (!email) return;
  const name = prompt('Staff member full name:');
  if (!name) return;
  const role = prompt('Role: manager, doctor, or gymkhana');
  if (!role) return;
  const password = prompt('Temporary password (minimum 14 characters):');
  if (!password) return;
  try {
    await api('/api/users', { method: 'POST', body: JSON.stringify({ email, name, role: role.trim().toLowerCase(), password }) });
    showToast('Staff account created. Share the temporary password securely.');
    await loadDashboard();
  } catch (error) { showToast(error.message); }
}

$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const formElement = event.currentTarget;
  displayError('#loginError', '');
  const form = new FormData(formElement);
  const button = $('#loginSubmit');
  button.disabled = true;
  button.textContent = 'Signing in…';
  try {
    const result = await api('/api/login', { method: 'POST', body: JSON.stringify({ email: form.get('email'), password: form.get('password') }) });
    formElement.reset();
    setAuthenticated(result.user);
  } catch (error) { displayError('#loginError', error.message); }
  finally { button.disabled = false; button.innerHTML = 'Sign in <span></span>'; }
});

$('#setupForm').addEventListener('submit', async event => {
  event.preventDefault();
  const formElement = event.currentTarget;
  displayError('#setupError', '');
  const form = new FormData(formElement);
  const button = $('#setupSubmit');
  button.disabled = true;
  try {
    const result = await api('/api/setup', { method: 'POST', body: JSON.stringify({ name: form.get('name'), email: form.get('email'), password: form.get('password') }) });
    formElement.reset();
    setAuthenticated(result.user);
  } catch (error) { displayError('#setupError', error.message); }
  finally { button.disabled = false; }
});

$('#signoutButton').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST', body: '{}' }); } finally { setAuthenticated(null); }
});

$('#changePasswordButton').addEventListener('click', () => {
  displayError('#passwordChangeError', '');
  $('#changePasswordModal').showModal();
});
$('#closePasswordModal').addEventListener('click', () => $('#changePasswordModal').close());
$('#cancelPasswordModal').addEventListener('click', () => $('#changePasswordModal').close());
$('#changePasswordForm').addEventListener('submit', async event => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const currentPassword = form.get('currentPassword');
  const newPassword = form.get('newPassword');
  if (newPassword !== form.get('confirmPassword')) {
    return displayError('#passwordChangeError', 'The new passwords do not match.');
  }
  displayError('#passwordChangeError', '');
  const button = formElement.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    await api('/api/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
    formElement.reset();
    $('#changePasswordModal').close();
    showToast('Password updated. Other active sessions were signed out.');
  } catch (error) {
    displayError('#passwordChangeError', error.message);
  } finally { button.disabled = false; }
});

$('#closeStaffPasswordResetModal').addEventListener('click', () => $('#resetStaffPasswordModal').close());
$('#cancelStaffPasswordResetModal').addEventListener('click', () => $('#resetStaffPasswordModal').close());
$('#resetStaffPasswordForm').addEventListener('submit', async event => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const newPassword = form.get('newPassword');
  if (newPassword !== form.get('confirmPassword')) {
    return displayError('#staffPasswordResetError', 'The passwords do not match.');
  }
  displayError('#staffPasswordResetError', '');
  const button = formElement.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    await api(`/api/users/${encodeURIComponent(formElement.dataset.userId)}/password`, {
      method: 'POST', body: JSON.stringify({ newPassword })
    });
    formElement.reset();
    $('#resetStaffPasswordModal').close();
    showToast('Staff password reset. Share it through a secure channel.');
  } catch (error) {
    displayError('#staffPasswordResetError', error.message);
  } finally { button.disabled = false; }
});

$('#checkinForm').addEventListener('submit', async event => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const amount = Number(form.get('amount'));
  try {
    const result = await api('/api/checkins', { method: 'POST', body: JSON.stringify({
      name: form.get('name'), registrationMode: form.get('registrationMode'), membershipId: form.get('membershipId'), phone: form.get('phone'), age: form.get('age') ? Number(form.get('age')) : null, condition: form.get('condition'),
      sessionsPrescribed: form.get('sessionsPrescribed') ? Number(form.get('sessionsPrescribed')) : null,
      doctorId: form.get('doctor'), visitType: form.get('visit'), date: form.get('date'), time: form.get('time'),
      paymentMode: form.get('payment'), paymentStatus: form.get('paymentStatus'), amountPaisa: Math.round(amount * 100)
    }) });
    formElement.reset();
    resetMemberLookup();
    $('#checkinModal').close();
    await loadDashboard();
    showToast(result.existingPatient ? 'Existing member found. Follow-up attached to their profile.' : result.membershipMissing ? `Appointment-only patient added. Appointment ID #${result.appointmentNumber}.` : `New member checked in. Appointment ID #${result.appointmentNumber}.`);
  } catch (error) { showToast(error.message); }
});

$('#noteForm').addEventListener('submit', async event => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  if (!form.get('appointmentId')) return showToast('Enter a valid appointment ID and wait for its history to load.');
  try {
    await api('/api/notes', { method: 'POST', body: JSON.stringify({ appointmentId: form.get('appointmentId'), note: form.get('note'), treatmentPlan: form.get('treatmentPlan'), nextVisit: form.get('nextVisit') }) });
    formElement.reset();
    $('#appointmentNoteHistory').hidden = true;
    $('#appointmentNoteHistory').innerHTML = '';
    $('#noteModal').close();
    if (currentView === 'Overview') await loadDashboard();
    else await openWorkspace(currentView);
    showToast('Clinical session note saved.');
  } catch (error) { showToast(error.message); }
});

$('#noteAppointmentNumber').addEventListener('input', () => {
  appointmentLookupSequence += 1;
  $('#noteForm').elements.appointmentId.value = '';
  $('#memberAppointmentField').hidden = true;
  $('#memberAppointmentSelect').innerHTML = '';
  $('#appointmentNoteHistory').hidden = true;
  $('#appointmentNoteHistory').innerHTML = '';
});
$('#noteAppointmentNumber').addEventListener('change', lookupAppointmentNoteHistory);
$('#noteAppointmentNumber').addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    lookupAppointmentNoteHistory();
  }
});
$('#noteLookupType').addEventListener('change', () => {
  appointmentLookupSequence += 1;
  $('#noteForm').elements.lookupNumber.value = '';
  $('#noteForm').elements.appointmentId.value = '';
  $('#memberAppointmentField').hidden = true;
  $('#memberAppointmentSelect').innerHTML = '';
  $('#appointmentNoteHistory').hidden = true;
  $('#appointmentNoteHistory').innerHTML = '';
  const membershipMode = $('#noteLookupType').value === 'membership';
  $('#noteLookupLabel').childNodes[0].nodeValue = membershipMode ? 'Membership ID' : 'Appointment ID';
  $('#noteAppointmentNumber').placeholder = membershipMode ? 'Enter Gymkhana membership ID' : 'Enter appointment ID, e.g. 1278';
  $('#noteAppointmentNumber').focus();
});
$('#memberAppointmentSelect').addEventListener('change', () => {
  $('#noteForm').elements.appointmentId.value = $('#memberAppointmentSelect').value;
});

$('#closeModal').addEventListener('click', () => $('#checkinModal').close());
$('#cancelModal').addEventListener('click', () => $('#checkinModal').close());
$('#closeNoteModal').addEventListener('click', () => $('#noteModal').close());
$('#cancelNoteModal').addEventListener('click', () => $('#noteModal').close());
$('#menuToggle').addEventListener('click', () => {
  const isOpen = $('#sidebar').classList.toggle('open');
  $('#menuToggle').setAttribute('aria-expanded', String(isOpen));
  $('#menuToggle').setAttribute('aria-label', isOpen ? 'Close navigation' : 'Open navigation');
});
$('#previousSchedule').addEventListener('click', () => {
  selectedScheduleDate ||= clinicToday();
  selectedScheduleDate = shiftScheduleDate(selectedScheduleDate, scheduleMode === 'week' ? -7 : -1);
  loadDashboard();
});
$('#nextSchedule').addEventListener('click', () => {
  selectedScheduleDate ||= clinicToday();
  selectedScheduleDate = shiftScheduleDate(selectedScheduleDate, scheduleMode === 'week' ? 7 : 1);
  loadDashboard();
});
$('#dayViewButton').addEventListener('click', () => {
  scheduleMode = 'day';
  loadDashboard();
});
$('#weekViewButton').addEventListener('click', () => {
  scheduleMode = 'week';
  loadDashboard();
});
$('#viewAllButton').addEventListener('click', () => {
  scheduleMode = 'week';
  loadDashboard();
});

async function showInitialSetupIfRequired() {
  try {
    const status = await api('/api/setup-status');
    if (!status.setupRequired) return;
    $('#loginForm').hidden = true;
    $('.auth-content > .eyebrow').hidden = true;
    $('#loginTitle').hidden = true;
    $('.auth-subtitle').hidden = true;
    $('#loginError').hidden = true;
    $('.auth-footnote').hidden = true;
    $('#setupForm').hidden = false;
  } catch (error) {
    if (error.status !== 401) displayError('#loginError', 'Unable to connect to the clinic server. Try again shortly.');
  }
}

api('/api/session').then(async result => {
  setAuthenticated(result.user);
  if (!result.user) await showInitialSetupIfRequired();
}).catch(async error => {
  setAuthenticated(null);
  if (error.status === 401) return showInitialSetupIfRequired();
  displayError('#loginError', 'Unable to connect to the clinic server. Try again shortly.');
});

$('#membershipIdInput').addEventListener('change', lookupGymkhanaMember);
$('#registrationMode').addEventListener('change', syncRegistrationMode);
$('#membershipIdInput').addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    lookupGymkhanaMember();
  }
});