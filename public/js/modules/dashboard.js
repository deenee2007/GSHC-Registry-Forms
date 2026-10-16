/*
 * modules/dashboard.js — Home.
 * Everyone: greeting, what needs their attention, latest notifications.
 * Unit staff: their unit's numbers and quick links to each form.
 * Administrators: system overview, per unit numbers and a records backup.
 */
(function () {
  window.App = window.App || {};

  function card(ui, value, label, mod, onclick) {
    return ui.el(onclick ? 'button' : 'div', { class: 'dash-card' + (mod ? ' ' + mod : ''), onclick, type: onclick ? 'button' : null }, [
      ui.el('div', { class: 'dash-card__num' }, String(value)),
      ui.el('div', { class: 'dash-card__label' }, label)
    ]);
  }
  function section(ui, title, body) {
    return ui.el('div', { class: 'dash-section' }, [ui.el('h2', null, title), body]);
  }

  window.App.dashboard = {
    async render(container, ctx) {
      const { ui, api, permissions, router, workflow: wf, user, offline } = ctx;
      const isAdmin = permissions.isAdmin(user);
      const hour = new Date().getHours();
      const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
      const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      const units = await router.units();
      const dash = ui.el('div', { class: 'dash' });
      container.appendChild(dash);

      const place = units.length === 1 ? units[0].name : isAdmin ? 'System Administrator' : `${units.length} units`;
      dash.appendChild(ui.el('div', { class: 'dash-welcome' }, [
        ui.el('h1', null, `${greeting}, ${[user.title, user.fullName].filter(Boolean).join(' ')}`),
        ui.el('p', { class: 'dash-sub' }, `${place}  ·  ${today}`)
      ]));

      if (offline) dash.appendChild(ui.el('div', { class: 'notice notice--warn' }, 'You are offline. You can open your units and save drafts; they will be sent when the connection returns. Submitting and signing need the internet.'));

      // Signer setup reminder
      if (permissions.isSigner(user) && !(user.hasSignature && user.hasSigningPin)) {
        dash.appendChild(ui.el('div', { class: 'notice notice--warn' }, [
          'Your signature or signing PIN is not set up yet, so you cannot sign forms. ',
          ui.el('button', { class: 'btn btn--small btn--primary', onclick: () => router.loadModule('signature') }, 'Set up My Signature')
        ]));
      }

      let stats = null;
      try { stats = await api.get('/records/stats'); } catch (e) { /* offline */ }

      // ── What needs attention ──
      if (stats) {
        const row = ui.el('div', { class: 'dash-stats' });
        if (permissions.isSigner(user)) row.appendChild(card(ui, stats.inbox, 'Awaiting My Signature', stats.inbox ? 'dash-card--warn' : '', () => router.loadModule('inbox')));
        if (isAdmin || permissions.can('finalize', user)) {
          row.appendChild(card(ui, stats.approvedUnprinted, 'Approved, Ready to Print', stats.approvedUnprinted ? 'dash-card--ok' : '', () => router.loadModule('submissions', { tab: 'final' })));
        }
        if (!isAdmin) {
          const sum = (k) => Object.values(stats.byUnit).reduce((n, u) => n + u[k], 0);
          row.appendChild(card(ui, sum('draft'), 'Drafts'));
          row.appendChild(card(ui, sum('pending'), 'Awaiting Signature'));
          row.appendChild(card(ui, sum('returned'), 'Returned', sum('returned') ? 'dash-card--warn' : ''));
          row.appendChild(card(ui, sum('final'), 'Signed'));
        }
        if (row.children.length) dash.appendChild(row);
      }

      // ── Quick actions (unit staff) ──
      if (!isAdmin && permissions.can('create', user)) {
        const all = window.App.allForms || {};
        units.forEach(u => {
          const btns = ui.el('div', { class: 'dash-forms' });
          (u.forms || []).forEach(key => {
            if (!all[key]) return;
            btns.appendChild(ui.el('button', { class: 'dash-form-btn', onclick: () => router.loadUnitWithForm(u, key) }, all[key].label));
          });
          if (btns.children.length) dash.appendChild(section(ui, `New Form · ${u.name}`, btns));
        });
      }

      // ── Administrator overview ──
      if (isAdmin && stats) {
        let sys = null;
        try { sys = await api.get('/admin/stats'); } catch (e) { /* ignore */ }
        if (sys) {
          const row = ui.el('div', { class: 'dash-stats' });
          row.append(
            card(ui, sys.activeUsers, 'Active Users', '', () => router.loadModule('settings')),
            card(ui, sys.signers, 'Signers'),
            card(ui, sys.units, 'Units'),
            card(ui, (sys.records.pending || 0), 'Awaiting Signature', sys.records.pending ? 'dash-card--warn' : ''),
            card(ui, (sys.records.final || 0), 'Signed Documents', 'dash-card--ok')
          );
          dash.appendChild(section(ui, 'System Overview', row));
        }
        const unitRows = units.map(u => ({ unit: u, ...(stats.byUnit[u.key] || {}) }));
        dash.appendChild(section(ui, 'Units', ui.table(
          [
            { label: 'Unit', value: r => r.unit.name },
            { label: 'Drafts', value: r => r.draft || 0 },
            { label: 'Awaiting Signature', value: r => r.pending || 0 },
            { label: 'Returned', value: r => r.returned || 0 },
            { label: 'Signed', value: r => r.final || 0 },
            { label: 'Revoked', value: r => r.revoked || 0 }
          ],
          unitRows,
          [{ label: 'Open', onClick: r => router.loadUnit(r.unit) }]
        )));
        dash.appendChild(section(ui, 'Backup', ui.el('div', { class: 'dash-links' }, [
          ui.el('a', { class: 'btn btn--ghost', href: '/api/admin/export', download: '' }, '⬇ Download all records (JSON)'),
          ui.el('span', { class: 'muted' }, 'MongoDB Atlas also keeps automatic backups of the database.')
        ])));
      }

      // ── Notifications ──
      let notes = null;
      try { notes = await api.get('/notifications'); } catch (e) { /* offline */ }
      if (notes) {
        const list = ui.el('div', { class: 'notes' });
        if (!notes.notifications.length) list.appendChild(ui.empty('No notifications.'));
        notes.notifications.slice(0, 15).forEach(n => {
          list.appendChild(ui.el('button', { class: 'note' + (n.read ? '' : ' note--unread'), onclick: async () => {
            if (!n.read) { await api.post('/notifications/read', { ids: [n.id] }).catch(() => {}); router.refreshBadges(); }
            if (n.record) wf.openDocument(n.record);
          } }, [
            ui.el('span', { class: 'note__kind note__kind--' + n.kind }, { submitted: 'For signature', approved: 'Approved', signed: 'Signed', returned: 'Returned', revoked: 'Revoked' }[n.kind] || n.kind),
            ui.el('span', { class: 'note__msg' }, n.message),
            ui.el('span', { class: 'note__time muted' }, ui.fmtDate(n.createdAt))
          ]));
        });
        const head = ui.el('div', { class: 'notes__head' }, notes.unread ? [
          ui.el('button', { class: 'btn btn--ghost btn--small', onclick: async () => { await api.post('/notifications/read', { all: true }); router.refreshBadges(); router.loadDashboard(); } }, 'Mark all as read')
        ] : []);
        dash.appendChild(section(ui, `Notifications${notes.unread ? ` (${notes.unread} new)` : ''}`, ui.el('div', null, [head, list])));
      }
    }
  };
})();
