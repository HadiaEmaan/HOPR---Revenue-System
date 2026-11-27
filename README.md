# HOPR Clinic PMS

Standalone Node.js and SQLite application. It does not modify the existing `Design` website.

## Requirements

- Node.js 24 or newer
- A private server disk for the SQLite database
- HTTPS termination at a trusted reverse proxy before using real patient data

## First run (PowerShell)

For local development, start the server from the workspace root:

```powershell
$env:PMS_ADMIN_EMAIL = "clinic-admin@example.com"
$securePassword = Read-Host "Create an admin password (14+ characters)" -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try { $env:PMS_ADMIN_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer) }

```

Open `http://127.0.0.1:4177`. The first account is created only when the database has no admin. The database defaults to `PMS/data/clinic.sqlite`; set `PMS_DB_PATH` to a protected persistent volume in deployment. Set `PORT` to change the local port and `PMS_TIME_ZONE` to change clinic reporting time (default `Asia/Karachi`).

The local first-run setup screen is disabled when `NODE_ENV=production`. For a production deployment, provision the initial admin using `PMS_ADMIN_EMAIL` and `PMS_ADMIN_PASSWORD` in the server's secret manager, start the server once, then remove those variables. Do not expose the local development setup flow through a public reverse proxy.

After signing in as admin, use **Add staff** to provision clinic manager, doctor, or Gymkhana accounts. The clinic manager workspace includes front-desk check-in, the **Invoices** page with an invoice action for each payment, and the same **Inventory** page as Admin, including adding items and adjusting stock, alongside the live queue, daily tasks, follow-ups, and compliance pages. Doctors do not see patient phone numbers in their patient list or its workspace data. The UI asks for a temporary password; communicate it using a secure channel. There is no public account registration.

In the Admin **Patients** workspace, **Delete options (by Appointment ID)** lets you choose any appointment ID for that patient, then use one of two actions. **Delete appointment** removes only the selected appointment and its payment, invoice, assessment/PDF, and linked session notes; other visits for that patient stay. **Delete patient record** removes the patient record selected by its appointment ID and all visits and linked clinical records for that specific patient entry; a separately registered duplicate patient entry is not affected. The **Appointments**, **New patients**, **Clinical records**, and **Follow-ups** workspaces also provide **Delete appointment** per row, making it possible to target a particular same-day duplicate. Confirm the ID before deleting. Deletion is recorded in the audit log.

Run the API tests with `npm test` from the `PMS` folder, or `npm --prefix PMS test` from the workspace root.

For Data Clear

Stop the PMS server, then run `node .\clear-data.js` from the `PMS` folder and type `CLEAR` at the prompt. This permanently removes clinic records, billing, audit history, and generated assessment PDFs; all existing login accounts are kept. Restart PMS with `npm start`.

npm start

## Public Windows deployment with Tailscale Funnel

This option gives staff a free `https://...ts.net` URL that works in an ordinary browser; staff devices do not need the Tailscale app. **Funnel publishes the PMS login page to the public internet. Anyone can reach that page and attempt to sign in.** Only staff with valid PMS accounts can access clinic data, but public exposure increases the risk of attacks. Proceed only because the clinic has explicitly accepted this exposure. Funnel is beta, availability and bandwidth are subject to Tailscale's limits, and it does not provide a custom branded domain. The host PC and Tailscale must stay online. Review the official [Funnel overview](https://tailscale.com/docs/features/tailscale-funnel) and [Funnel CLI](https://tailscale.com/docs/reference/tailscale-cli/funnel) before enabling it.

1. On the Windows host, install Node.js 24 or newer and Tailscale. Keep the existing `PMS` application folder and its `data\clinic.sqlite` database; the launcher uses this database and does not create a blank one. Keep sibling assets `gymkhana.png`, `invoice.png`, and `clinic.jpeg` beside the `PMS` folder. From the `PMS` folder run `npm ci`.
2. Sign in to Tailscale on the host. In the Tailscale admin console, enable MagicDNS and HTTPS certificates, and authorize Funnel for the host in the tailnet policy. Use a neutral device name, not a patient name. A custom domain is not supported by Funnel.
3. On the host, run `tailscale funnel --bg http://127.0.0.1:4177`. This makes the local-only PMS available through a public HTTPS Funnel URL. Use `tailscale funnel status` to confirm the exact `https://...ts.net` address. `PMS_PUBLIC_ORIGIN` must match the browser address exactly, with no trailing slash; the launcher default is `https://desktop-rpl642b.tail350fbe.ts.net`. If the Funnel address changes, update that default or override it in PowerShell before starting the app: `$env:PMS_PUBLIC_ORIGIN = "https://your-current-host.example-tailnet.ts.net"; .\start-pms.cmd`. A mismatch causes write requests, including login, to be rejected. Do not configure router port forwarding or open inbound firewall ports.
4. Use the existing clinic admin account; do not run first-admin setup or clear the database. The launcher sets production mode and points to the existing `data\clinic.sqlite`.
5. Start the app with `.\start-pms.cmd`. For automatic startup, create a Windows Task Scheduler task at system startup under a non-admin account that has read access to the app files and write access to the `PMS\data` folder. Keep the host powered on and Tailscale connected. Staff use the HTTPS Funnel URL in a browser; they do not install Tailscale.
6. Before real use, verify the URL from a device outside the tailnet, sign in with an authorized account, and perform an authorized test action. Give every staff member a separate account and a strong, unique password; never share admin credentials. Configure encrypted backups of the entire `PMS\data` folder, including `clinic.sqlite` and `patient-assessments`, and test a restore. Protect the host with disk encryption, updates, and a non-admin service account. If the app folder is in OneDrive or another synced folder, move it and the database to a stable local directory before production use; synchronized SQLite files can conflict with the database journal.
7. To make the app unavailable publicly, stop the PMS process and run `tailscale funnel --bg http://127.0.0.1:4177 off` on the host. Confirm it is no longer listed by `tailscale funnel status`. Keep the application origin set to the Funnel URL if you later enable Funnel again.

Do not use this deployment for real patient or financial records until encrypted backups and restore, host protection, strong individual accounts, monitoring, incident response, and a privacy/security review for applicable local health-data law are ready. HTTPS protects data in transit, but it does not make the login page private or replace app, host, and account security.

## Patient history and assessment

Doctors can use **Print** in the Actions column for each assigned **New patient** appointment. Patient name, age, contact number, and assessment date are prefilled; the remaining demographic and clinical fields autosave as a draft. **Save & preview PDF** generates a separate filled copy of `Patient History & Assessment Form.pdf` and opens it in the assessment dialog. The preview has an **Edit form** action and a **Print** button that opens the PDF viewer's print dialog for the complete document. Long answers continue on additional pages rather than being discarded. The assigned doctor can submit the assessment and continue editing it later.

Admins and clinic managers can use **New patients** to preview and print saved forms, then choose **Edit form** if a correction is needed; only the assigned doctor can submit. Doctors see only their own notes for patients also assigned to them. Assessment answers are positioned inside the corresponding template boxes; long answers continue on additional pages. Assessment PDFs are served only through an authenticated route and saved beside the configured database under `patient-assessments/`. The supplied blank PDF remains unchanged. Assessment access is not available to patient or Gymkhana accounts. Generated PDFs embed a standard font; if text contains characters that font cannot encode, the save reports an error instead of silently dropping them.

In Admin **Clinical records**, **Patient full record → Open** shows the patient's name, age, membership ID, condition, prescribed/completed session totals, and complete appointment/session timeline, including appointment IDs, dates and times, session numbers, status, treating clinician, session notes, treatment plans, next-session recommendations and their matching appointment status, and saved assessment answers. This full-record view is restricted to Admin. If Open reports that patient history is not available on the server, restart PMS and reload the page so the server loads the full-record endpoint.

Doctors can mark an assigned appointment **In progress** while examining the patient, then **Mark complete** when finished. Admin, Clinic Manager/HR, and other dashboard users can see the patient's **In progress** status in their appointment list and live queue; in-progress visits are prioritized in the shared dashboard queue, which refreshes automatically.

## Clearing clinic data

To permanently remove all clinic records and billing while keeping the single admin account, stop the PMS server and run `node clear-data.js` from the `PMS` folder. The script prompts for the exact word `CLEAR`; it creates no backup, removes non-admin accounts, audit history, and generated assessment PDFs, and clears appointment numbering. It refuses to run if the database does not contain exactly one admin account. Restart the PMS server after the reset so all existing sessions are discarded. Set `PMS_DB_PATH` in the same environment when the application uses a non-default database.

## Security and deployment boundary

The server hashes passwords with PBKDF2, issues HttpOnly/SameSite session cookies, applies login throttling, checks roles on the server, parameterizes SQL, and records account/check-in audit events. Only Head / Admin can change passwords: admins can change their own password after confirming the current one, or reset a non-admin account from **Staff & shifts**. Passwords must be at least 14 characters, and a reset signs the affected staff member out of all active sessions. Staff cannot change passwords themselves; admins should share reset passwords through a secure channel. Financial summaries use all recorded payments and expenses; the Billing & expenses tables show the latest 200 rows. Payment and invoice edits record before/after financial values in the admin audit log. Invoice advance is derived from the amount recorded as paid; invoice subtotal cannot be lower than that collection, and payment corrections cannot exceed an existing invoice subtotal. The payment record is the single collection amount per appointment; this application does not track multiple installment transactions. Doctor dashboards and clinical-note access are filtered by assigned clinician ID. Gymkhana footfall shows daily patient counts, paid revenue, and club-share totals; opening a date or selecting **All records** for a month shows patient, appointment, membership, contact, session, issue, payment, and club-share details with matching totals. The record dialog can be dismissed with its cross or Escape. Admins can enter each appointment's club share in Billing & expenses; it is included in daily and monthly Gymkhana reports. Admins and clinic managers can create or update an invoice from each Appointments row; patient and appointment details are filled automatically, item quantities/prices calculate the subtotal and balance due, and saved invoices print using the supplied `invoice.png` template. Printing saves a copy of the exact invoice shown; Admin's Invoice action opens the last-printed copy, even if a newer draft is being edited. Payment methods include Cash, Online, and POS. Clinical notes remain private to Gymkhana. Clinic managers can create check-ins, update payment status and prescribed sessions, edit a payment amount once per appointment, and manage daily tasks and compliance checks; only admins can correct payment method, edit the amount again, change appointment scheduling/status, or correct patient records. Appointment-only patients have their generated appointment ID shown wherever a membership ID is absent. For HTTPS reverse-proxy deployments, set `PMS_PUBLIC_ORIGIN` to the exact public origin (for example `https://clinic.example.com`) so write-request origin validation matches the browser URL.

This is an initial clinic application, not a compliance certification. Before real patient data is used, deploy behind HTTPS, restrict network access, establish encrypted backups and tested restore, configure disk/volume encryption and monitoring, define retention and incident-response procedures, and complete a privacy/security review for applicable local health-data law. Session state currently lives in the application process, so run one app instance; restarting it signs users out. Live updates use 15-second polling rather than push delivery.