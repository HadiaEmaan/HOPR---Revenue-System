'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { afterEach, test } = require('node:test');
const { clearClinicData } = require('./clear-data');

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function createDatabase({ adminCount = 1 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopr-clear-data-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'clinic.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT NOT NULL);
    CREATE TABLE patients (id TEXT PRIMARY KEY, created_by TEXT REFERENCES users(id));
    CREATE TABLE appointments (id TEXT PRIMARY KEY, patient_id TEXT REFERENCES patients(id), doctor_id TEXT REFERENCES users(id), created_by TEXT REFERENCES users(id));
    CREATE TABLE invoices (appointment_id TEXT REFERENCES appointments(id));
    CREATE TABLE patient_assessments (appointment_id TEXT REFERENCES appointments(id));
    CREATE TABLE payments (appointment_id TEXT REFERENCES appointments(id));
    CREATE TABLE appointment_references (appointment_number INTEGER PRIMARY KEY AUTOINCREMENT, appointment_id TEXT REFERENCES appointments(id));
    CREATE TABLE clinical_notes (id TEXT PRIMARY KEY, patient_id TEXT REFERENCES patients(id), doctor_id TEXT REFERENCES users(id));
    CREATE TABLE expenses (id TEXT PRIMARY KEY, recorded_by TEXT REFERENCES users(id));
    CREATE TABLE clinic_tasks (id TEXT PRIMARY KEY, created_by TEXT REFERENCES users(id), completed_by TEXT REFERENCES users(id));
    CREATE TABLE compliance_checks (id TEXT PRIMARY KEY, checked_by TEXT REFERENCES users(id));
    CREATE TABLE inventory_items (id TEXT PRIMARY KEY, updated_by TEXT REFERENCES users(id));
    CREATE TABLE audit_log (id TEXT PRIMARY KEY, actor_id TEXT REFERENCES users(id));
    INSERT INTO users VALUES ('admin-1', 'admin'), ('doctor-1', 'doctor'), ('manager-1', 'manager');
    INSERT INTO patients VALUES ('patient-1', 'manager-1');
    INSERT INTO appointments VALUES ('appointment-1', 'patient-1', 'doctor-1', 'manager-1');
    INSERT INTO invoices VALUES ('appointment-1');
    INSERT INTO patient_assessments VALUES ('appointment-1');
    INSERT INTO payments VALUES ('appointment-1');
    INSERT INTO appointment_references (appointment_id) VALUES ('appointment-1');
    INSERT INTO clinical_notes VALUES ('note-1', 'patient-1', 'doctor-1');
    INSERT INTO expenses VALUES ('expense-1', 'manager-1');
    INSERT INTO clinic_tasks VALUES ('task-1', 'manager-1', 'manager-1');
    INSERT INTO compliance_checks VALUES ('check-1', 'manager-1');
    INSERT INTO inventory_items VALUES ('item-1', 'manager-1');
    INSERT INTO audit_log VALUES ('audit-1', 'manager-1');
  `);
  if (adminCount > 1) database.prepare("INSERT INTO users VALUES ('admin-2', 'admin')").run();
  if (adminCount === 0) database.prepare("DELETE FROM users WHERE role = 'admin'").run();
  database.close();
  return { directory, databasePath };
}

test('clears clinic data while preserving all accounts and unrelated files', () => {
  const { directory, databasePath } = createDatabase();
  const pdfDirectory = path.join(directory, 'patient-assessments');
  fs.mkdirSync(pdfDirectory);
  fs.writeFileSync(path.join(pdfDirectory, 'assessment-123.pdf'), 'generated');
  fs.writeFileSync(path.join(pdfDirectory, 'keep.txt'), 'unrelated');

  clearClinicData(databasePath);

  const database = new DatabaseSync(databasePath);
  assert.deepEqual(
    database.prepare('SELECT id, role FROM users ORDER BY id').all().map(row => ({ ...row })),
    [
      { id: 'admin-1', role: 'admin' },
      { id: 'doctor-1', role: 'doctor' },
      { id: 'manager-1', role: 'manager' }
    ]
  );
  for (const table of ['patients', 'appointments', 'invoices', 'patient_assessments', 'payments', 'appointment_references', 'clinical_notes', 'expenses', 'clinic_tasks', 'compliance_checks', 'inventory_items', 'audit_log']) {
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count, 0, `${table} should be empty`);
  }
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_sequence WHERE name = 'appointment_references'").get().count, 0);
  database.close();
  assert.deepEqual(fs.readdirSync(pdfDirectory), ['keep.txt']);
});

test('refuses to clear data unless exactly one admin account exists', () => {
  for (const adminCount of [0, 2]) {
    const { databasePath } = createDatabase({ adminCount });
    assert.throws(() => clearClinicData(databasePath), /Expected exactly one admin account/);
    const database = new DatabaseSync(databasePath);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM patients').get().count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM users').get().count, 2 + adminCount);
    database.close();
  }
});
