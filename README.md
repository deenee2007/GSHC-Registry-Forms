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

## User guide
**❓ Help** in the menu (and **User guide** on the sign in screen) opens
`/guide`: one page each for everyone, registry and unit staff, judges and
signers, the Execution / Bailiffs Unit, administrators, and checking a
document. Each prints on one A4 sheet (**Print this page**), or all
together. It works offline. When a button or menu name changes, update
`public/guide.html`; `test/guide.test.js` fails if the guide names a button
the app no longer has.

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
* **Signing in:** staff sign in with their **email address** (or a username,
  for staff who have no email). A new user added with an email needs no
  username: the email is used. On the first start after this change, every
  existing account with an email address switched to it (once). The built in
  `admin` account keeps the username "admin", which ADMIN_RESET looks for,
  and can also sign in with its email. When an administrator adds or
  changes someone's email, they sign in with the new email.
* **Removing an account:** **Deactivate** (under More) stops someone signing
  in and warns how many forms are waiting for their signature; documents
  they made or signed stay valid with their name. A deactivated account that
  is in no document at all (a test account) can be **Deleted permanently**,
  which frees its email for a new account. Adding an email that belongs to a
  deactivated account offers to activate that account instead.
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

## Process Registry
New cases are filed, numbered and assigned to a court here.
1. **Filing** (Process Registry staff): **+ New Filing** with the case type,
   parties, nature of case, originating process, counsel, date of filing,
   the fees (picked from the fee schedule; the total is worked out). Then
   **🧾 Print Invoice** for the filer to go and pay: an A5 invoice with the
   fees, the total in figures and words, the payment details set by the
   administrator and a reference (INV/2026/0001, from 1 again each year;
   printing again after the fees change keeps the reference). When the
   filer returns, the receipt number and an **upload of the payment
   receipt** (photo or PDF, kept privately; the administrator can make the
   upload optional). Optionally, the email addresses of the parties and
   counsel: each gets a short email when the invoice is issued, the case is
   registered, assigned to a court, and its file received there. The emails
   give only the stage, and each one sent is noted on the case. They can be
   switched off in Settings → Process Registry. They use the Brevo account
   (the free plan allows about 300 emails a day in all). **Official** (criminal cases filed by the State, EFCC
   matters) needs no fee or receipt; ticking **EFCC matter** makes a case
   official. Then **Send to Process Registrar**. The Process Registrar may
   file a case themselves and register it at once, with no sending.
2. **Registration** (Process Registrar): checks the filing and the receipt,
   then **Register and Give Number**, or **Return with Comments**. Each case
   type counts on its own and starts again at 1 each year: GM/1/2026 (civil),
   GM/1<sup>c</sup>/2026 (criminal), GM/1<sup>p</sup>/2026 (petition). The
   next court in turn is proposed: after the court proposed last, back to
   High Court 1 after the last; EFCC matters go round the EFCC courts only.
3. **Assignment** (Hon. Chief Judge): **⚖ Awaiting Assignment** lists the
   registered cases with the proposed court. The Chief Judge keeps it or
   chooses another and assigns with their signing PIN. The rotation
   continues from the court proposed.
4. **Slip and dispatch** (Process Registry): **🖨 Print Assignment Slip**
   (or **🖨 Print Slips** for several, one A6 card each) prints the slip for
   the file: "Assigned to High Court No. IX", the suit number and the
   parties (first named on each side, "and others"), the date of
   assignment, the Chief Judge's signature and a QR code. **📦 Dispatch
   Files** marks the files sent to their courts (each court is told), with
   an optional Dispatch List for the receiving clerks to sign. The court can
   mark a file received only after it is dispatched.
5. **Case Register** (court registry): **📒 Case Register** in the menu
   (and on the court's page; someone in several courts chooses the court)
   keeps two books, **Civil Register** and **Criminal Register**, as
   on paper. Each is numbered from 1 and has the columns S/No, Name of case,
   Suit number, Date of filing, Date of assignment, Type of case, Date
   received, Date of disposal and Remarks. **File received** when the file
   arrives; **Record Remark** with the date of disposal when the case is
   disposed of (Judgment entered, Struck out, Withdrawn, Dismissed,
   Transferred, or Other typed in). **+ Add Earlier Case** enters a case
   filed before the system. A newly assigned case shows on the court's
   Home (**New Cases Assigned**) and as a number beside **📒 Case Register**
   until its file is received. The Chief Judge who assigns a case is not
   sent the court's notice for it, even when they sit in that court.

**Court fees.** The fee list comes from the First Schedule of the Gombe
State High Court (Increase of Court Fees) Rules, 2023 (Legal Notice No. 1
of 2023, in force from 22 December 2023): 101 fees under their item
numbers, by section (`src/forms/feeSchedule2023.js`). It is loaded once by
itself on the first start after it was added (the list it replaces is kept
in appmeta); after that the list in Settings → Process Registry is the one
used and can be corrected, and **Load the official schedule again**
restores it. A fee per unit (each exhibit, per page, per ₦1,000,000 or
part thereof) is multiplied by the number staff enter; a percentage fee
(seven items, such as 2% of arrears of rent) is worked out on the amount
staff enter, which shows on the invoice.

**Fill a form from a case.** In the court registries and the Execution
Unit, **📝 Fill a Form** (Case Register View, Case File, Court Diary) or
**Choose a case** at the top of a new form fills the form from a
registered case: the suit number; the parties in the form's own boxes
(Plaintiff and Defendant, Complainant and Accused, Applicant and
Respondent); the party addresses given at filing; the court as "High
Court No. 9" in Issued At (or its number where the form asks for it); the
court's judge where it has one; counsel; the offence for a criminal case;
and from a diary entry, its date, time and business. Other boxes come from
earlier documents of the case. Only empty boxes (and court or party boxes
still at the form's starting wording) are filled; filled boxes are shaded
until edited. Nothing is saved until the form is.

**Court Order.** The judge's signature is placed above the judge's name in
the left column (each judge's above their own on a panel order), with
space to sign by hand before signing; the box for the seal is gone, as the
court's seal is placed on the paper.

**Register import.** **⬆ Import Register** in the Case Register brings in
a court's existing book from Excel (.xlsx) or CSV, using the template's
columns (S/No, Register, Name of case, Suit number, Date of filing, Date of
assignment, Type of case, Date received, Date of disposal, Remarks, Next
date, Coming up for; in any order, found by their headings). Dates are read
day first, or as Excel dates. Every row is checked and shown before
anything is saved: a row with no suit number, an unreadable date, or a
suit number already in a register (or twice in the sheet) is left out.
The case type comes from the Register column or the letter in the suit
number. A next date still to come goes into the Court Diary. The file is
read with Node's own zlib (no spreadsheet library); old .xls files must be
saved as .xlsx first.

**Scanned documents.** Each case has **Documents**: the Process Registry
(at filing) and the assigned court's staff add scanned PDFs or photos (up
to 10 MB each, the most Cloudinary's free plan takes for one file; a long
document goes in parts), with the type, title and date filed. They are
kept privately in Cloudinary and open only for the Process Registry, the
Chief Judge and the assigned court; other users see them listed in the
Case File but cannot open them. The uploader may delete a document the
same day, an administrator at any time; each upload and deletion is in
the audit log.

**Court Diary.** **📅 Court Diary** in the menu gives each court one diary,
shared by its registry and its judges. **+ Fix a Date** takes a case from
the Case Register (or one typed in), the date and time, and what it is
coming up for: the list is set in Settings → Process Registry (Mention,
Hearing, Continuation of hearing, Ruling, Judgment, Report of service to
start with; Others is always offered), with an optional limit of cases a
day for each court (a warning, which staff can pass). **Record Outcome**
after the sitting notes what happened and the next date (a new entry),
and a disposal goes to the Case Register. Parties and counsel with an
email are told each date fixed or changed. Day, week and month views;
diary dates also show on Home and in the day before email. **📋 Draw Cause
List** takes the day's cases in order, with any others added, into the
court's Cause List form to check, save and sign as usual.

**Today in Court.** Home shows each court's cases for the day from the
diary, with **Record Outcome** (only on or after the day of a sitting), and
the number fixed for tomorrow; always for judges, and for court staff on a
day with cases.

**Court Statistics** (Hon. Chief Judge and administrators): for a period,
cases assigned and disposed of, sittings and adjournments per court; as
they stand today, cases pending with their average and oldest age and in
bands (under 1 year, 1 to 3, 3 to 5, over 5); each court's pending cases,
oldest first, with adjournments and the next date. Print, or download for
Excel (CSV).

Roles: give the **Process Registrar** and **Hon. Chief Judge** signing roles
in Settings → Users; Process Registry staff need the Process Registry unit
(the Process Registrar role alone is enough to see it).
Settings → **Process Registry**: the number prefix (GM), case types with their
letters and register book (Civil or Criminal), the payment details on
the invoice, whether the receipt upload is required, the fee schedule, and the courts that hear EFCC matters. The Process
Registry's **Summary** tab gives cases registered by type, official cases,
fees recorded and cases assigned per court for any period. Cases are in the
Case File, the daily backup, and Clear Test Data (which also restarts the
numbering at 1 and the rotation at High Court 1). Receipt files stay in
Cloudinary, like signatures.

## Before going live: clearing test data
Until it has been used, Home shows administrators a **Before Going Live**
section with **🗑 Clear Test Data**. Typing `CLEAR TEST DATA` removes every
form, saved copy and notification, and the audit entries about those forms
(so Reports start from zero). Users, units, form access, signing rules,
signatures and PINs are kept. A backup of everything is made first; if the
backup fails, nothing is cleared. It works **once only**: afterwards the
section disappears and the server refuses it, so it can never touch real
court records. Test QR codes then show "Not found". Test accounts no longer
in any document can then be deleted permanently (Settings → Users → More).

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
