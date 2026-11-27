'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { DatabaseSync } = require('node:sqlite');

const dataTables = [
  'invoices',
  'patient_assessments',
  'payments',
  'appointment_references',
  'clinical_notes',
  'appointments',
  'patients',
  'expenses',
  'clinic_tasks',
  'compliance_checks',
  'inventory_items',
  'audit_log'
];

function clearClinicData(databasePath, { deleteGeneratedFiles = true } = {}) {
  const resolvedDatabasePath = path.resolve(databasePath);
  if (!fs.existsSync(resolvedDatabasePath)) {
    throw new Error(`Database not found: ${resolvedDatabasePath}`);
  }
  const assessmentPdfPaths = deleteGeneratedFiles
    ? getGeneratedAssessmentPdfPaths(path.join(path.dirname(resolvedDatabasePath), 'patient-assessments'))
    : [];

  const database = new DatabaseSync(resolvedDatabasePath);
  try {
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;');
    const admins = database.prepare("SELECT id FROM users WHERE role = 'admin'").all();
    if (admins.length !== 1) {
      throw new Error(`Expected exactly one admin account; found ${admins.length}. No data was cleared.`);
    }

    const existingTables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    for (const table of dataTables) {
      if (existingTables.has(table)) database.exec(`DELETE FROM "${table}"`);
    }
    if (existingTables.has('sessions')) database.exec('DELETE FROM sessions');
    if (existingTables.has('login_failures')) database.exec('DELETE FROM login_failures');
    database.prepare("DELETE FROM sqlite_sequence WHERE name = 'appointment_references'").run();
    database.exec('COMMIT');
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK');
    throw error;
  } finally {
    database.close();
  }

  for (const pdfPath of assessmentPdfPaths) fs.unlinkSync(pdfPath);
}

function getGeneratedAssessmentPdfPaths(directoryPath) {
  if (!fs.existsSync(directoryPath)) return [];
  const directoryStat = fs.lstatSync(directoryPath);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error(`Refusing to clear generated files because this is not a regular directory: ${directoryPath}`);
  }

  return fs.readdirSync(directoryPath, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^assessment-.+\.pdf(?:\..+\.tmp)?$/i.test(entry.name))
    .map(entry => path.join(directoryPath, entry.name));
}

async function main() {
  const databasePath = process.env.PMS_DB_PATH || path.join(__dirname, 'data', 'clinic.sqlite');
  if (!fs.existsSync(databasePath)) throw new Error(`Database not found: ${path.resolve(databasePath)}`);

  console.log('This permanently deletes clinic records, billing, audit history, and generated assessment PDFs.');
  console.log('All existing accounts will be kept. No backup will be created.');
  console.log('Stop the PMS server before continuing, then restart it after the reset.');
  const prompt = readline.createInterface({ input: stdin, output: stdout });
  let confirmation;
  try {
    confirmation = await prompt.question('Type CLEAR to continue: ');
  } finally {
    prompt.close();
  }
  if (confirmation !== 'CLEAR') {
    console.log('Cancelled. No data was cleared.');
    return;
  }

  clearClinicData(databasePath);
  console.log('Clinic data cleared. All accounts were preserved.');
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Clear failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { clearClinicData };
