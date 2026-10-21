/*
 * modules/settings.js — administration.
 * Users (units, privileges, signing roles), units, which forms each unit
 * may use, who signs each form, and the audit log.
 */
(function () {
  window.App = window.App || {};
  window.App.modules = window.App.modules || {};

  const TYPE_LABELS = { registry: 'Court Registry', appeals: 'Appeals', execution: 'Execution / Bailiffs', general: 'Other Unit' };
  const MODULE_OF = { registry: 'Registry', appeals: 'Appeals', execution: 'Execution' };

  window.App.modules.settings = {
    async render(container, ctx) {
      const { ui, api, router } = ctx;
      const el = ui.el;

      container.appendChild(el('div', { class: 'page-head' }, [
        el('h1', null, '⚙  Settings & Administration'),
        el('p', { class: 'muted' }, 'Users, units, form access, signing rules and the audit log')
      ]));
      const tabsBar = el('div', { class: 'tabs', role: 'tablist' });
      const panel = el('div', { class: 'tab-panel' });
      container.append(tabsBar, panel);

      const meta = await api.get('/admin/meta');
      const allUnits = async () => (await api.get('/catalogue/units')).units;
      const checkboxes = (items, selected) => {
        const map = {};
        const wrap = el('div', { class: 'checks' }, items.map(([value, label]) => {
          const cb = el('input', { type: 'checkbox' });
          cb.checked = selected.includes(value);
          map[value] = cb;
          return el('label', { class: 'check check--plain' }, [cb, ' ' + label]);
        }));
        return { node: wrap, values: () => Object.entries(map).filter(([, cb]) => cb.checked).map(([v]) => v) };
      };

      function showTempPassword(u, pw, note) {
        const copyBtn = el('button', { class: 'btn btn--primary', type: 'button', onclick: async () => {
          const ok = await ui.copyText(pw);
          copyBtn.textContent = ok ? '✔ Copied' : 'Select and copy';
          ui.toast(ok ? 'Password copied. Paste it into your message to the user.' : 'Could not copy automatically; select the password and copy it.', ok ? 'success' : 'error');
        } }, '📋 Copy');
        ui.modal('Temporary Password', el('div', null, [
          note ? el('div', { class: 'notice notice--warn' }, note) : null,
          el('p', null, `Give this one time password to ${u.fullName}. They sign in with ${u.username} and must change the password the first time. It will not be shown again.`),
          el('div', { class: 'temp-pw-row' }, [el('div', { class: 'temp-pw' }, pw), copyBtn])
        ]), { confirmText: 'Done', cancelText: 'Close' });
      }

      async function emailLink(u) {
        if (!confirm(`Email a link to ${u.email} so ${u.fullName} can choose a new password?`)) return;
        try {
          const r = await api.post(`/admin/users/${u.id}/send-link`);
          ui.toast(r.kind === 'invite' ? `Invitation sent to ${r.email}.` : `Reset link sent to ${r.email}.`, 'success', 5000);
        } catch (e) { ui.toast(e.message, 'error'); }
      }

      // ── USERS ──
      async function renderUsers() {
        ui.clear(panel);
        const [{ users }, units] = await Promise.all([api.get('/admin/users'), allUnits()]);
        const unitName = (k) => (units.find(u => u.key === k) || {}).name || k;
        const globalAlerts = el('input', { type: 'checkbox' });
        globalAlerts.checked = meta.settings.emailAlerts;
        globalAlerts.disabled = !meta.mailEnabled;
        globalAlerts.addEventListener('change', async () => {
          try {
            const r = await api.put('/admin/settings', { emailAlerts: globalAlerts.checked });
            meta.settings = r.settings;
            ui.toast(r.settings.emailAlerts ? 'Email alerts switched on for everyone (except users switched off below).' : 'Email alerts switched off for everyone.', 'success', 5000);
            renderUsers();
          } catch (e) { globalAlerts.checked = !globalAlerts.checked; ui.toast(e.message, 'error'); }
        });
        panel.appendChild(el('div', { class: 'toolbar' }, [
          el('button', { class: 'btn btn--primary', onclick: () => userForm(null, units) }, '+ Add User'),
          el('label', { class: 'check check--plain alert-switch' }, [globalAlerts,
            meta.mailEnabled ? ' Send email alerts to all users' : ' Email alerts (email is not set up on the server)'])
        ]));
        // Five tidy columns; the less used actions sit behind More.
        const small = (text, cls) => el('div', { class: 'cell-sub' + (cls ? ' ' + cls : '') }, text);
        const accessOf = (u) => u.role === 'admin' ? 'Administrator · all units'
          : (u.unitKeys.length ? u.unitKeys.map(unitName).join(', ') : (u.signerRoles.length ? 'All units' : 'No unit'));
        const alertsOf = (u) => !u.email ? 'No email' : !meta.settings.emailAlerts ? 'Off for everyone'
          : u.emailAlertsBlocked ? 'Off (by admin)' : u.emailAlerts ? 'On' : 'Off (by user)';
        panel.appendChild(ui.table(
          [
            { label: 'User', node: u => el('div', null, [
              el('div', { class: 'cell-main' }, [u.title, u.fullName].filter(Boolean).join(' ')),
              small([u.email, u.username !== u.email ? `username: ${u.username}` : ''].filter(Boolean).join(' · '))]) },
            { label: 'Access', node: u => el('div', null, [
              el('div', null, accessOf(u)),
              small(u.role === 'admin' ? 'Full access' : (u.privileges.join(', ') || 'No privileges'))]) },
            { label: 'Signs As', node: u => u.signerRoles.length ? el('div', null, [
              el('div', null, u.signerRoles.map(r => meta.signerRoles[r] || r).join(', ')),
              small(u.hasSignature && u.hasSigningPin ? 'Signature ready' : 'Signature not set up', u.hasSignature && u.hasSigningPin ? '' : 'cell-sub--warn')]) : el('span', { class: 'muted' }, '—') },
            { label: 'Email Alerts', value: alertsOf },
            { label: 'Status', node: u => el('span', { class: 'badge ' + (u.active ? 'badge--final' : 'badge--revoked') }, u.active ? 'Active' : 'Inactive') }
          ],
          users,
          [
            { label: 'Edit', onClick: u => userForm(u, units) },
            { label: 'More ▾', onClick: u => userActions(u) }
          ]
        ));
      }

      // The other actions for one user, each with what it does.
      function userActions(u) {
        let dialog;
        const close = () => dialog && dialog.close();
        const run = (fn) => async () => { close(); await fn(); };
        const item = (label, help, onClick, cls) => el('div', { class: 'action-item' }, [
          el('button', { class: 'btn btn--small ' + (cls || 'btn--ghost'), onclick: run(onClick) }, label),
          el('span', { class: 'muted' }, help)]);
        const items = [
          meta.mailEnabled && u.email && u.active ? item('Email Reset Link', `Emails ${u.email} a link to choose a new password.`, () => emailLink(u)) : null,
          item(meta.mailEnabled && u.email ? 'One Time Password' : 'Reset Password', 'Shows a new password here for you to give them privately.', async () => {
            if (!confirm(`Give ${u.username} a new one time password?`)) return;
            try { const r = await api.post(`/admin/users/${u.id}/reset-password`); showTempPassword(u, r.tempPassword); }
            catch (e) { ui.toast(e.message, 'error'); }
          }),
          u.hasSigningPin ? item('Reset PIN', 'Clears their signing PIN; they set a new one under My Signature.', async () => {
            if (!confirm(`Clear ${u.username}'s signing PIN? They will set a new one under My Signature.`)) return;
            try { await api.post(`/admin/users/${u.id}/reset-pin`); ui.toast('Signing PIN cleared.', 'success'); renderUsers(); }
            catch (e) { ui.toast(e.message, 'error'); }
          }) : null,
          item(u.active ? 'Deactivate' : 'Activate', u.active ? 'Stops them signing in. Documents they signed stay valid.' : 'Lets them sign in again.', async () => {
            if (u.active) {
              let waitingNote = '';
              try {
                const w = await api.get(`/admin/users/${u.id}/work`);
                if (w.waiting) waitingNote = `\n\n${w.waiting} form(s) are waiting for ${u.fullName}'s signature. They will not move by themselves: ask the units to Withdraw them and submit them to another signer.`;
              } catch (e) { /* the warning is extra; deactivating still works */ }
              if (!confirm(`Deactivate ${u.fullName} (${u.username})? They will no longer be able to sign in. Documents they signed stay valid.${waitingNote}`)) return;
            }
            try {
              if (u.active) await api.del('/admin/users/' + u.id); else await api.patch('/admin/users/' + u.id, { active: true });
              renderUsers();
            } catch (e) { ui.toast(e.message, 'error'); }
          }, u.active ? 'btn--danger' : 'btn--ok'),
          !u.active && u.username !== 'admin' ? item('Delete permanently', 'Removes the account for good, so its email can be used for a new account. Only for an account in no document (a test account).', async () => {
            if (!confirm(`Delete ${u.fullName}'s account permanently? This cannot be undone.`)) return;
            try { await api.del(`/admin/users/${u.id}/permanent`); ui.toast('Account deleted. Its email can now be used for a new account.', 'success', 6000); renderUsers(); }
            catch (e) { ui.toast(e.message, 'error', 9000); }
          }, 'btn--danger') : null
        ].filter(Boolean);
        items.push(el('div', { class: 'action-close' }, [el('button', { class: 'btn btn--ghost', onclick: close }, 'Close')]));
        ui.modal([u.title, u.fullName].filter(Boolean).join(' ') + ` (${u.username})`, el('div', { class: 'action-list' }, items), {
          noFooter: true, onOpen: (o) => { dialog = o; }
        });
      }

      async function userForm(existing, units) {
        const v = existing || { role: 'user', unitKeys: [], privileges: ['view', 'create', 'edit', 'finalize', 'print'], signerRoles: [] };
        const username = el('input', { type: 'text', value: v.username || '', autocapitalize: 'none', placeholder: existing ? '' : 'Leave empty to use the email' });
        if (existing) username.disabled = true;
        const fullName = el('input', { type: 'text', value: v.fullName || '' });
        const title = el('input', { type: 'text', value: v.title || '', placeholder: 'e.g. Hon. Justice' });
        const email = el('input', { type: 'email', value: v.email || '', placeholder: 'name@example.com', autocomplete: 'off' });
        const invite = el('input', { type: 'checkbox' });
        invite.checked = true;
        const inviteRow = el('label', { class: 'check check--plain form-field--full' }, [invite,
          ' Email an invitation link so they choose their own password (instead of showing a one time password here)']);
        const alertsAllowed = el('input', { type: 'checkbox' });
        alertsAllowed.checked = !v.emailAlertsBlocked;
        const alertsRow = el('label', { class: 'check check--plain form-field--full' }, [alertsAllowed,
          ' Allow email alerts for this user (forms waiting for them; their forms approved, returned or revoked)']);
        const syncInvite = () => { inviteRow.hidden = !(meta.mailEnabled && !existing && email.value.trim()); };
        email.addEventListener('input', syncInvite);
        syncInvite();
        const role = el('select', null, [el('option', { value: 'user' }, 'Unit User'), el('option', { value: 'admin' }, 'Administrator')]);
        role.value = v.role;
        const unitBox = checkboxes(units.map(u => [u.key, u.name]), v.unitKeys);
        const privBox = checkboxes(meta.privileges.map(p => [p, p]), v.privileges);
        const signBox = checkboxes(Object.entries(meta.signerRoles), v.signerRoles);

        const unitRow = ui.field('Units', unitBox.node, 'Leave all unticked for a signer who serves every unit (for example the Chief Registrar).');
        const privRow = ui.field('Privileges', privBox.node, '"finalize" lets the user submit forms for signature or finalise them. "reports" shows the Reports page for their own unit.');
        const signRow = ui.field('Signs as', signBox.node, 'The signing roles this person holds. Each judge should be ticked to their own court.');
        const sync = () => { const user = role.value === 'user'; unitRow.hidden = !user; privRow.hidden = !user; };
        role.addEventListener('change', sync);
        sync();

        const body = el('div', { class: 'form-grid' }, [
          el('label', { class: 'form-field' }, [el('span', { class: 'form-field__label' }, 'Full Name'), fullName]),
          el('label', { class: 'form-field' }, [el('span', { class: 'form-field__label' }, 'Title (printed with signature)'), title]),
          el('label', { class: 'form-field form-field--full' }, [el('span', { class: 'form-field__label' }, 'Email (they sign in with it; also for invitations and password reset)'), email]),
          el('label', { class: 'form-field' }, [el('span', { class: 'form-field__label' }, existing ? 'Signs in as' : 'Username (only for staff without email)'), username]),
          el('label', { class: 'form-field' }, [el('span', { class: 'form-field__label' }, 'Role'), role]),
          inviteRow,
          meta.mailEnabled ? alertsRow : null,
          unitRow, privRow, signRow
        ]);

        await ui.modal(existing ? 'Edit User' : 'Add User', body, {
          confirmText: existing ? 'Save' : 'Create User',
          onConfirm: async () => {
            const payload = { fullName: fullName.value, title: title.value, email: email.value, role: role.value, unitKeys: unitBox.values(), privileges: privBox.values(), signerRoles: signBox.values(), emailAlertsBlocked: !alertsAllowed.checked };
            if (existing) {
              await api.patch('/admin/users/' + existing.id, payload);
              ui.toast('User updated.', 'success');
            } else {
              let r;
              try { r = await api.post('/admin/users', { ...payload, username: username.value, sendInvite: !inviteRow.hidden && invite.checked }); }
              catch (e) {
                const old = e.body && e.body.inactiveUser;
                if (!old) throw e;
                // The email belongs to a deactivated account: bring it back instead.
                if (confirm(`${e.message}\n\nActivate ${old.fullName}'s account again? They keep their history, signature and PIN; you can then change their court and roles with Edit.\n\n(If it was only a test account, cancel, open it under More and choose Delete permanently.)`)) {
                  await api.patch('/admin/users/' + old.id, { active: true });
                  ui.toast(`${old.fullName}'s account is active again.`, 'success', 5000);
                  renderUsers();
                  return true;
                }
                return undefined;
              }
              if (r.invited) ui.toast(`Invitation sent to ${r.user.email}. The link expires in 24 hours.`, 'success', 6000);
              else showTempPassword(r.user, r.tempPassword, r.emailError ? `The invitation email could not be sent (${r.emailError}). Give this password to the user instead.` : null);
            }
            renderUsers();
            return true;
          }
        });
      }

      // ── UNITS ──
      async function renderUnits() {
        ui.clear(panel);
        const units = await allUnits();
        panel.appendChild(el('div', { class: 'toolbar' }, [
          el('button', { class: 'btn btn--primary', onclick: addUnit }, '+ Add Unit')
        ]));
        panel.appendChild(ui.table(
          [
            { label: 'Unit', key: 'name' },
            { label: 'Type', value: u => TYPE_LABELS[u.type] || u.type },
            { label: 'Key', key: 'key' }
          ],
          units,
          [{ label: 'Rename', onClick: async u => {
            const name = prompt('New name for ' + u.name, u.name);
            if (!name || name === u.name) return;
            try { await api.patch('/admin/units/' + u.key, { name }); ui.toast('Renamed.', 'success'); await router.buildNav(); renderUnits(); }
            catch (e) { ui.toast(e.message, 'error'); }
          } }]
        ));
      }
      async function addUnit() {
        const units = await allUnits();
        const nextCourt = Math.max(0, ...units.filter(u => u.type === 'registry').map(u => u.courtNo || 0)) + 1;
        const type = el('select', null, [
          el('option', { value: 'registry' }, 'Court Registry'),
          el('option', { value: 'general' }, 'Other Unit (Probate, Accounts, Open Registry and so on)')
        ]);
        const name = el('input', { type: 'text' });
        const help = el('p', { class: 'muted form-field--full' });
        const sync = () => {
          if (type.value === 'registry') {
            name.value = `High Court ${nextCourt} Registry`;
            help.textContent = `Numbered automatically as High Court ${nextCourt}. It gets the court registry forms; you can change them later under Form Access.`;
          } else {
            if (/^High Court \d+ Registry$/.test(name.value)) name.value = '';
            name.placeholder = 'e.g. Probate Registry';
            help.textContent = 'It starts with no forms. Next you choose its forms from any module; its own forms and workflow can be added to the system later.';
          }
        };
        type.addEventListener('change', sync);
        sync();
        await ui.modal('Add Unit', el('div', { class: 'form-grid' }, [ui.field('Type', type), ui.field('Unit Name', name), help]), {
          confirmText: 'Add',
          onConfirm: async () => {
            if (!name.value.trim()) { ui.toast('Enter a name.', 'error'); return undefined; }
            const { unit } = await api.post('/admin/units', { type: type.value, name: name.value.trim() });
            ui.toast(`${unit.name} added.`, 'success');
            await router.buildNav();
            renderUnits();
            if (unit.type === 'general') setTimeout(() => configureFormAccess(unit, renderUnits), 50);
            return true;
          }
        });
      }

      // ── FORM ACCESS ──
      async function renderFormAccess() {
        ui.clear(panel);
        const units = await allUnits();
        panel.appendChild(el('p', { class: 'muted' }, 'By default each unit uses its own module\'s forms. You can also give a unit forms from other modules, for example a Hearing Notice for the Appeals Registry.'));
        panel.appendChild(ui.table(
          [
            { label: 'Unit', key: 'name' },
            { label: 'Type', value: u => TYPE_LABELS[u.type] || u.type },
            { label: 'Form Access', value: u => u.allowedForms ? `${u.allowedForms.length} form(s) chosen` : (u.type === 'general' ? 'None yet: choose its forms' : 'Default (own module)') }
          ],
          units,
          [
            { label: 'Configure', onClick: u => configureFormAccess(u) },
            { label: 'Reset', class: 'btn--ghost', show: u => !!u.allowedForms && u.type !== 'general', onClick: async u => {
              if (!confirm(`Reset ${u.name} to its default forms?`)) return;
              await api.patch('/admin/units/' + u.key, { allowedForms: null });
              ui.toast('Reset to defaults.', 'success'); renderFormAccess();
            } }
          ]
        ));
      }
      async function configureFormAccess(unit, after) {
        const byModule = window.App.allFormsByModule || {};
        const boxes = {};
        const body = el('div', { class: 'form-grid' });
        Object.entries(byModule).forEach(([moduleName, forms]) => {
          body.appendChild(el('div', { class: 'form-section' }, moduleName + ' Forms'));
          body.appendChild(el('div', { class: 'checks form-field--full' }, Object.entries(forms).map(([key, def]) => {
            const cb = el('input', { type: 'checkbox' });
            cb.checked = unit.allowedForms ? unit.allowedForms.includes(key) : moduleName === MODULE_OF[unit.type];
            boxes[key] = cb;
            return el('label', { class: 'check check--plain' }, [cb, ' ' + def.label]);
          })));
        });
        await ui.modal('Form Access: ' + unit.name, body, {
          confirmText: 'Save', wide: true,
          onConfirm: async () => {
            const selected = Object.entries(boxes).filter(([, cb]) => cb.checked).map(([k]) => k);
            if (!selected.length) { ui.toast('Select at least one form.', 'error'); return undefined; }
            await api.patch('/admin/units/' + unit.key, { allowedForms: selected });
            ui.toast(`Saved: ${selected.length} form(s) for ${unit.name}.`, 'success');
            await router.buildNav();
            (after || renderFormAccess)();
            return true;
          }
        });
      }

      // ── SIGNING RULES ──
      async function renderSigning() {
        ui.clear(panel);
        const { forms } = await api.get('/catalogue/forms');
        panel.appendChild(el('p', { class: 'muted' }, 'Who signs each form. A form with no signature line is signed by hand outside the system (deponent, surety, counsel); finalising it still locks it and issues a QR code. If the person submitting holds the signing role, they sign it themselves when they finalise.'));
        ['registry', 'appeals', 'execution'].forEach(type => {
          const list = forms.filter(f => f.unitType === type);
          panel.appendChild(el('h3', { class: 'settings-group' }, TYPE_LABELS[type]));
          panel.appendChild(ui.table(
            [
              { label: 'Form', key: 'label' },
              { label: 'Signed By', value: f => f.signers.length ? f.signers.map(s => `${s.label} (${meta.signerRoles[s.role]})`).join(' + ') : 'By hand (outside the system)' }
            ],
            list,
            [{ label: 'Change', onClick: f => editSigners(f) }]
          ));
        });
      }
      async function editSigners(form) {
        const rows = el('div', { class: 'signer-rows' });
        function addRow(line) {
          const role = el('select', null, Object.entries(meta.signerRoles).map(([k, v]) => el('option', { value: k }, v)));
          const label = el('input', { type: 'text', placeholder: 'Printed label, e.g. Judge' });
          role.value = line ? line.role : 'judge';
          label.value = line ? line.label : meta.signerRoles[role.value];
          role.addEventListener('change', () => { if (!label.value || Object.values(meta.signerRoles).includes(label.value)) label.value = meta.signerRoles[role.value]; });
          const row = el('div', { class: 'signer-row' }, [role, label, el('button', { class: 'btn btn--ghost btn--small', type: 'button', onclick: () => row.remove() }, '✕')]);
          row.get = () => ({ role: role.value, label: label.value.trim() });
          rows.appendChild(row);
        }
        form.signers.forEach(addRow);
        const body = el('div', null, [
          el('p', { class: 'muted' }, 'Add one line per signature on the printed form. Remove every line if the form is signed by hand.'),
          rows,
          el('button', { class: 'btn btn--ghost btn--small', type: 'button', onclick: () => (rows.children.length < 4 ? addRow() : ui.toast('At most 4 signature lines.', 'error')) }, '+ Add signature line')
        ]);
        await ui.modal('Signing Rule: ' + form.label, body, {
          confirmText: 'Save',
          onConfirm: async () => {
            const signers = Array.from(rows.children).map(r => r.get());
            if (signers.some(s => !s.label)) { ui.toast('Every line needs a label.', 'error'); return undefined; }
            await api.put(`/admin/forms/${form.formType}/signers`, { signers });
            await window.App.workflow.meta(true);
            ui.toast('Signing rule saved.', 'success');
            renderSigning();
            return true;
          }
        });
      }

      // ── AUDIT LOG ──
      async function renderAudit() {
        ui.clear(panel);
        const username = el('input', { type: 'search', class: 'search-input', placeholder: 'Filter by username' });
        const action = el('select', { class: 'sort-select' }, ['', 'login', 'login_failed', 'record_created', 'record_submitted', 'record_approved', 'record_finalized', 'record_returned', 'record_revoked', 'record_printed', 'record_deleted', 'user_created', 'user_updated', 'password_reset', 'signature_registered', 'form_signers_updated', 'backup_exported']
          .map(a => el('option', { value: a }, a ? a.replace(/_/g, ' ') : 'All actions')));
        const out = el('div');
        async function load() {
          const { entries } = await api.get('/admin/audit' + api.qs({ username: username.value.trim(), action: action.value, limit: 300 }));
          ui.clear(out);
          if (!entries.length) { out.appendChild(ui.empty('No entries.')); return; }
          out.appendChild(ui.table([
            { label: 'When', value: e => ui.fmtDate(e.at) },
            { label: 'User', value: e => e.username || '—' },
            { label: 'Action', value: e => e.action.replace(/_/g, ' ') },
            { label: 'Unit', value: e => e.unitKey || '' },
            { label: 'Details', value: e => e.details ? Object.entries(e.details).filter(([k]) => !['slots', 'signers'].includes(k)).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ') : '' },
            { label: 'IP', value: e => e.ip || '' }
          ], entries, null));
        }
        username.addEventListener('change', load);
        action.addEventListener('change', load);
        panel.append(el('div', { class: 'filter-bar' }, [username, action]), out);
        load();
      }

      // ── PROCESS REGISTRY: number prefix, case types, fee schedule, EFCC courts ──
      async function renderProcess() {
        ui.clear(panel);
        const s = await api.get('/process/settings');
        const prefix = el('input', { type: 'text', value: s.prefix, maxlength: '6', class: 'narrow', 'aria-label': 'Number prefix' });
        const rowsOf = (items, make) => { const box = el('div', { class: 'settings-rows' }); items.forEach(x => box.appendChild(make(x))); return box; };
        const removable = (cells) => { const row = el('div', { class: 'settings-row' }, cells); row.appendChild(el('button', { class: 'btn btn--small btn--ghost', type: 'button', onclick: () => row.remove() }, '✕')); return row; };
        const bookPick = (b) => { const sel = el('select', { 'data-f': 'book', 'aria-label': 'Register book' }, [el('option', { value: 'civil' }, 'Civil Register'), el('option', { value: 'criminal' }, 'Criminal Register')]); sel.value = b === 'criminal' ? 'criminal' : 'civil'; return sel; };
        const typeRow = (t) => { const r = removable([el('input', { type: 'text', value: t.label, placeholder: 'Case type, e.g. Motion', 'data-f': 'label' }),
          el('input', { type: 'text', value: t.suffix, placeholder: 'Letter', maxlength: '3', class: 'narrow', 'data-f': 'suffix' }),
          bookPick(t.book)]); r.dataset.key = t.key || ''; return r; };
        const feeRow = (f) => removable([el('input', { type: 'text', value: f.item, placeholder: 'Fee, e.g. Writ of summons', 'data-f': 'item' }),
          el('input', { type: 'number', min: '0', step: '0.01', value: f.amount === undefined ? '' : String(f.amount), placeholder: 'Amount (₦)', class: 'narrow', 'data-f': 'amount' })]);
        const types = rowsOf(s.caseTypes, typeRow), fees = rowsOf(s.fees, feeRow);
        const efcc = el('div', { class: 'checks' }, s.courts.map(c => {
          const box = el('input', { type: 'checkbox', value: c.key }); box.checked = s.efccCourts.includes(c.key);
          return el('label', { class: 'check' }, [box, ` High Court No. ${c.roman}`]);
        }));
        const partyEmails = el('input', { type: 'checkbox' }); partyEmails.checked = s.partyEmails !== false;
        const receiptRequired = el('input', { type: 'checkbox' }); receiptRequired.checked = s.receiptRequired !== false;
        const paymentNote = el('textarea', { rows: 3, maxlength: '1000', placeholder: 'e.g. Pay at the cash office, Gombe State High Court, or into account number ..., account name ..., bank ...' }, s.paymentNote || '');
        const name = (k) => (s.courts.find(c => c.key === k) || { name: 'none yet' }).name;
        const read = (box, fields) => [...box.querySelectorAll('.settings-row')].map(r => Object.assign({ key: r.dataset.key }, ...fields.map(f => ({ [f]: r.querySelector(`[data-f="${f}"]`).value }))));
        panel.append(
          el('p', { class: 'muted' }, 'How new cases are numbered, the filing fees staff choose from, the invoice and receipt, and which courts hear EFCC matters.'),
          el('h3', null, 'Suit numbers'),
          el('div', { class: 'settings-row' }, [el('span', null, 'Prefix'), prefix, el('span', { class: 'muted' }, `Numbers read ${s.prefix}/1/${new Date().getFullYear()}; each type counts on its own and starts again at 1 each year.`)]),
          el('h3', null, 'Case types and their letter'), el('p', { class: 'muted' }, 'The letter is printed raised after the number (Criminal: GM/45c/2026). Leave it empty for one type only (Civil). Each type goes in the Civil or the Criminal register book of the court.'),
          types, el('button', { class: 'btn btn--small btn--ghost', type: 'button', onclick: () => types.appendChild(typeRow({ label: '', suffix: '', book: 'civil' })) }, '+ Add case type'),
          el('h3', null, 'Fee schedule'), el('p', { class: 'muted' }, 'Staff pick fees from this list when filing; the total is worked out for them. Official cases have no fee.'),
          fees, el('button', { class: 'btn btn--small btn--ghost', type: 'button', onclick: () => fees.appendChild(feeRow({ item: '' })) }, '+ Add fee'),
          el('h3', null, 'Invoice and receipt'),
          el('label', { class: 'form-field form-field--full' }, [el('span', { class: 'form-field__label' }, 'Payment details printed on the invoice'), paymentNote]),
          el('label', { class: 'check check--plain' }, [receiptRequired, ' The receipt file must be uploaded before a case is registered (untick to make the upload optional; the receipt number is still needed)']),
          el('h3', null, 'Email updates to parties and counsel'),
          el('label', { class: 'check check--plain' }, [partyEmails, ' Email the parties and counsel (where addresses are given at filing) when the invoice is issued, the case is registered, assigned and the file received']),
          el('h3', null, 'Courts that hear EFCC matters'), efcc,
          el('p', { class: 'muted' }, `Rotation: the last ordinary case was proposed for ${name(s.rotation.ordinaryLast)}; the last EFCC matter for ${name(s.rotation.efccLast)}.`),
          el('div', { class: 'card__actions' }, [el('button', { class: 'btn btn--primary', onclick: async () => {
            try {
              await api.put('/process/settings', {
                prefix: prefix.value, caseTypes: read(types, ['label', 'suffix', 'book']).filter(t => t.label.trim()),
                fees: read(fees, ['item', 'amount']).filter(f => f.item.trim()).map(f => ({ item: f.item, amount: Number(f.amount) })),
                efccCourts: [...efcc.querySelectorAll('input:checked')].map(b => b.value),
                receiptRequired: receiptRequired.checked, partyEmails: partyEmails.checked, paymentNote: paymentNote.value
              });
              ui.toast('Process Registry settings saved.', 'success');
              renderProcess();
            } catch (e) { ui.toast(e.message, 'error', 7000); }
          } }, 'Save')])
        );
      }

      const tabDefs = [
        ['Users', renderUsers], ['Units', renderUnits], ['Form Access', renderFormAccess],
        ['Signing Rules', renderSigning], ['Process Registry', renderProcess], ['Audit Log', renderAudit]
      ];
      tabDefs.forEach(([name, fn], i) => {
        const btn = el('button', { class: 'tab' + (i === 0 ? ' is-active' : ''), role: 'tab', onclick: () => {
          tabsBar.querySelectorAll('.tab').forEach(t => t.classList.remove('is-active'));
          btn.classList.add('is-active');
          fn().catch(e => ui.toast(e.message, 'error'));
        } }, name);
        tabsBar.appendChild(btn);
      });
      await renderUsers();
    }
  };
})();
