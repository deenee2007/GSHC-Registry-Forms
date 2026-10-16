# GSHC Registry & Units Forms Automation System

Offline forms-automation app for the **Gombe State High Court of Justice**.
*Directorate of ICT.*

A local Node server hosts the app on `localhost`; **all data is stored in the
browser's IndexedDB on the same machine** — no remote server, no MySQL, works
fully offline (same model as before).

## Units in this build
- **Court Registries — High Court 1 to 9** (one reusable module, nine units)
- **Appeals Registry**
- **Execution / Bailiffs Unit**
- **Settings** (admin only)

## Setup
1. Install [Node.js](https://nodejs.org) (LTS) on the machine.
2. In this folder, run:
   ```
   npm install
   npm start
   ```
3. Open `http://localhost:3100`.

On Windows, double-click **`start.vbs`** to launch silently and open the browser
automatically. (Make a desktop/startup shortcut to it if you want auto-start.)

## First login
- Username: `admin`  ·  Password: `admin`
- You'll be forced to set a new password immediately.
- Then go to **Settings → Users** to create staff accounts, assign each to a
  unit, and tick their privileges (view / create / edit / finalize / delete / print).

## How it's organised (modular)
```
server.js                     local host only
public/
  index.html
  css/styles.css              official green theme
  js/
    main.js                   bootstrap, login, first-run seeding
    core/
      db.js                   IndexedDB data layer (one store per unit type)
      auth.js                 SHA-256 login + sessions
      permissions.js          role + per-action privilege checks
      ui.js                   shared DOM/modal/table/form helpers
      recordEngine.js         shared draft->finalize/lock workflow
      router.js               builds nav from a user's accessible units
    modules/
      registry.js             Court Registry (HC 1-9)
      appeals.js              Appeals Registry
      execution.js            Execution / Bailiffs
      settings.js             admin: users, units, privileges
```

## Adding the real forms
Each unit module has a `forms` object near the top. A form is just a
**label + field schema**, e.g.:
```js
my_form: {
  label: 'Form Name',
  schema: [
    { name: 'fieldKey', label: 'Field Label', type: 'text', required: true },
    { name: 'notes', label: 'Notes', type: 'textarea', full: true }
  ]
}
```
The starter forms are placeholders — replace them with the actual registry,
appeals and execution forms. No other code changes needed; the engine renders
them, handles drafts, locking, viewing, editing and deleting automatically.

## Adding another court later
Settings → Units → **+ Add Court Registry** (or add to `SEED_UNITS` in
`main.js`). New record stores only need adding to `STORES` in `core/db.js`
(+ bump `DB_VERSION`) if you introduce a brand-new *type* of unit.
