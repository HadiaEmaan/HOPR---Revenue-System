const defaultAppointments = [
  { time: '09:00', name: 'Ayesha Khan', doctor: 'Dr. Ayesha Malik', visit: 'Follow-up', area: 'Lower back', status: 'In session', initials: 'AK', color: '#e8f0f3', payment: 'Cash' },
  { time: '09:30', name: 'Usman Tariq', doctor: 'Dr. Hamza Raza', visit: 'New patient', area: 'Knee pain', status: 'Waiting', initials: 'UT', color: '#eceff1', payment: 'Online' },
  { time: '10:00', name: 'Mariam Ali', doctor: 'Dr. Ayesha Malik', visit: 'Follow-up', area: 'Frozen shoulder', status: 'Confirmed', initials: 'MA', color: '#edf1e8', payment: 'Cash' },
  { time: '10:30', name: 'Bilal Ahmed', doctor: 'Dr. Hamza Raza', visit: 'Follow-up', area: 'Cervical pain', status: 'Confirmed', initials: 'BA', color: '#f2eaf2', payment: 'Online' },
  { time: '11:00', name: 'Noor Fatima', doctor: 'Dr. Sara Ahmed', visit: 'New patient', area: 'Ankle sprain', status: 'Confirmed', initials: 'NF', color: '#eaf2f3', payment: 'Unpaid' }
];

const roles = {
  admin: { name: 'Sara Ahmed', title: 'Good morning, Sara', subtitle: 'Here’s what’s happening across your clinic today.', role: 'Clinic Admin', metrics: [['Today’s visits', '32', '↑ 8.3%', 'vs. last Monday', '♧'], ['Revenue today', 'Rs 48,500', '↑ 6.2%', 'Cash + digital', '↗'], ['Waiting now', '04', '2 new', 'Avg. wait 12 min', '◷'], ['Team on duty', '06 / 08', '75%', '2 shifts today', '♙']], nav: ['Overview', 'Appointments', 'Patients', 'Clinical records', 'Billing & expenses', 'Staff & shifts', 'Inventory', 'Reports & audit'], primary: 'Today’s appointments', insight: 'Patient visits', secondary: 'Doctor utilisation' },
  manager: { name: 'Hina Farooq', title: 'Good morning, Hina', subtitle: 'Your team and clinic flow, all in one place.', role: 'Clinic Manager', metrics: [['Appointments today', '32', '↑ 8.3%', '4 doctors scheduled', '▦'], ['In waiting room', '04', '2 new', 'Avg. wait 12 min', '◷'], ['Rooms in use', '03 / 04', '75%', '1 room available', '⌂'], ['Tasks to complete', '05', '2 due soon', 'Today’s checklist', '✓']], nav: ['Overview', 'Live queue', 'Appointments', 'Patients', 'Patient check-in', 'Receipts', 'Daily tasks', 'Follow-ups', 'Compliance'], primary: 'Today’s appointments', insight: 'Patient flow', secondary: 'Daily operations' },
  doctor: { name: 'Dr. Ayesha Malik', title: 'Good morning, Dr. Ayesha', subtitle: 'Your schedule and assigned patients for today.', role: 'Physiotherapist', metrics: [['My appointments', '08', '2 completed', 'Next at 09:30 AM', '▦'], ['My waiting patients', '02', '1 checked in', 'Avg. wait 9 min', '◷'], ['Follow-ups due', '05', 'Today', 'Across my caseload', '↻'], ['Sessions completed', '02 / 08', '25%', 'Today’s progress', '✓']], nav: ['Overview', 'My appointments', 'My patients', 'Clinical notes', 'Exercise plans'], primary: 'My appointments', insight: 'My sessions', secondary: 'My patient follow-ups' },
  gymkhana: { name: 'Gymkhana Audit', title: 'Clinic overview', subtitle: 'Aggregated operations and compliance. No patient identities shown.', role: 'Inspection access', metrics: [['Patients treated', '32', 'Today', 'Aggregated count', '♧'], ['Monthly visits', '684', '↑ 4.1%', 'vs. previous month', '▦'], ['Audit checklist', '94%', '↑ 2 items', 'Latest: 16 Oct', '✓'], ['Open hours', '14:00–22:00', 'On schedule', 'Mon–Sat', '◷']], nav: ['Overview', 'Footfall', 'Compliance', 'Operating hours'], primary: 'Clinic activity', insight: 'Patient visits', secondary: 'Compliance & hygiene' }
};

const stored = (() => {
  try { return JSON.parse(localStorage.getItem('hopr-pms-demo-visits') || 'null'); } catch { return null; }
})();
let appointments = Array.isArray(stored) ? stored : defaultAppointments.map(item => ({ ...item }));
let currentRole = 'admin';
let activeSection = 'Overview';
let toastTimer;

const icons = ['▦', '◷', '♧', '▤', '✚', '♙', '⌂', '▥'];
const initialsFor = name => name.split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
const safeText = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function visibleAppointments() {
  if (currentRole === 'doctor') return appointments.filter(visit => visit.doctor === 'Dr. Ayesha Malik');
  return appointments;
}

function renderNavigation(role) {
  const nav = document.getElementById('navigation');
  nav.innerHTML = role.nav.map((item, index) => `<button class="nav-item ${item === activeSection ? 'active' : ''}" type="button" data-section="${safeText(item)}"><span class="nav-icon">${icons[index % icons.length]}</span><span>${safeText(item)}</span>${item === 'Live queue' ? '<span class="nav-badge">4</span>' : ''}</button>`).join('');
  nav.querySelectorAll('.nav-item').forEach(button => button.addEventListener('click', () => {
    activeSection = button.dataset.section;
    nav.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item === button));
    document.getElementById('breadcrumbCurrent').textContent = activeSection;
    if (activeSection === 'Patient check-in') openCheckin();
    else if (activeSection !== 'Overview') showToast(`${activeSection} view selected in this demo.`);
  }));
}

function renderMetrics(role) {
  document.getElementById('metrics').innerHTML = role.metrics.map(([label, value, change, caption, icon]) => `<article class="metric-card"><div class="metric-top"><span>${safeText(label)}</span><span class="metric-symbol">${icon}</span></div><div class="metric-value">${safeText(value)}<span class="metric-change">${safeText(change)}</span></div><small class="metric-caption">${safeText(caption)}</small></article>`).join('');
}

function renderAppointments(role) {
  const visits = visibleAppointments().slice(0, 5);
  const list = document.getElementById('appointmentList');
  if (currentRole === 'gymkhana') {
    list.innerHTML = ['09:00', '09:30', '10:00', '10:30', '11:00'].map((time, index) => `<div class="appointment-row"><span class="appointment-time">${time}</span><div class="patient-main"><span class="avatar" aria-hidden="true">•</span><div class="patient-info"><b>Patient visit ${String(index + 1).padStart(2, '0')}</b><small>Physiotherapy session · ${index % 2 ? 'Follow-up' : 'New visit'}</small></div></div><div class="appointment-meta"><span class="status ${index === 0 ? 'completed' : 'confirmed'}">${index === 0 ? 'Completed' : 'On schedule'}</span><small>Clinic</small></div></div>`).join('');
    return;
  }
  if (!visits.length) { list.innerHTML = '<div class="empty-state">No appointments assigned to you today.</div>'; return; }
  list.innerHTML = visits.map(visit => {
    const person = currentRole === 'doctor' ? visit.name : visit.name;
    const provider = currentRole === 'manager' ? visit.doctor : visit.area;
    const statusClass = visit.status.toLowerCase().replace(' ', '-');
    return `<div class="appointment-row"><span class="appointment-time">${safeText(visit.time)}</span><div class="patient-main"><span class="avatar" style="background:${visit.color || '#e8f0f3'}">${safeText(visit.initials || initialsFor(person))}</span><div class="patient-info"><b>${safeText(person)}</b><small>${safeText(visit.visit)} · ${safeText(provider)}</small></div></div><div class="appointment-meta"><span class="status ${statusClass}">${safeText(visit.status)}</span><small>${safeText(visit.doctor.split(' ').slice(-2).join(' '))}</small></div></div>`;
  }).join('');
}

function renderQueue() {
  const isAudit = currentRole === 'gymkhana';
  const queue = visibleAppointments().filter(visit => visit.status === 'Waiting' || visit.status === 'In session').slice(0, 4);
  document.getElementById('queueCount').textContent = isAudit ? '—' : String(queue.length).padStart(2, '0');
  document.getElementById('queueList').innerHTML = isAudit
    ? '<div class="queue-person"><span class="avatar">✓</span><div class="queue-details"><b>Waiting-room checklist</b><small>Last verified today at 08:45</small></div><span class="queue-wait">Passed</span></div><div class="queue-person"><span class="avatar">✓</span><div class="queue-details"><b>Operating hours</b><small>Clinic open · 14:00–22:00</small></div><span class="queue-wait">On time</span></div>'
    : queue.map((visit, index) => `<div class="queue-person"><span class="avatar" style="background:${visit.color || '#e8f0f3'}">${safeText(visit.initials || initialsFor(visit.name))}</span><div class="queue-details"><b>${safeText(visit.name)}</b><small>${safeText(visit.doctor.replace('Dr. ', ''))} · ${safeText(visit.area)}</small></div><span class="queue-wait">${index === 0 ? 'In session' : `${9 + index * 3} min`}</span></div>`).join('') || '<div class="empty-state">No one is waiting right now.</div>';
  document.getElementById('queueAction').innerHTML = `${isAudit ? 'View compliance' : 'Open queue'} <span></span>`;
  document.getElementById('queueAction').onclick = () => showToast(isAudit ? 'Compliance checklist is up to date.' : 'Queue management is available in the full system.');
}

function renderSecondary(role) {
  const title = document.getElementById('secondaryTitle');
  const eyebrow = document.getElementById('secondaryEyebrow');
  const action = document.getElementById('secondaryAction');
  const content = document.getElementById('secondaryContent');
  if (currentRole === 'gymkhana') {
    eyebrow.textContent = 'COMPLIANCE & HYGIENE'; title.textContent = 'Inspection checklist'; action.textContent = 'Updated today';
    content.innerHTML = '<div class="utilisation-list">' + [['Treatment rooms sanitised', '100%', 'high'], ['Equipment safety check', '100%', 'high'], ['Daily opening checklist', '92%', ''], ['Operating hours adherence', '98%', 'high']].map(([label, value, style]) => `<div class="utilisation-row"><span class="utilisation-name">${label}</span><div class="progress-track"><div class="progress-fill ${style}" style="width:${value}"></div></div><span class="utilisation-value">${value}</span></div>`).join('') + '</div>';
    return;
  }
  if (currentRole === 'manager') {
    eyebrow.textContent = currentRole === 'manager' ? 'OPEN TASKS' : 'FRONT DESK'; title.textContent = currentRole === 'manager' ? 'Operations checklist' : 'Payment summary'; action.textContent = currentRole === 'manager' ? '5 tasks' : 'Today';
    content.innerHTML = currentRole === 'manager'
      ? '<div class="activity-list"><div class="activity-row"><span class="activity-mark">✓</span><p><b>Room 2 equipment check</b><br>Due at 10:00 AM</p><small>In progress</small></div><div class="activity-row"><span class="activity-mark">◷</span><p><b>Hydrocollator temperature log</b><br>Due at 11:00 AM</p><small>Pending</small></div><div class="activity-row"><span class="activity-mark">↻</span><p><b>Confirm tomorrow’s follow-ups</b><br>5 patients to contact</p><small>Pending</small></div></div>'
      : '<div class="utilisation-list">' + [['Cash collected', 'Rs 28,500', 'high'], ['Online payments', 'Rs 20,000', ''], ['Pending receipts', '02', '']].map(([label, value, style]) => `<div class="utilisation-row"><span class="utilisation-name">${label}</span><div class="progress-track"><div class="progress-fill ${style}" style="width:${label === 'Cash collected' ? '72%' : label === 'Online payments' ? '54%' : '18%'}"></div></div><span class="utilisation-value">${value}</span></div>`).join('') + '</div>';
    return;
  }
  if (currentRole === 'doctor') {
    eyebrow.textContent = 'MY CASELOAD'; title.textContent = 'Follow-ups due today'; action.textContent = 'View patients';
    const mine = visibleAppointments().slice(0, 3);
    content.innerHTML = `<div class="activity-list">${mine.map(visit => `<div class="activity-row"><span class="avatar">${safeText(visit.initials || initialsFor(visit.name))}</span><p><b>${safeText(visit.name)}</b><br>${safeText(visit.area)} · ${safeText(visit.visit)}</p><small>${safeText(visit.time)}</small></div>`).join('')}</div>`;
    return;
  }
  eyebrow.textContent = 'TEAM PERFORMANCE'; title.textContent = role.secondary; action.textContent = 'This week ⌄';
  content.innerHTML = `<div class="utilisation-list">${[['Dr. Ayesha Malik', 82], ['Dr. Hamza Raza', 74], ['Dr. Sara Ahmed', 61]].map(([name, percent]) => `<div class="utilisation-row"><span class="utilisation-name">${name}</span><div class="progress-track"><div class="progress-fill ${percent > 80 ? 'high' : ''}" style="width:${percent}%"></div></div><span class="utilisation-value">${percent}%</span></div>`).join('')}</div>`;
}

function renderActivity() {
  const items = currentRole === 'gymkhana'
    ? [['✓', 'Opening checklist completed', '08:48 AM'], ['✓', 'Treatment room hygiene logged', '08:42 AM'], ['✓', 'Equipment safety check passed', 'Yesterday']]
    : currentRole === 'doctor'
      ? [['✓', 'Session note saved for Ayesha K.', '09:12 AM'], ['▦', 'Follow-up scheduled for Bilal A.', '08:54 AM'], ['↗', 'Exercise plan updated', 'Yesterday']]
      : [['♧', 'New patient checked in', '09:22 AM'], ['▤', 'Receipt issued · HOPR-1048', '09:15 AM'], ['↻', 'Appointment confirmed for tomorrow', '09:08 AM']];
  document.getElementById('activityList').innerHTML = items.map(([icon, text, time]) => `<div class="activity-row"><span class="activity-mark">${icon}</span><p>${text}</p><small>${time}</small></div>`).join('');
}

function renderChart(role) {
  const values = currentRole === 'gymkhana' ? [45, 62, 54, 82, 71, 92, 24] : currentRole === 'doctor' ? [30, 65, 48, 82, 56, 73, 20] : [50, 65, 56, 83, 68, 96, 25];
  document.getElementById('chart').innerHTML = values.map((value, index) => `<span class="chart-bar ${index === 5 ? 'current' : ''}" style="height:${value}%"></span>`).join('');
  document.getElementById('chartTotal').textContent = currentRole === 'doctor' ? '08' : currentRole === 'gymkhana' ? '684' : '128';
  document.getElementById('chartTrend').textContent = currentRole === 'doctor' ? '2 completed' : '↑ 12.8%';
  document.getElementById('chartCaption').textContent = currentRole === 'gymkhana' ? 'visits this month' : currentRole === 'doctor' ? 'of 8 sessions today' : 'vs. previous week';
  document.getElementById('insightEyebrow').textContent = currentRole === 'doctor' ? 'MY SCHEDULE' : currentRole === 'gymkhana' ? 'AGGREGATED FOOTFALL' : 'CLINIC PULSE';
  document.getElementById('insightTitle').textContent = role.insight;
}

function renderRole(roleName) {
  currentRole = roleName;
  const role = roles[roleName];
  activeSection = 'Overview';
  document.getElementById('profileName').textContent = role.name;
  document.getElementById('profileRole').textContent = role.role;
  document.getElementById('pageTitle').innerHTML = `${safeText(role.title)}<span class="wave">.</span>`;
  document.getElementById('pageSubtitle').textContent = role.subtitle;
  document.getElementById('breadcrumbCurrent').textContent = 'Overview';
  document.getElementById('primaryTitle').textContent = role.primary;
  document.getElementById('headingActions').innerHTML = roleName === 'doctor'
      ? '<button class="button secondary-button" id="notesButton">▤ &nbsp; Clinical notes</button><button class="button primary-button" id="newVisitButton">＋ &nbsp; Add session note</button>'
      : roleName === 'gymkhana'
        ? '<button class="button secondary-button" id="auditButton">↓ &nbsp; Export audit</button>'
        : roleName === 'manager'
          ? '<button class="button secondary-button" id="receiptButton">▤ &nbsp; Create receipt</button><button class="button primary-button" id="newVisitButton">＋ &nbsp; Patient check-in</button>'
          : '<button class="button secondary-button" id="reportButton">↓ &nbsp; Export report</button><button class="button primary-button" id="newVisitButton">＋ &nbsp; New appointment</button>';
  renderNavigation(role);
  renderMetrics(role);
  renderAppointments(role);
  renderQueue();
  renderSecondary(role);
  renderActivity();
  renderChart(role);
  document.getElementById('newVisitButton')?.addEventListener('click', () => roleName === 'manager' ? openCheckin() : showToast(roleName === 'doctor' ? 'Clinical note editor is part of the secure production workflow.' : 'Appointment booking is available in the full system.'));
  document.getElementById('receiptButton')?.addEventListener('click', () => showToast('Receipt generation is a demo placeholder.'));
  document.getElementById('notesButton')?.addEventListener('click', () => showToast('Clinical notes are restricted to your assigned patients.'));
  document.getElementById('reportButton')?.addEventListener('click', () => showToast('Reports are a demo placeholder.'));
  document.getElementById('auditButton')?.addEventListener('click', () => showToast('Audit export is a demo placeholder.'));
}

function openCheckin() { document.getElementById('checkinModal').showModal(); }
function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}

document.getElementById('roleSelect').addEventListener('change', event => renderRole(event.target.value));
document.getElementById('checkinForm').addEventListener('submit', event => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const name = String(data.get('name')).trim();
  const phone = String(data.get('phone')).trim();
  if (!name || !phone) return;
  appointments.unshift({ time: '11:30', name, doctor: String(data.get('doctor')), visit: String(data.get('visit')), area: String(data.get('condition') || 'Assessment pending'), status: 'Waiting', initials: initialsFor(name), color: '#edf4f7', payment: String(data.get('payment')), phone });
  try { localStorage.setItem('hopr-pms-demo-visits', JSON.stringify(appointments)); } catch { showToast('Browser storage is unavailable; this visit will not persist.'); }
  event.currentTarget.reset();
  document.getElementById('checkinModal').close();
  renderRole(currentRole);
  showToast('Patient added to this browser’s demo schedule.');
});
document.getElementById('closeModal').addEventListener('click', () => document.getElementById('checkinModal').close());
document.getElementById('cancelModal').addEventListener('click', () => document.getElementById('checkinModal').close());
document.getElementById('menuToggle').addEventListener('click', () => document.getElementById('sidebar').classList.toggle('open'));
document.getElementById('viewAllButton').addEventListener('click', () => { activeSection = currentRole === 'doctor' ? 'My appointments' : 'Appointments'; renderRole(currentRole); showToast('Schedule view selected.'); });
document.getElementById('dateLabel').textContent = new Intl.DateTimeFormat('en', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }).format(new Date()).toUpperCase();
renderRole('admin');