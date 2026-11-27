'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { pathToFileURL } = require('node:url');
const { createClient } = require('@libsql/client');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const root = __dirname;
const dataDir = path.join(root, 'data');
const dbPath = process.env.PMS_DB_PATH || path.join(dataDir, 'clinic.sqlite');
const assessmentTemplatePath = path.join(root, 'Patient History & Assessment Form.pdf');
const port = Number(process.env.PORT || 7860);
const host = process.env.HOST || '0.0.0.0';
if (process.env.VERCEL && (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN)) {
  throw new Error('Vercel deployment requires TURSO_DATABASE_URL and TURSO_AUTH_TOKEN. Set both in Project Settings > Environment Variables, then redeploy.');
}
const databaseUrl = process.env.TURSO_DATABASE_URL || pathToFileURL(dbPath).href;
const dbClient = createClient({
  url: databaseUrl,
  authToken: process.env.TURSO_AUTH_TOKEN
});
const requestContext = new AsyncLocalStorage();
const sessionHours = 12;
const cookieName = 'hopr_session';
const roles = new Set(['admin', 'manager', 'doctor', 'gymkhana']);
const labels = { admin: 'Head / Admin', manager: 'Clinic Manager', doctor: 'Physiotherapist', gymkhana: 'Gymkhana Audit' };
const mimeTypes = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.jpeg': 'image/jpeg', '.png': 'image/png' };
const assessmentFields = [
  ['patientName', 'Patient name'], ['age', 'Age'], ['gender', 'Gender'], ['contactNumber', 'Contact no.'],
  ['assessmentDate', 'Date of assessment'], ['presentingComplaint', 'Presenting complaint'], ['currentSymptoms', 'Current signs & symptoms'],
  ['painSeverity', 'Pain severity (VAS 0-10)'], ['aggravatingFactors', 'Aggravating factors'], ['relievingFactors', 'Relieving factors'],
  ['sleepNightPain', 'Sleep / night pain'], ['previousInjuriesSurgeries', 'Previous related injuries / surgeries'],
  ['comorbidConditions', 'Comorbid conditions'], ['currentMedications', 'Current medications'], ['allergies', 'Allergies'],
  ['posture', 'Posture'], ['gait', 'Gait'], ['swellingDeformity', 'Swelling / deformity'], ['observation', 'Observation'],
  ['activeRom', 'Active range of motion (ROM)'], ['passiveRom', 'Passive range of motion (ROM)'],
  ['muscleStrengthMmt', 'Muscle strength (MMT)'], ['specialTests', 'Special tests'], ['provisionalDiagnosis', 'Provisional diagnosis'],
  ['treatmentPlan', 'Treatment plan'], ['homeExercisePlan', 'Home exercise plan'], ['adviceEducation', 'Advice and education']
];
const assessmentFieldNames = new Set(assessmentFields.map(([key]) => key));

function activeConnection() {
  return requestContext.getStore()?.transaction || dbClient;
}

const db = {
  prepare(sql) {
    const normalizeArgs = args => args.map(value => value === undefined ? null : value);
    return {
      async all(...args) {
        const result = await activeConnection().execute({ sql, args: normalizeArgs(args) });
        return result.rows.map(row => Object.fromEntries(result.columns.map((column, index) => [
          typeof column === 'string' ? column : column.name,
          row[index]
        ])));
      },
      async get(...args) {
        const result = await activeConnection().execute({ sql, args: normalizeArgs(args) });
        return result.rows.length
          ? Object.fromEntries(result.columns.map((column, index) => [
            typeof column === 'string' ? column : column.name,
            result.rows[0][index]
          ]))
          : undefined;
      },
      async run(...args) {
        const result = await activeConnection().execute({ sql, args: normalizeArgs(args) });
        return {
          changes: Number(result.rowsAffected),
          lastInsertRowid: result.lastInsertRowid === undefined ? undefined : Number(result.lastInsertRowid)
        };
      }
    };
  },
  async exec(sql) {
    const statement = sql.trim();
    const context = requestContext.getStore();
    if (/^BEGIN(?:\s+IMMEDIATE)?$/i.test(statement)) {
      if (!context || context.transaction) throw new Error('Database transaction context is unavailable.');
      context.transaction = await dbClient.transaction('write');
      return;
    }
    if (/^COMMIT$/i.test(statement)) {
      if (!context?.transaction) throw new Error('No database transaction is active.');
      const transaction = context.transaction;
      await transaction.commit();
      context.transaction = null;
      return;
    }
    if (/^ROLLBACK$/i.test(statement)) {
      if (!context?.transaction) return;
      const transaction = context.transaction;
      await transaction.rollback();
      context.transaction = null;
      return;
    }

    const statements = statement.split(';').map(part => part.trim()).filter(Boolean);
    if (!statements.length) return;
    const connection = activeConnection();
    if (statements.length === 1) {
      await connection.execute(statements[0]);
    } else if (connection === dbClient) {
      await dbClient.batch(statements, 'write');
    } else {
      for (const sqlStatement of statements) await connection.execute(sqlStatement);
    }
  },
  get isTransaction() {
    return Boolean(requestContext.getStore()?.transaction);
  },
  async close() {
    await dbClient.close();
  }
};

async function initializeSchema() {
if (!process.env.TURSO_DATABASE_URL && !process.env.VERCEL) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
await dbClient.execute('PRAGMA foreign_keys = ON');
await db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','manager','reception','doctor','gymkhana')),
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS patients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    membership_id TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
    membership_source TEXT NOT NULL DEFAULT 'gymkhana' CHECK (membership_source IN ('gymkhana','admin')),
    sessions_prescribed INTEGER CHECK (sessions_prescribed IS NULL OR sessions_prescribed BETWEEN 1 AND 100),
    sessions_reception_updated INTEGER NOT NULL DEFAULT 0 CHECK (sessions_reception_updated IN (0,1)),
    age INTEGER CHECK (age IS NULL OR age BETWEEN 0 AND 130),
    condition TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS appointments (
    id TEXT PRIMARY KEY,
    patient_id TEXT NOT NULL REFERENCES patients(id),
    doctor_id TEXT NOT NULL REFERENCES users(id),
    appointment_date TEXT NOT NULL,
    appointment_time TEXT NOT NULL,
    visit_type TEXT NOT NULL CHECK (visit_type IN ('New patient','Follow-up')),
    visit_category TEXT NOT NULL DEFAULT '',
    session_number INTEGER NOT NULL DEFAULT 1 CHECK (session_number > 0),
    status TEXT NOT NULL DEFAULT 'Confirmed' CHECK (status IN ('Confirmed','Waiting','In session','Completed','Cancelled')),
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS appointments_date_idx ON appointments(appointment_date, appointment_time);
  CREATE INDEX IF NOT EXISTS appointments_doctor_idx ON appointments(doctor_id, appointment_date);
  CREATE TABLE IF NOT EXISTS appointment_references (
    appointment_number INTEGER PRIMARY KEY AUTOINCREMENT,
    appointment_id TEXT NOT NULL UNIQUE REFERENCES appointments(id)
  );
  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    appointment_id TEXT NOT NULL REFERENCES appointments(id),
    amount_paisa INTEGER NOT NULL CHECK (amount_paisa >= 0),
    amount_manager_updated INTEGER NOT NULL DEFAULT 0 CHECK (amount_manager_updated IN (0,1)),
    club_share_paisa INTEGER NOT NULL DEFAULT 0 CHECK (club_share_paisa >= 0),
    payment_mode TEXT NOT NULL CHECK (payment_mode IN ('Cash','Online','POS','Unpaid')),
    payment_status TEXT NOT NULL DEFAULT 'Paid' CHECK (payment_status IN ('Paid','Unpaid')),
    recorded_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS invoices (
    appointment_id TEXT PRIMARY KEY REFERENCES appointments(id),
    invoice_date TEXT NOT NULL,
    line_items_json TEXT NOT NULL,
    subtotal_paisa INTEGER NOT NULL CHECK (subtotal_paisa >= 0),
    advance_paisa INTEGER NOT NULL CHECK (advance_paisa >= 0),
    printed_invoice_json TEXT,
    printed_at TEXT,
    printed_by TEXT REFERENCES users(id),
    updated_by TEXT NOT NULL REFERENCES users(id),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS patient_assessments (
    appointment_id TEXT PRIMARY KEY REFERENCES appointments(id),
    assessment_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft','Submitted')),
    submitted_at TEXT,
    submitted_by TEXT REFERENCES users(id),
    updated_by TEXT NOT NULL REFERENCES users(id),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS clinical_notes (
    id TEXT PRIMARY KEY,
    patient_id TEXT NOT NULL REFERENCES patients(id),
    doctor_id TEXT NOT NULL REFERENCES users(id),
    appointment_id TEXT REFERENCES appointments(id),
    note TEXT NOT NULL,
    treatment_plan TEXT NOT NULL DEFAULT '',
    next_visit TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    actor_id TEXT REFERENCES users(id),
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    details_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS expenses (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    amount_paisa INTEGER NOT NULL CHECK (amount_paisa > 0),
    spent_on TEXT NOT NULL,
    recorded_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS clinic_tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    due_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','In progress','Completed')),
    created_by TEXT NOT NULL REFERENCES users(id),
    completed_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS compliance_checks (
    id TEXT PRIMARY KEY,
    check_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('Passed','Needs attention')),
    notes TEXT NOT NULL DEFAULT '',
    checked_by TEXT NOT NULL REFERENCES users(id),
    checked_on TEXT NOT NULL DEFAULT (date('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS inventory_items (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity >= 0),
    unit TEXT NOT NULL,
    reorder_at INTEGER NOT NULL CHECK (reorder_at >= 0),
    updated_by TEXT NOT NULL REFERENCES users(id),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS login_failures (
    address_hash TEXT PRIMARY KEY,
    failure_count INTEGER NOT NULL DEFAULT 0,
    window_expires_at INTEGER NOT NULL
  );
`);

await db.exec("UPDATE users SET role = 'manager' WHERE role = 'reception'");

const auditColumns = await db.prepare('PRAGMA table_info(audit_log)').all();
if (!auditColumns.some(column => column.name === 'details_json')) {
  await db.exec('ALTER TABLE audit_log ADD COLUMN details_json TEXT');
}

const invoiceColumns = await db.prepare('PRAGMA table_info(invoices)').all();
if (!invoiceColumns.some(column => column.name === 'printed_invoice_json')) {
  await db.exec('ALTER TABLE invoices ADD COLUMN printed_invoice_json TEXT');
}
if (!invoiceColumns.some(column => column.name === 'printed_at')) {
  await db.exec('ALTER TABLE invoices ADD COLUMN printed_at TEXT');
}
if (!invoiceColumns.some(column => column.name === 'printed_by')) {
  await db.exec('ALTER TABLE invoices ADD COLUMN printed_by TEXT REFERENCES users(id)');
}

const patientColumns = await db.prepare('PRAGMA table_info(patients)').all();
if (!patientColumns.some(column => column.name === 'membership_id')) {
  await db.exec("ALTER TABLE patients ADD COLUMN membership_id TEXT NOT NULL DEFAULT '' COLLATE NOCASE");
}
if (!patientColumns.some(column => column.name === 'membership_source')) {
  await db.exec("ALTER TABLE patients ADD COLUMN membership_source TEXT NOT NULL DEFAULT 'gymkhana' CHECK (membership_source IN ('gymkhana','admin'))");
}
if (!patientColumns.some(column => column.name === 'sessions_prescribed')) {
  await db.exec('ALTER TABLE patients ADD COLUMN sessions_prescribed INTEGER CHECK (sessions_prescribed IS NULL OR sessions_prescribed BETWEEN 1 AND 100)');
}
if (!patientColumns.some(column => column.name === 'sessions_reception_updated')) {
  await db.exec('ALTER TABLE patients ADD COLUMN sessions_reception_updated INTEGER NOT NULL DEFAULT 0 CHECK (sessions_reception_updated IN (0,1))');
}
const appointmentColumns = await db.prepare('PRAGMA table_info(appointments)').all();
if (!appointmentColumns.some(column => column.name === 'visit_category')) {
  await db.exec("ALTER TABLE appointments ADD COLUMN visit_category TEXT NOT NULL DEFAULT ''");
}
if (!appointmentColumns.some(column => column.name === 'session_number')) {
  await db.exec('ALTER TABLE appointments ADD COLUMN session_number INTEGER NOT NULL DEFAULT 1 CHECK (session_number > 0)');
  await db.exec(`WITH numbered AS (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY patient_id ORDER BY appointment_date, appointment_time, created_at, id) AS session_number
    FROM appointments WHERE status != 'Cancelled'
  )
  UPDATE appointments SET session_number = (SELECT session_number FROM numbered WHERE numbered.id = appointments.id)
  WHERE id IN (SELECT id FROM numbered)`);
}
await db.exec('DROP INDEX IF EXISTS patients_membership_id_unique');
await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS patients_gymkhana_membership_id_unique ON patients(membership_id COLLATE NOCASE) WHERE membership_id != '' AND membership_source = 'gymkhana'");
const paymentColumns = await db.prepare('PRAGMA table_info(payments)').all();
if (!paymentColumns.some(column => column.name === 'payment_status')) {
  await db.exec("ALTER TABLE payments ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'Paid' CHECK (payment_status IN ('Paid','Unpaid'))");
  await db.exec("UPDATE payments SET payment_status = 'Unpaid' WHERE payment_mode = 'Unpaid'");
}
if (!paymentColumns.some(column => column.name === 'club_share_paisa')) {
  await db.exec('ALTER TABLE payments ADD COLUMN club_share_paisa INTEGER NOT NULL DEFAULT 0 CHECK (club_share_paisa >= 0)');
}
if (!paymentColumns.some(column => column.name === 'amount_manager_updated')) {
  await db.exec('ALTER TABLE payments ADD COLUMN amount_manager_updated INTEGER NOT NULL DEFAULT 0 CHECK (amount_manager_updated IN (0,1))');
}
const paymentTableDefinition = (await db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'payments'").get()).sql;
if (!paymentTableDefinition.includes("'POS'")) {
  await db.exec('BEGIN IMMEDIATE');
  try {
    await db.exec(`CREATE TABLE payments_with_pos (
      id TEXT PRIMARY KEY,
      appointment_id TEXT NOT NULL REFERENCES appointments(id),
      amount_paisa INTEGER NOT NULL CHECK (amount_paisa >= 0),
      amount_manager_updated INTEGER NOT NULL DEFAULT 0 CHECK (amount_manager_updated IN (0,1)),
      club_share_paisa INTEGER NOT NULL DEFAULT 0 CHECK (club_share_paisa >= 0),
      payment_mode TEXT NOT NULL CHECK (payment_mode IN ('Cash','Online','POS','Unpaid')),
      recorded_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      payment_status TEXT NOT NULL DEFAULT 'Paid' CHECK (payment_status IN ('Paid','Unpaid'))
    );
    INSERT INTO payments_with_pos (id, appointment_id, amount_paisa, amount_manager_updated, club_share_paisa, payment_mode, recorded_by, created_at, payment_status)
      SELECT id, appointment_id, amount_paisa, amount_manager_updated, club_share_paisa, payment_mode, recorded_by, created_at, payment_status FROM payments;
    DROP TABLE payments;
    ALTER TABLE payments_with_pos RENAME TO payments;
  `);
    await db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) await db.exec('ROLLBACK');
    throw error;
  }
}
await db.prepare('INSERT OR IGNORE INTO appointment_references (appointment_id) SELECT id FROM appointments ORDER BY created_at, id').run();
}

const dbReady = requestContext.run({ transaction: null }, async () => {
  await initializeSchema();
  await bootstrapAdmin();
});

function makeId(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
function passwordDigest(password, salt) { return crypto.pbkdf2Sync(password, salt, 310000, 32, 'sha256').toString('hex'); }
async function audit(actorId, action, entityType, entityId, details = null) {
  await db.prepare('INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, details_json) VALUES (?, ?, ?, ?, ?, ?)')
    .run(makeId('evt'), actorId || null, action, entityType, entityId || null, details === null ? null : JSON.stringify(details));
}

async function deleteAppointmentRecords(appointments) {
  for (const appointment of appointments) {
    await db.prepare('DELETE FROM clinical_notes WHERE appointment_id = ?').run(appointment.id);
    await db.prepare('DELETE FROM invoices WHERE appointment_id = ?').run(appointment.id);
    await db.prepare('DELETE FROM patient_assessments WHERE appointment_id = ?').run(appointment.id);
    await db.prepare('DELETE FROM payments WHERE appointment_id = ?').run(appointment.id);
    await db.prepare('DELETE FROM appointment_references WHERE appointment_id = ?').run(appointment.id);
    await db.prepare('DELETE FROM appointments WHERE id = ?').run(appointment.id);
  }
}

async function getFormerStaffId() {
  const email = 'former-staff@invalid.local';
  const existing = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return existing.id;
  const id = makeId('usr');
  const salt = crypto.randomBytes(16).toString('hex');
  const randomPassword = crypto.randomBytes(48).toString('base64url');
  await db.prepare('INSERT INTO users (id, email, name, role, password_hash, password_salt, active) VALUES (?, ?, ?, ?, ?, ?, 0)')
    .run(id, email, 'Former staff', 'manager', passwordDigest(randomPassword, salt), salt);
  return id;
}

async function revokeUserSessions(userId) {
  await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

async function bootstrapAdmin() {
  const email = process.env.PMS_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.PMS_ADMIN_PASSWORD;
  if (!email && !password) return;
  if (!email || !password || password.length < 14) {
    throw new Error('Set both PMS_ADMIN_EMAIL and PMS_ADMIN_PASSWORD (at least 14 characters).');
  }
  const existing = await db.prepare('SELECT id FROM users WHERE role = ? LIMIT 1').get('admin');
  if (existing) return;
  const id = makeId('usr');
  const salt = crypto.randomBytes(16).toString('hex');
  await db.prepare('INSERT INTO users (id, email, name, role, password_hash, password_salt) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, email, email.split('@')[0], 'admin', passwordDigest(password, salt), salt);
  await audit(id, 'bootstrap', 'user', id);
  console.log(`Initial admin account created for ${email}.`);
}

function sendJson(response, status, data, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  response.end(JSON.stringify(data));
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => part.trim().split(/=(.*)/s).slice(0, 2)).filter(pair => pair.length === 2));
}

async function getUser(request) {
  const token = parseCookies(request.headers.cookie)[cookieName];
  if (!token) return null;
  const digest = crypto.createHash('sha256').update(token).digest('hex');
  const session = await db.prepare('SELECT user_id AS userId, expires_at AS expiresAt FROM sessions WHERE token_hash = ?').get(digest);
  if (!session || session.expiresAt <= Date.now()) {
    if (session) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest);
    return null;
  }
  const user = await db.prepare('SELECT id, email, name, role FROM users WHERE id = ? AND active = 1').get(session.userId);
  if (!user) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest);
  return user || null;
}

function requireRole(user, allowed) {
  return Boolean(user && allowed.includes(user.role));
}

function emptyAssessment(patient, appointmentDate) {
  return {
    ...Object.fromEntries(assessmentFields.map(([key]) => [key, ''])),
    patientName: patient.name || patient.patientName || '',
    age: patient.age === null ? '' : String(patient.age),
    contactNumber: patient.phone || patient.contactNumber || '',
    assessmentDate: appointmentDate || ''
  };
}

function savedAssessmentAnswers(serializedAnswers, appointment) {
  const answers = emptyAssessment(appointment, appointment.appointmentDate);
  const savedAnswers = JSON.parse(serializedAnswers);
  if (!savedAnswers || typeof savedAnswers !== 'object' || Array.isArray(savedAnswers)) return answers;
  for (const [key] of assessmentFields) {
    const value = savedAnswers[key];
    if (typeof value === 'string') answers[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) answers[key] = String(value);
  }
  return answers;
}

function wrapAssessmentText(value, font, fontSize, maxWidth) {
  const lines = [];
  for (const paragraph of value.split(/\r?\n/)) {
    if (!paragraph) {
      lines.push('');
      continue;
    }
    const words = [];
    for (const word of paragraph.split(/\s+/)) {
      if (font.widthOfTextAtSize(word, fontSize) <= maxWidth) {
        words.push(word);
        continue;
      }
      let chunk = '';
      for (const character of word) {
        if (chunk && font.widthOfTextAtSize(`${chunk}${character}`, fontSize) > maxWidth) {
          words.push(chunk);
          chunk = character;
        } else chunk += character;
      }
      if (chunk) words.push(chunk);
    }
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth || !line) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

async function generateAssessmentPdf(appointmentNumber, answers) {
  if (!fs.existsSync(assessmentTemplatePath)) throw new Error('The patient assessment PDF template is missing.');
  const document = await PDFDocument.load(fs.readFileSync(assessmentTemplatePath));
  const font = await document.embedFont(StandardFonts.Helvetica);
  const fontSize = 8;
  const lineHeight = 10;
  const layouts = {
    patientName: { page: 0, x: 165, y: 612, bottom: 602, maxWidth: 405 },
    age: { page: 0, x: 115, y: 598, bottom: 588, maxWidth: 455 },
    gender: { page: 0, x: 135, y: 584, bottom: 574, maxWidth: 435 },
    contactNumber: { page: 0, x: 155, y: 570, bottom: 560, maxWidth: 415 },
    assessmentDate: { page: 0, x: 165, y: 557, bottom: 547, maxWidth: 405 },
    presentingComplaint: { page: 0, x: 34, y: 495, bottom: 470, maxWidth: 540 },
    currentSymptoms: { page: 0, x: 34, y: 412, bottom: 374, maxWidth: 540 },
    painSeverity: { page: 0, x: 34, y: 315, bottom: 264, maxWidth: 540 },
    aggravatingFactors: { page: 0, x: 34, y: 205, bottom: 167, maxWidth: 540 },
    relievingFactors: { page: 0, x: 34, y: 108, bottom: 80, maxWidth: 540 },
    sleepNightPain: { page: 1, x: 34, y: 679, bottom: 649, maxWidth: 540 },
    previousInjuriesSurgeries: { page: 1, x: 34, y: 590, bottom: 564, maxWidth: 540 },
    comorbidConditions: { page: 1, x: 34, y: 504, bottom: 482, maxWidth: 540 },
    currentMedications: { page: 1, x: 34, y: 423, bottom: 394, maxWidth: 540 },
    allergies: { page: 1, x: 34, y: 335, bottom: 314, maxWidth: 540 },
    posture: { page: 1, x: 34, y: 255, bottom: 236, maxWidth: 540 },
    gait: { page: 1, x: 34, y: 175, bottom: 156, maxWidth: 540 },
    swellingDeformity: { page: 1, x: 34, y: 96, bottom: 80, maxWidth: 540 },
    observation: { page: 2, x: 34, y: 679, bottom: 654, maxWidth: 540 },
    activeRom: { page: 2, x: 34, y: 596, bottom: 574, maxWidth: 540 },
    passiveRom: { page: 2, x: 34, y: 516, bottom: 493, maxWidth: 540 },
    muscleStrengthMmt: { page: 2, x: 34, y: 435, bottom: 412, maxWidth: 540 },
    specialTests: { page: 2, x: 34, y: 354, bottom: 333, maxWidth: 540 },
    provisionalDiagnosis: { page: 2, x: 34, y: 277, bottom: 253, maxWidth: 540 },
    treatmentPlan: { page: 2, x: 34, y: 198, bottom: 165, maxWidth: 540 },
    homeExercisePlan: { page: 2, x: 34, y: 109, bottom: 82, maxWidth: 540 },
    adviceEducation: { page: 3, x: 34, y: 688, bottom: 632, maxWidth: 540 }
  };
  const overflowSections = [];
  for (const [key, label] of assessmentFields) {
    const value = answers[key];
    if (value === undefined || value === null || value === '') continue;
    const layout = layouts[key];
    const maxLines = Math.max(1, Math.floor((layout.y - layout.bottom) / lineHeight) + 1);
    const lines = wrapAssessmentText(value, font, fontSize, layout.maxWidth);
    const page = document.getPage(layout.page);
    lines.slice(0, maxLines).forEach((line, index) => {
      page.drawText(line, { x: layout.x, y: layout.y - index * lineHeight, size: fontSize, font, color: rgb(0.08, 0.16, 0.22) });
    });
    if (lines.length > maxLines) overflowSections.push({ label, lines: lines.slice(maxLines) });
  }
  let continuationPage;
  let y = 750;
  for (const section of overflowSections) {
    if (!continuationPage || y < 55) {
      continuationPage = document.addPage([612, 792]);
      continuationPage.drawText(`Patient History & Assessment - Appointment #${appointmentNumber}`, { x: 36, y: 760, size: 12, font });
      y = 735;
    }
    continuationPage.drawText(section.label, { x: 36, y, size: 9, font });
    y -= 13;
    for (const line of section.lines) {
      if (y < 40) {
        continuationPage = document.addPage([612, 792]);
        continuationPage.drawText(`Patient History & Assessment - Appointment #${appointmentNumber} (continued)`, { x: 36, y: 760, size: 12, font });
        y = 735;
      }
      continuationPage.drawText(line, { x: 36, y, size: fontSize, font });
      y -= lineHeight;
    }
    y -= 8;
  }
  return Buffer.from(await document.save());
}

function jsonBody(request, maxBytes = 12000) {
  if (request.body !== undefined) {
    const body = request.body;
    const serialized = Buffer.isBuffer(body) ? body.toString('utf8') : typeof body === 'string' ? body : null;
    if (serialized !== null) {
      if (Buffer.byteLength(serialized) > maxBytes) return Promise.reject(Object.assign(new Error('Request body too large'), { status: 413 }));
      try { return Promise.resolve(JSON.parse(serialized || '{}')); }
      catch { return Promise.reject(Object.assign(new Error('Invalid JSON body'), { status: 400 })); }
    }
    if (body && typeof body === 'object') {
      if (Buffer.byteLength(JSON.stringify(body)) > maxBytes) return Promise.reject(Object.assign(new Error('Request body too large'), { status: 413 }));
      return Promise.resolve(body);
    }
  }
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > maxBytes) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        request.destroy();
      }
    });
    request.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { reject(Object.assign(new Error('Invalid JSON body'), { status: 400 })); }
    });
    request.on('error', reject);
  });
}

function assertSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return;
  const forwardedProtocol = request.headers['x-forwarded-proto']?.split(',')[0];
  const expected = process.env.PMS_PUBLIC_ORIGIN || `${forwardedProtocol || (request.socket?.encrypted ? 'https' : 'http')}://${request.headers.host}`;
  if (origin !== expected) throw Object.assign(new Error('Cross-origin request rejected'), { status: 403 });
}

async function limitLogin(request) {
  const forwardedFor = request.headers['x-forwarded-for']?.split(',')[0].trim();
  const address = forwardedFor || request.socket?.remoteAddress || 'unknown';
  const key = crypto.createHash('sha256').update(address).digest('hex');
  const now = Date.now();
  const windowExpiresAt = now + 15 * 60 * 1000;
  const entry = await db.prepare('SELECT failure_count AS failureCount, window_expires_at AS windowExpiresAt FROM login_failures WHERE address_hash = ?').get(key);
  if (!entry || entry.windowExpiresAt <= now) {
    await db.prepare(`INSERT INTO login_failures (address_hash, failure_count, window_expires_at) VALUES (?, 0, ?)
      ON CONFLICT(address_hash) DO UPDATE SET failure_count = 0, window_expires_at = excluded.window_expires_at`)
      .run(key, windowExpiresAt);
    return key;
  }
  if (entry.failureCount >= 10) throw Object.assign(new Error('Too many attempts. Try again in 15 minutes.'), { status: 429 });
  return key;
}

async function recordLoginFailure(addressHash) {
  await db.prepare('UPDATE login_failures SET failure_count = failure_count + 1 WHERE address_hash = ?').run(addressHash);
}

function todayString() { return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.PMS_TIME_ZONE || 'Asia/Karachi' }).format(new Date()); }

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function shiftIsoDate(value, days) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function weekRange(value) {
  const dayOfWeek = new Date(`${value}T00:00:00.000Z`).getUTCDay();
  const mondayOffset = (dayOfWeek + 6) % 7;
  const startDate = shiftIsoDate(value, -mondayOffset);
  return { startDate, endDate: shiftIsoDate(startDate, 6) };
}

async function dashboard(user, selectedDate, mode) {
  const today = todayString();
  const range = mode === 'week' ? weekRange(selectedDate) : { startDate: selectedDate, endDate: selectedDate };
  const schedule = { mode, selectedDate, ...range };
  if (user.role === 'gymkhana') {
    const visits = (await db.prepare("SELECT COUNT(*) AS count FROM appointments WHERE appointment_date BETWEEN ? AND ? AND status != 'Cancelled'").get(range.startDate, range.endDate)).count;
    const month = today.slice(0, 7);
    const monthly = (await db.prepare("SELECT COUNT(*) AS count FROM appointments WHERE substr(appointment_date, 1, 7) = ? AND status != 'Cancelled'").get(month)).count;
    const visitRoster = await db.prepare(`SELECT p.name, a.appointment_time AS time, a.appointment_date AS date, a.status
      FROM appointments a JOIN patients p ON p.id = a.patient_id
      WHERE a.appointment_date BETWEEN ? AND ? AND a.status != 'Cancelled'
      ORDER BY a.appointment_date, a.appointment_time LIMIT 500`).all(range.startDate, range.endDate);
    const queue = await db.prepare(`SELECT p.name, a.appointment_time AS time, a.status
      FROM appointments a JOIN patients p ON p.id = a.patient_id
      WHERE a.appointment_date = ? AND a.status IN ('Waiting','In session')
      ORDER BY CASE a.status WHEN 'In session' THEN 0 ELSE 1 END, a.appointment_time LIMIT 20`).all(today);
    return { user: { ...user, roleLabel: labels[user.role] }, auditOnly: true, schedule, metrics: { visitsToday: visits, visitsMonth: monthly }, visits: visitRoster, queue, compliance: [] };
  }

  const whereDoctor = user.role === 'doctor' ? ' AND a.doctor_id = ?' : '';
  const patientCondition = ['admin', 'doctor'].includes(user.role) ? 'p.condition' : "''";
  const params = user.role === 'doctor' ? [range.startDate, range.endDate, user.id] : [range.startDate, range.endDate];
  const visits = await db.prepare(`
    SELECT a.id, ar.appointment_number AS appointmentNumber, a.appointment_date AS date, a.appointment_time AS time, COALESCE(NULLIF(a.visit_category, ''), a.visit_type) AS visit, a.status,
      p.id AS patientId, p.name, ${patientCondition} AS area, d.name AS doctor
    FROM appointments a JOIN appointment_references ar ON ar.appointment_id = a.id JOIN patients p ON p.id = a.patient_id JOIN users d ON d.id = a.doctor_id
    WHERE a.appointment_date BETWEEN ? AND ? AND a.status != 'Cancelled'${whereDoctor}
    ORDER BY a.appointment_date, a.appointment_time LIMIT 500
  `).all(...params);
  const assignedPatients = user.role === 'doctor'
    ? await db.prepare(`SELECT p.id, p.name, p.condition, MAX(a.appointment_date) AS lastVisit
      FROM appointments a JOIN patients p ON p.id = a.patient_id
      WHERE a.doctor_id = ? AND a.status != 'Cancelled'
      GROUP BY p.id ORDER BY lastVisit DESC, p.name LIMIT 5`).all(user.id)
    : [];
  const waiting = visits.filter(visit => visit.date === today && (visit.status === 'Waiting' || visit.status === 'In session'));
  const revenue = user.role === 'admin'
    ? (await db.prepare(`SELECT COALESCE(SUM(p.amount_paisa), 0) AS total FROM payments p JOIN appointments a ON a.id = p.appointment_id WHERE a.appointment_date BETWEEN ? AND ? AND p.payment_status = 'Paid'`).get(range.startDate, range.endDate)).total
    : null;
  const countUsers = user.role === 'admin' ? (await db.prepare('SELECT COUNT(*) AS count FROM users WHERE active = 1').get()).count : null;
  const doctors = ['admin', 'manager'].includes(user.role)
    ? await db.prepare("SELECT id, name FROM users WHERE role = 'doctor' AND active = 1 ORDER BY name").all()
    : [];
  const monthlyCount = user.role === 'admin' ? (await db.prepare("SELECT COUNT(*) AS count FROM appointments WHERE substr(appointment_date, 1, 7) = ? AND status != 'Cancelled'").get(today.slice(0, 7))).count : null;
  const queueParams = user.role === 'doctor' ? [today, user.id] : [today];
  const queue = user.role === 'gymkhana' ? [] : await db.prepare(`
    SELECT a.id, a.appointment_time AS time, a.status, p.id AS patientId, p.name, d.name AS doctor
    FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN users d ON d.id = a.doctor_id
    WHERE a.appointment_date = ? AND a.status IN ('Waiting','In session')${whereDoctor}
    ORDER BY CASE a.status WHEN 'In session' THEN 0 ELSE 1 END, a.appointment_time LIMIT 20
  `).all(...queueParams);
  return {
    user: { ...user, roleLabel: labels[user.role] },
    schedule,
    metrics: { visitsToday: visits.length, waiting: waiting.length, revenuePaisa: revenue, staffOnDuty: countUsers, visitsMonth: monthlyCount },
    visits,
    assignedPatients,
    queue,
    doctors
  };
}

const workspaceRoles = {
  'Appointments': ['admin', 'manager'],
  'My appointments': ['doctor'],
  'New patients': ['admin', 'manager'],
  'Live queue': ['admin', 'manager', 'doctor'],
  'Patients': ['admin', 'manager'],
  'Membership requests': ['admin'],
  'My patients': ['doctor'],
  'Clinical records': ['admin', 'doctor'],
  'Clinical archive': ['admin'],
  'Clinical notes': ['admin', 'doctor'],
  'Exercise plans': ['doctor'],
  'Billing & expenses': ['admin'],
  'Receipts': ['admin', 'manager'],
  'Staff & shifts': ['admin'],
  'Inventory': ['admin', 'manager'],
  'Daily tasks': ['admin', 'manager'],
  'Follow-ups': ['admin', 'manager', 'doctor'],
  'Reports & audit': ['admin'],
  'Footfall': ['gymkhana'],
  'Compliance': ['admin', 'manager', 'gymkhana'],
  'Operating hours': ['gymkhana']
};

async function getWorkspace(user, view, requestedMonth = '', requestedDate = '') {
  const today = todayString();
  if (!workspaceRoles[view]?.includes(user.role)) return null;
  const doctorFilter = user.role === 'doctor' ? ' AND a.doctor_id = ?' : '';
  const appointmentParams = user.role === 'doctor' ? [user.id] : [];
  if (view === 'New patients') {
    const rows = await db.prepare(`SELECT a.id, ref.appointment_number AS appointmentNumber, a.appointment_date AS date,
      a.appointment_time AS time, p.id AS patientId, p.name, p.membership_id AS membershipId, p.condition,
      COALESCE(NULLIF(a.visit_category, ''), a.visit_type) AS visit, a.status, d.name AS doctor,
      COALESCE(pa.status, 'Not started') AS assessmentStatus
      FROM appointments a JOIN appointment_references ref ON ref.appointment_id = a.id
      JOIN patients p ON p.id = a.patient_id JOIN users d ON d.id = a.doctor_id
      LEFT JOIN patient_assessments pa ON pa.appointment_id = a.id
      WHERE COALESCE(NULLIF(a.visit_category, ''), a.visit_type) = 'New patient'
      ORDER BY a.appointment_date DESC, a.appointment_time DESC LIMIT 500`).all();
    return { view, rows };
  }
  if (view === 'Appointments' || view === 'My appointments' || view === 'Live queue') {
    const statusFilter = view === 'Live queue' ? " AND a.status IN ('Waiting','In session','Completed')" : '';
    const rows = await db.prepare(`SELECT a.id, ref.appointment_number AS appointmentNumber, a.appointment_date AS date, a.appointment_time AS time, COALESCE(NULLIF(a.visit_category, ''), a.visit_type) AS visit, a.status,
      p.id AS patientId, p.name, ${['admin', 'doctor'].includes(user.role) ? 'p.condition' : "''"} AS condition,
      ${['admin', 'manager'].includes(user.role) ? "COALESCE(NULLIF(p.membership_id, ''), 'Appointment #' || ref.appointment_number)" : user.role === 'doctor' && view === 'My appointments' ? 'p.membership_id' : "''"} AS membershipId,
      ${['admin', 'manager'].includes(user.role) ? 'p.phone' : "''"} AS phone,
      ${['admin', 'manager'].includes(user.role) ? 'p.sessions_prescribed' : 'NULL'} AS sessionsPrescribed,
      ${['admin', 'manager'].includes(user.role) ? 'p.sessions_reception_updated' : 'NULL'} AS sessionsReceptionUpdated,
      ${['admin', 'manager'].includes(user.role) ? 'pay.payment_mode' : "''"} AS paymentMode,
      ${['admin', 'manager'].includes(user.role) ? 'pay.amount_paisa' : 'NULL'} AS amountPaisa,
      ${['admin', 'manager'].includes(user.role) ? 'pay.amount_manager_updated' : 'NULL'} AS amountManagerUpdated,
      ${['admin', 'manager'].includes(user.role) ? 'pay.payment_status' : "''"} AS paymentStatus,
      ${['admin', 'manager'].includes(user.role) ? 'a.session_number' : 'NULL'} AS sessionNumber,
      d.name AS doctor, a.doctor_id AS doctorId,
      ${view === 'My appointments' ? "COALESCE(pa.status, 'Not started')" : "''"} AS assessmentStatus
      FROM appointments a JOIN appointment_references ref ON ref.appointment_id = a.id JOIN patients p ON p.id = a.patient_id JOIN users d ON d.id = a.doctor_id
      LEFT JOIN payments pay ON pay.appointment_id = a.id
      LEFT JOIN patient_assessments pa ON pa.appointment_id = a.id
      WHERE a.appointment_date >= ?${doctorFilter}${statusFilter}
      ORDER BY a.appointment_date, a.appointment_time LIMIT 300`).all(today, ...appointmentParams);
    return { view, rows, doctors: ['admin', 'manager'].includes(user.role) ? await db.prepare("SELECT id, name FROM users WHERE role = 'doctor' AND active = 1 ORDER BY name").all() : [] };
  }
  if (view === 'Patients' || view === 'My patients') {
    const patientRoleFilter = user.role === 'doctor' ? `WHERE EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id = p.id AND a.doctor_id = ?)` : '';
    const rows = await db.prepare(`SELECT p.id, p.name, p.age, ${['admin', 'manager', 'doctor'].includes(user.role) ? 'p.condition' : "''"} AS condition,
      ${['admin', 'manager', 'doctor'].includes(user.role) ? 'p.membership_id' : "''"} AS membershipId,
      ${['admin', 'manager'].includes(user.role) ? 'p.phone' : "''"} AS phone,
      ${['admin', 'manager'].includes(user.role) ? 'p.sessions_prescribed' : 'NULL'} AS sessionsPrescribed,
      ${['admin', 'manager'].includes(user.role) ? 'p.sessions_reception_updated' : 'NULL'} AS sessionsReceptionUpdated,
      (SELECT ar.appointment_number FROM appointments a JOIN appointment_references ar ON ar.appointment_id = a.id
        WHERE a.patient_id = p.id${user.role === 'doctor' ? ' AND a.doctor_id = ?' : ''}
        ORDER BY a.appointment_date DESC, a.appointment_time DESC LIMIT 1) AS appointmentNumber,
      ${['admin', 'manager'].includes(user.role) ? `(SELECT json_group_array(json_object('id', appointmentId, 'number', appointmentNumber, 'date', appointmentDate, 'time', appointmentTime, 'status', status))
        FROM (SELECT a.id AS appointmentId, ar.appointment_number AS appointmentNumber,
            a.appointment_date AS appointmentDate, a.appointment_time AS appointmentTime, a.status
          FROM appointments a JOIN appointment_references ar ON ar.appointment_id = a.id
          WHERE a.patient_id = p.id ORDER BY a.appointment_date DESC, a.appointment_time DESC))` : "'[]'"} AS appointmentOptionsJson,
      (SELECT MAX(a.appointment_date) FROM appointments a WHERE a.patient_id = p.id${user.role === 'doctor' ? ' AND a.doctor_id = ?' : ''}) AS lastVisit
      FROM patients p ${patientRoleFilter} ORDER BY p.created_at DESC LIMIT 300`)
      .all(...(user.role === 'doctor' ? [user.id, user.id, user.id] : []));
    return { view, rows };
  }
  if (view === 'Membership requests') {
    const rows = await db.prepare(`SELECT p.id, p.name, p.phone, p.age,
      (SELECT ar.appointment_number FROM appointments a JOIN appointment_references ar ON ar.appointment_id = a.id
        WHERE a.patient_id = p.id ORDER BY a.appointment_date DESC, a.appointment_time DESC LIMIT 1) AS appointmentNumber,
      (SELECT MAX(a.appointment_date) FROM appointments a WHERE a.patient_id = p.id) AS lastVisit,
      (SELECT COUNT(*) FROM appointments a WHERE a.patient_id = p.id) AS visitCount
      FROM patients p WHERE p.membership_id = '' AND EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id = p.id)
      ORDER BY p.created_at DESC LIMIT 300`).all();
    return { view, rows };
  }
  if (view === 'Staff & shifts') {
    return { view, rows: await db.prepare("SELECT id, name, email, role, active, created_at AS joined FROM users WHERE email != 'former-staff@invalid.local' ORDER BY role, name").all() };
  }
  if (view === 'Inventory') {
    return { view, rows: await db.prepare('SELECT id, name, category, quantity, unit, reorder_at AS reorderAt FROM inventory_items ORDER BY category, name').all() };
  }
  if (view === 'Billing & expenses' || view === 'Receipts') {
    const canViewExpenses = user.role === 'admin';
    const receipts = await db.prepare(`SELECT pay.id, pay.appointment_id AS appointmentId, pay.amount_paisa AS amountPaisa,
      ${['admin', 'manager'].includes(user.role) ? 'pay.amount_manager_updated' : 'NULL'} AS amountManagerUpdated,
      pay.club_share_paisa AS clubSharePaisa, pay.payment_mode AS paymentMode, pay.payment_status AS paymentStatus, pay.created_at AS createdAt,
      p.name AS patient, a.appointment_date AS date, a.appointment_time AS time
      FROM payments pay JOIN appointments a ON a.id = pay.appointment_id JOIN patients p ON p.id = a.patient_id
      ORDER BY pay.created_at DESC LIMIT 200`).all();
    const expenses = canViewExpenses ? await db.prepare('SELECT id, category, description, amount_paisa AS amountPaisa, spent_on AS date FROM expenses ORDER BY spent_on DESC LIMIT 200').all() : [];
    const revenue = (await db.prepare("SELECT COALESCE(SUM(amount_paisa), 0) AS total FROM payments WHERE payment_status = 'Paid'").get()).total;
    if (!canViewExpenses) return { view, rows: receipts, expenses, summary: { revenuePaisa: revenue } };
    const expenseTotal = (await db.prepare('SELECT COALESCE(SUM(amount_paisa), 0) AS total FROM expenses').get()).total;
    return { view, rows: receipts, expenses, summary: { revenuePaisa: revenue, expensesPaisa: expenseTotal, netPaisa: revenue - expenseTotal } };
  }
  if (view === 'Daily tasks' || view === 'Follow-ups') {
    const doctorOnly = user.role === 'doctor';
    const rows = view === 'Follow-ups'
      ? await db.prepare(`SELECT a.id, ar.appointment_number AS appointmentNumber, COALESCE(NULLIF(p.membership_id, ''), 'Appointment #' || ar.appointment_number) AS membershipId,
          a.appointment_date AS date, a.appointment_time AS time, COALESCE(NULLIF(a.visit_category, ''), a.visit_type) AS visit, p.id AS patientId, p.name, d.name AS doctor
        FROM appointments a JOIN appointment_references ar ON ar.appointment_id = a.id JOIN patients p ON p.id = a.patient_id JOIN users d ON d.id = a.doctor_id
        WHERE a.status != 'Cancelled' AND a.visit_type = 'Follow-up' AND a.appointment_date >= ?${doctorOnly ? ' AND a.doctor_id = ?' : ''}
        ORDER BY a.appointment_date, a.appointment_time LIMIT 200`).all(...(doctorOnly ? [today, user.id] : [today]))
      : await db.prepare('SELECT id, title, due_date AS date, status FROM clinic_tasks ORDER BY status != \'Completed\', due_date LIMIT 200').all();
    return { view, rows };
  }
  if (view === 'Clinical records' || view === 'Clinical notes' || view === 'Exercise plans') {
    const kind = view === 'Exercise plans' ? "AND n.treatment_plan != ''" : '';
    if (view === 'Clinical records') {
      const currentMonth = today.slice(0, 7);
      const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(requestedMonth) ? requestedMonth : currentMonth;
      const doctorFilter = user.role === 'doctor' ? ' AND a.doctor_id = ?' : '';
      const rows = await db.prepare(`SELECT a.id, a.patient_id AS patientId, p.name AS patient,
        COALESCE(NULLIF(p.membership_id, ''), 'Appointment #' || ar.appointment_number) AS membershipId,
        ar.appointment_number AS appointmentNumber, a.session_number AS sessionNumber, p.sessions_prescribed AS sessionsPrescribed,
        p.sessions_reception_updated AS sessionsReceptionUpdated,
        a.appointment_date AS recordDate, a.appointment_time AS time,
        a.visit_type AS visit, COALESCE(NULLIF(a.visit_category, ''), a.visit_type) AS visitCategory,
        a.status, d.name AS doctor, COALESCE(n.note, '') AS note, COALESCE(n.treatment_plan, '') AS treatmentPlan,
        n.next_visit AS nextVisit, n.created_at AS createdAt
        FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN users d ON d.id = a.doctor_id
        JOIN appointment_references ar ON ar.appointment_id = a.id
        LEFT JOIN clinical_notes n ON n.id = (SELECT latest.id FROM clinical_notes latest
          WHERE latest.appointment_id = a.id ORDER BY latest.created_at DESC LIMIT 1)
        WHERE substr(a.appointment_date, 1, 7) = ? AND a.status != 'Cancelled'${doctorFilter}
        ORDER BY a.appointment_date DESC, a.appointment_time DESC`).all(...(user.role === 'doctor' ? [month, user.id] : [month]));
      const archives = user.role === 'admin'
        ? await db.prepare(`SELECT substr(a.appointment_date, 1, 7) AS month, COUNT(*) AS count
            FROM appointments a WHERE a.status != 'Cancelled'
            GROUP BY month HAVING month < ? ORDER BY month DESC`).all(currentMonth)
        : [];
      return { view, rows, month, currentMonth, archives };
    }
    const rows = await db.prepare(`SELECT n.id, n.patient_id AS patientId, p.name AS patient, p.membership_id AS membershipId,
      n.appointment_id AS appointmentId, ar.appointment_number AS appointmentNumber, n.note, n.treatment_plan AS treatmentPlan,
      n.next_visit AS nextVisit, n.created_at AS createdAt, d.name AS doctor
      FROM clinical_notes n JOIN patients p ON p.id = n.patient_id JOIN users d ON d.id = n.doctor_id
      LEFT JOIN appointment_references ar ON ar.appointment_id = n.appointment_id
      WHERE (? = 'admin' OR n.doctor_id = ?) ${kind}
      ORDER BY n.created_at DESC LIMIT 300`).all(user.role, user.id);
    return { view, rows };
  }
  if (view === 'Clinical archive') {
    const currentMonth = today.slice(0, 7);
    const rows = await db.prepare(`SELECT substr(appointment_date, 1, 7) AS month, COUNT(*) AS count
      FROM appointments WHERE status != 'Cancelled'
      GROUP BY month HAVING month < ? ORDER BY month DESC`).all(currentMonth);
    return { view, rows, currentMonth };
  }
  if (view === 'Reports & audit') {
    const rows = await db.prepare('SELECT l.action, l.entity_type AS entity, l.created_at AS createdAt, l.details_json AS detailsJson, u.name AS staff FROM audit_log l LEFT JOIN users u ON u.id = l.actor_id ORDER BY l.created_at DESC LIMIT 200').all();
    const months = await db.prepare(`SELECT substr(appointment_date, 1, 7) AS month, COUNT(*) AS visits FROM appointments WHERE status != 'Cancelled' GROUP BY month ORDER BY month DESC LIMIT 12`).all();
    return { view, rows, months };
  }
  if (view === 'Compliance') {
    const notesColumn = user.role === 'gymkhana' ? '' : ', notes';
    return { view, rows: await db.prepare(`SELECT check_name AS checkName, status${notesColumn}, checked_on AS checkedOn FROM compliance_checks ORDER BY checked_on DESC, created_at DESC LIMIT 200`).all() };
  }
  if (view === 'Footfall') {
    const startDate = new Date(`${today}T00:00:00.000Z`);
    startDate.setUTCDate(startDate.getUTCDate() - 30);
    const startDateString = startDate.toISOString().slice(0, 10);
    const rows = await db.prepare(`SELECT a.appointment_date AS date, COUNT(*) AS visits,
      COALESCE(SUM(CASE WHEN pay.payment_status = 'Paid' THEN pay.amount_paisa ELSE 0 END), 0) AS revenuePaisa,
      COALESCE(SUM(pay.club_share_paisa), 0) AS clubSharePaisa
      FROM appointments a LEFT JOIN payments pay ON pay.appointment_id = a.id
      WHERE a.appointment_date BETWEEN ? AND ? AND a.status != 'Cancelled'
      GROUP BY a.appointment_date ORDER BY a.appointment_date DESC`).all(startDateString, today);
    const selectedMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(requestedMonth) ? requestedMonth : today.slice(0, 7);
    const detailRows = requestedDate || requestedMonth
      ? await db.prepare(`SELECT a.appointment_date AS date, ref.appointment_number AS appointmentNumber, a.session_number AS sessionNumber,
          p.name, COALESCE(NULLIF(p.membership_id, ''), 'Appointment #' || ref.appointment_number) AS membershipId,
          p.phone, p.age, p.condition AS issue, p.sessions_prescribed AS sessionsPrescribed,
          a.appointment_time AS time, a.status, COALESCE(pay.amount_paisa, 0) AS amountPaisa,
          COALESCE(pay.payment_status, 'Unpaid') AS paymentStatus, COALESCE(pay.club_share_paisa, 0) AS clubSharePaisa
        FROM appointments a JOIN patients p ON p.id = a.patient_id
        JOIN appointment_references ref ON ref.appointment_id = a.id
        LEFT JOIN payments pay ON pay.appointment_id = a.id
        WHERE ${requestedDate ? 'a.appointment_date = ?' : "substr(a.appointment_date, 1, 7) = ?"} AND a.status != 'Cancelled'
        ORDER BY a.appointment_date DESC, a.appointment_time, p.name LIMIT 2000`).all(requestedDate || selectedMonth)
      : null;
    return { view, rows, detailRows, detailDate: requestedDate || null, detailMonth: requestedMonth ? selectedMonth : null, summary: { visitsMonth: (await db.prepare("SELECT COUNT(*) AS count FROM appointments WHERE substr(appointment_date, 1, 7) = ? AND status != 'Cancelled'").get(today.slice(0, 7))).count } };
  }
  if (view === 'Operating hours') {
    return { view, rows: [{ day: 'Monday–Saturday', hours: '14:00–22:00', adherence: 'Tracked from appointments' }, { day: 'Sunday', hours: 'Closed', adherence: 'Scheduled closure' }] };
  }
  return { view, rows: [] };
}

function contentSecurityHeaders() {
  return {
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  };
}

async function routeApi(request, response, url) {
  if (['POST', 'PATCH', 'DELETE'].includes(request.method)) assertSameOrigin(request);

  if (url.pathname === '/api/setup-status' && request.method === 'GET') {
    const adminExists = Boolean(await db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get());
    return sendJson(response, 200, { setupRequired: !adminExists && process.env.NODE_ENV !== 'production' });
  }

  if (url.pathname === '/api/setup' && request.method === 'POST') {
    if (process.env.NODE_ENV === 'production') return sendJson(response, 404, { error: 'Not found.' });
    const body = await jsonBody(request, 3000);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 160) : '';
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email.includes('@') || !name || password.length < 14) return sendJson(response, 400, { error: 'Enter your name, a valid email and a password of at least 14 characters.' });
    const id = makeId('usr');
    const salt = crypto.randomBytes(16).toString('hex');
    try {
      await db.exec('BEGIN IMMEDIATE');
      if (await db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get()) {
        await db.exec('ROLLBACK');
        return sendJson(response, 409, { error: 'Initial setup has already been completed.' });
      }
      await db.prepare('INSERT INTO users (id, email, name, role, password_hash, password_salt) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, email, name, 'admin', passwordDigest(password, salt), salt);
      await audit(id, 'bootstrap', 'user', id);
      await db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) await db.exec('ROLLBACK');
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return sendJson(response, 409, { error: 'An account with that email already exists.' });
      throw error;
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + sessionHours * 60 * 60 * 1000;
    await db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(crypto.createHash('sha256').update(token).digest('hex'), id, expiresAt);
    return sendJson(response, 201, { user: { id, email, name, role: 'admin', roleLabel: labels.admin } }, {
      'Set-Cookie': `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionHours * 60 * 60}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`
    });
  }

  if (url.pathname === '/api/login' && request.method === 'POST') {
    const key = await limitLogin(request);
    const body = await jsonBody(request, 2000);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 160) : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const user = await db.prepare('SELECT id, email, name, role, password_hash, password_salt, active FROM users WHERE email = ?').get(email);
    const candidate = passwordDigest(password.slice(0, 256), user?.password_salt || 'invalid-account-salt');
    const valid = Boolean(user && crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(user.password_hash, 'hex')));
    if (!valid) {
      await recordLoginFailure(key);
      return sendJson(response, 401, { error: 'Email or password is incorrect.' });
    }
    await db.prepare('DELETE FROM login_failures WHERE address_hash = ?').run(key);
    await db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    if (!user.active) return sendJson(response, 403, { error: 'Account restricted. Please contact your admin.' });
    const token = crypto.randomBytes(32).toString('base64url');
    const digest = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = Date.now() + sessionHours * 60 * 60 * 1000;
    await db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(digest, user.id, expiresAt);
    await audit(user.id, 'login', 'session');
    return sendJson(response, 200, { user: { id: user.id, email: user.email, name: user.name, role: user.role, roleLabel: labels[user.role] } }, {
      'Set-Cookie': `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionHours * 60 * 60}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`
    });
  }

  if (url.pathname === '/api/logout' && request.method === 'POST') {
    const token = parseCookies(request.headers.cookie)[cookieName];
    if (token) await db.prepare('DELETE FROM sessions WHERE token_hash = ?')
      .run(crypto.createHash('sha256').update(token).digest('hex'));
    return sendJson(response, 200, { ok: true }, { 'Set-Cookie': `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}` });
  }

  const user = await getUser(request);
  if (url.pathname === '/api/session' && request.method === 'GET') {
    return sendJson(response, 200, { user: user ? { id: user.id, email: user.email, name: user.name, role: user.role, roleLabel: labels[user.role] } : null });
  }
  if (!user) return sendJson(response, 401, { error: 'Authentication required.' });

  if (url.pathname === '/api/change-password' && request.method === 'POST') {
    if (user.role !== 'admin') return sendJson(response, 403, { error: 'Only Head / Admin can change passwords.' });
    const body = await jsonBody(request, 2000);
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
    if (currentPassword.length > 256 || newPassword.length < 14 || newPassword.length > 256) {
      return sendJson(response, 400, { error: 'Enter your current password and a new password of 14 to 256 characters.' });
    }
    const account = await db.prepare('SELECT password_hash, password_salt FROM users WHERE id = ?').get(user.id);
    const currentHash = passwordDigest(currentPassword, account.password_salt);
    if (!crypto.timingSafeEqual(Buffer.from(currentHash, 'hex'), Buffer.from(account.password_hash, 'hex'))) {
      return sendJson(response, 403, { error: 'Current password is incorrect.' });
    }
    const reusedHash = passwordDigest(newPassword, account.password_salt);
    if (crypto.timingSafeEqual(Buffer.from(reusedHash, 'hex'), Buffer.from(account.password_hash, 'hex'))) {
      return sendJson(response, 400, { error: 'Choose a new password different from your current password.' });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    await db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?')
      .run(passwordDigest(newPassword, salt), salt, user.id);
    const currentToken = parseCookies(request.headers.cookie)[cookieName];
    const currentDigest = crypto.createHash('sha256').update(currentToken).digest('hex');
    await db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(user.id, currentDigest);
    await audit(user.id, 'password_change', 'user', user.id);
    return sendJson(response, 200, { ok: true });
  }

  const staffPasswordMatch = url.pathname.match(/^\/api\/users\/([A-Za-z0-9_-]+)\/password$/);
  if (staffPasswordMatch && request.method === 'POST') {
    if (user.role !== 'admin') return sendJson(response, 403, { error: 'Only Head / Admin can reset staff passwords.' });
    const target = await db.prepare('SELECT id, role FROM users WHERE id = ? AND email != ?')
      .get(staffPasswordMatch[1], 'former-staff@invalid.local');
    if (!target) return sendJson(response, 404, { error: 'Staff account not found.' });
    if (target.role === 'admin' || target.id === user.id) {
      return sendJson(response, 400, { error: 'Use Change password to update your own administrator password.' });
    }
    const body = await jsonBody(request, 1000);
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
    if (newPassword.length < 14 || newPassword.length > 256) {
      return sendJson(response, 400, { error: 'New password must contain 14 to 256 characters.' });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    await db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?')
      .run(passwordDigest(newPassword, salt), salt, target.id);
    await revokeUserSessions(target.id);
    await audit(user.id, 'staff_password_reset', 'user', target.id);
    return sendJson(response, 200, { ok: true });
  }

  if (url.pathname === '/api/dashboard' && request.method === 'GET') {
    const requestedDate = url.searchParams.get('date');
    const selectedDate = isIsoDate(requestedDate) ? requestedDate : todayString();
    const mode = url.searchParams.get('mode') === 'week' ? 'week' : 'day';
    return sendJson(response, 200, await dashboard(user, selectedDate, mode));
  }

  const memberHistoryMatch = url.pathname.match(/^\/api\/members\/([^/]+)$/);
  if (memberHistoryMatch && request.method === 'GET') {
    if (!requireRole(user, ['admin', 'manager', 'doctor'])) return sendJson(response, 403, { error: 'Member lookup is not available to your role.' });
    const membershipId = decodeURIComponent(memberHistoryMatch[1]).trim().slice(0, 64);
    const member = await db.prepare("SELECT id, membership_id AS membershipId, name, phone, age, sessions_prescribed AS sessionsPrescribed, sessions_reception_updated AS sessionsReceptionUpdated FROM patients WHERE membership_id = ? COLLATE NOCASE AND membership_source = 'gymkhana'").get(membershipId);
    if (!member) return sendJson(response, 404, { error: 'No Gymkhana member found with that membership ID.' });
    if (user.role === 'doctor' && !await db.prepare("SELECT 1 FROM appointments WHERE patient_id = ? AND doctor_id = ? AND status != 'Cancelled' LIMIT 1").get(member.id, user.id)) {
      return sendJson(response, 404, { error: 'Member not found in your assigned caseload.' });
    }
    const visits = await db.prepare(`SELECT a.id, ar.appointment_number AS appointmentNumber, a.appointment_date AS date,
      a.appointment_time AS time, COALESCE(NULLIF(a.visit_category, ''), a.visit_type) AS visit, a.status, d.name AS doctor
      FROM appointments a JOIN appointment_references ar ON ar.appointment_id = a.id JOIN users d ON d.id = a.doctor_id
      WHERE a.patient_id = ?${user.role === 'doctor' ? ' AND a.doctor_id = ?' : ''}
      ORDER BY a.appointment_date DESC, a.appointment_time DESC LIMIT 100`).all(...(user.role === 'doctor' ? [member.id, user.id] : [member.id]));
    const notes = ['admin', 'doctor'].includes(user.role)
      ? await db.prepare(`SELECT n.id, n.appointment_id AS appointmentId, ar.appointment_number AS appointmentNumber,
          n.note, n.treatment_plan AS treatmentPlan, n.next_visit AS nextVisit, n.created_at AS createdAt, d.name AS doctor
          FROM clinical_notes n JOIN users d ON d.id = n.doctor_id
          LEFT JOIN appointment_references ar ON ar.appointment_id = n.appointment_id
          WHERE n.patient_id = ?${user.role === 'doctor' ? ' AND n.doctor_id = ?' : ''}
          ORDER BY n.created_at DESC LIMIT 100`).all(...(user.role === 'doctor' ? [member.id, user.id] : [member.id]))
      : [];
    return sendJson(response, 200, { member, visitCount: visits.length, visits, notes });
  }

  const appointmentLookupMatch = url.pathname.match(/^\/api\/appointment-lookup\/(\d+)$/);
  if (appointmentLookupMatch && request.method === 'GET') {
    if (!requireRole(user, ['admin', 'doctor'])) return sendJson(response, 403, { error: 'Appointment note lookup is limited to doctors and Head / Admin.' });
    const appointment = await db.prepare(`SELECT a.id, ar.appointment_number AS appointmentNumber, a.patient_id AS patientId,
      a.appointment_date AS date, a.appointment_time AS time, COALESCE(NULLIF(a.visit_category, ''), a.visit_type) AS visit, a.status,
      p.name AS patient, p.membership_id AS membershipId, d.name AS doctor, a.doctor_id AS doctorId
      FROM appointment_references ar JOIN appointments a ON a.id = ar.appointment_id
      JOIN patients p ON p.id = a.patient_id JOIN users d ON d.id = a.doctor_id
      WHERE ar.appointment_number = ?`).get(Number(appointmentLookupMatch[1]));
    if (!appointment || user.role === 'doctor' && appointment.doctorId !== user.id) return sendJson(response, 404, { error: 'Appointment not found in your assigned caseload.' });
    const notes = await db.prepare(`SELECT n.id, n.note, n.treatment_plan AS treatmentPlan, n.next_visit AS nextVisit,
      n.created_at AS createdAt, d.name AS doctor, ar.appointment_number AS appointmentNumber
      FROM clinical_notes n JOIN users d ON d.id = n.doctor_id
      LEFT JOIN appointment_references ar ON ar.appointment_id = n.appointment_id
      WHERE n.patient_id = ?${user.role === 'doctor' ? ' AND n.doctor_id = ?' : ''}
      ORDER BY n.created_at DESC LIMIT 100`).all(...(user.role === 'doctor' ? [appointment.patientId, user.id] : [appointment.patientId]));
    return sendJson(response, 200, { appointment, notes });
  }

  if (url.pathname === '/api/workspace' && request.method === 'GET') {
    const view = url.searchParams.get('view') || '';
    const requestedDate = url.searchParams.get('date') || '';
    const requestedMonth = url.searchParams.get('month') || '';
    if (view === 'Footfall' && requestedDate && !isIsoDate(requestedDate)) return sendJson(response, 400, { error: 'Choose a valid footfall date.' });
    if (view === 'Footfall' && requestedMonth && !/^\d{4}-(0[1-9]|1[0-2])$/.test(requestedMonth)) return sendJson(response, 400, { error: 'Choose a valid month.' });
    if (view === 'Footfall' && requestedDate) {
      const startDate = new Date(`${todayString()}T00:00:00.000Z`);
      startDate.setUTCDate(startDate.getUTCDate() - 30);
      if (requestedDate < startDate.toISOString().slice(0, 10) || requestedDate > todayString()) {
        return sendJson(response, 400, { error: 'Choose a date from the last 30 days.' });
      }
    }
    const workspace = await getWorkspace(user, view, requestedMonth, requestedDate);
    return workspace ? sendJson(response, 200, workspace) : sendJson(response, 403, { error: 'This workspace is not available to your role.' });
  }

  const assessmentMatch = url.pathname.match(/^\/api\/appointments\/([A-Za-z0-9_-]+)\/assessment(\.pdf)?$/);
  if (assessmentMatch && ['GET', 'PUT', 'POST'].includes(request.method)) {
    if (!requireRole(user, ['admin', 'manager', 'doctor'])) return sendJson(response, 403, { error: 'Patient assessments are not available to your role.' });
    if (assessmentMatch[2] && request.method !== 'GET') return sendJson(response, 405, { error: 'Assessment PDFs are read-only.' });
    const appointment = await db.prepare(`SELECT a.id, a.doctor_id AS doctorId, a.appointment_date AS appointmentDate,
      COALESCE(NULLIF(a.visit_category, ''), a.visit_type) AS visit, ref.appointment_number AS appointmentNumber,
      p.name AS patientName, p.age, p.phone AS contactNumber, p.membership_id AS membershipId, p.condition
      FROM appointments a JOIN appointment_references ref ON ref.appointment_id = a.id
      JOIN patients p ON p.id = a.patient_id WHERE a.id = ?`).get(assessmentMatch[1]);
    if (!appointment || appointment.visit !== 'New patient') return sendJson(response, 404, { error: 'New-patient appointment not found.' });
    const savedAssessment = await db.prepare(`SELECT assessment_json AS assessmentJson, status, submitted_at AS submittedAt,
      submitted_by AS submittedBy, updated_at AS updatedAt FROM patient_assessments WHERE appointment_id = ?`).get(appointment.id);
    if (user.role === 'doctor' && appointment.doctorId !== user.id && savedAssessment?.submittedBy !== user.id) {
      return sendJson(response, 404, { error: 'Appointment not found in your assigned caseload.' });
    }
    if (assessmentMatch[2]) {
      if (!savedAssessment) return sendJson(response, 404, { error: 'This assessment has not been saved yet.' });
      try {
        const pdf = await generateAssessmentPdf(appointment.appointmentNumber, savedAssessmentAnswers(savedAssessment.assessmentJson, appointment));
        response.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="assessment-${appointment.appointmentNumber}.pdf"`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        });
        return response.end(pdf);
      } catch (error) {
        if (error instanceof Error && /WinAnsi|encode/i.test(error.message)) {
          return sendJson(response, 400, { error: 'The PDF template font cannot display one or more characters. Use English or supported Latin characters in this assessment.' });
        }
        throw error;
      }
    }
    if (request.method === 'GET') {
      return sendJson(response, 200, {
        appointment,
        status: savedAssessment?.status || 'Draft',
        submittedAt: savedAssessment?.submittedAt || null,
        hasAssessment: Boolean(savedAssessment),
        answers: savedAssessment ? savedAssessmentAnswers(savedAssessment.assessmentJson, appointment) : emptyAssessment(appointment, appointment.appointmentDate)
      });
    }
    if (request.method === 'POST' && (user.role !== 'doctor' || appointment.doctorId !== user.id)) {
      return sendJson(response, 403, { error: 'Only the assigned doctor may submit a patient assessment.' });
    }
    const body = await jsonBody(request, 262144);
    if (Object.keys(body).length !== 1 || !body.answers || typeof body.answers !== 'object' || Array.isArray(body.answers)
      || Object.keys(body.answers).some(key => !assessmentFieldNames.has(key))) {
      return sendJson(response, 400, { error: 'Submit only the defined patient assessment fields.' });
    }
    const answers = emptyAssessment(appointment, appointment.appointmentDate);
    for (const [key, value] of Object.entries(body.answers)) {
      if (typeof value !== 'string' || value.length > 8000) return sendJson(response, 400, { error: `Invalid assessment field: ${key}.` });
      answers[key] = value.trim();
    }
    if (!answers.patientName || !isIsoDate(answers.assessmentDate)) {
      return sendJson(response, 400, { error: 'Patient name and a valid assessment date are required.' });
    }
    if (answers.age && (!/^\d{1,3}$/.test(answers.age) || Number(answers.age) > 130)) {
      return sendJson(response, 400, { error: 'Age must be a whole number from 0 to 130.' });
    }
    if (answers.gender && !['Female', 'Male', 'Other', 'Prefer not to say'].includes(answers.gender)) {
      return sendJson(response, 400, { error: 'Choose a valid gender or leave it blank.' });
    }
    if (answers.painSeverity && (!/^(?:[0-9]|10)$/.test(answers.painSeverity))) {
      return sendJson(response, 400, { error: 'Pain severity must be a whole number from 0 to 10.' });
    }
    let pdf;
    try {
      pdf = await generateAssessmentPdf(appointment.appointmentNumber, answers);
    } catch (error) {
      if (error instanceof Error && /WinAnsi|encode/i.test(error.message)) {
        return sendJson(response, 400, { error: 'The PDF template font cannot display one or more characters. Use English or supported Latin characters in this assessment.' });
      }
      throw error;
    }
    const nextStatus = request.method === 'POST' ? 'Submitted' : savedAssessment?.status || 'Draft';
    await db.prepare(`INSERT INTO patient_assessments (appointment_id, assessment_json, status, submitted_at, submitted_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(appointment_id) DO UPDATE SET assessment_json = excluded.assessment_json,
        status = excluded.status, submitted_at = COALESCE(patient_assessments.submitted_at, excluded.submitted_at),
        submitted_by = COALESCE(patient_assessments.submitted_by, excluded.submitted_by),
        updated_by = excluded.updated_by, updated_at = datetime('now')`)
      .run(appointment.id, JSON.stringify(answers), nextStatus,
        request.method === 'POST' ? new Date().toISOString() : null,
        request.method === 'POST' ? user.id : null, user.id);
    await audit(user.id, request.method === 'POST' ? 'patient_assessment_submitted' : 'patient_assessment_saved', 'appointment', appointment.id);
    return sendJson(response, 200, { ok: true, status: nextStatus, answers, pdfUrl: `/api/appointments/${encodeURIComponent(appointment.id)}/assessment.pdf` });
  }

  if (url.pathname === '/api/checkins' && request.method === 'POST') {
    if (!requireRole(user, ['admin', 'manager'])) return sendJson(response, 403, { error: 'You cannot register patients.' });
    const body = await jsonBody(request);
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
    const phone = typeof body.phone === 'string' ? body.phone.trim().slice(0, 24) : '';
    const registrationMode = body.registrationMode === 'appointment' ? 'appointment' : 'membership';
    const membershipId = registrationMode === 'membership' && typeof body.membershipId === 'string' ? body.membershipId.trim().slice(0, 64) : '';
    const age = Number.isInteger(body.age) && body.age >= 0 && body.age <= 130 ? body.age : null;
    const condition = typeof body.condition === 'string' ? body.condition.trim().slice(0, 100) : '';
    const date = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : todayString();
    const time = typeof body.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(body.time) ? body.time : '';
    const visitType = body.visitType === 'Follow-up' ? 'Follow-up' : 'New patient';
    const visitCategory = body.visitType === 'Consultation' ? 'Consultation' : '';
    const doctorId = typeof body.doctorId === 'string' ? body.doctorId : '';
    const paymentMode = ['Cash', 'Online', 'POS', 'Unpaid'].includes(body.paymentMode) ? body.paymentMode : 'Unpaid';
    const paymentStatus = ['Paid', 'Unpaid'].includes(body.paymentStatus) ? body.paymentStatus : paymentMode === 'Unpaid' ? 'Unpaid' : 'Paid';
    const amountPaisa = Number.isSafeInteger(body.amountPaisa) && body.amountPaisa >= 0 ? body.amountPaisa : 0;
    const sessionsPrescribed = body.sessionsPrescribed === undefined || body.sessionsPrescribed === null || body.sessionsPrescribed === ''
      ? null
      : Number.isSafeInteger(body.sessionsPrescribed) && body.sessionsPrescribed >= 1 && body.sessionsPrescribed <= 100 ? body.sessionsPrescribed : NaN;
    if (Number.isNaN(sessionsPrescribed)) return sendJson(response, 400, { error: 'Prescribed sessions must be a whole number between 1 and 100.' });
    if (!name || !phone || !time || !doctorId || registrationMode === 'membership' && !membershipId) {
      return sendJson(response, 400, { error: 'Name, phone, appointment time, doctor and the selected patient ID are required.' });
    }
    const doctor = await db.prepare("SELECT id FROM users WHERE id = ? AND role = 'doctor' AND active = 1").get(doctorId);
    if (!doctor) return sendJson(response, 400, { error: 'Choose an active doctor.' });
    const appointmentId = makeId('apt');
    const paymentId = makeId('pay');
    let patientId;
    let appointmentNumber;
    let existingPatient = false;
    await db.exec('BEGIN IMMEDIATE');
    try {
      const sharedAdminId = membershipId ? await db.prepare("SELECT 1 FROM patients WHERE membership_id = ? COLLATE NOCASE AND membership_source = 'admin' LIMIT 1").get(membershipId) : null;
      if (sharedAdminId) {
        await db.exec('ROLLBACK');
        return sendJson(response, 409, { error: 'This is a shared admin-issued ID. Use Appointment ID only for patients without a Gymkhana membership.' });
      }
      const existingRecord = membershipId ? await db.prepare("SELECT id FROM patients WHERE membership_id = ? COLLATE NOCASE AND membership_source = 'gymkhana'").get(membershipId) : null;
      existingPatient = Boolean(existingRecord);
      patientId = existingRecord?.id || makeId('pat');
      if (!existingPatient) {
        await db.prepare('INSERT INTO patients (id, name, phone, membership_id, sessions_prescribed, age, condition, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(patientId, name, phone, membershipId, sessionsPrescribed, age, condition, user.id);
      } else if (user.role === 'manager' && sessionsPrescribed !== null) {
        await db.prepare('UPDATE patients SET sessions_prescribed = COALESCE(sessions_prescribed, ?) WHERE id = ?')
          .run(sessionsPrescribed, patientId);
      }
      const sessionNumber = (await db.prepare("SELECT COALESCE(MAX(session_number), 0) + 1 AS nextSession FROM appointments WHERE patient_id = ? AND status != 'Cancelled'").get(patientId)).nextSession;
      await db.prepare('INSERT INTO appointments (id, patient_id, doctor_id, appointment_date, appointment_time, visit_type, visit_category, session_number, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(appointmentId, patientId, doctorId, date, time, visitType, visitCategory, sessionNumber, 'Waiting', user.id);
      appointmentNumber = (await db.prepare('INSERT INTO appointment_references (appointment_id) VALUES (?)').run(appointmentId)).lastInsertRowid;
      await db.prepare('INSERT INTO payments (id, appointment_id, amount_paisa, payment_mode, payment_status, recorded_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(paymentId, appointmentId, amountPaisa, paymentMode, paymentStatus, user.id);
      await audit(user.id, 'checkin_created', 'appointment', appointmentId);
      await db.exec('COMMIT');
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }
    return sendJson(response, 201, { ok: true, appointmentId, appointmentNumber, patientId, existingPatient: Boolean(existingPatient), membershipMissing: !membershipId });
  }

  if (url.pathname === '/api/users' && request.method === 'POST') {
    if (user.role !== 'admin') return sendJson(response, 403, { error: 'Only Head / Admin can create accounts.' });
    const body = await jsonBody(request, 3000);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 160) : '';
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
    const role = typeof body.role === 'string' ? body.role : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email.includes('@') || !name || !roles.has(role) || role === 'admin' || password.length < 14) {
      return sendJson(response, 400, { error: 'Enter a valid email, name, non-admin role, and password of at least 14 characters.' });
    }
    const id = makeId('usr');
    const salt = crypto.randomBytes(16).toString('hex');
    try {
      await db.prepare('INSERT INTO users (id, email, name, role, password_hash, password_salt) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, email, name, role, passwordDigest(password, salt), salt);
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return sendJson(response, 409, { error: 'An account with that email already exists.' });
      throw error;
    }
    await audit(user.id, 'user_created', 'user', id);
    return sendJson(response, 201, { id, email, name, role });
  }

  const staffAccessMatch = url.pathname.match(/^\/api\/users\/([A-Za-z0-9_-]+)\/access$/);
  if (staffAccessMatch && request.method === 'PATCH') {
    if (user.role !== 'admin') return sendJson(response, 403, { error: 'Only Head / Admin can restrict staff accounts.' });
    const target = await db.prepare('SELECT id, role FROM users WHERE id = ? AND email != ?').get(staffAccessMatch[1], 'former-staff@invalid.local');
    if (!target) return sendJson(response, 404, { error: 'Staff account not found.' });
    if (target.role === 'admin' || target.id === user.id) return sendJson(response, 400, { error: 'You cannot restrict an administrator or your own account.' });
    const body = await jsonBody(request, 1000);
    if (typeof body.active !== 'boolean') return sendJson(response, 400, { error: 'Choose whether this account is active.' });
    await db.prepare('UPDATE users SET active = ? WHERE id = ?').run(body.active ? 1 : 0, target.id);
    await audit(user.id, body.active ? 'staff_access_restored' : 'staff_access_restricted', 'user', target.id);
    if (!body.active) await revokeUserSessions(target.id);
    return sendJson(response, 200, { ok: true, active: body.active });
  }

  const staffMatch = url.pathname.match(/^\/api\/users\/([A-Za-z0-9_-]+)$/);
  if (staffMatch && request.method === 'DELETE') {
    if (user.role !== 'admin') return sendJson(response, 403, { error: 'Only Head / Admin can delete staff accounts.' });
    const target = await db.prepare('SELECT id, role FROM users WHERE id = ? AND email != ?').get(staffMatch[1], 'former-staff@invalid.local');
    if (!target) return sendJson(response, 404, { error: 'Staff account not found.' });
    if (target.role === 'admin' || target.id === user.id) return sendJson(response, 400, { error: 'Administrator accounts cannot be deleted here.' });
    const formerStaffId = await getFormerStaffId();
    await db.exec('BEGIN IMMEDIATE');
    try {
      await audit(user.id, 'staff_deleted', 'user', target.id);
      await db.prepare('UPDATE patients SET created_by = ? WHERE created_by = ?').run(formerStaffId, target.id);
      await db.prepare('UPDATE appointments SET doctor_id = ? WHERE doctor_id = ?').run(formerStaffId, target.id);
      await db.prepare('UPDATE appointments SET created_by = ? WHERE created_by = ?').run(formerStaffId, target.id);
      await db.prepare('UPDATE payments SET recorded_by = ? WHERE recorded_by = ?').run(formerStaffId, target.id);
      await db.prepare('UPDATE clinical_notes SET doctor_id = ? WHERE doctor_id = ?').run(formerStaffId, target.id);
      await db.prepare('UPDATE clinic_tasks SET created_by = ?, completed_by = CASE WHEN completed_by = ? THEN ? ELSE completed_by END WHERE created_by = ? OR completed_by = ?')
        .run(formerStaffId, target.id, formerStaffId, target.id, target.id);
      await db.prepare('UPDATE compliance_checks SET checked_by = ? WHERE checked_by = ?').run(formerStaffId, target.id);
      await db.prepare('UPDATE inventory_items SET updated_by = ? WHERE updated_by = ?').run(formerStaffId, target.id);
      await db.prepare('UPDATE expenses SET recorded_by = ? WHERE recorded_by = ?').run(formerStaffId, target.id);
      await db.prepare('UPDATE audit_log SET actor_id = ?, entity_id = CASE WHEN entity_id = ? THEN NULL ELSE entity_id END WHERE actor_id = ?')
        .run(formerStaffId, target.id, target.id);
      await db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
      await db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) await db.exec('ROLLBACK');
      throw error;
    }
    await revokeUserSessions(target.id);
    await audit(user.id, 'staff_deleted', 'user', target.id);
    return sendJson(response, 200, { ok: true });
  }

  if (url.pathname === '/api/notes' && request.method === 'POST') {
    if (!requireRole(user, ['admin', 'doctor'])) return sendJson(response, 403, { error: 'Clinical notes are limited to clinicians and Head / Admin.' });
    const body = await jsonBody(request, 8000);
    const appointmentId = typeof body.appointmentId === 'string' ? body.appointmentId : '';
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 4000) : '';
    const treatmentPlan = typeof body.treatmentPlan === 'string' ? body.treatmentPlan.trim().slice(0, 2000) : '';
    const nextVisit = typeof body.nextVisit === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.nextVisit) ? body.nextVisit : null;
    if (!appointmentId || !note) return sendJson(response, 400, { error: 'Select an appointment and enter a session note.' });
    const assignment = await db.prepare("SELECT patient_id FROM appointments WHERE id = ? AND status != 'Cancelled' AND (? = 'admin' OR doctor_id = ?)").get(appointmentId, user.role, user.id);
    if (!assignment) return sendJson(response, 404, { error: 'Appointment not found in your assigned caseload.' });
    const noteId = makeId('note');
    await db.prepare('INSERT INTO clinical_notes (id, patient_id, doctor_id, appointment_id, note, treatment_plan, next_visit) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(noteId, assignment.patient_id, user.id, appointmentId, note, treatmentPlan, nextVisit);
    await audit(user.id, 'clinical_note_created', 'patient', assignment.patient_id);
    return sendJson(response, 201, { ok: true, id: noteId });
  }

  const appointmentMatch = url.pathname.match(/^\/api\/appointments\/([A-Za-z0-9_-]+)$/);
  if (appointmentMatch && request.method === 'PATCH') {
    const body = await jsonBody(request, 3000);
    if (user.role === 'doctor') {
      if (!['In session', 'Completed'].includes(body.status) || Object.keys(body).some(key => key !== 'status')) {
        return sendJson(response, 403, { error: 'Doctors can only start or complete their own assigned appointments.' });
      }
      const result = await db.prepare(`UPDATE appointments SET status = ?
        WHERE id = ? AND doctor_id = ? AND status != 'Cancelled'
          AND (? != 'In session' OR status != 'Completed')`)
        .run(body.status, appointmentMatch[1], user.id, body.status);
      if (!result.changes) return sendJson(response, 404, { error: 'Appointment not found in your assigned caseload.' });
      await audit(user.id, body.status === 'Completed' ? 'appointment_completed' : 'appointment_started', 'appointment', appointmentMatch[1]);
      return sendJson(response, 200, { ok: true, status: body.status });
    }
    if (user.role === 'manager') {
      if (Object.keys(body).length !== 1 || !['Waiting', 'In session', 'Completed'].includes(body.status)) {
        return sendJson(response, 403, { error: 'Clinic managers can only change appointment status to Waiting, In progress, or Completed.' });
      }
      const result = await db.prepare("UPDATE appointments SET status = ? WHERE id = ? AND status != 'Cancelled'")
        .run(body.status, appointmentMatch[1]);
      if (!result.changes) return sendJson(response, 404, { error: 'Appointment not found.' });
      await audit(user.id, 'appointment_status_updated', 'appointment', appointmentMatch[1], { status: body.status });
      return sendJson(response, 200, { ok: true, status: body.status });
    }
    if (user.role !== 'admin') return sendJson(response, 403, { error: 'Only Head / Admin can edit appointment scheduling.' });
    const date = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : '';
    const time = typeof body.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(body.time) ? body.time : '';
    const status = ['Confirmed', 'Waiting', 'In session', 'Completed', 'Cancelled'].includes(body.status) ? body.status : '';
    const doctorId = typeof body.doctorId === 'string' ? body.doctorId : '';
    if (!date && !time && !status && !doctorId) return sendJson(response, 400, { error: 'Choose a schedule or status change.' });
    if (doctorId && !await db.prepare("SELECT id FROM users WHERE id = ? AND role = 'doctor' AND active = 1").get(doctorId)) return sendJson(response, 400, { error: 'Choose an active doctor.' });
    const result = await db.prepare(`UPDATE appointments SET
      appointment_date = COALESCE(NULLIF(?, ''), appointment_date),
      appointment_time = COALESCE(NULLIF(?, ''), appointment_time),
      status = COALESCE(NULLIF(?, ''), status),
      doctor_id = COALESCE(NULLIF(?, ''), doctor_id)
      WHERE id = ?`).run(date, time, status, doctorId, appointmentMatch[1]);
    if (!result.changes) return sendJson(response, 404, { error: 'Appointment not found.' });
    await audit(user.id, 'appointment_updated', 'appointment', appointmentMatch[1]);
    return sendJson(response, 200, { ok: true });
  }

  const sessionMatch = url.pathname.match(/^\/api\/appointments\/([A-Za-z0-9_-]+)\/session$/);
  if (sessionMatch && request.method === 'PATCH') {
    if (!requireRole(user, ['admin', 'manager'])) return sendJson(response, 403, { error: 'Session numbers can only be updated by clinic managers and Head / Admin.' });
    const body = await jsonBody(request, 1000);
    if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'sessionNumber') || !Number.isSafeInteger(body.sessionNumber) || body.sessionNumber < 1) {
      return sendJson(response, 400, { error: 'Enter a positive whole-number session.' });
    }
    const result = await db.prepare('UPDATE appointments SET session_number = ? WHERE id = ?').run(body.sessionNumber, sessionMatch[1]);
    if (!result.changes) return sendJson(response, 404, { error: 'Appointment not found.' });
    await audit(user.id, 'appointment_session_updated', 'appointment', sessionMatch[1]);
    return sendJson(response, 200, { ok: true, sessionNumber: body.sessionNumber });
  }

  const paymentMatch = url.pathname.match(/^\/api\/appointments\/([A-Za-z0-9_-]+)\/payment$/);
  if (paymentMatch && request.method === 'PATCH') {
    if (!requireRole(user, ['admin', 'manager'])) return sendJson(response, 403, { error: 'Payment updates are limited to clinic managers and Head / Admin.' });
    const body = await jsonBody(request, 1000);
    const allowedKeys = user.role === 'admin' ? ['paymentMode', 'paymentStatus', 'amountPaisa', 'clubSharePaisa'] : ['paymentStatus', 'amountPaisa'];
    if (Object.keys(body).some(key => !allowedKeys.includes(key))) {
      return sendJson(response, 403, { error: user.role === 'admin' ? 'Only payment method, status, amount, and club share can be changed here.' : 'Clinic managers can only change payment status or edit the amount once.' });
    }
    const paymentMode = body.paymentMode === undefined ? '' : ['Cash', 'Online', 'POS', 'Unpaid'].includes(body.paymentMode) ? body.paymentMode : null;
    const paymentStatus = body.paymentStatus === undefined ? '' : ['Paid', 'Unpaid'].includes(body.paymentStatus) ? body.paymentStatus : null;
    const amountPaisa = body.amountPaisa === undefined ? null : Number.isSafeInteger(body.amountPaisa) && body.amountPaisa >= 0 ? body.amountPaisa : NaN;
    const clubSharePaisa = body.clubSharePaisa === undefined ? null : Number.isSafeInteger(body.clubSharePaisa) && body.clubSharePaisa >= 0 ? body.clubSharePaisa : NaN;
    if (paymentMode === null || paymentStatus === null || Number.isNaN(amountPaisa) || Number.isNaN(clubSharePaisa) || !paymentMode && !paymentStatus && amountPaisa === null && clubSharePaisa === null) {
      return sendJson(response, 400, { error: 'Choose a valid payment status and amount.' });
    }
    const paymentBefore = await db.prepare(`SELECT amount_paisa AS amountPaisa, payment_mode AS paymentMode,
      payment_status AS paymentStatus, club_share_paisa AS clubSharePaisa
      FROM payments WHERE appointment_id = ? LIMIT 1`).get(paymentMatch[1]);
    if (!paymentBefore) return sendJson(response, 404, { error: 'Payment record not found.' });
    const nextAmountPaisa = amountPaisa ?? paymentBefore.amountPaisa;
    const nextPaymentStatus = paymentStatus || paymentBefore.paymentStatus;
    const invoice = await db.prepare('SELECT subtotal_paisa AS subtotalPaisa FROM invoices WHERE appointment_id = ?').get(paymentMatch[1]);
    const nextAdvancePaisa = nextPaymentStatus === 'Paid' ? nextAmountPaisa : 0;
    if (invoice && nextAdvancePaisa > invoice.subtotalPaisa) {
      return sendJson(response, 409, { error: 'The collected payment cannot exceed the saved invoice subtotal. Update the invoice first.' });
    }
    const result = user.role === 'manager' && amountPaisa !== null
      ? await db.prepare(`UPDATE payments SET
          payment_status = COALESCE(NULLIF(?, ''), payment_status),
          amount_paisa = ?, amount_manager_updated = 1
          WHERE appointment_id = ? AND amount_manager_updated = 0`).run(paymentStatus || '', amountPaisa, paymentMatch[1])
      : await db.prepare(`UPDATE payments SET
          payment_mode = COALESCE(NULLIF(?, ''), payment_mode),
          payment_status = COALESCE(NULLIF(?, ''), payment_status),
          amount_paisa = COALESCE(?, amount_paisa),
          club_share_paisa = COALESCE(?, club_share_paisa)
          WHERE appointment_id = ?`).run(paymentMode || '', paymentStatus || '', amountPaisa, clubSharePaisa, paymentMatch[1]);
    if (!result.changes) {
      if (user.role === 'manager' && amountPaisa !== null) {
        const payment = await db.prepare('SELECT amount_manager_updated AS amountManagerUpdated FROM payments WHERE appointment_id = ?').get(paymentMatch[1]);
        if (payment?.amountManagerUpdated) return sendJson(response, 409, { error: 'Clinic managers can edit the payment amount only once. Ask Head / Admin to correct it.' });
      }
      return sendJson(response, 404, { error: 'Payment record not found.' });
    }
    const paymentAfter = await db.prepare(`SELECT amount_paisa AS amountPaisa, payment_mode AS paymentMode,
      payment_status AS paymentStatus, club_share_paisa AS clubSharePaisa
      FROM payments WHERE appointment_id = ? LIMIT 1`).get(paymentMatch[1]);
    const auditAction = user.role === 'manager' && amountPaisa !== null
      ? 'manager_payment_amount_updated'
      : body.clubSharePaisa !== undefined && Object.keys(body).length === 1
        ? 'club_share_updated'
        : 'payment_updated';
    await audit(user.id, auditAction, 'appointment', paymentMatch[1], {
      before: paymentBefore,
      after: paymentAfter
    });
    return sendJson(response, 200, { ok: true, amountPaisa: amountPaisa ?? undefined, amountManagerUpdated: amountPaisa !== null && user.role === 'manager', clubSharePaisa: clubSharePaisa ?? undefined });
  }

  const invoiceMatch = url.pathname.match(/^\/api\/appointments\/([A-Za-z0-9_-]+)\/invoice$/);
  if (invoiceMatch && ['GET', 'PUT', 'POST'].includes(request.method)) {
    if (!requireRole(user, ['admin', 'manager'])) return sendJson(response, 403, { error: 'Invoices can only be created and printed by clinic managers or Head / Admin.' });
    const appointment = await db.prepare(`SELECT a.id AS appointmentId, ar.appointment_number AS appointmentNumber,
      a.appointment_date AS appointmentDate, a.appointment_time AS appointmentTime,
      COALESCE(NULLIF(a.visit_category, ''), a.visit_type) AS visit, a.status,
      p.name AS patientName, p.phone AS patientPhone,
      COALESCE(NULLIF(p.membership_id, ''), 'Appointment #' || ar.appointment_number) AS membershipId,
      pay.amount_paisa AS recordedAmountPaisa, pay.payment_status AS paymentStatus
      FROM appointments a JOIN appointment_references ar ON ar.appointment_id = a.id
      JOIN patients p ON p.id = a.patient_id LEFT JOIN payments pay ON pay.appointment_id = a.id
      WHERE a.id = ?`).get(invoiceMatch[1]);
    if (!appointment) return sendJson(response, 404, { error: 'Appointment not found.' });
    const invoice = await db.prepare(`SELECT invoice_date AS invoiceDate, line_items_json AS lineItemsJson,
      subtotal_paisa AS subtotalPaisa, advance_paisa AS advancePaisa, updated_at AS updatedAt,
      printed_invoice_json AS printedInvoiceJson, printed_at AS printedAt
      FROM invoices WHERE appointment_id = ?`).get(invoiceMatch[1]);
    const currentCollectedAdvancePaisa = async () => {
      const payment = await db.prepare('SELECT amount_paisa AS amountPaisa, payment_status AS paymentStatus FROM payments WHERE appointment_id = ? LIMIT 1')
        .get(appointment.appointmentId);
      return payment?.paymentStatus === 'Paid' ? payment.amountPaisa : 0;
    };
    const makeInvoice = async (invoiceData, { printedAt = null } = {}) => {
      if (!invoiceData) return null;
      const advancePaisa = await currentCollectedAdvancePaisa();
      return {
        invoiceNumber: `INV-${String(appointment.appointmentNumber).padStart(6, '0')}`,
        invoiceDate: invoiceData.invoiceDate,
        lineItems: JSON.parse(invoiceData.lineItemsJson),
        subtotalPaisa: invoiceData.subtotalPaisa,
        advancePaisa,
        balancePaisa: invoiceData.subtotalPaisa - advancePaisa,
        printedAt
      };
    };
    if (request.method === 'GET') {
      const draftInvoice = await makeInvoice(invoice);
      const printedInvoice = invoice?.printedInvoiceJson ? {
        ...JSON.parse(invoice.printedInvoiceJson),
        printedAt: invoice.printedAt
      } : null;
      return sendJson(response, 200, {
        appointment,
        invoice: printedInvoice || draftInvoice,
        draftInvoice,
        printedInvoice
      });
    }

    if (request.method === 'POST') {
      if (!invoice) return sendJson(response, 404, { error: 'Save the invoice before printing it.' });
      const printedInvoice = await makeInvoice(invoice, { printedAt: new Date().toISOString() });
      await db.prepare(`UPDATE invoices SET printed_invoice_json = ?, printed_at = ?, printed_by = ?
        WHERE appointment_id = ?`)
        .run(JSON.stringify(printedInvoice), printedInvoice.printedAt, user.id, appointment.appointmentId);
      await audit(user.id, 'invoice_printed', 'appointment', appointment.appointmentId);
      return sendJson(response, 200, { ok: true, invoice: printedInvoice });
    }

    const body = await jsonBody(request, 12000);
    if (Object.keys(body).some(key => !['invoiceDate', 'lineItems'].includes(key))
      || !isIsoDate(body.invoiceDate)
      || !Array.isArray(body.lineItems)
      || body.lineItems.length < 1
      || body.lineItems.length > 6
    ) {
      return sendJson(response, 400, { error: 'Enter a valid invoice date and 1 to 6 invoice items.' });
    }
    const lineItems = [];
    let subtotalPaisa = 0;
    for (const item of body.lineItems) {
      if (!item || Object.keys(item).some(key => !['description', 'quantity', 'unitPricePaisa'].includes(key))
        || typeof item.description !== 'string'
        || !item.description.trim()
        || item.description.trim().length > 120
        || !Number.isSafeInteger(item.quantity)
        || item.quantity < 1
        || item.quantity > 10000
        || !Number.isSafeInteger(item.unitPricePaisa)
        || item.unitPricePaisa < 0) {
        return sendJson(response, 400, { error: 'Each invoice item needs a description, quantity from 1 to 10,000, and a non-negative unit price.' });
      }
      const lineAmountPaisa = item.quantity * item.unitPricePaisa;
      if (!Number.isSafeInteger(lineAmountPaisa) || !Number.isSafeInteger(subtotalPaisa + lineAmountPaisa)) {
        return sendJson(response, 400, { error: 'Invoice totals are too large.' });
      }
      subtotalPaisa += lineAmountPaisa;
      lineItems.push({ description: item.description.trim(), quantity: item.quantity, unitPricePaisa: item.unitPricePaisa, amountPaisa: lineAmountPaisa });
    }
    const collectedAdvancePaisa = await currentCollectedAdvancePaisa();
    if (collectedAdvancePaisa > subtotalPaisa) return sendJson(response, 400, { error: 'The invoice subtotal cannot be less than the amount already recorded as collected.' });
    const currentInvoice = await db.prepare(`SELECT invoice_date AS invoiceDate, subtotal_paisa AS subtotalPaisa
      FROM invoices WHERE appointment_id = ?`).get(appointment.appointmentId);
    const invoiceBefore = currentInvoice ? {
      invoiceDate: currentInvoice.invoiceDate,
      subtotalPaisa: currentInvoice.subtotalPaisa,
      advancePaisa: collectedAdvancePaisa
    } : null;
    await db.prepare(`INSERT INTO invoices (appointment_id, invoice_date, line_items_json, subtotal_paisa, advance_paisa, updated_by)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(appointment_id) DO UPDATE SET invoice_date = excluded.invoice_date,
        line_items_json = excluded.line_items_json, subtotal_paisa = excluded.subtotal_paisa,
        advance_paisa = excluded.advance_paisa, updated_by = excluded.updated_by, updated_at = datetime('now')`)
      .run(appointment.appointmentId, body.invoiceDate, JSON.stringify(lineItems), subtotalPaisa, collectedAdvancePaisa, user.id);
    await audit(user.id, currentInvoice ? 'invoice_updated' : 'invoice_created', 'appointment', appointment.appointmentId, {
      before: invoiceBefore,
      after: { invoiceDate: body.invoiceDate, subtotalPaisa, advancePaisa: collectedAdvancePaisa }
    });
    return sendJson(response, 200, {
      ok: true,
      invoice: {
        invoiceNumber: `INV-${String(appointment.appointmentNumber).padStart(6, '0')}`,
        invoiceDate: body.invoiceDate,
        lineItems,
        subtotalPaisa,
        advancePaisa: collectedAdvancePaisa,
        balancePaisa: subtotalPaisa - collectedAdvancePaisa
      }
    });
  }

  const patientMatch = url.pathname.match(/^\/api\/patients\/([A-Za-z0-9_-]+)$/);
  if (patientMatch && request.method === 'PATCH') {
    if (user.role !== 'admin') return sendJson(response, 403, { error: 'Only Head / Admin can correct patient records.' });
    const body = await jsonBody(request, 3000);
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
    const phone = typeof body.phone === 'string' ? body.phone.trim().slice(0, 24) : '';
    const condition = typeof body.condition === 'string' ? body.condition.trim().slice(0, 100) : '';
    const age = Number.isInteger(body.age) && body.age >= 0 && body.age <= 130 ? body.age : null;
    if (!name || !phone) return sendJson(response, 400, { error: 'Patient name and phone are required.' });
    const result = await db.prepare('UPDATE patients SET name = ?, phone = ?, condition = ?, age = ? WHERE id = ?').run(name, phone, condition, age, patientMatch[1]);
    if (!result.changes) return sendJson(response, 404, { error: 'Patient not found.' });
    await audit(user.id, 'patient_corrected', 'patient', patientMatch[1]);
    return sendJson(response, 200, { ok: true });
  }

  const deletePatientRecordMatch = url.pathname.match(/^\/api\/patients\/by-appointment\/(\d+)$/);
  if (deletePatientRecordMatch && request.method === 'DELETE') {
    if (user.role !== 'admin') return sendJson(response, 403, { error: 'Only Head / Admin can delete a patient record.' });
    const appointmentNumber = Number(deletePatientRecordMatch[1]);
    if (!Number.isSafeInteger(appointmentNumber) || appointmentNumber < 1) return sendJson(response, 400, { error: 'Enter a valid appointment ID.' });

    await db.exec('BEGIN IMMEDIATE');
    let appointmentNumbers;
    let patientId;
    try {
      const selectedAppointment = await db.prepare(`SELECT a.patient_id AS patientId
        FROM appointment_references ar JOIN appointments a ON a.id = ar.appointment_id
        WHERE ar.appointment_number = ?`).get(appointmentNumber);
      if (!selectedAppointment) {
        await db.exec('ROLLBACK');
        return sendJson(response, 404, { error: 'Appointment not found.' });
      }
      patientId = selectedAppointment.patientId;
      const appointments = await db.prepare(`SELECT a.id, ar.appointment_number AS appointmentNumber
        FROM appointments a JOIN appointment_references ar ON ar.appointment_id = a.id
        WHERE a.patient_id = ? ORDER BY ar.appointment_number`).all(patientId);
      appointmentNumbers = appointments.map(appointment => appointment.appointmentNumber);
      await deleteAppointmentRecords(appointments);
      await db.prepare('DELETE FROM clinical_notes WHERE patient_id = ?').run(patientId);
      const removedPatient = await db.prepare('DELETE FROM patients WHERE id = ?').run(patientId);
      if (!removedPatient.changes) throw new Error('Patient record could not be deleted.');
      await audit(user.id, 'patient_record_deleted', 'patient', patientId, { selectedAppointmentNumber: appointmentNumber, appointmentNumbers });
      await db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) await db.exec('ROLLBACK');
      throw error;
    }

    return sendJson(response, 200, { ok: true, appointmentNumber, deletedAppointments: appointmentNumbers.length, appointmentNumbers });
  }

  const deletePatientAppointmentMatch = url.pathname.match(/^\/api\/appointments\/by-number\/(\d+)$/);
  if (deletePatientAppointmentMatch && request.method === 'DELETE') {
    if (user.role !== 'admin') return sendJson(response, 403, { error: 'Only Head / Admin can delete a patient appointment.' });
    const appointmentNumber = Number(deletePatientAppointmentMatch[1]);
    if (!Number.isSafeInteger(appointmentNumber) || appointmentNumber < 1) return sendJson(response, 400, { error: 'Enter a valid appointment ID.' });

    await db.exec('BEGIN IMMEDIATE');
    let patientRemoved;
    try {
      const appointment = await db.prepare(`SELECT a.id, a.patient_id AS patientId
        FROM appointment_references ar JOIN appointments a ON a.id = ar.appointment_id
        WHERE ar.appointment_number = ?`).get(appointmentNumber);
      if (!appointment) {
        await db.exec('ROLLBACK');
        return sendJson(response, 404, { error: 'Appointment not found.' });
      }

      await deleteAppointmentRecords([{ ...appointment, appointmentNumber }]);
      const removedPatientResult = await db.prepare(`DELETE FROM patients WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM appointments WHERE patient_id = ?)
        AND NOT EXISTS (SELECT 1 FROM clinical_notes WHERE patient_id = ?)`)
        .run(appointment.patientId, appointment.patientId, appointment.patientId);
      patientRemoved = Boolean(removedPatientResult.changes);
      await audit(user.id, 'patient_appointment_deleted', 'appointment', appointment.id, { appointmentNumber });
      await db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) await db.exec('ROLLBACK');
      throw error;
    }
    return sendJson(response, 200, { ok: true, appointmentNumber, patientRemoved });
  }

  const patientSessionsMatch = url.pathname.match(/^\/api\/patients\/([A-Za-z0-9_-]+)\/sessions$/);
  if (patientSessionsMatch && request.method === 'PATCH') {
    if (!requireRole(user, ['admin', 'manager'])) return sendJson(response, 403, { error: 'Prescribed sessions can only be edited by clinic managers or Head / Admin.' });
    const body = await jsonBody(request, 1000);
    const sessionsPrescribed = body.sessionsPrescribed === null ? null : body.sessionsPrescribed;
    if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'sessionsPrescribed') || !Number.isSafeInteger(sessionsPrescribed) || sessionsPrescribed < 1 || sessionsPrescribed > 100) {
      return sendJson(response, 400, { error: 'Enter a whole number of prescribed sessions from 1 to 100.' });
    }
    const result = user.role === 'admin'
      ? await db.prepare('UPDATE patients SET sessions_prescribed = ? WHERE id = ?').run(sessionsPrescribed, patientSessionsMatch[1])
      : await db.prepare('UPDATE patients SET sessions_prescribed = ?, sessions_reception_updated = 1 WHERE id = ? AND sessions_reception_updated = 0').run(sessionsPrescribed, patientSessionsMatch[1]);
    if (!result.changes) {
      const patient = await db.prepare('SELECT id FROM patients WHERE id = ?').get(patientSessionsMatch[1]);
      if (!patient) return sendJson(response, 404, { error: 'Patient not found.' });
      if (user.role === 'manager') return sendJson(response, 409, { error: 'Clinic managers can update prescribed sessions only once. Ask Head / Admin to correct it.' });
    }
    await audit(user.id, 'patient_sessions_updated', 'patient', patientSessionsMatch[1]);
    return sendJson(response, 200, { ok: true, sessionsPrescribed, receptionUpdated: user.role === 'manager' });
  }

  const patientMembershipMatch = url.pathname.match(/^\/api\/patients\/([A-Za-z0-9_-]+)\/membership$/);
  if (patientMembershipMatch && request.method === 'PATCH') {
    if (user.role !== 'admin') return sendJson(response, 403, { error: 'Only Head / Admin can assign a membership ID.' });
    const body = await jsonBody(request, 1000);
    const membershipId = typeof body.membershipId === 'string' ? body.membershipId.trim().slice(0, 64) : '';
    if (!membershipId) return sendJson(response, 400, { error: 'Membership ID is required.' });
    if (await db.prepare("SELECT 1 FROM patients WHERE membership_id = ? COLLATE NOCASE AND membership_source = 'gymkhana' LIMIT 1").get(membershipId)) {
      return sendJson(response, 409, { error: 'That ID is already a Gymkhana membership number.' });
    }
    const result = await db.prepare("UPDATE patients SET membership_id = ?, membership_source = 'admin' WHERE id = ? AND membership_id = ''").run(membershipId, patientMembershipMatch[1]);
    if (!result.changes) {
      const patient = await db.prepare('SELECT membership_id FROM patients WHERE id = ?').get(patientMembershipMatch[1]);
      return patient ? sendJson(response, 409, { error: 'This patient already has an ID or the request is no longer available.' }) : sendJson(response, 404, { error: 'Patient record not found.' });
    }
    await audit(user.id, 'membership_id_assigned', 'patient', patientMembershipMatch[1]);
    return sendJson(response, 200, { ok: true, membershipId });
  }

  if (url.pathname === '/api/tasks' && request.method === 'POST') {
    if (!requireRole(user, ['admin', 'manager'])) return sendJson(response, 403, { error: 'Daily tasks are limited to clinic managers and Head / Admin.' });
    const body = await jsonBody(request, 2000);
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : '';
    const dueDate = typeof body.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.dueDate) ? body.dueDate : '';
    if (!title || !dueDate) return sendJson(response, 400, { error: 'Task title and due date are required.' });
    const id = makeId('task');
    await db.prepare('INSERT INTO clinic_tasks (id, title, due_date, created_by) VALUES (?, ?, ?, ?)').run(id, title, dueDate, user.id);
    await audit(user.id, 'task_created', 'task', id);
    return sendJson(response, 201, { id });
  }

  const taskMatch = url.pathname.match(/^\/api\/tasks\/([A-Za-z0-9_-]+)$/);
  if (taskMatch && request.method === 'PATCH') {
    if (!requireRole(user, ['admin', 'manager'])) return sendJson(response, 403, { error: 'Daily tasks are limited to clinic managers and Head / Admin.' });
    const body = await jsonBody(request, 1000);
    const status = ['Pending', 'In progress', 'Completed'].includes(body.status) ? body.status : '';
    if (!status) return sendJson(response, 400, { error: 'Choose a valid task status.' });
    const result = await db.prepare('UPDATE clinic_tasks SET status = ?, completed_by = ? WHERE id = ?').run(status, status === 'Completed' ? user.id : null, taskMatch[1]);
    if (!result.changes) return sendJson(response, 404, { error: 'Task not found.' });
    await audit(user.id, 'task_updated', 'task', taskMatch[1]);
    return sendJson(response, 200, { ok: true });
  }

  if (url.pathname === '/api/compliance' && request.method === 'POST') {
    if (!requireRole(user, ['admin', 'manager'])) return sendJson(response, 403, { error: 'Only clinic managers can record compliance checks.' });
    const body = await jsonBody(request, 2000);
    const checkName = typeof body.checkName === 'string' ? body.checkName.trim().slice(0, 120) : '';
    const status = body.status === 'Passed' ? 'Passed' : body.status === 'Needs attention' ? 'Needs attention' : '';
    const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 500) : '';
    if (!checkName || !status) return sendJson(response, 400, { error: 'Check name and status are required.' });
    const id = makeId('check');
    await db.prepare('INSERT INTO compliance_checks (id, check_name, status, notes, checked_by) VALUES (?, ?, ?, ?, ?)').run(id, checkName, status, notes, user.id);
    await audit(user.id, 'compliance_recorded', 'compliance', id);
    return sendJson(response, 201, { id });
  }

  if (url.pathname === '/api/expenses' && request.method === 'POST') {
    if (user.role !== 'admin') return sendJson(response, 403, { error: 'Only Head / Admin can record expenses.' });
    const body = await jsonBody(request, 2000);
    const category = typeof body.category === 'string' ? body.category.trim().slice(0, 60) : '';
    const description = typeof body.description === 'string' ? body.description.trim().slice(0, 160) : '';
    const amountPaisa = Number.isSafeInteger(body.amountPaisa) && body.amountPaisa > 0 ? body.amountPaisa : 0;
    const date = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : todayString();
    if (!category || !description || !amountPaisa) return sendJson(response, 400, { error: 'Category, description and positive amount are required.' });
    const id = makeId('exp');
    await db.prepare('INSERT INTO expenses (id, category, description, amount_paisa, spent_on, recorded_by) VALUES (?, ?, ?, ?, ?, ?)').run(id, category, description, amountPaisa, date, user.id);
    await audit(user.id, 'expense_recorded', 'expense', id);
    return sendJson(response, 201, { id });
  }

  if (url.pathname === '/api/inventory' && request.method === 'POST') {
    if (!requireRole(user, ['admin', 'manager'])) return sendJson(response, 403, { error: 'Only Head / Admin or Clinic Manager can manage inventory.' });
    const body = await jsonBody(request, 2000);
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
    const category = typeof body.category === 'string' ? body.category.trim().slice(0, 60) : '';
    const unit = typeof body.unit === 'string' ? body.unit.trim().slice(0, 30) : '';
    const quantity = Number.isInteger(body.quantity) && body.quantity >= 0 ? body.quantity : -1;
    const reorderAt = Number.isInteger(body.reorderAt) && body.reorderAt >= 0 ? body.reorderAt : -1;
    if (!name || !category || !unit || quantity < 0 || reorderAt < 0) return sendJson(response, 400, { error: 'Enter item, category, unit, quantity and reorder threshold.' });
    const id = makeId('item');
    await db.prepare('INSERT INTO inventory_items (id, name, category, quantity, unit, reorder_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, name, category, quantity, unit, reorderAt, user.id);
    await audit(user.id, 'inventory_item_created', 'inventory', id);
    return sendJson(response, 201, { id });
  }

  const inventoryMatch = url.pathname.match(/^\/api\/inventory\/([A-Za-z0-9_-]+)$/);
  if (inventoryMatch && request.method === 'PATCH') {
    if (!requireRole(user, ['admin', 'manager'])) return sendJson(response, 403, { error: 'Only Head / Admin or Clinic Manager can manage inventory.' });
    const body = await jsonBody(request, 1000);
    const quantity = Number.isInteger(body.quantity) && body.quantity >= 0 ? body.quantity : -1;
    if (quantity < 0) return sendJson(response, 400, { error: 'Enter a non-negative whole-number stock quantity.' });
    const result = await db.prepare("UPDATE inventory_items SET quantity = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?")
      .run(quantity, user.id, inventoryMatch[1]);
    if (!result.changes) return sendJson(response, 404, { error: 'Inventory item not found.' });
    await audit(user.id, 'inventory_stock_updated', 'inventory', inventoryMatch[1]);
    return sendJson(response, 200, { ok: true });
  }

  const patientFullRecordMatch = url.pathname.match(/^\/api\/patients\/([A-Za-z0-9_-]+)\/full-record$/);
  if (patientFullRecordMatch && request.method === 'GET') {
    if (!requireRole(user, ['admin'])) return sendJson(response, 403, { error: 'Patient full records are limited to Head / Admin.' });
    const patientId = patientFullRecordMatch[1];
    const patient = await db.prepare(`SELECT id, name, age, membership_id AS membershipId, sessions_prescribed AS sessionsPrescribed, condition
      FROM patients WHERE id = ?`).get(patientId);
    if (!patient) return sendJson(response, 404, { error: 'Patient not found.' });
    const visits = (await db.prepare(`SELECT a.id, ar.appointment_number AS appointmentNumber,
        a.appointment_date AS date, a.appointment_time AS time,
        COALESCE(NULLIF(a.visit_category, ''), a.visit_type) AS visit,
        a.session_number AS sessionNumber, a.status, d.name AS doctor,
        pa.status AS assessmentStatus, pa.assessment_json AS assessmentJson
      FROM appointments a
      JOIN appointment_references ar ON ar.appointment_id = a.id
      JOIN users d ON d.id = a.doctor_id
      LEFT JOIN patient_assessments pa ON pa.appointment_id = a.id
      WHERE a.patient_id = ?
      ORDER BY a.appointment_date DESC, a.appointment_time DESC`).all(patientId))
      .map(visit => ({
        ...visit,
        membershipOrAppointmentId: patient.membershipId || `Appointment #${visit.appointmentNumber}`,
        assessment: visit.assessmentJson ? { status: visit.assessmentStatus, answers: savedAssessmentAnswers(visit.assessmentJson, { ...patient, appointmentDate: visit.date }) } : null,
        notes: []
      }));
    patient.sessionsCompleted = visits.filter(visit => visit.status === 'Completed').length;
    const visitsById = new Map(visits.map(visit => [visit.id, visit]));
    const notes = await db.prepare(`SELECT n.id, n.appointment_id AS appointmentId, ar.appointment_number AS appointmentNumber,
        a.appointment_date AS appointmentDate, a.appointment_time AS appointmentTime,
        n.note, n.treatment_plan AS treatmentPlan, n.next_visit AS nextVisit,
        n.created_at AS createdAt, d.name AS doctor,
        (SELECT nextRef.appointment_number FROM appointments nextAppointment
          JOIN appointment_references nextRef ON nextRef.appointment_id = nextAppointment.id
          WHERE nextAppointment.patient_id = n.patient_id AND nextAppointment.appointment_date = n.next_visit
          ORDER BY CASE nextAppointment.status WHEN 'Completed' THEN 0 WHEN 'In session' THEN 1 WHEN 'Waiting' THEN 2 WHEN 'Confirmed' THEN 3 ELSE 4 END,
            nextAppointment.appointment_time LIMIT 1) AS nextVisitAppointmentNumber,
        (SELECT nextAppointment.status FROM appointments nextAppointment
          WHERE nextAppointment.patient_id = n.patient_id AND nextAppointment.appointment_date = n.next_visit
          ORDER BY CASE nextAppointment.status WHEN 'Completed' THEN 0 WHEN 'In session' THEN 1 WHEN 'Waiting' THEN 2 WHEN 'Confirmed' THEN 3 ELSE 4 END,
            nextAppointment.appointment_time LIMIT 1) AS nextVisitAppointmentStatus
      FROM clinical_notes n
      JOIN users d ON d.id = n.doctor_id
      LEFT JOIN appointment_references ar ON ar.appointment_id = n.appointment_id
      LEFT JOIN appointments a ON a.id = n.appointment_id
      WHERE n.patient_id = ?
      ORDER BY n.created_at DESC`).all(patientId);
    for (const note of notes) {
      const visit = visitsById.get(note.appointmentId);
      if (visit) visit.notes.push(note);
    }
    return sendJson(response, 200, { patient, visits });
  }

  const patientNotesMatch = url.pathname.match(/^\/api\/patients\/([A-Za-z0-9_-]+)\/notes$/);
  if (patientNotesMatch && request.method === 'GET') {
    if (!requireRole(user, ['admin', 'doctor'])) return sendJson(response, 403, { error: 'Clinical notes are limited to clinicians and Head / Admin.' });
    const patientId = patientNotesMatch[1];
    const assigned = user.role === 'admin' || await db.prepare("SELECT 1 FROM appointments WHERE patient_id = ? AND doctor_id = ? AND status != 'Cancelled' LIMIT 1").get(patientId, user.id);
    if (!assigned) return sendJson(response, 404, { error: 'Patient not found in your assigned caseload.' });
    const notes = await db.prepare(`SELECT n.id, n.note, n.treatment_plan AS treatmentPlan, n.next_visit AS nextVisit, n.created_at AS createdAt, u.name AS doctor
      FROM clinical_notes n JOIN users u ON u.id = n.doctor_id
      WHERE n.patient_id = ?${user.role === 'doctor' ? ' AND n.doctor_id = ?' : ''}
      ORDER BY n.created_at DESC LIMIT 100`).all(...(user.role === 'doctor' ? [patientId, user.id] : [patientId]));
    return sendJson(response, 200, { notes });
  }

  if (url.pathname.startsWith('/api/') && request.method === 'GET') return sendJson(response, 404, { error: 'Not found.' });
  return sendJson(response, 405, { error: 'Method not allowed.' });
}

function serveStatic(request, response, url) {
  const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\//, '');
  if (requested === 'favicon.ico') {
    response.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
    return response.end();
  }
  const publicFiles = new Map([
    ['index.html', path.join(root, 'index.html')],
    ['styles.css', path.join(root, 'styles.css')],
    ['secure-app.js', path.join(root, 'secure-app.js')],
    ['hopr.jpeg', path.join(root, 'hopr.jpeg')],
    ['gymkhana.png', path.join(root, 'gymkhana.png')],
    ['invoice.png', path.join(root, 'invoice.png')],
    ['clinic.jpeg', path.join(root, 'clinic.jpeg')]
  ]);
  const filePath = publicFiles.get(requested);
  if (!filePath) return sendJson(response, 404, { error: 'Not found.' });
  fs.readFile(filePath, (error, content) => {
    if (error) return sendJson(response, 404, { error: 'Not found.' });
    const cacheControl = ['.js', '.css'].includes(path.extname(filePath)) || filePath.endsWith('index.html')
      ? 'no-cache'
      : 'public, max-age=300';
    response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': cacheControl, ...contentSecurityHeaders() });
    response.end(content);
  });
}

async function handler(request, response) {
  return requestContext.run({ transaction: null }, async () => {
  try {
    await dbReady;
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await routeApi(request, response, url);
    if (request.method !== 'GET' && request.method !== 'HEAD') return sendJson(response, 405, { error: 'Method not allowed.' });
    return serveStatic(request, response, url);
  } catch (error) {
    if (response.headersSent || response.destroyed) return;
    const status = error.status || 500;
    if (status === 500) console.error(error);
    return sendJson(response, status, { error: status === 500 ? 'An unexpected server error occurred.' : error.message });
  }
  });
}

module.exports = handler;

if (require.main === module) {
  const server = http.createServer(handler);
  dbReady.then(() => {
    server.listen(port, host, async () => {
      console.log(`HOPR PMS listening on ${host}:${port}`);
      if (!await db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get()) {
        console.warn(process.env.NODE_ENV === 'production'
          ? 'No admin account exists. Provision PMS_ADMIN_EMAIL and PMS_ADMIN_PASSWORD using the deployment secret manager.'
          : 'No admin account exists. Open the local setup page to create one.');
      }
    });
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });

  function shutdown() {
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}