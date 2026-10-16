/*
 * modules/settings.js — Admin panel
 * Create users, assign each user to a unit, and grant/revoke action
 * privileges. Also lists the configured units and lets the admin add a
 * court registry if needed. Admin-only (router enforces this).
 */
(function () {
  window.App = window.App || {};
  window.App.modules = window.App.modules || {};

  window.App.modules.settings = {
    id: 'settings',
    async render(container, ctx) {
      const { ui, db, permissions, auth } = ctx;

      container.appendChild(ui.el('div', { class: 'page-head' }, [
        ui.el('h1', null, '⚙  Settings & Administration'),
        ui.el('p', { class: 'muted' }, 'Manage users, unit assignments and privileges')
      ]));

      const tabsBar = ui.el('div', { class: 'tabs' });
      const panel = ui.el('div', { class: 'tab-panel' });
      container.appendChild(tabsBar);
      container.appendChild(panel);

      // ---------- USERS ----------
      async function renderUsers() {
        ui.clear(panel);
        const units = await db.getAll('units');
        const unitName = (k) => (units.find(u => u.key === k) || {}).name || (k ? k : '—');

        panel.appendChild(ui.el('button', { class: 'btn btn--primary', onclick: () => userForm(null, units) }, '+ Add User'));

        const users = await db.getAll('users');
        panel.appendChild(ui.table(
          [
            { label: 'Username', key: 'username' },
            { label: 'Full Name', key: 'fullName' },
            { label: 'Role', value: u => u.role === 'admin' ? 'Administrator' : 'Unit User' },
            { label: 'Unit', value: u => u.role === 'admin' ? 'All' : unitName(u.unitKey) },
            { label: 'Privileges', value: u => u.role === 'admin' ? 'Full' : ((u.privileges || []).join(', ') || 'none') }
          ],
          users,
          [
            { label: 'Edit', onClick: u => userForm(u, units) },
            { label: 'Reset PW', onClick: u => resetPw(u) },
            { label: 'Delete', class: 'btn--danger', show: u => u.username !== auth.current().username, onClick: u => delUser(u) }
          ]
        ));
      }

      async function userForm(existing, units) {
        const wrap = ui.el('div', { class: 'form-grid' });
        const v = existing || {};

        const username = ui.el('input', { type: 'text', value: v.username || '', disabled: existing ? 'disabled' : null });
        const fullName = ui.el('input', { type: 'text', value: v.fullName || '' });
        const role = ui.el('select', null, [ui.el('option', { value: 'user' }, 'Unit User'), ui.el('option', { value: 'admin' }, 'Administrator')]);
        role.value = v.role || 'user';
        const unitSel = ui.el('select', null, units.map(u => ui.el('option', { value: u.key }, u.name)));
        if (v.unitKey) unitSel.value = v.unitKey;

        // Privilege checkboxes
        const privBoxes = {};
        const privWrap = ui.el('div', { class: 'checks' });
        permissions.ACTIONS.forEach(a => {
          const cb = ui.el('input', { type: 'checkbox' });
          if ((v.privileges || []).includes(a)) cb.checked = true;
          privBoxes[a] = cb;
          privWrap.appendChild(ui.el('label', { class: 'check' }, [cb, ' ' + a]));
        });

        const unitRow = ui.el('label', { class: 'form-field form-field--full' }, [ui.el('span', { class: 'form-field__label' }, 'Assigned Unit'), unitSel]);
        const privRow = ui.el('label', { class: 'form-field form-field--full' }, [ui.el('span', { class: 'form-field__label' }, 'Privileges (within unit)'), privWrap]);

        function syncRole() { const show = role.value === 'user'; unitRow.style.display = show ? '' : 'none'; privRow.style.display = show ? '' : 'none'; }
        role.addEventListener('change', syncRole);

        [['Username', username], ['Full Name', fullName], ['Role', role]].forEach(([label, input]) =>
          wrap.appendChild(ui.el('label', { class: 'form-field' }, [ui.el('span', { class: 'form-field__label' }, label), input])));
        wrap.appendChild(unitRow); wrap.appendChild(privRow);
        if (!existing) wrap.appendChild(ui.el('p', { class: 'muted form-field--full' }, 'Default password will be "changeme" — user is prompted to change it on first login.'));
        syncRole();

        const formData = await ui.modal(existing ? 'Edit User' : 'Add User', wrap, {
          confirmText: 'Save User',
          onConfirm: () => {
            const uname = username.value.trim();
            const fname = fullName.value.trim();
            if (!uname || !fname) { ui.toast('Username and full name required.', 'error'); return undefined; }
            const r = role.value;
            return {
              username:   uname,
              fullName:   fname,
              role:       r,
              unitKey:    r === 'user' ? unitSel.value : null,
              privileges: r === 'user' ? permissions.ACTIONS.filter(a => privBoxes[a].checked) : []
            };
          }
        });
        if (!formData) return;

        try {
          if (existing) {
            existing.fullName   = formData.fullName;
            existing.role       = formData.role;
            existing.unitKey    = formData.unitKey;
            existing.privileges = formData.privileges;
            await db.put('users', existing);
            ui.toast('User updated.', 'success');
          } else {
            await db.add('users', {
              username:        formData.username,
              fullName:        formData.fullName,
              role:            formData.role,
              unitKey:         formData.unitKey,
              privileges:      formData.privileges,
              passwordHash:    await auth.sha256('changeme'),
              mustChangePassword: true,
              createdAt:       Date.now()
            });
            ui.toast('User created. Default password: changeme', 'success');
          }
          renderUsers();
        } catch (err) {
          ui.toast('Error saving user: ' + (err.message || String(err)), 'error');
        }
      }

      async function resetPw(u) {
        if (!confirm(`Reset ${u.username}'s password to "changeme"?`)) return;
        u.passwordHash = await auth.sha256('changeme'); u.mustChangePassword = true;
        await db.put('users', u); ui.toast('Password reset.', 'success');
      }
      async function delUser(u) {
        if (!confirm(`Delete user ${u.username}?`)) return;
        await db.remove('users', u.id); ui.toast('User deleted.', 'info'); renderUsers();
      }

      // ---------- UNITS ----------
      async function renderUnits() {
        ui.clear(panel);
        const units = await db.getAll('units');
        panel.appendChild(ui.el('button', { class: 'btn btn--primary', onclick: () => addCourt(units) }, '+ Add Court Registry'));
        panel.appendChild(ui.table(
          [
            { label: 'Unit', key: 'name' },
            { label: 'Type', value: u => ({ registry: 'Court Registry', appeals: 'Appeals', execution: 'Execution/Bailiffs' }[u.type]) },
            { label: 'Key', key: 'key' }
          ],
          units, null
        ));
      }
      async function addCourt(units) {
        const nums = units.filter(u => u.type === 'registry').map(u => parseInt((u.key.match(/\d+/) || [0])[0], 10));
        const next = (Math.max(0, ...nums) + 1);
        const wrap = ui.el('div', { class: 'form-grid' });
        const name = ui.el('input', { type: 'text', value: `High Court ${next} Registry` });
        wrap.appendChild(ui.el('label', { class: 'form-field form-field--full' }, [ui.el('span', { class: 'form-field__label' }, 'Registry Name'), name]));
        const ok = await ui.modal('Add Court Registry', wrap, { confirmText: 'Add' });
        if (!ok) return;
        await db.put('units', { key: 'hc' + next, type: 'registry', name: name.value.trim(), courtNo: next });
        ui.toast('Registry added.', 'success'); renderUnits();
      }

      // ---------- FORM ACCESS ----------
      async function renderFormAccess() {
        ui.clear(panel);
        const units = await db.getAll('units');

        panel.appendChild(ui.el('p', { class: 'muted' }, [
          'Configure which forms each unit can access. By default each unit sees only its own module\'s forms. ',
          'You can grant any unit access to forms from other modules — for example giving the Appeals Registry access to Hearing Notice.'
        ]));

        panel.appendChild(ui.table(
          [
            { label: 'Unit', key: 'name' },
            { label: 'Type', value: u => ({ registry: 'Court Registry', appeals: 'Appeals', execution: 'Execution' }[u.type] || u.type) },
            { label: 'Form Access', value: u => u.allowedForms
                ? `${u.allowedForms.length} form(s) configured`
                : 'Default (module forms only)' }
          ],
          units,
          [
            { label: 'Configure', onClick: u => configureFormAccess(u, units) },
            { label: 'Reset', class: 'btn--ghost',
              show: u => !!u.allowedForms,
              onClick: async u => {
                if (!confirm(`Reset ${u.name} to default forms only?`)) return;
                u.allowedForms = null;
                await db.put('units', u);
                ui.toast('Reset to defaults.', 'success');
                renderFormAccess();
              }
            }
          ]
        ));
      }

      async function configureFormAccess(unit) {
        const allByModule = window.App.allFormsByModule || {};
        const typeToModule = { registry: 'Registry', execution: 'Execution', appeals: 'Appeals' };
        const unitModuleName = typeToModule[unit.type] || '';

        const wrap = ui.el('div', { class: 'form-grid' });
        wrap.appendChild(ui.el('p', { class: 'muted form-field--full' },
          `Tick the forms ${unit.name} should be able to use. Forms from its own module are ticked by default.`));

        const checkboxes = {};

        Object.entries(allByModule).forEach(([moduleName, moduleForms]) => {
          wrap.appendChild(ui.el('div', { class: 'form-section form-field--full' }, moduleName + ' Forms'));
          const moduleWrap = ui.el('div', { class: 'checks form-field--full' });

          Object.entries(moduleForms).forEach(([key, def]) => {
            const cb = ui.el('input', { type: 'checkbox' });
            if (unit.allowedForms) {
              cb.checked = unit.allowedForms.includes(key);
            } else {
              // Default: pre-tick unit's own module forms
              cb.checked = (moduleName === unitModuleName);
            }
            checkboxes[key] = cb;
            moduleWrap.appendChild(ui.el('label', { class: 'check' }, [cb, '\u00a0' + def.label]));
          });
          wrap.appendChild(moduleWrap);
        });

        const result = await ui.modal('Form Access: ' + unit.name, wrap, {
          confirmText: 'Save',
          onConfirm: () => {
            const selected = Object.entries(checkboxes)
              .filter(([, cb]) => cb.checked).map(([k]) => k);
            if (!selected.length) {
              ui.toast('Please select at least one form.', 'error');
              return undefined;
            }
            return { forms: selected };
          }
        });

        if (!result) return;
        unit.allowedForms = result.forms;
        await db.put('units', unit);
        ui.toast(`Form access saved: ${result.forms.length} form(s) for ${unit.name}.`, 'success');
        renderFormAccess();
      }

      // ── Build tabs AFTER all functions declared — avoids any hoisting ambiguity ──
      const tabDefs = [
        { name: 'Users',       fn: renderUsers },
        { name: 'Units',       fn: renderUnits },
        { name: 'Form Access', fn: renderFormAccess }
      ];
      tabDefs.forEach(({ name, fn }, i) => {
        const btn = ui.el('button', {
          class: 'tab' + (i === 0 ? ' is-active' : ''),
          onclick: () => {
            tabsBar.querySelectorAll('.tab').forEach(t => t.classList.remove('is-active'));
            btn.classList.add('is-active');
            fn();
          }
        }, name);
        tabsBar.appendChild(btn);
      });
      renderUsers();
    }
  };
})();
