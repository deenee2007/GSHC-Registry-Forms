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
* **Court Registries:** High Court 1 to 9 (one shared module, 15 forms)
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
  audit log. The dashboard also offers a full JSON backup of records.

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
