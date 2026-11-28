'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { PDFDocument } = require('pdf-lib');

test('Vercel-bundled static assets stay in sync with root assets', () => {
  const assetNames = [
    'index.html',
    'styles.css',
    'secure-app.js',
    'hopr.jpeg',
    'gymkhana.png',
    'invoice.png',
    'clinic.jpeg',
    'Patient History & Assessment Form.pdf'
  ];
  for (const assetName of assetNames) {
    assert.deepEqual(
      fs.readFileSync(path.join(__dirname, assetName)),
      fs.readFileSync(path.join(__dirname, 'api', 'static', assetName)),
      `${assetName} must match its Vercel-bundled copy`
    );
  }
});

test('Vercel routes auth and initial workspace requests to their exact API paths', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'vercel.json'), 'utf8'));
  const rewrites = new Map(config.rewrites.map(rewrite => [rewrite.source, rewrite.destination]));
  for (const route of ['/api/session', '/api/setup-status', '/api/login', '/api/setup', '/api/logout', '/api/dashboard', '/api/workspace']) {
    assert.equal(rewrites.get(route), `/api/index?__pms_path=${route}`);
  }
  assert.equal(config.rewrites.at(-1).source, '/api/:path*');
});

test('static pages remain available when database initialization fails', async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hopr-pms-static-test-'));
  const databasePath = path.join(tempDir, 'broken.sqlite');
  fs.writeFileSync(databasePath, 'not a sqlite database');
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const selectedPort = probe.address().port;
      probe.close(error => error ? reject(error) : resolve(selectedPort));
    });
  });
  const serverBootstrap = "const http = require('node:http'); const handler = require('./api'); http.createServer(handler).listen(Number(process.env.PORT), '127.0.0.1');";
  const child = spawn(process.execPath, ['-e', serverBootstrap], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(port), PMS_DB_PATH: databasePath, NODE_ENV: 'test' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let serverError = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { serverError += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      await fetch(baseUrl);
      ready = true;
      break;
    } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  assert.equal(ready, true, `server did not start: ${serverError}`);
  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /HOPR/);
  const apiResponse = await fetch(`${baseUrl}/api/setup-status`);
  assert.equal(apiResponse.status, 500);
  assert.match(serverError, /\[pms-request-error\]/);
  assert.match(serverError, /stage: 'database initialization'/);
});

test('server handler reconstructs rewritten setup-status and login routes', async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hopr-pms-rewrite-test-'));
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const selectedPort = probe.address().port;
      probe.close(error => error ? reject(error) : resolve(selectedPort));
    });
  });
  const serverBootstrap = "const http = require('node:http'); const handler = require('./server'); http.createServer(handler).listen(Number(process.env.PORT), '127.0.0.1');";
  const childEnv = { ...process.env, PORT: String(port), PMS_DB_PATH: path.join(tempDir, 'clinic.sqlite'), NODE_ENV: 'test' };
  delete childEnv.VERCEL;
  delete childEnv.TURSO_DATABASE_URL;
  delete childEnv.TURSO_AUTH_TOKEN;
  delete childEnv.PMS_ADMIN_EMAIL;
  delete childEnv.PMS_ADMIN_PASSWORD;
  const child = spawn(process.execPath, ['-e', serverBootstrap], {
    cwd: __dirname,
    env: childEnv,
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let serverError = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { serverError += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/api/index?__pms_path=%2Fapi%2Fsetup-status`);
      if (response.status === 200) {
        ready = true;
        break;
      }
    } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  assert.equal(ready, true, `handler did not start: ${serverError}`);

  const setupStatusResponse = await fetch(`${baseUrl}/api/index?__pms_path=%2Fapi%2Fsetup-status`);
  assert.equal(setupStatusResponse.status, 200);
  assert.equal((await setupStatusResponse.json()).setupRequired, true);
  const loginResponse = await fetch(`${baseUrl}/api/index?__pms_path=%2Fapi%2Flogin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'missing@example.test', password: crypto.randomBytes(18).toString('base64url') })
  });
  assert.equal(loginResponse.status, 401);
  assert.equal((await loginResponse.json()).error, 'Email or password is incorrect.');
});

test('server enforces sessions, roles, doctor scope and audit masking', async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hopr-pms-test-'));
  const password = crypto.randomBytes(18).toString('base64url');
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const selectedPort = probe.address().port;
      probe.close(error => error ? reject(error) : resolve(selectedPort));
    });
  });
  let child;
  let serverError = '';
  const serverBootstrap = "const http = require('node:http'); const handler = require('./api'); http.createServer((request, response) => { const url = new URL(request.url, 'http://localhost'); request.query = Object.fromEntries(url.searchParams); url.searchParams.delete('__pms_path'); request.url = url.pathname + url.search; handler(request, response); }).listen(Number(process.env.PORT), process.env.HOST);";
  const startServer = (extraEnv = {}) => {
    const childProcess = spawn(process.execPath, ['-e', serverBootstrap], {
      cwd: __dirname,
      env: { ...process.env, PORT: String(port), HOST: '0.0.0.0', PMS_DB_PATH: path.join(tempDir, 'clinic.sqlite'), NODE_ENV: 'test', ...extraEnv },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    childProcess.stderr.setEncoding('utf8');
    childProcess.stderr.on('data', chunk => { serverError += chunk; });
    return childProcess;
  };
  child = startServer();
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(async () => {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      await fetch(`${baseUrl}/api/session`);
      ready = true;
      break;
    } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  assert.equal(ready, true, `server did not start: ${serverError}`);

  const vercelFetch = async (url, options) => {
    const requestUrl = new URL(url, baseUrl);
    if (requestUrl.pathname.startsWith('/api/')) {
      const originalPath = requestUrl.pathname;
      requestUrl.pathname = '/api/index';
      requestUrl.searchParams.set('__pms_path', originalPath);
    }
    return fetch(requestUrl, options);
  };
  const request = async (url, { cookie, ...options } = {}) => {
    const response = await vercelFetch(url, {
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...options.headers }
    });
    const body = await response.json();
    return { response, body, cookie: response.headers.getSetCookie?.()[0]?.split(';')[0] };
  };
  const login = async (email, loginPassword) => {
    const result = await request('/api/login', { method: 'POST', body: JSON.stringify({ email, password: loginPassword }) });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    return result.cookie;
  };
  const createUser = async (adminCookie, name, role) => {
    const email = `${role}-${crypto.randomUUID()}@example.test`;
    const userPassword = crypto.randomBytes(18).toString('base64url');
    const result = await request('/api/users', { method: 'POST', cookie: adminCookie, body: JSON.stringify({ email, name, role, password: userPassword }) });
    assert.equal(result.response.status, 201, `${JSON.stringify(result.body)}\n${serverError}`);
    return { id: result.body.id, email, password: userPassword, cookie: await login(email, userPassword) };
  };

  assert.equal((await request('/api/dashboard')).response.status, 401);
  assert.equal((await request('/api/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: 'x', newPassword: 'x'.repeat(14) }) })).response.status, 401);
  const anonymousSession = await request('/api/session');
  assert.equal(anonymousSession.response.status, 401);
  assert.equal(anonymousSession.body.error, 'Authentication required.');
  assert.equal((await vercelFetch(`${baseUrl}/server.js`)).status, 404);
  assert.equal((await vercelFetch(`${baseUrl}/api.test.js`)).status, 404);
  assert.equal((await vercelFetch(`${baseUrl}/data/clinic.sqlite`)).status, 404);
  const homepage = await vercelFetch(baseUrl);
  assert.equal(homepage.status, 200);
  const contentSecurityPolicy = homepage.headers.get('content-security-policy');
  assert.match(contentSecurityPolicy, /script-src[^;]*https:\/\/vercel\.live/);
  assert.match(contentSecurityPolicy, /connect-src[^;]*https:\/\/vercel\.live/);
  assert.match(contentSecurityPolicy, /frame-src[^;]*https:\/\/vercel\.live/);
  assert.equal((await vercelFetch(`${baseUrl}/index.html`)).status, 200);
  assert.equal((await vercelFetch(`${baseUrl}/styles.css`)).status, 200);
  assert.equal((await vercelFetch(`${baseUrl}/secure-app.js`)).status, 200);
  assert.equal((await vercelFetch(`${baseUrl}/Patient%20History%20%26%20Assessment%20Form.pdf`)).status, 404);
  const clinicPhoto = await vercelFetch(`${baseUrl}/clinic.jpeg`);
  assert.equal(clinicPhoto.status, 200);
  assert.match(clinicPhoto.headers.get('content-type'), /image\/jpeg/);
  const clinicLogo = await vercelFetch(`${baseUrl}/hopr.jpeg`);
  assert.equal(clinicLogo.status, 200);
  assert.match(clinicLogo.headers.get('content-type'), /image\/jpeg/);
  const invoiceTemplate = await vercelFetch(`${baseUrl}/invoice.png`);
  assert.equal(invoiceTemplate.status, 200);
  assert.match(invoiceTemplate.headers.get('content-type'), /image\/png/);
  const gymkhanaLogo = await vercelFetch(`${baseUrl}/gymkhana.png`);
  assert.equal(gymkhanaLogo.status, 200);
  assert.match(gymkhanaLogo.headers.get('content-type'), /image\/png/);
  const setupStatus = await request('/api/setup-status');
  assert.equal(setupStatus.response.status, 200);
  assert.equal(setupStatus.body.setupRequired, true);
  const setup = await request('/api/setup', { method: 'POST', body: JSON.stringify({ name: 'Clinic Admin', email: 'admin@example.test', password }) });
  assert.equal(setup.response.status, 201, JSON.stringify(setup.body));
  let adminCookie = setup.cookie;
  const firstProcess = child;
  const firstProcessExit = new Promise(resolve => firstProcess.once('exit', resolve));
  firstProcess.kill();
  await firstProcessExit;
  child = startServer();
  ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      await fetch(`${baseUrl}/api/session`);
      ready = true;
      break;
    } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  assert.equal(ready, true, `server did not restart: ${serverError}`);
  const persistedSession = await request('/api/session', { cookie: adminCookie });
  assert.equal(persistedSession.body.user.email, 'admin@example.test', 'a signed-in session should survive a server process restart');
  const secondaryAdminCookie = await login('admin@example.test', password);
  const incorrectCurrentPassword = await request('/api/change-password', {
    method: 'POST', cookie: adminCookie,
    body: JSON.stringify({ currentPassword: 'incorrect-password', newPassword: crypto.randomBytes(24).toString('base64url') })
  });
  assert.equal(incorrectCurrentPassword.response.status, 403);
  const weakNewPassword = await request('/api/change-password', {
    method: 'POST', cookie: adminCookie,
    body: JSON.stringify({ currentPassword: password, newPassword: 'too-short' })
  });
  assert.equal(weakNewPassword.response.status, 400);
  const reusedPassword = await request('/api/change-password', {
    method: 'POST', cookie: adminCookie,
    body: JSON.stringify({ currentPassword: password, newPassword: password })
  });
  assert.equal(reusedPassword.response.status, 400);
  const rotatedPassword = crypto.randomBytes(24).toString('base64url');
  const passwordChange = await request('/api/change-password', {
    method: 'POST', cookie: adminCookie,
    body: JSON.stringify({ currentPassword: password, newPassword: rotatedPassword })
  });
  assert.equal(passwordChange.response.status, 200, JSON.stringify(passwordChange.body));
  assert.equal((await request('/api/dashboard', { cookie: secondaryAdminCookie })).response.status, 401);
  assert.equal((await request('/api/login', {
    method: 'POST', body: JSON.stringify({ email: 'admin@example.test', password })
  })).response.status, 401);
  const rotatedLogin = await request('/api/login', {
    method: 'POST', body: JSON.stringify({ email: 'admin@example.test', password: rotatedPassword })
  });
  assert.equal(rotatedLogin.response.status, 200);
  assert.equal((await request('/api/dashboard', { cookie: adminCookie })).response.status, 200);
  assert.equal((await request('/api/setup', { method: 'POST', body: JSON.stringify({ name: 'Second Admin', email: 'second@example.test', password }) })).response.status, 409);
  const doctorA = await createUser(adminCookie, 'Doctor One', 'doctor');
  const doctorB = await createUser(adminCookie, 'Doctor Two', 'doctor');
  const receptionist = await createUser(adminCookie, 'Clinic Manager One', 'manager');
  const departingReceptionist = await createUser(adminCookie, 'Departing Clinic Manager', 'manager');
  const manager = await createUser(adminCookie, 'Operations Manager', 'manager');
  const gymkhana = await createUser(adminCookie, 'Auditor', 'gymkhana');
  assert.equal((await request('/api/session', { cookie: receptionist.cookie })).body.user.roleLabel, 'Clinic Manager');
  assert.equal((await request('/api/change-password', {
    method: 'POST', cookie: receptionist.cookie,
    body: JSON.stringify({ currentPassword: receptionist.password, newPassword: crypto.randomBytes(24).toString('base64url') })
  })).response.status, 403);
  assert.equal((await request(`/api/users/${doctorA.id}/password`, {
    method: 'POST', cookie: receptionist.cookie,
    body: JSON.stringify({ newPassword: crypto.randomBytes(24).toString('base64url') })
  })).response.status, 403);
  assert.equal((await request('/api/users', { method: 'POST', cookie: adminCookie, body: JSON.stringify({ email: `legacy-${crypto.randomUUID()}@example.test`, name: 'Legacy Reception', role: 'reception', password: crypto.randomBytes(18).toString('base64url') }) })).response.status, 400);
  const clinicToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());
  const dateOffset = days => {
    const date = new Date(`${clinicToday}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  };
  const doctorList = (await request('/api/dashboard', { cookie: receptionist.cookie })).body.doctors;
  const staffWorkspace = await request('/api/workspace?view=Staff%20%26%20shifts', { cookie: adminCookie });
  assert.equal(staffWorkspace.response.status, 200);
  assert.ok(staffWorkspace.body.rows.some(staff => staff.id === doctorA.id));
  assert.equal((await request('/api/workspace?view=Patients', { cookie: adminCookie })).response.status, 200);
  assert.equal((await request('/api/workspace?view=Reports%20%26%20audit', { cookie: adminCookie })).response.status, 200);
  assert.equal((await request('/api/workspace?view=Staff%20%26%20shifts', { cookie: manager.cookie })).response.status, 403);
  assert.equal((await request('/api/workspace?view=Billing%20%26%20expenses', { cookie: manager.cookie })).response.status, 403);
  assert.equal((await request('/api/workspace?view=Compliance', { cookie: manager.cookie })).response.status, 200);
  assert.equal((await request('/api/workspace?view=Receipts', { cookie: receptionist.cookie })).response.status, 200);
  for (const view of ['Live queue', 'Daily tasks', 'Follow-ups', 'Compliance']) {
    assert.equal((await request(`/api/workspace?view=${encodeURIComponent(view)}`, { cookie: receptionist.cookie })).response.status, 200);
  }
  assert.equal((await request('/api/workspace?view=My%20patients', { cookie: doctorA.cookie })).response.status, 200);
  assert.equal((await request('/api/workspace?view=Footfall', { cookie: gymkhana.cookie })).response.status, 200);
  const gymkhanaHours = await request('/api/workspace?view=Operating%20hours', { cookie: gymkhana.cookie });
  assert.equal(gymkhanaHours.body.rows[0].hours, '14:00–22:00');
  assert.equal((await request('/api/workspace?view=Footfall', { cookie: adminCookie })).response.status, 403);
  assert.equal((await request(`/api/workspace?view=Footfall&date=${clinicToday}`, { cookie: manager.cookie })).response.status, 403);
  assert.equal((await request('/api/workspace?view=Footfall&date=2026-99-99', { cookie: gymkhana.cookie })).response.status, 400);
  assert.equal((await request('/api/workspace?view=Footfall&month=2026-99', { cookie: gymkhana.cookie })).response.status, 400);

  let firstAppointmentId;
  let firstAppointmentNumber;
  let firstPatientId;
  for (const [name, phone, doctorId, membershipId] of [['Private Person One', '03000000001', doctorA.id, 'GYM-1001'], ['Private Person Two', '03000000002', doctorB.id, 'GYM-1002']]) {
    const result = await request('/api/checkins', {
      method: 'POST', cookie: receptionist.cookie,
      body: JSON.stringify({ name, phone, membershipId, sessionsPrescribed: 10, age: 42, condition: 'Sensitive diagnosis', doctorId, visitType: 'New patient', date: clinicToday, time: '10:30', paymentMode: 'Cash', amountPaisa: 250000 })
    });
    assert.equal(result.response.status, 201, `${JSON.stringify(result.body)}\n${serverError}`);
    if (!firstAppointmentId) {
      firstAppointmentId = result.body.appointmentId;
      firstAppointmentNumber = result.body.appointmentNumber;
      firstPatientId = result.body.patientId;
    }
  }
  const initialAssessment = await request(`/api/appointments/${firstAppointmentId}/assessment`, { cookie: doctorA.cookie });
  assert.equal(initialAssessment.response.status, 200);
  assert.equal(initialAssessment.body.hasAssessment, false);
  assert.equal(initialAssessment.body.answers.patientName, 'Private Person One');
  assert.equal(initialAssessment.body.answers.contactNumber, '03000000001');
  assert.equal((await request(`/api/appointments/${firstAppointmentId}/assessment`, { cookie: doctorB.cookie })).response.status, 404);
  assert.equal((await request(`/api/appointments/${firstAppointmentId}/assessment`, { cookie: gymkhana.cookie })).response.status, 403);
  assert.equal((await request('/api/workspace?view=New%20patients', { cookie: adminCookie })).response.status, 200);
  assert.equal((await request('/api/workspace?view=New%20patients', { cookie: manager.cookie })).response.status, 200);
  assert.equal((await request('/api/workspace?view=New%20patients', { cookie: doctorA.cookie })).response.status, 403);
  const assessmentDoctorAppointments = await request('/api/workspace?view=My%20appointments', { cookie: doctorA.cookie });
  assert.equal(assessmentDoctorAppointments.response.status, 200);
  assert.ok(assessmentDoctorAppointments.body.rows.some(row => row.id === firstAppointmentId && row.visit === 'New patient' && row.assessmentStatus === 'Not started'));
  const answers = {
    ...initialAssessment.body.answers,
    gender: 'Female',
    presentingComplaint: 'Lower back pain',
    currentSymptoms: 'Persistent symptom detail. '.repeat(250),
    painSeverity: '7',
    treatmentPlan: 'Manual therapy and graded strengthening.'
  };
  const savedAssessment = await request(`/api/appointments/${firstAppointmentId}/assessment`, {
    method: 'PUT', cookie: doctorA.cookie, body: JSON.stringify({ answers })
  });
  assert.equal(savedAssessment.response.status, 200, JSON.stringify(savedAssessment.body));
  assert.equal(savedAssessment.body.status, 'Draft');
  assert.equal(savedAssessment.body.answers.presentingComplaint, 'Lower back pain');
  assert.equal(fs.existsSync(path.join(tempDir, 'patient-assessments', `assessment-${firstAppointmentNumber}.pdf`)), false);
  const assessmentPdf = await fetch(`${baseUrl}${savedAssessment.body.pdfUrl}`, { headers: { Cookie: doctorA.cookie } });
  assert.equal(assessmentPdf.status, 200);
  assert.match(assessmentPdf.headers.get('content-type'), /application\/pdf/);
  const assessmentPdfBuffer = Buffer.from(await assessmentPdf.arrayBuffer());
  assert.equal(assessmentPdfBuffer.subarray(0, 5).toString(), '%PDF-');
  assert.ok((await PDFDocument.load(assessmentPdfBuffer)).getPageCount() > 4, 'long answers should continue onto an additional page');
  assert.equal((await request(`/api/appointments/${firstAppointmentId}/assessment`, { cookie: adminCookie })).body.answers.treatmentPlan, 'Manual therapy and graded strengthening.');
  assert.equal((await request(`/api/appointments/${firstAppointmentId}/assessment`, {
    method: 'PUT', cookie: manager.cookie, body: JSON.stringify({ answers: { ...answers, treatmentPlan: 'Manager correction.' } })
  })).body.status, 'Draft');
  const managerSavedDraft = await request(`/api/appointments/${firstAppointmentId}/assessment`, { cookie: doctorA.cookie });
  assert.equal(managerSavedDraft.body.answers.treatmentPlan, 'Manager correction.');
  assert.equal((await request(`/api/appointments/${firstAppointmentId}/assessment`, {
    method: 'POST', cookie: manager.cookie, body: JSON.stringify({ answers })
  })).response.status, 403);
  const submittedAssessment = await request(`/api/appointments/${firstAppointmentId}/assessment`, {
    method: 'POST', cookie: doctorA.cookie, body: JSON.stringify({ answers })
  });
  assert.equal(submittedAssessment.response.status, 200);
  assert.equal(submittedAssessment.body.status, 'Submitted');
  assert.ok((await request(`/api/appointments/${firstAppointmentId}/assessment`, { cookie: manager.cookie })).body.submittedAt);
  const editedSubmittedAssessment = await request(`/api/appointments/${firstAppointmentId}/assessment`, {
    method: 'PUT', cookie: adminCookie, body: JSON.stringify({ answers: { ...answers, adviceEducation: 'Continue home exercises.' } })
  });
  assert.equal(editedSubmittedAssessment.body.status, 'Submitted');
  assert.equal((await request(`/api/appointments/${firstAppointmentId}/assessment`, { cookie: doctorA.cookie })).body.answers.adviceEducation, 'Continue home exercises.');
  const legacyAssessmentDb = new DatabaseSync(path.join(tempDir, 'clinic.sqlite'));
  try {
    const savedJson = legacyAssessmentDb.prepare('SELECT assessment_json FROM patient_assessments WHERE appointment_id = ?').get(firstAppointmentId).assessment_json;
    const legacyAnswers = JSON.parse(savedJson);
    legacyAnswers.painSeverity = 0;
    legacyAssessmentDb.prepare('UPDATE patient_assessments SET assessment_json = ? WHERE appointment_id = ?').run(JSON.stringify(legacyAnswers), firstAppointmentId);
  } finally {
    legacyAssessmentDb.close();
  }
  const zeroPainAssessment = await request(`/api/appointments/${firstAppointmentId}/assessment`, { cookie: adminCookie });
  assert.equal(zeroPainAssessment.body.answers.painSeverity, '0', 'legacy numeric zero pain ratings should be returned as visible form values');
  const zeroPainPdf = await fetch(`${baseUrl}/api/appointments/${firstAppointmentId}/assessment.pdf`, { headers: { Cookie: adminCookie } });
  assert.equal(zeroPainPdf.status, 200, 'a zero pain rating should not break PDF generation');
  assert.ok((await PDFDocument.load(Buffer.from(await zeroPainPdf.arrayBuffer()))).getPageCount() >= 4);
  const newPatients = await request('/api/workspace?view=New%20patients', { cookie: manager.cookie });
  assert.ok(newPatients.body.rows.some(row => row.id === firstAppointmentId && row.assessmentStatus === 'Submitted' && row.visit === 'New patient'));
  assert.equal((await request(`/api/appointments/${firstAppointmentId}/assessment`, {
    method: 'PUT', cookie: doctorA.cookie, body: JSON.stringify({ answers: { ...answers, unexpected: 'No' } })
  })).response.status, 400);
  assert.equal((await request(`/api/appointments/${firstAppointmentId}/assessment`, {
    method: 'PUT', cookie: doctorA.cookie, body: JSON.stringify({ answers: { ...answers, painSeverity: '11' } })
  })).response.status, 400);
  const assessmentUi = await fetch(`${baseUrl}/secure-app.js`);
  assert.equal(assessmentUi.status, 200);
  assert.equal(assessmentUi.headers.get('cache-control'), 'no-cache');
  const indexPage = await fetch(`${baseUrl}/`);
  assert.equal(indexPage.status, 200);
  assert.equal(indexPage.headers.get('cache-control'), 'no-cache');
  assert.match(await indexPage.text(), /secure-app\.js\?v=admin-password-controls-20261127a/, 'admin password controls should load as a fresh client bundle');
  const assessmentUiSource = await assessmentUi.text();
  assert.match(assessmentUiSource, /function profileNameFor\(user\)[\s\S]*if \(user\.role !== 'doctor'\) return user\.name;[\s\S]*return name \? `Dr\. \$\{name\}` : 'Doctor';/, 'doctor dashboard profiles should show the doctor title with the name');
  assert.match(assessmentUiSource, /'#profileName'\)\.textContent = profileNameFor\(user\)/, 'the authenticated profile should render the doctor display name');
  assert.match(assessmentUiSource, /function renderDashboard\(data\)[\s\S]*'#profileName'\)\.textContent = profileNameFor\(currentUser\)/, 'dashboard refreshes should keep the doctor title beside the sidebar name');
  assert.match(assessmentUiSource, /nav: \[[^\]]*'Invoices'/, 'clinic manager navigation should label the receipts workspace as invoices');
  assert.match(assessmentUiSource, /nav: \[[^\]]*'Inventory'/, 'clinic manager navigation should include inventory');
  assert.match(assessmentUiSource, /const summaryLabels = \{ revenuePaisa: 'Revenue', expensesPaisa: 'Expense', netPaisa: 'Net' \}/, 'billing summary labels should omit the internal paisa unit');
  assert.match(assessmentUiSource, /view === 'Inventory' && \['admin', 'manager'\]\.includes\(currentUser\.role\)/, 'clinic managers should be able to manage inventory in the same workspace');
  assert.match(assessmentUiSource, /const invoiceColumn = \['Appointments', 'Receipts'\]/, 'clinic manager invoice records should include an invoice action');
  assert.match(assessmentUiSource, /\['patientStatus', 'Appointment status'\]/, 'the Patients table should place appointment status beside its appointment ID');
  assert.match(assessmentUiSource, /key === 'patientStatus' && !\['admin', 'manager'\]\.includes\(currentUser\.role\)/, 'only admins and clinic managers should see the Patients status column');
  assert.match(assessmentUiSource, /data-action="update-patient-status"/, 'the Patients page should allow appointment status changes');
  assert.match(assessmentUiSource, /async function updatePatientAppointmentStatus/, 'patient status changes should save immediately');
  assert.match(assessmentUiSource, /const patientFullRecordColumn = view === 'Clinical records' && currentUser\.role === 'admin'/, 'admin clinical records should include a full-patient-record column');
  assert.match(assessmentUiSource, /data-action="open-patient-full-record"/, 'the full patient record column should include an Open action');
  assert.match(assessmentUiSource, /function showPatientFullRecord\(record\)/, 'the full patient record should open a dedicated timeline');
  assert.match(assessmentUiSource, /function hasAssessmentAnswer\(value\)/, 'zero-valued answers should be treated as saved history');
  assert.match(assessmentUiSource, /assessment-preview-toolbar[\s\S]*Open full PDF/, 'the assessment preview should offer the complete PDF');
  assert.match(assessmentUiSource, /toolbar=1&navpanes=0/, 'the assessment preview should show PDF page controls');
  assert.match(assessmentUiSource, /const deletePatientColumn = \['Patients', 'Appointments', 'New patients', 'Clinical records', 'Follow-ups'\]\.includes\(view\) && currentUser\.role === 'admin'/, 'appointment-specific delete columns should only be available to admins');
  assert.match(assessmentUiSource, /const deletePatientRecordColumn = view === 'Patients' && currentUser\.role === 'admin'/, 'the Patients page should expose a separate admin-only full-record delete option');
  assert.match(assessmentUiSource, /Delete options \(by Appointment ID\)/, 'the Patients page should visibly label both delete options as appointment-ID based');
  assert.match(assessmentUiSource, /function renderPatientDeleteOptions\(row\)/, 'the Patients page should let admins choose which appointment ID to delete');
  assert.match(assessmentUiSource, /data-action="select-patient-appointment"/, 'the Patients page should show all appointment IDs for the selected patient');
  assert.match(assessmentUiSource, /data-action="delete-patient-record"[^>]*data-appointment-number=/, 'full-record deletion should be targeted by the visible appointment ID');
  assert.match(assessmentUiSource, /data-action="delete-patient-appointment"[^>]*data-appointment-number=/, 'single-appointment deletion should be targeted by the visible appointment ID');
  assert.match(assessmentUiSource, /Other separately registered patient records will be kept\./, 'full-record deletion should clarify that a separate duplicate patient row is preserved');
  assert.match(assessmentUiSource, /patient\.sessionsPrescribed/, 'the patient timeline should show the prescribed session count per visit');
  assert.match(assessmentUiSource, /Next session prescribed for/, 'the patient timeline should identify recommended follow-up dates');
  assert.match(assessmentUiSource, /Restart PMS, then reload the page/, 'the Open action should explain when the server endpoint has not been activated');
  assert.match(assessmentUiSource, /data-action="start-appointment"/, 'doctors should be able to mark an appointment in progress');
  assert.match(assessmentUiSource, /statusLabel\(visit\.status\)/, 'appointment and queue views should show the shared in-progress label to every role');
  assert.match(assessmentUiSource, /if \(key === 'status'\) return text\(statusLabel\(row\[key\]\)\)/, 'workspace tables should show the shared in-progress label');
  assert.match(assessmentUiSource, /view === 'My patients' && currentUser\.role === 'doctor' && key === 'phone'/, 'doctor patient tables should not display phone numbers');
  assert.match(assessmentUiSource, /data-action="print-assessment-pdf"/);
  assert.match(assessmentUiSource, /data-action="print-assessment"/);
  assert.match(assessmentUiSource, /Edit form/);
  assert.match(assessmentUiSource, /pdfWindow\.print\(\)/, 'assessment printing should use the PDF viewer to print every page');
  assert.match(assessmentUiSource, /closeMobileNavigation\(\);[\s\S]*const section = button\.dataset\.section/, 'selecting a navigation item should close the mobile sidebar');
  assert.match(assessmentUiSource, /setAttribute\('aria-expanded', String\(isOpen\)\)/, 'the mobile navigation toggle should expose its expanded state');
  const dailyFootfall = await request(`/api/workspace?view=Footfall&date=${clinicToday}`, { cookie: gymkhana.cookie });
  assert.equal(dailyFootfall.response.status, 200);
  assert.deepEqual(dailyFootfall.body.rows.find(row => row.date === clinicToday), { date: clinicToday, visits: 2, revenuePaisa: 500000, clubSharePaisa: 0 });
  assert.equal(dailyFootfall.body.detailRows.length, 2);
  assert.ok(dailyFootfall.body.detailRows.some(row => row.date === clinicToday && row.appointmentNumber === firstAppointmentNumber && row.name === 'Private Person One' && row.membershipId === 'GYM-1001' && row.phone === '03000000001' && row.age === 42 && row.issue === 'Sensitive diagnosis' && row.sessionNumber === 1 && row.sessionsPrescribed === 10 && row.time === '10:30' && row.status === 'Waiting' && row.amountPaisa === 250000 && row.paymentStatus === 'Paid'));
  const monthlyFootfall = await request(`/api/workspace?view=Footfall&month=${clinicToday.slice(0, 7)}`, { cookie: gymkhana.cookie });
  assert.equal(monthlyFootfall.response.status, 200);
  assert.equal(monthlyFootfall.body.detailMonth, clinicToday.slice(0, 7));
  assert.equal(monthlyFootfall.body.detailRows.length, 2);
  const invoicePermission = await request(`/api/appointments/${firstAppointmentId}/invoice`, { cookie: manager.cookie });
  assert.equal(invoicePermission.response.status, 200);
  assert.equal(invoicePermission.body.invoice, null);
  assert.equal((await request(`/api/appointments/${firstAppointmentId}/invoice`, { cookie: gymkhana.cookie })).response.status, 403);
  const createdInvoice = await request(`/api/appointments/${firstAppointmentId}/invoice`, {
    method: 'PUT', cookie: manager.cookie,
    body: JSON.stringify({
      invoiceDate: clinicToday,
      lineItems: [
        { description: 'Physiotherapy session', quantity: 2, unitPricePaisa: 100000 },
        { description: 'Assessment', quantity: 1, unitPricePaisa: 50000 }
      ]
    })
  });
  assert.equal(createdInvoice.response.status, 200);
  assert.equal(createdInvoice.body.invoice.invoiceNumber, `INV-${String(firstAppointmentNumber).padStart(6, '0')}`);
  assert.equal(createdInvoice.body.invoice.subtotalPaisa, 250000);
  assert.equal(createdInvoice.body.invoice.advancePaisa, 250000);
  assert.equal(createdInvoice.body.invoice.balancePaisa, 0);
  assert.equal(createdInvoice.body.invoice.lineItems[0].amountPaisa, 200000);
  const savedInvoice = await request(`/api/appointments/${firstAppointmentId}/invoice`, { cookie: adminCookie });
  assert.equal(savedInvoice.body.invoice.subtotalPaisa, 250000);
  assert.equal(savedInvoice.body.appointment.patientName, 'Private Person One');
  assert.equal((await request(`/api/appointments/${firstAppointmentId}/invoice`, {
    method: 'PUT', cookie: manager.cookie,
    body: JSON.stringify({ invoiceDate: clinicToday, lineItems: [{ description: 'Too small', quantity: 1, unitPricePaisa: 20000 }] })
  })).response.status, 400);
  assert.equal((await request(`/api/appointments/${firstAppointmentId}/payment`, {
    method: 'PATCH', cookie: adminCookie, body: JSON.stringify({ amountPaisa: 300000 })
  })).response.status, 409);
  assert.equal((await request(`/api/appointments/${firstAppointmentId}/invoice`, {
    method: 'PUT', cookie: manager.cookie,
    body: JSON.stringify({ invoiceDate: clinicToday, lineItems: [{ description: 'Updated session', quantity: 1, unitPricePaisa: 300000 }] })
  })).body.invoice.subtotalPaisa, 300000);
  const printedInvoice = await request(`/api/appointments/${firstAppointmentId}/invoice`, { method: 'POST', cookie: manager.cookie });
  assert.equal(printedInvoice.response.status, 200);
  assert.equal(printedInvoice.body.invoice.subtotalPaisa, 300000);
  assert.equal(printedInvoice.body.invoice.advancePaisa, 250000);
  assert.equal(printedInvoice.body.invoice.balancePaisa, 50000);
  assert.ok(printedInvoice.body.invoice.printedAt);
  const adminPrintedCopy = await request(`/api/appointments/${firstAppointmentId}/invoice`, { cookie: adminCookie });
  assert.equal(adminPrintedCopy.body.invoice.subtotalPaisa, 300000);
  assert.equal(adminPrintedCopy.body.printedInvoice.subtotalPaisa, 300000);
  assert.equal((await request(`/api/appointments/${firstAppointmentId}/invoice`, {
    method: 'PUT', cookie: manager.cookie,
    body: JSON.stringify({ invoiceDate: clinicToday, lineItems: [{ description: 'Draft only', quantity: 1, unitPricePaisa: 350000 }] })
  })).body.invoice.subtotalPaisa, 350000);
  const adminStillSeesPrintedCopy = await request(`/api/appointments/${firstAppointmentId}/invoice`, { cookie: adminCookie });
  assert.equal(adminStillSeesPrintedCopy.body.invoice.subtotalPaisa, 300000);
  assert.equal(adminStillSeesPrintedCopy.body.draftInvoice.subtotalPaisa, 350000);
  assert.equal(adminStillSeesPrintedCopy.body.draftInvoice.advancePaisa, 250000);
  const updatedPrintedInvoice = await request(`/api/appointments/${firstAppointmentId}/invoice`, { method: 'POST', cookie: manager.cookie });
  assert.equal(updatedPrintedInvoice.response.status, 200);
  assert.equal((await request(`/api/appointments/${firstAppointmentId}/invoice`, { cookie: adminCookie })).body.invoice.subtotalPaisa, 350000);
  assert.equal((await request(`/api/appointments/${firstAppointmentId}/invoice`, {
    method: 'PUT', cookie: adminCookie,
    body: JSON.stringify({ invoiceDate: clinicToday, lineItems: [{ description: 'Session', quantity: 1, unitPricePaisa: 1000 }], advancePaisa: 1001 })
  })).response.status, 400);
  assert.equal((await request(`/api/appointments/${firstAppointmentId}/invoice`, {
    method: 'PUT', cookie: adminCookie,
    body: JSON.stringify({ invoiceDate: clinicToday, lineItems: Array.from({ length: 7 }, (_, index) => ({ description: `Item ${index + 1}`, quantity: 1, unitPricePaisa: 1000 })) })
  })).response.status, 400);
  assert.equal((await request('/api/checkins', { method: 'POST', cookie: receptionist.cookie, body: JSON.stringify({ name: 'Missing ID', phone: '03000000008', doctorId: doctorA.id, date: clinicToday, time: '11:00' }) })).response.status, 400);
  assert.ok(doctorList.length >= 2);
  const initialMemberHistory = await request('/api/members/gym-1001', { cookie: receptionist.cookie });
  assert.equal(initialMemberHistory.response.status, 200);
  assert.equal(initialMemberHistory.body.member.id, firstPatientId);
  assert.equal(initialMemberHistory.body.visitCount, 1);
  assert.equal(JSON.stringify(initialMemberHistory.body).includes('Sensitive diagnosis'), false);
  assert.equal((await request('/api/members/GYM-1001', { cookie: adminCookie })).response.status, 200);
  assert.equal((await request('/api/members/GYM-1001', { cookie: manager.cookie })).response.status, 200);
  assert.equal((await request('/api/members/GYM-1001', { cookie: doctorA.cookie })).response.status, 200);
  const receptionDashboard = await request('/api/dashboard', { cookie: receptionist.cookie });
  assert.equal(receptionDashboard.body.visits[0].area, '');
  const receptionAppointments = await request('/api/workspace?view=Appointments', { cookie: receptionist.cookie });
  const frontDeskAppointment = receptionAppointments.body.rows.find(row => row.id === firstAppointmentId);
  assert.equal(frontDeskAppointment.paymentMode, 'Cash');
  assert.equal(frontDeskAppointment.paymentStatus, 'Paid');
  assert.equal(frontDeskAppointment.amountPaisa, 250000);
  assert.equal(frontDeskAppointment.membershipId, 'GYM-1001');
  assert.equal(frontDeskAppointment.sessionsPrescribed, 10);
  const receptionPlanUpdate = await request(`/api/patients/${firstPatientId}/sessions`, { method: 'PATCH', cookie: receptionist.cookie, body: JSON.stringify({ sessionsPrescribed: 11 }) });
  assert.equal(receptionPlanUpdate.response.status, 200);
  assert.equal(receptionPlanUpdate.body.receptionUpdated, true);
  const lockedReceptionPatient = (await request('/api/workspace?view=Patients', { cookie: receptionist.cookie })).body.rows.find(row => row.id === firstPatientId);
  assert.equal(lockedReceptionPatient.sessionsPrescribed, 11);
  assert.equal(lockedReceptionPatient.sessionsReceptionUpdated, 1);
  assert.equal((await request(`/api/patients/${firstPatientId}/sessions`, { method: 'PATCH', cookie: receptionist.cookie, body: JSON.stringify({ sessionsPrescribed: 13 }) })).response.status, 409);
  assert.equal((await request(`/api/patients/${firstPatientId}/sessions`, { method: 'PATCH', cookie: adminCookie, body: JSON.stringify({ sessionsPrescribed: 12 }) })).body.sessionsPrescribed, 12);
  assert.equal(frontDeskAppointment.sessionNumber, 1);
  const receptionistSessionUpdate = await request(`/api/appointments/${firstAppointmentId}/session`, { method: 'PATCH', cookie: receptionist.cookie, body: JSON.stringify({ sessionNumber: 2 }) });
  assert.equal(receptionistSessionUpdate.response.status, 200);
  assert.equal((await request(`/api/appointments/${firstAppointmentId}/session`, { method: 'PATCH', cookie: manager.cookie, body: JSON.stringify({ sessionNumber: 3 }) })).response.status, 200);
  assert.equal((await request(`/api/appointments/${firstAppointmentId}/payment`, { method: 'PATCH', cookie: receptionist.cookie, body: JSON.stringify({ paymentStatus: 'Unpaid' }) })).response.status, 200);
  assert.equal((await request(`/api/appointments/${firstAppointmentId}/payment`, { method: 'PATCH', cookie: receptionist.cookie, body: JSON.stringify({ amountPaisa: 1 }) })).response.status, 200);
  assert.equal((await request(`/api/appointments/${firstAppointmentId}/payment`, { method: 'PATCH', cookie: receptionist.cookie, body: JSON.stringify({ amountPaisa: 2 }) })).response.status, 409);
  assert.equal((await request(`/api/appointments/${firstAppointmentId}/payment`, { method: 'PATCH', cookie: receptionist.cookie, body: JSON.stringify({ paymentMode: 'Online' }) })).response.status, 403);
  assert.equal((await request(`/api/appointments/${firstAppointmentId}`, { method: 'PATCH', cookie: receptionist.cookie, body: JSON.stringify({ status: 'Cancelled' }) })).response.status, 403);
  const managerDashboard = await request('/api/dashboard', { cookie: manager.cookie });
  assert.equal(managerDashboard.body.visits[0].area, '');
  assert.equal(managerDashboard.body.metrics.revenuePaisa, null);

  const doctorDashboard = await request('/api/dashboard', { cookie: doctorA.cookie });
  assert.equal(doctorDashboard.body.visits.length, 1);
  assert.equal(doctorDashboard.body.visits[0].name, 'Private Person One');
  assert.equal(doctorDashboard.body.visits[0].appointmentNumber, firstAppointmentNumber);
  assert.equal(doctorDashboard.body.assignedPatients.length, 1);
  assert.equal(doctorDashboard.body.assignedPatients[0].name, 'Private Person One');
  assert.equal(doctorDashboard.body.assignedPatients[0].condition, 'Sensitive diagnosis');
  const emptyNoteHistory = await request(`/api/appointment-lookup/${firstAppointmentNumber}`, { cookie: doctorA.cookie });
  assert.equal(emptyNoteHistory.response.status, 200);
  assert.equal(emptyNoteHistory.body.notes.length, 0);
  assert.equal(emptyNoteHistory.body.appointment.id, firstAppointmentId);
  assert.equal((await request(`/api/appointment-lookup/${firstAppointmentNumber}`, { cookie: doctorB.cookie })).response.status, 404);
  assert.equal((await request(`/api/appointment-lookup/${firstAppointmentNumber}`, { cookie: receptionist.cookie })).response.status, 403);
  assert.equal((await request(`/api/appointments/${firstAppointmentId}`, { method: 'PATCH', cookie: manager.cookie, headers: { Origin: 'https://attacker.example' }, body: JSON.stringify({ status: 'Completed' }) })).response.status, 403);
  const note = await request('/api/notes', { method: 'POST', cookie: doctorA.cookie, body: JSON.stringify({ appointmentId: firstAppointmentId, note: 'Range of motion improving.', treatmentPlan: 'Continue prescribed mobility exercises.', nextVisit: dateOffset(2) }) });
  assert.equal(note.response.status, 201);
  const loadedNoteHistory = await request(`/api/appointment-lookup/${firstAppointmentNumber}`, { cookie: doctorA.cookie });
  assert.equal(loadedNoteHistory.body.notes.length, 1);
  assert.equal(loadedNoteHistory.body.notes[0].note, 'Range of motion improving.');
  assert.equal(loadedNoteHistory.body.notes[0].appointmentNumber, firstAppointmentNumber);
  const clinicalRecords = await request('/api/workspace?view=Clinical%20records', { cookie: adminCookie });
  assert.equal(clinicalRecords.body.month, clinicToday.slice(0, 7));
  assert.ok(clinicalRecords.body.rows.some(row => row.appointmentNumber === firstAppointmentNumber && row.sessionNumber === 3 && row.recordDate === clinicToday && row.note === 'Range of motion improving.'));
  assert.deepEqual(clinicalRecords.body.rows.map(row => row.patient).sort(), ['Private Person One', 'Private Person Two']);
  assert.deepEqual(clinicalRecords.body.archives, []);
  assert.equal((await request(`/api/appointments/${firstAppointmentId}/session`, { method: 'PATCH', cookie: adminCookie, body: JSON.stringify({ sessionNumber: 4 }) })).body.sessionNumber, 4);
  assert.equal((await request('/api/workspace?view=Appointments', { cookie: receptionist.cookie })).body.rows.find(row => row.id === firstAppointmentId).sessionNumber, 4);
  const unassignedNote = await request('/api/notes', { method: 'POST', cookie: doctorB.cookie, body: JSON.stringify({ appointmentId: firstAppointmentId, note: 'Unauthorized note.' }) });
  assert.equal(unassignedNote.response.status, 404);
  const receptionistNote = await request('/api/notes', { method: 'POST', cookie: receptionist.cookie, body: JSON.stringify({ appointmentId: firstAppointmentId, note: 'Unauthorized note.' }) });
  assert.equal(receptionistNote.response.status, 403);
  assert.equal((await request(`/api/appointments/${firstAppointmentId}`, { method: 'PATCH', cookie: doctorB.cookie, body: JSON.stringify({ status: 'Completed' }) })).response.status, 404);
  assert.equal((await request(`/api/appointments/${firstAppointmentId}`, { method: 'PATCH', cookie: doctorB.cookie, body: JSON.stringify({ status: 'In session' }) })).response.status, 404);
  assert.equal((await request(`/api/appointments/${firstAppointmentId}`, { method: 'PATCH', cookie: doctorA.cookie, body: JSON.stringify({ status: 'Cancelled' }) })).response.status, 403);
  const inProgress = await request(`/api/appointments/${firstAppointmentId}`, { method: 'PATCH', cookie: doctorA.cookie, body: JSON.stringify({ status: 'In session' }) });
  assert.equal(inProgress.response.status, 200);
  assert.equal(inProgress.body.status, 'In session');
  const inProgressManagerQueue = await request('/api/workspace?view=Live%20queue', { cookie: manager.cookie });
  assert.ok(inProgressManagerQueue.body.rows.some(row => row.id === firstAppointmentId && row.status === 'In session'));
  const inProgressDoctorDashboard = await request('/api/dashboard', { cookie: doctorA.cookie });
  assert.ok(inProgressDoctorDashboard.body.visits.some(visit => visit.id === firstAppointmentId && visit.status === 'In session'));
  assert.equal(inProgressDoctorDashboard.body.queue[0].id, firstAppointmentId, 'in-progress appointments should be prioritized in shared dashboards');
  const completed = await request(`/api/appointments/${firstAppointmentId}`, { method: 'PATCH', cookie: doctorA.cookie, body: JSON.stringify({ status: 'Completed' }) });
  assert.equal(completed.response.status, 200);
  const completedDoctorView = await request('/api/dashboard', { cookie: doctorA.cookie });
  assert.equal(completedDoctorView.body.visits[0].status, 'Completed');
  assert.equal(completedDoctorView.body.queue.length, 0);
  const completedReceptionView = await request('/api/workspace?view=Appointments', { cookie: receptionist.cookie });
  assert.ok(completedReceptionView.body.rows.some(row => row.id === firstAppointmentId && row.status === 'Completed'));
  const completedManagerQueue = await request('/api/workspace?view=Live%20queue', { cookie: manager.cookie });
  assert.ok(completedManagerQueue.body.rows.some(row => row.id === firstAppointmentId && row.status === 'Completed'));
  const forbiddenWrite = await request('/api/checkins', { method: 'POST', cookie: gymkhana.cookie, body: '{}' });
  assert.equal(forbiddenWrite.response.status, 403);

  const auditDashboard = await request('/api/dashboard', { cookie: gymkhana.cookie });
  assert.equal(auditDashboard.body.auditOnly, true);
  assert.equal(auditDashboard.body.visits.length, 2);
  assert.ok(auditDashboard.body.visits.some(visit => visit.name === 'Private Person One' && visit.time === '10:30'));
  assert.equal(auditDashboard.body.queue.length, 1);
  assert.equal(auditDashboard.body.queue[0].name, 'Private Person Two');
  assert.equal(auditDashboard.body.queue[0].status, 'Waiting');
  assert.equal(JSON.stringify(auditDashboard.body).includes('Sensitive diagnosis'), false);
  assert.equal(JSON.stringify(auditDashboard.body).includes('03000000001'), false);
  assert.equal(JSON.stringify(auditDashboard.body).includes('GYM-1001'), false);
  assert.equal(JSON.stringify(auditDashboard.body).includes('paymentMode'), false);

  const adminDashboard = await request('/api/dashboard', { cookie: adminCookie });
  assert.equal(adminDashboard.body.visits.length, 2);
  assert.equal(adminDashboard.body.visits.find(visit => visit.id === firstAppointmentId).status, 'Completed');
  assert.equal(adminDashboard.body.queue.length, 1);
  assert.equal(adminDashboard.body.metrics.revenuePaisa, 250000);

  for (const [days, time] of [[1, '09:00'], [6, '11:00'], [7, '13:00']]) {
    const result = await request('/api/checkins', { method: 'POST', cookie: receptionist.cookie, body: JSON.stringify({
      name: `Schedule ${days}`, membershipId: `SCHEDULE-${days}`, phone: `030000000${days}`, doctorId: doctorA.id, visitType: 'Follow-up',
      date: dateOffset(days), time, paymentMode: 'Unpaid', amountPaisa: 0
    }) });
    assert.equal(result.response.status, 201, JSON.stringify(result.body));
  }
  const scheduledAppointment = (await request('/api/workspace?view=Appointments', { cookie: manager.cookie })).body.rows
    .find(row => row.name === 'Schedule 1');
  assert.ok(scheduledAppointment);
  const managerPatientsWithStatusOptions = (await request('/api/workspace?view=Patients', { cookie: manager.cookie })).body.rows;
  const scheduledPatient = managerPatientsWithStatusOptions.find(row => row.id === scheduledAppointment.patientId);
  assert.ok(scheduledPatient);
  const scheduledPatientAppointment = JSON.parse(scheduledPatient.appointmentOptionsJson)
    .find(appointment => appointment.number === scheduledAppointment.appointmentNumber);
  assert.equal(scheduledPatientAppointment.id, scheduledAppointment.id);
  assert.equal(scheduledPatientAppointment.status, 'Waiting');
  assert.equal((await request(`/api/appointments/${scheduledAppointment.id}`, {
    method: 'PATCH', cookie: manager.cookie, body: JSON.stringify({ status: 'Cancelled' })
  })).response.status, 403, 'clinic managers can only set the supported patient-screen statuses');
  for (const status of ['In session', 'Completed']) {
    const updatedStatus = await request(`/api/appointments/${scheduledAppointment.id}`, {
      method: 'PATCH', cookie: manager.cookie, body: JSON.stringify({ status })
    });
    assert.equal(updatedStatus.response.status, 200, JSON.stringify(updatedStatus.body));
    assert.equal(updatedStatus.body.status, status);
    const appointmentView = await request('/api/workspace?view=Appointments', { cookie: adminCookie });
    assert.equal(appointmentView.body.rows.find(row => row.id === scheduledAppointment.id).status, status);
    const patientStatusView = await request('/api/workspace?view=Patients', { cookie: manager.cookie });
    const updatedPatientStatus = JSON.parse(patientStatusView.body.rows.find(row => row.id === scheduledAppointment.patientId).appointmentOptionsJson)
      .find(appointment => appointment.number === scheduledAppointment.appointmentNumber);
    assert.equal(updatedPatientStatus.status, status);
    const scheduleDashboard = await request(`/api/dashboard?date=${dateOffset(1)}&mode=day`, { cookie: doctorA.cookie });
    assert.equal(scheduleDashboard.body.visits.find(visit => visit.id === scheduledAppointment.id).status, status);
    const managerQueue = await request('/api/workspace?view=Live%20queue', { cookie: manager.cookie });
    assert.equal(managerQueue.body.rows.find(row => row.id === scheduledAppointment.id).status, status);
  }
  const returningMember = await request('/api/checkins', { method: 'POST', cookie: receptionist.cookie, body: JSON.stringify({
    name: 'Changed Name Must Not Replace Profile', phone: '03000999999', membershipId: 'gym-1001', sessionsPrescribed: 20, condition: 'Changed diagnosis must not replace profile', doctorId: doctorA.id,
    visitType: 'Follow-up', date: dateOffset(2), time: '14:00', paymentMode: 'Unpaid', amountPaisa: 0
  }) });
  assert.equal(returningMember.response.status, 201);
  assert.equal(returningMember.body.existingPatient, true);
  assert.equal(returningMember.body.patientId, firstPatientId);
  const frontDeskPatient = (await request('/api/workspace?view=Patients', { cookie: receptionist.cookie })).body.rows.find(row => row.id === firstPatientId);
  assert.equal(frontDeskPatient.membershipId, 'GYM-1001');
  assert.equal(frontDeskPatient.name, 'Private Person One');
  assert.equal(frontDeskPatient.phone, '03000000001');
  assert.equal(frontDeskPatient.condition, 'Sensitive diagnosis');
  const managerPatient = (await request('/api/workspace?view=Patients', { cookie: manager.cookie })).body.rows.find(row => row.id === firstPatientId);
  assert.equal(managerPatient.membershipId, 'GYM-1001');
  assert.equal(managerPatient.phone, '03000000001');
  assert.equal(managerPatient.condition, 'Sensitive diagnosis');
  assert.equal(managerPatient.sessionsPrescribed, 12);
  const doctorPatients = await request('/api/workspace?view=My%20patients', { cookie: doctorA.cookie });
  const doctorPatient = doctorPatients.body.rows.find(row => row.id === firstPatientId);
  assert.equal(doctorPatient.phone, '');
  const adminPatient = (await request('/api/workspace?view=Patients', { cookie: adminCookie })).body.rows.find(row => row.id === firstPatientId);
  assert.equal(adminPatient.sessionsPrescribed, 12);
  const managerAppointments = await request('/api/workspace?view=Appointments', { cookie: manager.cookie });
  const managerAppointment = managerAppointments.body.rows.find(row => row.id === firstAppointmentId);
  assert.equal(managerAppointment.phone, '03000000001');
  assert.equal(managerAppointment.membershipId, 'GYM-1001');
  const managerFollowups = await request('/api/workspace?view=Follow-ups', { cookie: manager.cookie });
  const managerFollowup = managerFollowups.body.rows.find(row => row.id === returningMember.body.appointmentId);
  assert.equal(managerFollowup.membershipId, 'GYM-1001');
  assert.ok(managerFollowup.appointmentNumber > 0);
  const memberHistoryAfterFollowup = await request('/api/members/GYM-1001', { cookie: receptionist.cookie });
  assert.equal(memberHistoryAfterFollowup.body.visitCount, 2);
  assert.equal(memberHistoryAfterFollowup.body.visits[0].date, dateOffset(2));
  const selectedDay = await request(`/api/dashboard?date=${dateOffset(1)}&mode=day`, { cookie: adminCookie });
  assert.equal(selectedDay.body.schedule.selectedDate, dateOffset(1));
  assert.equal(selectedDay.body.visits.length, 1);
  assert.equal(selectedDay.body.visits[0].date, dateOffset(1));
  const selectedWeek = await request(`/api/dashboard?date=${clinicToday}&mode=week`, { cookie: adminCookie });
  const mondayOffset = (new Date(`${clinicToday}T00:00:00.000Z`).getUTCDay() + 6) % 7;
  assert.equal(selectedWeek.body.schedule.endDate, dateOffset(6 - mondayOffset));
  assert.equal(selectedWeek.body.visits.length, [0, 0, 1, 2, 6, 7].filter(offset => offset >= -mondayOffset && offset <= 6 - mondayOffset).length);
  assert.equal(selectedWeek.body.queue.length, 1);
  const nextWeek = await request(`/api/dashboard?date=${dateOffset(7)}&mode=week`, { cookie: adminCookie });
  assert.equal(nextWeek.body.visits.length, [0, 0, 1, 2, 6, 7].filter(offset => offset >= 7 - mondayOffset && offset <= 13 - mondayOffset).length);
  const doctorWeek = await request(`/api/dashboard?date=${clinicToday}&mode=week`, { cookie: doctorA.cookie });
  assert.equal(doctorWeek.body.visits.length, [0, 1, 2, 6].filter(offset => offset >= -mondayOffset && offset <= 6 - mondayOffset).length);
  const invalidDay = await request('/api/dashboard?date=2026-02-30&mode=day', { cookie: adminCookie });
  assert.equal(invalidDay.body.schedule.selectedDate, clinicToday);

  const appointmentOnly = await request('/api/checkins', { method: 'POST', cookie: receptionist.cookie, body: JSON.stringify({
    registrationMode: 'appointment', name: 'Gymkhana Guest', phone: '03000000077', doctorId: doctorA.id,
    visitType: 'Consultation', date: dateOffset(30), time: '15:00', paymentMode: 'Unpaid', amountPaisa: 0
  }) });
  assert.equal(appointmentOnly.response.status, 201);
  assert.equal(appointmentOnly.body.membershipMissing, true);
  assert.ok(appointmentOnly.body.appointmentNumber > 0);
  const managerAmountUpdate = await request(`/api/appointments/${appointmentOnly.body.appointmentId}/payment`, { method: 'PATCH', cookie: manager.cookie, body: JSON.stringify({ amountPaisa: 17500 }) });
  assert.equal(managerAmountUpdate.response.status, 200);
  assert.equal(managerAmountUpdate.body.amountPaisa, 17500);
  assert.equal(managerAmountUpdate.body.amountManagerUpdated, true);
  const repeatedManagerAmountUpdate = await request(`/api/appointments/${appointmentOnly.body.appointmentId}/payment`, { method: 'PATCH', cookie: manager.cookie, body: JSON.stringify({ amountPaisa: 19000 }) });
  assert.equal(repeatedManagerAmountUpdate.response.status, 409);
  assert.match(repeatedManagerAmountUpdate.body.error, /only once/i);
  const managerReceiptsAfterAmountUpdate = await request('/api/workspace?view=Receipts', { cookie: manager.cookie });
  const updatedManagerReceipt = managerReceiptsAfterAmountUpdate.body.rows.find(row => row.appointmentId === appointmentOnly.body.appointmentId);
  assert.equal(updatedManagerReceipt.amountPaisa, 17500);
  assert.equal(updatedManagerReceipt.amountManagerUpdated, 1);
  const appointmentOnlyRow = (await request('/api/workspace?view=Appointments', { cookie: receptionist.cookie })).body.rows.find(row => row.id === appointmentOnly.body.appointmentId);
  assert.equal(appointmentOnlyRow.membershipId, `Appointment #${appointmentOnly.body.appointmentNumber}`);
  assert.equal(appointmentOnlyRow.visit, 'Consultation');
  const managerAppointmentOnlyRow = (await request('/api/workspace?view=Appointments', { cookie: manager.cookie })).body.rows.find(row => row.id === appointmentOnly.body.appointmentId);
  assert.equal(managerAppointmentOnlyRow.membershipId, `Appointment #${appointmentOnly.body.appointmentNumber}`);
  const managerAppointmentOnlyPatient = (await request('/api/workspace?view=Patients', { cookie: manager.cookie })).body.rows.find(row => row.id === appointmentOnly.body.patientId);
  assert.equal(managerAppointmentOnlyPatient.appointmentNumber, appointmentOnly.body.appointmentNumber);
  const secondAppointmentOnly = await request('/api/checkins', { method: 'POST', cookie: receptionist.cookie, body: JSON.stringify({
    registrationMode: 'appointment', name: 'Second Admin ID Patient', phone: '03000000078', doctorId: doctorA.id,
    visitType: 'Consultation', date: dateOffset(31), time: '16:00', paymentMode: 'Unpaid', amountPaisa: 0
  }) });
  assert.equal(secondAppointmentOnly.response.status, 201);
  const posCheckin = await request('/api/checkins', { method: 'POST', cookie: receptionist.cookie, body: JSON.stringify({
    registrationMode: 'appointment', name: 'POS Payment Patient', phone: '03000000079', doctorId: doctorA.id,
    visitType: 'Consultation', date: dateOffset(32), time: '16:30', paymentMode: 'POS', amountPaisa: 85000
  }) });
  assert.equal(posCheckin.response.status, 201);
  assert.equal((await request('/api/workspace?view=Appointments', { cookie: manager.cookie })).body.rows.find(row => row.id === posCheckin.body.appointmentId).paymentMode, 'POS');
  const pendingMemberships = await request('/api/workspace?view=Membership%20requests', { cookie: adminCookie });
  assert.equal(pendingMemberships.response.status, 200);
  assert.ok(pendingMemberships.body.rows.some(row => row.id === appointmentOnly.body.patientId && row.appointmentNumber === appointmentOnly.body.appointmentNumber));
  assert.equal((await request('/api/workspace?view=Membership%20requests', { cookie: manager.cookie })).response.status, 403);
  assert.equal((await request(`/api/appointment-lookup/${appointmentOnly.body.appointmentNumber}`, { cookie: doctorA.cookie })).response.status, 200);
  assert.equal((await request(`/api/appointment-lookup/${appointmentOnly.body.appointmentNumber}`, { cookie: doctorB.cookie })).response.status, 404);
  const assignedNote = await request('/api/notes', { method: 'POST', cookie: doctorA.cookie, body: JSON.stringify({
    appointmentId: appointmentOnly.body.appointmentId, note: 'Guest assessment completed.', treatmentPlan: 'Provide membership desk details.'
  }) });
  assert.equal(assignedNote.response.status, 201);
  assert.equal((await request(`/api/appointment-lookup/${appointmentOnly.body.appointmentNumber}`, { cookie: doctorA.cookie })).body.notes.length, 1);
  const pastMonth = dateOffset(-30).slice(0, 7);
  const pastVisit = await request('/api/checkins', { method: 'POST', cookie: receptionist.cookie, body: JSON.stringify({
    name: 'Archived Patient', membershipId: 'GYM-ARCHIVE-1', phone: '03000000088', doctorId: doctorA.id,
    visitType: 'Follow-up', date: dateOffset(-30), time: '16:00', paymentMode: 'Cash', amountPaisa: 150000
  }) });
  assert.equal(pastVisit.response.status, 201);
  const pastVisitNote = await request('/api/notes', { method: 'POST', cookie: doctorA.cookie, body: JSON.stringify({
    appointmentId: pastVisit.body.appointmentId, note: 'Archived clinical record.'
  }) });
  assert.equal(pastVisitNote.response.status, 201);
  const pastMonthRecords = await request(`/api/workspace?view=Clinical%20records&month=${pastMonth}`, { cookie: adminCookie });
  assert.ok(pastMonthRecords.body.rows.some(row => row.patient === 'Archived Patient' && row.note === 'Archived clinical record.'));
  const clinicalArchive = await request('/api/workspace?view=Clinical%20archive', { cookie: adminCookie });
  assert.ok(clinicalArchive.body.rows.some(row => row.month === pastMonth && row.count >= 1));
  assert.equal((await request('/api/workspace?view=Clinical%20archive', { cookie: manager.cookie })).response.status, 403);
  assert.equal((await request(`/api/patients/${appointmentOnly.body.patientId}/membership`, { method: 'PATCH', cookie: manager.cookie, body: JSON.stringify({ membershipId: 'GYM-GUEST-77' }) })).response.status, 403);
  assert.equal((await request(`/api/patients/${appointmentOnly.body.patientId}/membership`, { method: 'PATCH', cookie: adminCookie, body: JSON.stringify({ membershipId: 'GYM-1001' }) })).response.status, 409);
  assert.equal((await request(`/api/patients/${appointmentOnly.body.patientId}/membership`, { method: 'PATCH', cookie: adminCookie, body: JSON.stringify({ membershipId: 'GYM-GUEST-77' }) })).response.status, 200);
  assert.equal((await request(`/api/patients/${secondAppointmentOnly.body.patientId}/membership`, { method: 'PATCH', cookie: adminCookie, body: JSON.stringify({ membershipId: 'GYM-GUEST-77' }) })).response.status, 200);
  const adminAssignedPatients = (await request('/api/workspace?view=Patients', { cookie: adminCookie })).body.rows.filter(row => [appointmentOnly.body.patientId, secondAppointmentOnly.body.patientId].includes(row.id));
  assert.equal(adminAssignedPatients.length, 2);
  assert.ok(adminAssignedPatients.every(row => row.membershipId === 'GYM-GUEST-77'));
  assert.notEqual(adminAssignedPatients[0].appointmentNumber, adminAssignedPatients[1].appointmentNumber);
  assert.equal((await request('/api/workspace?view=Membership%20requests', { cookie: adminCookie })).body.rows.some(row => row.id === appointmentOnly.body.patientId), false);
  const correctedPayment = await request(`/api/appointments/${firstAppointmentId}/payment`, { method: 'PATCH', cookie: adminCookie, body: JSON.stringify({ paymentMode: 'POS', paymentStatus: 'Paid', amountPaisa: 12000, clubSharePaisa: 7000 }) });
  assert.equal(correctedPayment.response.status, 200);
  assert.equal(correctedPayment.body.clubSharePaisa, 7000);
  assert.equal((await request(`/api/appointments/${firstAppointmentId}/payment`, { method: 'PATCH', cookie: manager.cookie, body: JSON.stringify({ clubSharePaisa: 100 }) })).response.status, 403);
  const updatedAdminAppointment = (await request('/api/workspace?view=Appointments', { cookie: adminCookie })).body.rows.find(row => row.id === firstAppointmentId);
  assert.equal(updatedAdminAppointment.paymentMode, 'POS');
  assert.equal(updatedAdminAppointment.paymentStatus, 'Paid');
  assert.equal(updatedAdminAppointment.amountPaisa, 12000);
  const updatedBilling = await request('/api/workspace?view=Billing%20%26%20expenses', { cookie: adminCookie });
  assert.equal(updatedBilling.body.rows.find(row => row.appointmentId === firstAppointmentId).clubSharePaisa, 7000);
  const financialAudit = await request('/api/workspace?view=Reports%20%26%20audit', { cookie: adminCookie });
  const paymentAudit = financialAudit.body.rows.find(row => row.action === 'payment_updated'
    && row.entity === 'appointment'
    && JSON.parse(row.detailsJson || '{}').after?.amountPaisa === 12000);
  assert.ok(paymentAudit);
  assert.deepEqual(JSON.parse(paymentAudit.detailsJson), {
    before: { amountPaisa: 1, paymentMode: 'Cash', paymentStatus: 'Unpaid', clubSharePaisa: 0 },
    after: { amountPaisa: 12000, paymentMode: 'POS', paymentStatus: 'Paid', clubSharePaisa: 7000 }
  });
  const invoiceAudit = financialAudit.body.rows.find(row => row.action === 'invoice_created' && row.entity === 'appointment');
  assert.ok(invoiceAudit);
  assert.equal(JSON.parse(invoiceAudit.detailsJson).after.advancePaisa, 250000);
  const invoiceUpdateAudit = financialAudit.body.rows.find(row => row.action === 'invoice_updated' && row.entity === 'appointment');
  assert.ok(invoiceUpdateAudit);
  assert.equal(JSON.parse(invoiceUpdateAudit.detailsJson).before.subtotalPaisa, 250000);
  assert.equal(JSON.parse(invoiceUpdateAudit.detailsJson).after.subtotalPaisa, 300000);
  const refreshedInvoice = await request(`/api/appointments/${firstAppointmentId}/invoice`, { cookie: adminCookie });
  assert.equal(refreshedInvoice.body.draftInvoice.advancePaisa, 12000);
  assert.equal(refreshedInvoice.body.printedInvoice.advancePaisa, 250000);
  const monthlyFootfallAfterClubShare = await request(`/api/workspace?view=Footfall&month=${clinicToday.slice(0, 7)}`, { cookie: gymkhana.cookie });
  assert.equal(monthlyFootfallAfterClubShare.body.detailRows.find(row => row.appointmentNumber === firstAppointmentNumber).clubSharePaisa, 7000);
  const dailyFootfallAfterClubShare = await request(`/api/workspace?view=Footfall&date=${clinicToday}`, { cookie: gymkhana.cookie });
  assert.equal(dailyFootfallAfterClubShare.body.rows.find(row => row.date === clinicToday).clubSharePaisa, 7000);
  const guestMemberHistory = await request('/api/members/GYM-GUEST-77', { cookie: doctorA.cookie });
  assert.equal(guestMemberHistory.response.status, 404);
  const doctorAppointments = await request('/api/workspace?view=My%20appointments', { cookie: doctorA.cookie });
  assert.ok(doctorAppointments.body.rows.some(row => row.id === appointmentOnly.body.appointmentId && row.appointmentNumber === appointmentOnly.body.appointmentNumber));

  const task = await request('/api/tasks', { method: 'POST', cookie: manager.cookie, body: JSON.stringify({ title: 'Check treatment room', dueDate: new Date().toISOString().slice(0, 10) }) });
  assert.equal(task.response.status, 201);
  const receptionistTask = await request('/api/tasks', { method: 'POST', cookie: receptionist.cookie, body: JSON.stringify({ title: 'Prepare front desk', dueDate: new Date().toISOString().slice(0, 10) }) });
  assert.equal(receptionistTask.response.status, 201);
  const managerTasks = await request('/api/workspace?view=Daily%20tasks', { cookie: manager.cookie });
  assert.equal(managerTasks.body.rows[0].title, 'Check treatment room');
  assert.equal((await request(`/api/tasks/${task.body.id}`, { method: 'PATCH', cookie: manager.cookie, body: JSON.stringify({ status: 'Completed' }) })).response.status, 200);
  assert.equal((await request(`/api/tasks/${receptionistTask.body.id}`, { method: 'PATCH', cookie: receptionist.cookie, body: JSON.stringify({ status: 'Completed' }) })).response.status, 200);
  const compliance = await request('/api/compliance', { method: 'POST', cookie: manager.cookie, body: JSON.stringify({ checkName: 'Treatment room hygiene', status: 'Passed', notes: 'Internal staff note' }) });
  assert.equal(compliance.response.status, 201);
  const receptionistCompliance = await request('/api/compliance', { method: 'POST', cookie: receptionist.cookie, body: JSON.stringify({ checkName: 'Front desk checklist', status: 'Passed' }) });
  assert.equal(receptionistCompliance.response.status, 201);

  const expense = await request('/api/expenses', { method: 'POST', cookie: adminCookie, body: JSON.stringify({ category: 'Supplies', description: 'Exercise bands', amountPaisa: 240000 }) });
  assert.equal(expense.response.status, 201, JSON.stringify(expense.body));
  const billing = await request('/api/workspace?view=Billing%20%26%20expenses', { cookie: adminCookie });
  assert.equal(billing.body.summary.expensesPaisa, 240000);
  const inventoryItem = await request('/api/inventory', { method: 'POST', cookie: adminCookie, body: JSON.stringify({ name: 'Resistance band', category: 'Equipment', quantity: 4, unit: 'pieces', reorderAt: 2 }) });
  assert.equal(inventoryItem.response.status, 201);
  const inventory = await request('/api/workspace?view=Inventory', { cookie: adminCookie });
  assert.equal(inventory.body.rows[0].name, 'Resistance band');
  assert.equal((await request(`/api/inventory/${inventoryItem.body.id}`, { method: 'PATCH', cookie: adminCookie, body: JSON.stringify({ quantity: 1 }) })).response.status, 200);
  assert.equal((await request('/api/workspace?view=Inventory', { cookie: manager.cookie })).response.status, 200);
  assert.equal((await request(`/api/inventory/${inventoryItem.body.id}`, { method: 'PATCH', cookie: manager.cookie, body: JSON.stringify({ quantity: 0 }) })).response.status, 200);
  const managerInventoryItem = await request('/api/inventory', { method: 'POST', cookie: manager.cookie, body: JSON.stringify({ name: 'No', category: 'No', quantity: 1, unit: 'x', reorderAt: 0 }) });
  assert.equal(managerInventoryItem.response.status, 201);
  assert.equal((await request('/api/workspace?view=Inventory', { cookie: doctorA.cookie })).response.status, 403);
  assert.equal((await request('/api/inventory', { method: 'POST', cookie: doctorA.cookie, body: JSON.stringify({ name: 'No', category: 'No', quantity: 1, unit: 'x', reorderAt: 0 }) })).response.status, 403);
  assert.equal((await request(`/api/inventory/${inventoryItem.body.id}`, { method: 'PATCH', cookie: doctorA.cookie, body: JSON.stringify({ quantity: 0 }) })).response.status, 403);
  const gymkhanaCompliance = await request('/api/workspace?view=Compliance', { cookie: gymkhana.cookie });
  assert.equal(gymkhanaCompliance.response.status, 200);
  assert.equal(JSON.stringify(gymkhanaCompliance.body).includes('notes'), false);

  const departingCheckin = await request('/api/checkins', {
    method: 'POST', cookie: departingReceptionist.cookie,
    body: JSON.stringify({ name: 'History Patient', membershipId: 'GYM-HISTORY-1', phone: '03000000009', condition: 'Retained history', doctorId: doctorA.id, visitType: 'New patient', date: clinicToday, time: '12:00', paymentMode: 'Unpaid', amountPaisa: 0 })
  });
  assert.equal(departingCheckin.response.status, 201);
  const adminId = setup.body.user.id;
  assert.equal((await request(`/api/users/${adminId}/access`, { method: 'PATCH', cookie: adminCookie, body: JSON.stringify({ active: false }) })).response.status, 400);
  assert.equal((await request(`/api/users/${adminId}`, { method: 'DELETE', cookie: adminCookie })).response.status, 400);
  assert.equal((await request(`/api/users/${departingReceptionist.id}/access`, { method: 'PATCH', cookie: manager.cookie, body: JSON.stringify({ active: false }) })).response.status, 403);
  assert.equal((await request(`/api/users/${departingReceptionist.id}`, { method: 'DELETE', cookie: manager.cookie })).response.status, 403);
  assert.equal((await request(`/api/users/${departingReceptionist.id}/access`, { method: 'PATCH', cookie: adminCookie, body: JSON.stringify({ active: false }) })).response.status, 200);
  const revokedSession = await request('/api/session', { cookie: departingReceptionist.cookie });
  assert.equal(revokedSession.response.status, 401);
  assert.equal(revokedSession.body.error, 'Authentication required.');
  const restrictedLogin = await request('/api/login', { method: 'POST', body: JSON.stringify({ email: departingReceptionist.email, password: departingReceptionist.password }) });
  assert.equal(restrictedLogin.response.status, 403);
  assert.equal(restrictedLogin.body.error, 'Account restricted. Please contact your admin.');
  const restrictedWrongPassword = await request('/api/login', { method: 'POST', body: JSON.stringify({ email: departingReceptionist.email, password: 'wrong-password' }) });
  assert.equal(restrictedWrongPassword.response.status, 401);
  assert.equal(restrictedWrongPassword.body.error, 'Email or password is incorrect.');
  const reactivated = await request(`/api/users/${departingReceptionist.id}/access`, { method: 'PATCH', cookie: adminCookie, body: JSON.stringify({ active: true }) });
  assert.equal(reactivated.response.status, 200);
  const restoredCookie = await login(departingReceptionist.email, departingReceptionist.password);
  const deleteResult = await request(`/api/users/${departingReceptionist.id}`, { method: 'DELETE', cookie: adminCookie });
  assert.equal(deleteResult.response.status, 200, JSON.stringify(deleteResult.body));
  assert.equal((await request('/api/session', { cookie: restoredCookie })).response.status, 401);
  assert.equal((await request('/api/workspace?view=Staff%20%26%20shifts', { cookie: adminCookie })).body.rows.some(row => row.id === departingReceptionist.id), false);
  assert.equal((await request('/api/login', { method: 'POST', body: JSON.stringify({ email: departingReceptionist.email, password: departingReceptionist.password }) })).response.status, 401);
  const followUp = await request('/api/checkins', {
    method: 'POST', cookie: receptionist.cookie,
    body: JSON.stringify({ name: 'Private Person One', phone: '03000000001', membershipId: 'GYM-1001', doctorId: doctorA.id, visitType: 'Follow-up', date: clinicToday, time: '11:30' })
  });
  assert.equal(followUp.response.status, 201);
  assert.equal((await request(`/api/appointments/${followUp.body.appointmentId}/assessment`, { cookie: doctorA.cookie })).response.status, 404);
  const preservedHistory = await request('/api/workspace?view=Appointments', { cookie: adminCookie });
  assert.ok(preservedHistory.body.rows.some(row => row.patientId && row.name === 'History Patient' && row.doctor === 'Doctor One'));

  const secondClinicianAppointment = await request('/api/checkins', {
    method: 'POST', cookie: receptionist.cookie,
    body: JSON.stringify({
      name: 'Private Person One', phone: '03000000001', membershipId: 'GYM-1001', doctorId: doctorB.id,
      visitType: 'Follow-up', date: dateOffset(40), time: '12:00', paymentMode: 'Unpaid', amountPaisa: 0
    })
  });
  assert.equal(secondClinicianAppointment.response.status, 201);
  const secondClinicianNote = await request('/api/notes', {
    method: 'POST', cookie: doctorB.cookie,
    body: JSON.stringify({ appointmentId: secondClinicianAppointment.body.appointmentId, note: 'Second clinician private note.' })
  });
  assert.equal(secondClinicianNote.response.status, 201);
  const patientFullRecord = await request(`/api/patients/${firstPatientId}/full-record`, { cookie: adminCookie });
  assert.equal(patientFullRecord.response.status, 200);
  assert.equal(patientFullRecord.body.patient.name, 'Private Person One');
  assert.equal(patientFullRecord.body.patient.age, 42);
  assert.equal(patientFullRecord.body.patient.membershipId, 'GYM-1001');
  assert.equal(patientFullRecord.body.patient.sessionsPrescribed, 12);
  assert.equal(patientFullRecord.body.patient.sessionsCompleted, 1);
  assert.equal(Object.hasOwn(patientFullRecord.body.patient, 'phone'), false);
  assert.equal(patientFullRecord.body.visits.length, 4);
  const firstFullRecordVisit = patientFullRecord.body.visits.find(visit => visit.id === firstAppointmentId);
  assert.equal(firstFullRecordVisit.appointmentNumber, firstAppointmentNumber);
  assert.equal(firstFullRecordVisit.sessionNumber, 4);
  assert.equal(firstFullRecordVisit.doctor, 'Doctor One');
  assert.equal(firstFullRecordVisit.assessment.status, 'Submitted');
  assert.equal(firstFullRecordVisit.assessment.answers.presentingComplaint, 'Lower back pain');
  assert.equal(firstFullRecordVisit.assessment.answers.painSeverity, '0', 'the admin full history should retain a zero pain rating');
  assert.equal(firstFullRecordVisit.notes[0].note, 'Range of motion improving.');
  assert.equal(firstFullRecordVisit.notes[0].nextVisit, dateOffset(2));
  assert.equal(firstFullRecordVisit.notes[0].nextVisitAppointmentStatus, 'Waiting');
  assert.equal(firstFullRecordVisit.notes[0].nextVisitAppointmentNumber, returningMember.body.appointmentNumber);
  assert.ok(patientFullRecord.body.visits.some(visit => visit.doctor === 'Doctor Two' && visit.notes.some(note => note.note === 'Second clinician private note.')));
  assert.equal((await request(`/api/patients/${firstPatientId}/full-record`, { cookie: manager.cookie })).response.status, 403);
  assert.equal((await request(`/api/patients/${firstPatientId}/full-record`, { cookie: doctorA.cookie })).response.status, 403);
  assert.equal((await request('/api/patients/missing-patient/full-record', { cookie: adminCookie })).response.status, 404);
  const doctorPatientNotes = await request(`/api/patients/${firstPatientId}/notes`, { cookie: doctorA.cookie });
  assert.deepEqual(doctorPatientNotes.body.notes.map(row => row.note), ['Range of motion improving.']);
  const doctorAppointmentNotes = await request(`/api/appointment-lookup/${firstAppointmentNumber}`, { cookie: doctorA.cookie });
  assert.deepEqual(doctorAppointmentNotes.body.notes.map(row => row.note), ['Range of motion improving.']);
  const otherDoctorNotes = await request(`/api/appointment-lookup/${secondClinicianAppointment.body.appointmentNumber}`, { cookie: doctorB.cookie });
  assert.deepEqual(otherDoctorNotes.body.notes.map(row => row.note), ['Second clinician private note.']);
  const adminPatientNotes = await request(`/api/patients/${firstPatientId}/notes`, { cookie: adminCookie });
  assert.equal(adminPatientNotes.body.notes.length, 2);

  const duplicatePatientCheckin = async ({ name, phone, membershipId, registrationMode = 'membership', visitType = 'New patient', time }) => request('/api/checkins', {
    method: 'POST',
    cookie: receptionist.cookie,
    body: JSON.stringify({
      name, phone, membershipId, registrationMode, doctorId: doctorA.id,
      visitType, date: clinicToday, time, paymentMode: 'Cash', amountPaisa: 10000
    })
  });
  const retainedAppointment = await duplicatePatientCheckin({
    name: 'Duplicate Record Test', phone: '03000000011', membershipId: 'GYM-DELETE-TEST', time: '14:30'
  });
  assert.equal(retainedAppointment.response.status, 201);
  const selectedAppointment = await duplicatePatientCheckin({
    name: 'Duplicate Record Test', phone: '03000000011', membershipId: 'GYM-DELETE-TEST', time: '14:45'
  });
  assert.equal(selectedAppointment.response.status, 201);
  assert.equal(selectedAppointment.body.patientId, retainedAppointment.body.patientId);
  const appointmentsBeforeDelete = await request('/api/workspace?view=Appointments', { cookie: adminCookie });
  assert.ok(appointmentsBeforeDelete.body.rows.some(row => row.appointmentNumber === retainedAppointment.body.appointmentNumber));
  assert.ok(appointmentsBeforeDelete.body.rows.some(row => row.appointmentNumber === selectedAppointment.body.appointmentNumber));
  const newPatientsBeforeDelete = await request('/api/workspace?view=New%20patients', { cookie: adminCookie });
  assert.ok(newPatientsBeforeDelete.body.rows.some(row => row.appointmentNumber === retainedAppointment.body.appointmentNumber));
  assert.ok(newPatientsBeforeDelete.body.rows.some(row => row.appointmentNumber === selectedAppointment.body.appointmentNumber));
  const clinicalRecordsBeforeDelete = await request(`/api/workspace?view=Clinical%20records&month=${clinicToday.slice(0, 7)}`, { cookie: adminCookie });
  assert.ok(clinicalRecordsBeforeDelete.body.rows.some(row => row.appointmentNumber === retainedAppointment.body.appointmentNumber));
  assert.ok(clinicalRecordsBeforeDelete.body.rows.some(row => row.appointmentNumber === selectedAppointment.body.appointmentNumber));
  assert.equal((await request(`/api/appointments/by-number/${selectedAppointment.body.appointmentNumber}`, {
    method: 'DELETE', cookie: manager.cookie
  })).response.status, 403, 'clinic managers must not delete patient appointments');
  const selectedAssessmentBeforeDelete = await request(`/api/appointments/${selectedAppointment.body.appointmentId}/assessment`, { cookie: doctorA.cookie });
  assert.equal(selectedAssessmentBeforeDelete.response.status, 200);
  const selectedAssessmentSaved = await request(`/api/appointments/${selectedAppointment.body.appointmentId}/assessment`, {
    method: 'PUT', cookie: doctorA.cookie,
    body: JSON.stringify({ answers: { ...selectedAssessmentBeforeDelete.body.answers, presentingComplaint: 'Mistaken duplicate visit' } })
  });
  assert.equal(selectedAssessmentSaved.response.status, 200);
  const selectedNote = await request('/api/notes', {
    method: 'POST', cookie: doctorA.cookie,
    body: JSON.stringify({ appointmentId: selectedAppointment.body.appointmentId, note: 'Delete only this duplicate visit.' })
  });
  assert.equal(selectedNote.response.status, 201);
  const selectedInvoice = await request(`/api/appointments/${selectedAppointment.body.appointmentId}/invoice`, {
    method: 'PUT', cookie: manager.cookie,
    body: JSON.stringify({ invoiceDate: clinicToday, lineItems: [{ description: 'Test visit', quantity: 1, unitPricePaisa: 10000 }] })
  });
  assert.equal(selectedInvoice.response.status, 200);
  const deletedAssessmentDirectory = path.join(tempDir, 'patient-assessments');
  const deletedAssessmentPdfPath = path.join(deletedAssessmentDirectory, `assessment-${selectedAppointment.body.appointmentNumber}.pdf`);
  assert.equal(fs.existsSync(deletedAssessmentPdfPath), false, 'assessment PDFs should be generated in memory, not persisted to disk');
  const patientRowsBeforeDelete = await request('/api/workspace?view=Patients', { cookie: adminCookie });
  const patientRowBeforeDelete = patientRowsBeforeDelete.body.rows.find(row => row.id === retainedAppointment.body.patientId);
  assert.equal(patientRowBeforeDelete.appointmentNumber, selectedAppointment.body.appointmentNumber);
  assert.deepEqual(JSON.parse(patientRowBeforeDelete.appointmentOptionsJson).map(appointment => appointment.number), [
    selectedAppointment.body.appointmentNumber,
    retainedAppointment.body.appointmentNumber
  ], 'the Patients delete controls should offer both same-day appointment IDs');
  const deletedSelectedAppointment = await request(`/api/appointments/by-number/${selectedAppointment.body.appointmentNumber}`, {
    method: 'DELETE', cookie: adminCookie
  });
  assert.equal(deletedSelectedAppointment.response.status, 200, JSON.stringify(deletedSelectedAppointment.body));
  assert.equal(deletedSelectedAppointment.body.patientRemoved, false);
  assert.equal(fs.existsSync(deletedAssessmentPdfPath), false, 'the deleted visit assessment PDF should be removed');
  assert.equal((await request(`/api/appointments/${selectedAppointment.body.appointmentId}/assessment.pdf`, { cookie: adminCookie })).response.status, 404);
  const retainedPatientHistory = await request(`/api/patients/${retainedAppointment.body.patientId}/full-record`, { cookie: adminCookie });
  assert.equal(retainedPatientHistory.body.visits.length, 1, 'other appointments for the patient should remain');
  assert.equal(retainedPatientHistory.body.visits[0].id, retainedAppointment.body.appointmentId);
  const appointmentsAfterDelete = await request('/api/workspace?view=Appointments', { cookie: adminCookie });
  assert.ok(appointmentsAfterDelete.body.rows.some(row => row.appointmentNumber === retainedAppointment.body.appointmentNumber));
  assert.equal(appointmentsAfterDelete.body.rows.some(row => row.appointmentNumber === selectedAppointment.body.appointmentNumber), false);
  const newPatientsAfterDelete = await request('/api/workspace?view=New%20patients', { cookie: adminCookie });
  assert.ok(newPatientsAfterDelete.body.rows.some(row => row.appointmentNumber === retainedAppointment.body.appointmentNumber));
  assert.equal(newPatientsAfterDelete.body.rows.some(row => row.appointmentNumber === selectedAppointment.body.appointmentNumber), false);
  const clinicalRecordsAfterDelete = await request(`/api/workspace?view=Clinical%20records&month=${clinicToday.slice(0, 7)}`, { cookie: adminCookie });
  assert.ok(clinicalRecordsAfterDelete.body.rows.some(row => row.appointmentNumber === retainedAppointment.body.appointmentNumber));
  assert.equal(clinicalRecordsAfterDelete.body.rows.some(row => row.appointmentNumber === selectedAppointment.body.appointmentNumber), false);
  const footfallAfterDelete = await request(`/api/workspace?view=Footfall&date=${clinicToday}`, { cookie: gymkhana.cookie });
  assert.ok(footfallAfterDelete.body.detailRows.some(row => row.appointmentNumber === retainedAppointment.body.appointmentNumber));
  assert.equal(footfallAfterDelete.body.detailRows.some(row => row.appointmentNumber === selectedAppointment.body.appointmentNumber), false);
  assert.equal((await request(`/api/appointments/${selectedAppointment.body.appointmentId}/assessment`, { cookie: adminCookie })).response.status, 404);
  assert.equal((await fetch(`${baseUrl}/api/appointments/${selectedAppointment.body.appointmentId}/assessment.pdf`, {
    headers: { Cookie: adminCookie }
  })).status, 404, 'the deleted assessment should not be available via its former appointment');
  const deletedVisitLookup = await request(`/api/appointments/${selectedAppointment.body.appointmentId}/invoice`, { cookie: adminCookie });
  assert.equal(deletedVisitLookup.response.status, 404, 'the selected appointment and invoice should be removed');
  const patientDeleteDb = new DatabaseSync(path.join(tempDir, 'clinic.sqlite'));
  try {
    assert.equal(patientDeleteDb.prepare('SELECT COUNT(*) AS count FROM payments WHERE appointment_id = ?').get(selectedAppointment.body.appointmentId).count, 0);
    assert.equal(patientDeleteDb.prepare('SELECT COUNT(*) AS count FROM clinical_notes WHERE appointment_id = ?').get(selectedAppointment.body.appointmentId).count, 0);
    assert.equal(patientDeleteDb.prepare('SELECT COUNT(*) AS count FROM audit_log WHERE action = ? AND entity_id = ?').get('patient_appointment_deleted', selectedAppointment.body.appointmentId).count, 1);
  } finally {
    patientDeleteDb.close();
  }
  const separateDuplicate = await duplicatePatientCheckin({
    name: 'Mistaken Extra Record', phone: '03000000012', registrationMode: 'appointment', membershipId: '', time: '15:00'
  });
  assert.equal(separateDuplicate.response.status, 201);
  const deletedDuplicateRecord = await request(`/api/appointments/by-number/${separateDuplicate.body.appointmentNumber}`, {
    method: 'DELETE', cookie: adminCookie
  });
  assert.equal(deletedDuplicateRecord.response.status, 200);
  assert.equal(deletedDuplicateRecord.body.patientRemoved, true, 'a duplicate patient with no remaining visits should be removed');
  const remainingPatients = await request('/api/workspace?view=Patients', { cookie: adminCookie });
  assert.equal(remainingPatients.body.rows.some(row => row.id === separateDuplicate.body.patientId), false);
  assert.ok(remainingPatients.body.rows.some(row => row.id === retainedAppointment.body.patientId && row.appointmentNumber === retainedAppointment.body.appointmentNumber));
  const patientRowAfterDelete = remainingPatients.body.rows.find(row => row.id === retainedAppointment.body.patientId);
  assert.deepEqual(JSON.parse(patientRowAfterDelete.appointmentOptionsJson).map(appointment => appointment.number), [
    retainedAppointment.body.appointmentNumber
  ], 'the removed appointment ID should disappear from the patient delete selector');
  const alreadyDeletedAppointment = await request(`/api/appointments/by-number/${selectedAppointment.body.appointmentNumber}`, {
    method: 'DELETE', cookie: adminCookie
  });
  assert.equal(alreadyDeletedAppointment.response.status, 404, `deleting appointment #${selectedAppointment.body.appointmentNumber} twice should not affect remaining visit #${retainedAppointment.body.appointmentNumber}: ${JSON.stringify(alreadyDeletedAppointment.body)}`);

  const patientRecordFirstVisit = await duplicatePatientCheckin({
    name: 'Mistaken Extra Record', phone: '03000000012', membershipId: 'GYM-RECORD-DELETE', time: '15:15'
  });
  assert.equal(patientRecordFirstVisit.response.status, 201);
  const patientRecordSecondVisit = await duplicatePatientCheckin({
    name: 'Mistaken Extra Record', phone: '03000000012', membershipId: 'GYM-RECORD-DELETE',
    visitType: 'Follow-up', time: '15:30'
  });
  assert.equal(patientRecordSecondVisit.response.status, 201);
  assert.equal(patientRecordSecondVisit.body.patientId, patientRecordFirstVisit.body.patientId);
  const separatelyRegisteredPatient = await duplicatePatientCheckin({
    name: 'Mistaken Extra Record', phone: '03000000012', registrationMode: 'appointment', membershipId: '', time: '15:45'
  });
  assert.equal(separatelyRegisteredPatient.response.status, 201);
  assert.notEqual(separatelyRegisteredPatient.body.patientId, patientRecordFirstVisit.body.patientId);
  const patientRecordNote = await request('/api/notes', {
    method: 'POST', cookie: doctorA.cookie,
    body: JSON.stringify({ appointmentId: patientRecordFirstVisit.body.appointmentId, note: 'Delete with the selected duplicate patient record.' })
  });
  assert.equal(patientRecordNote.response.status, 201);
  const patientRecordInvoice = await request(`/api/appointments/${patientRecordSecondVisit.body.appointmentId}/invoice`, {
    method: 'PUT', cookie: manager.cookie,
    body: JSON.stringify({ invoiceDate: clinicToday, lineItems: [{ description: 'Duplicate patient test visit', quantity: 1, unitPricePaisa: 10000 }] })
  });
  assert.equal(patientRecordInvoice.response.status, 200);
  const fullDeletePatientRow = (await request('/api/workspace?view=Patients', { cookie: adminCookie })).body.rows.find(row => row.id === patientRecordFirstVisit.body.patientId);
  assert.deepEqual(JSON.parse(fullDeletePatientRow.appointmentOptionsJson).map(appointment => appointment.number), [
    patientRecordSecondVisit.body.appointmentNumber,
    patientRecordFirstVisit.body.appointmentNumber
  ]);
  const patientRecordAssessment = await request(`/api/appointments/${patientRecordFirstVisit.body.appointmentId}/assessment`, { cookie: doctorA.cookie });
  const patientRecordAssessmentSave = await request(`/api/appointments/${patientRecordFirstVisit.body.appointmentId}/assessment`, {
    method: 'PUT', cookie: doctorA.cookie,
    body: JSON.stringify({ answers: { ...patientRecordAssessment.body.answers, presentingComplaint: 'Duplicated registration test' } })
  });
  assert.equal(patientRecordAssessmentSave.response.status, 200);
  assert.equal((await request(`/api/patients/by-appointment/${patientRecordSecondVisit.body.appointmentNumber}`, {
    method: 'DELETE', cookie: manager.cookie
  })).response.status, 403, 'clinic managers must not delete full patient records');
  const patientRecordAssessmentPdf = path.join(deletedAssessmentDirectory, `assessment-${patientRecordFirstVisit.body.appointmentNumber}.pdf`);
  assert.equal(fs.existsSync(patientRecordAssessmentPdf), false);
  const deletedPatientRecord = await request(`/api/patients/by-appointment/${patientRecordSecondVisit.body.appointmentNumber}`, {
    method: 'DELETE', cookie: adminCookie
  });
  assert.equal(deletedPatientRecord.response.status, 200, JSON.stringify(deletedPatientRecord.body));
  assert.equal(deletedPatientRecord.body.deletedAppointments, 2);
  assert.deepEqual(deletedPatientRecord.body.appointmentNumbers, [
    patientRecordFirstVisit.body.appointmentNumber,
    patientRecordSecondVisit.body.appointmentNumber
  ]);
  assert.equal(fs.existsSync(patientRecordAssessmentPdf), false, 'all assessment PDFs for the selected patient record should be removed');
  assert.equal((await request(`/api/appointments/${patientRecordFirstVisit.body.appointmentId}/assessment.pdf`, { cookie: adminCookie })).response.status, 404);
  const patientRecordsAfterFullDelete = await request('/api/workspace?view=Patients', { cookie: adminCookie });
  assert.equal(patientRecordsAfterFullDelete.body.rows.some(row => row.id === patientRecordFirstVisit.body.patientId), false);
  assert.ok(patientRecordsAfterFullDelete.body.rows.some(row => row.id === separatelyRegisteredPatient.body.patientId), 'a separately registered duplicate patient record should remain');
  assert.ok(patientRecordsAfterFullDelete.body.rows.some(row => row.id === retainedAppointment.body.patientId), 'unrelated existing patient records should remain');
  const deletedPatientDb = new DatabaseSync(path.join(tempDir, 'clinic.sqlite'));
  try {
    assert.equal(deletedPatientDb.prepare('SELECT COUNT(*) AS count FROM patients WHERE id = ?').get(patientRecordFirstVisit.body.patientId).count, 0);
    for (const appointmentId of [patientRecordFirstVisit.body.appointmentId, patientRecordSecondVisit.body.appointmentId]) {
      for (const table of ['appointments', 'appointment_references', 'payments', 'invoices', 'patient_assessments', 'clinical_notes']) {
        const appointmentColumn = table === 'appointments' ? 'id' : 'appointment_id';
        assert.equal(deletedPatientDb.prepare(`SELECT COUNT(*) AS count FROM "${table}" WHERE "${appointmentColumn}" = ?`).get(appointmentId).count, 0, `${table} should be removed for deleted patient appointments`);
      }
    }
    assert.equal(deletedPatientDb.prepare('SELECT COUNT(*) AS count FROM audit_log WHERE action = ? AND entity_id = ?').get('patient_record_deleted', patientRecordFirstVisit.body.patientId).count, 1);
  } finally {
    deletedPatientDb.close();
  }
  assert.equal((await request(`/api/patients/by-appointment/${patientRecordFirstVisit.body.appointmentNumber}`, {
    method: 'DELETE', cookie: adminCookie
  })).response.status, 404, 'a deleted patient record must no longer resolve by either appointment ID');

  const financeDb = new DatabaseSync(path.join(tempDir, 'clinic.sqlite'));
  try {
    const existingRevenue = financeDb.prepare("SELECT COALESCE(SUM(amount_paisa), 0) AS total FROM payments WHERE payment_status = 'Paid'").get().total;
    const existingExpenses = financeDb.prepare('SELECT COALESCE(SUM(amount_paisa), 0) AS total FROM expenses').get().total;
    financeDb.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;');
    const addAppointment = financeDb.prepare(`INSERT INTO appointments
      (id, patient_id, doctor_id, appointment_date, appointment_time, visit_type, status, created_by)
      VALUES (?, ?, ?, ?, ?, 'Follow-up', 'Completed', ?)`);
    const addReference = financeDb.prepare('INSERT INTO appointment_references (appointment_id) VALUES (?)');
    const addPayment = financeDb.prepare(`INSERT INTO payments
      (id, appointment_id, amount_paisa, payment_mode, payment_status, recorded_by)
      VALUES (?, ?, 100, 'Cash', 'Paid', ?)`);
    const addExpense = financeDb.prepare(`INSERT INTO expenses
      (id, category, description, amount_paisa, spent_on, recorded_by)
      VALUES (?, 'Test', 'Summary limit test', 100, ?, ?)`);
    for (let index = 0; index < 201; index += 1) {
      const appointmentId = `summary-appointment-${index}`;
      addAppointment.run(appointmentId, firstPatientId, doctorA.id, dateOffset(-90), '12:00', adminId);
      addReference.run(appointmentId);
      addPayment.run(`summary-payment-${index}`, appointmentId, adminId);
      addExpense.run(`summary-expense-${index}`, dateOffset(-90), adminId);
    }
    financeDb.exec('COMMIT');
    const billingAfterLimit = await request('/api/workspace?view=Billing%20%26%20expenses', { cookie: adminCookie });
    assert.equal(billingAfterLimit.body.rows.length, 200);
    assert.equal(billingAfterLimit.body.expenses.length, 200);
    assert.equal(billingAfterLimit.body.summary.revenuePaisa, existingRevenue + 20100);
    assert.equal(billingAfterLimit.body.summary.expensesPaisa, existingExpenses + 20100);
    const managerReceiptsAfterLimit = await request('/api/workspace?view=Receipts', { cookie: manager.cookie });
    assert.equal(managerReceiptsAfterLimit.body.rows.length, 200);
    assert.equal(managerReceiptsAfterLimit.body.summary.revenuePaisa, existingRevenue + 20100);
    assert.equal(Object.hasOwn(managerReceiptsAfterLimit.body.summary, 'netPaisa'), false);
  } catch (error) {
    if (financeDb.isTransaction) financeDb.exec('ROLLBACK');
    throw error;
  } finally {
    financeDb.close();
  }

  const shortStaffPassword = await request(`/api/users/${manager.id}/password`, {
    method: 'POST', cookie: adminCookie,
    body: JSON.stringify({ newPassword: 'short' })
  });
  assert.equal(shortStaffPassword.response.status, 400);
  const adminPasswordReset = await request(`/api/users/${adminId}/password`, {
    method: 'POST', cookie: adminCookie,
    body: JSON.stringify({ newPassword: crypto.randomBytes(24).toString('base64url') })
  });
  assert.equal(adminPasswordReset.response.status, 400);
  const staffResetPassword = crypto.randomBytes(24).toString('base64url');
  const staffPasswordReset = await request(`/api/users/${manager.id}/password`, {
    method: 'POST', cookie: adminCookie,
    body: JSON.stringify({ newPassword: staffResetPassword })
  });
  assert.equal(staffPasswordReset.response.status, 200);
  assert.equal((await request('/api/session', { cookie: manager.cookie })).response.status, 401);
  assert.equal((await request('/api/login', {
    method: 'POST', body: JSON.stringify({ email: manager.email, password: manager.password })
  })).response.status, 401);
  assert.equal((await request('/api/login', {
    method: 'POST', body: JSON.stringify({ email: manager.email, password: staffResetPassword })
  })).response.status, 200);

  const beforeBootstrapLogin = await request('/api/login', {
    method: 'POST', body: JSON.stringify({ email: manager.email, password: staffResetPassword })
  });
  assert.equal(beforeBootstrapLogin.response.status, 200);
  const promotedPassword = crypto.randomBytes(24).toString('base64url');
  const promotionDb = new DatabaseSync(path.join(tempDir, 'clinic.sqlite'));
  promotionDb.prepare('UPDATE users SET email = ?, active = 0 WHERE id = ?').run(manager.email.toUpperCase(), manager.id);
  promotionDb.close();

  const previousProcess = child;
  const previousProcessExit = new Promise(resolve => previousProcess.once('exit', resolve));
  previousProcess.kill();
  await previousProcessExit;
  child = startServer({ PMS_ADMIN_EMAIL: manager.email, PMS_ADMIN_PASSWORD: promotedPassword });
  ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/api/session`);
      if (response.status === 401) {
        ready = true;
        break;
      }
    } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  assert.equal(ready, true, `server did not finish admin bootstrap: ${serverError}`);
  const revokedPromotedSession = await request('/api/session', { cookie: beforeBootstrapLogin.cookie });
  assert.equal(revokedPromotedSession.response.status, 401);
  const verifiedPromotionDb = new DatabaseSync(path.join(tempDir, 'clinic.sqlite'));
  const promotedAccount = verifiedPromotionDb.prepare('SELECT role, active FROM users WHERE id = ?').get(manager.id);
  const remainingSessions = verifiedPromotionDb.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?').get(manager.id).count;
  verifiedPromotionDb.close();
  assert.equal(promotedAccount.role, 'admin');
  assert.equal(promotedAccount.active, 1);
  assert.equal(remainingSessions, 0);
  const promotedLogin = await request('/api/login', {
    method: 'POST', body: JSON.stringify({ email: manager.email, password: promotedPassword })
  });
  assert.equal(promotedLogin.response.status, 200);
  assert.equal(promotedLogin.body.user.role, 'admin');
  assert.equal((await request('/api/login', {
    method: 'POST', body: JSON.stringify({ email: manager.email, password: staffResetPassword })
  })).response.status, 401);
});