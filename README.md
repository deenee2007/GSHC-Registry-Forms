# GSHC Registry & Units Forms Automation System

Online forms system for the **Gombe State High Court of Justice**.
*Directorate of ICT.*

Registry staff fill in official court forms, judges and registrars sign them
digitally, and the printed document carries a QR code anyone can scan to
confirm it is genuine.

> **Status:** online backend and screens complete. Tested end to end in a
> browser: admin setup, judge signature, submission, approval, printing,
> QR verification and offline drafts.

## Units
* **Court Registries:** High Court 1 to 9 (one shared module, 15 forms); more can be added
* **Appeals Registry** (4 forms)
* **Execution / Bailiffs Unit** (14 forms)
* **Settings** (administrators only)

## How signing works
1. A staff member fills a form and saves it as a **draft**.
2. On **Submit**, each signature line on the form is handled:
   * if the submitter holds that signing role (for example a Registrar on a
     hearing notice), they confirm with their signing PIN and their signature
     is placed at once;
   * otherwise the form goes to the person chosen to sign (the court's judge,
     the Chief Registrar, the Chief Bailiff and so on).
3. The signer sees it in their **inbox**, previews it, and either **approves**
   with their PIN (their signature is placed automatically) or **returns** it
   with comments.
4. When every line is signed, the record is **final** and locked. It returns
   to the submitter under **Approved**, ready to print.
5. For appeal panels, the submitter chooses the judges and whether **any one**
   or **all** of them must approve.
6. A signed document can be **revoked** with a reason; it is never deleted.

Who signs which form is set per form in Settings. Forms signed by people
outside the system (deponents, sureties, counsel) have no digital signature
line; finalising them still locks them and issues a verification code.

## Screens
* **Home:** what needs your attention, quick links to each form, notifications.
* **Awaiting My Signature** (signers): forms sent to you; review, approve
  with your PIN, or return with comments.
* **My Submissions:** forms you submitted, under Approved (ready to print),
  Awaiting Signature, Returned and Revoked.
* **Unit pages:** each unit's records, with search and status filters.
* **My Signature** (signers): draw or upload your signature, set your PIN.
* **Settings** (administrators): users, units, form access, signing rules,
  audit log. The dashboard shows the automatic backups (see Backups).

## Working offline
The app keeps working when the internet drops. It still opens, shows the
last loaded lists, and lets staff fill in and save drafts, which are kept on
that computer and sent to the server automatically when the connection
returns (the sidebar shows how many are waiting). Submitting, approving and
signing need a connection, because they must be recorded centrally for the
QR check to work. Signing never stores a PIN on the computer.

## Verification
Every final document gets a code such as `GSHC-7KQ4-9XM2-AB3D`, a QR code
linking to `/verify/<code>`, and a SHA-256 fingerprint of its content. The
public page at `/verify` shows whether a document is **genuine**, **revoked**,
**altered** or **not found**, with the form type, reference, court and
signers, but not the document's contents.

QR links use the address the app was opened from (the Render address during
testing, the court's domain later). Set `PUBLIC_BASE_URL` to pin them to one
domain.

## Security
* Passwords hashed with bcrypt; minimum 8 characters with letters and numbers.
* Sessions held on the server (MongoDB), in secure cookies, with automatic
  sign out after inactivity.
* Every permission and every record lock is enforced by the server.
* Accounts lock for 15 minutes after 5 failed sign ins; signing locks after
  5 wrong PINs.
* Signature images are private Cloudinary assets, served only to users who
  can view the record.
* Every action is written to an audit log.

## Running locally
1. Install [Node.js](https://nodejs.org) 20 or later and have a MongoDB
   available (local, or an Atlas connection string).
2. Copy `.env.example` to `.env` and fill it in.
3. Run:
   ```
   npm install
   npm start
   ```
4. Open `http://localhost:3100`. On first start the server creates the admin
   account (password from `ADMIN_PASSWORD`, or a random one printed in the
   log) and asks for a new password at first sign in.

Tests: `npm test` (needs a MongoDB at `TEST_MONGODB_URI`, default
`mongodb://127.0.0.1:27017/gshc_registry_test`).

## Deploying on Render
The repository includes `render.yaml`. Create the service from it, then
enter `MONGODB_URI`, `CLOUDINARY_URL` and `ADMIN_PASSWORD` when asked.
`SESSION_SECRET` is generated automatically. A paid instance is recommended
for daily use, because free instances sleep when idle.

## Passwords and email
* **New accounts:** if the user has an email address, the admin can email
  an invitation link; the user chooses their own password (link valid 24
  hours, works once). Without email, the admin gets a one time password
  with a Copy button.
* **Forgot password:** "Forgot password?" on the sign in screen emails a
  reset link (valid 60 minutes, works once). The answer is the same whether
  or not the account exists. Admins can also send a link from Settings.
* **My Account:** anyone signed in can change their password. Changing or
  resetting a password signs that user out on every other computer.
* Every password and PIN field has a show / hide button.

Email is sent through Brevo. Set `BREVO_API_KEY` (an API key, starting
`xkeysib-`) and `MAIL_FROM` (a sender address verified in Brevo) on Render.
Without them, the email features are hidden and everything else works.

## Reports
**📊 Reports** in the menu shows what happened in a period: forms created,
submitted, signed, returned and revoked, forms awaiting signature now, and
approval times, broken down by form, by court (administrators) and by
signer, with the list of documents signed (or forms created).
* Filters: period (today, this week, this month, last month, this year or
  any dates), form, current status and signer.
* Administrators see every court and unit and can filter by court. Other
  users need the **reports** privilege and see only their own unit.
* **Print** gives an A4 report with the court masthead; **Download for
  Excel** saves a CSV file that opens in Excel.

## Case File
**📁 Case File** in the menu: type a suit, case or appeal number (or part of
one, such as `45/2026`) to see every document for it, in all units, oldest
first, with its status. Capitals and spaces do not matter (`gm / 45 / 2026`
finds `GM/45/2026`). A document's **📁 Case File** button opens its case;
**Print list** prints the case list on A4.
* Numbers are read from every number box on a form, including each line of
  a cause list and the extra suit numbers on a court order. Forms that had no
  suit number box (the writs of possession, statutory notice, notice to
  vacate, auction receipt, summons to settle record) now have an optional one.
* **Filling a new form:** when a suit or case number is typed on a new
  form, the system looks for earlier documents for that case that you can
  open and offers to fill the empty boxes (parties, addresses, court,
  offence and so on) with **Fill them in**. Dates, times, fees, amounts,
  references and service details are never copied, and boxes already
  filled are left alone.
* Documents in your own unit can be opened. Documents in other units are
  listed by form, unit, status and date only, without their contents, and
  other units' drafts are not listed. Administrators see everything.

## Hearing reminders
Court dates are read from signed documents: hearing notices, civil and
criminal summonses, witness summonses, subpoenas, bail bonds, orders to
produce a prisoner, remand return dates, cause lists, summonses to settle
record and notices of appeal fixed.
* **Home** shows each court's dates for the next 14 days (time, case number,
  parties, what is happening), with Open. Administrators see every court.
* **Email:** every working day from 07:00 (`REMINDER_HOUR`), each person
  with an email address in a court is sent that court's dates for the next
  working day; on Friday, Monday's. One email per person, once a day. The
  same switches as the other alerts apply (My Account, and the
  administrator's per user and global switches).
* A date changed in court shows here only once a new document with the new
  date is signed. Set `PUBLIC_BASE_URL` so the email carries a button back
  to the app.

## Email alerts
When email is set up, people are emailed when a form waits for their
signature, and when a form they submitted is approved, returned or revoked.
* Each user can switch alerts off under **My Account**.
* The administrator can switch them off for one user (Edit user) or for
  everybody (Settings → Users). In app notifications continue either way.

## Saved copies
When a document is signed, the server keeps a copy exactly as signed: one
HTML file containing its styles, signatures and QR code. **Download Copy**
(in the document view and My Submissions) saves it; it opens and prints in
any browser, even offline. Revoked documents download with a REVOKED notice.
**Print** on a signed document also prints this copy, so a document always
prints exactly as it was signed, even after a form's wording is corrected.

When a form gains new boxes, a draft saved before the change shows a notice
naming them when it is next edited.

## Backups
Once a day the server makes a backup by itself and keeps it privately on
Cloudinary (no public address; only the server can read it):
* one compressed file with the units, users, signing rules, records,
  notifications, settings and audit log, exact to the second;
* each signed document's saved copy, once, as its own file.

Backups are kept 30 days (`BACKUP_KEEP_DAYS`); the newest is never removed.
The server checks every hour, so if it was asleep at the usual time it backs
up soon after it wakes. If a backup fails, administrators with an email
address are told (at most once a day) and it is tried again every hour.

On the **Dashboard**, administrators see the last backup, the list of kept
backups with **Download**, and **Back up now**. Signature images are not in
the file; they stay in Cloudinary.

**Restoring** (only into a new, empty database; it refuses to touch one
that has users):
```
MONGODB_URI=<new database> CLOUDINARY_URL=<same as on Render> npm run restore -- --latest
npm run restore -- gshc_2026-10-19_020000_000.json.gz --uri <new database>
```
Then point `MONGODB_URI` on Render at the restored database. Everyone's
password, PIN and signature carry over.

## Units
Settings → Units → **+ Add Unit** adds either another **Court Registry**
(numbered automatically, with the registry forms) or an **Other Unit**
(Probate, Accounts, Open Registry and so on), which starts with no forms;
choose its forms under Form Access. Its own forms and workflow can be added
to the system later as a new module.

## Startup log and admin recovery
Each start prints the database in use and how many accounts it holds:
```
  Database: GSHC_DB  ·  users: 12  ·  active administrators: 1
```
It warns if the database contains accounts this app did not create, which
means `MONGODB_URI` points at another application's database. In production
the app refuses to start if `MONGODB_URI` names no database at all.

If the admin password is lost or the account is locked:
1. On Render, set `ADMIN_PASSWORD` to a temporary password and add
   `ADMIN_RESET` = `true`.
2. Restart the service. The log confirms the reset.
3. Sign in as `admin` with that password and choose a new one.
4. Remove `ADMIN_RESET`. (Leaving it on does no harm: it acts only once for
   each `ADMIN_PASSWORD` value.)

## Project layout
```
server.js                 entry point: connect, first run setup, listen
src/
  config.js               settings from environment variables
  app.js                  Express app, security headers, sessions, routes
  models/index.js         MongoDB collections
  forms/catalogue.js      reads the form definitions from public/js/modules
  forms/signers.js        signing roles and default signer per form
  middleware/auth.js      sign in and permission checks
  routes/                 auth, me (signature, PIN), admin, catalogue,
                          records (workflow), notifications, verify
  services/               audit, passwords, seed, signature storage,
                          verification codes and QR
public/
  index.html, css/, js/   browser app (forms, print templates, screens)
  verify.html             public verification page
test/                     end to end API tests
```

## Adding or changing forms
Form fields are defined once, in `public/js/modules/registry.js`,
`appeals.js` and `execution.js`; the server reads the same definitions.
Printed layouts are in `public/js/core/output.js`. A new form also needs a
signing rule, which an administrator sets in Settings.
