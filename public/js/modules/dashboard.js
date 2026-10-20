/*
 * modules/dashboard.js — Home.
 * Everyone: greeting, what needs their attention, latest notifications.
 * Unit staff: their unit's numbers and quick links to each form.
 * Administrators: system overview, per unit numbers and the backups.
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

  const when = (d) => new Date(d).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  const size = (n) => n == null ? '' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

  // The automatic daily backup: how it stands, the files kept, Back up now.
  async function renderBackups(box, ctx) {
    const { ui, api } = ctx;
    let info;
    try { info = await api.get('/admin/backups'); }
    catch (e) { box.replaceChildren(ui.el('p', { class: 'muted' }, 'Backup details are not available offline.')); return; }
    const last = info.backups.find(b => b.ok);
    const failed = info.backups[0] && !info.backups[0].ok ? info.backups[0] : null;
    const kids = [];
    if (!info.enabled) {
      kids.push(ui.el('div', { class: 'notice notice--warn' }, 'Automatic backups are OFF because Cloudinary is not set up on the server (CLOUDINARY_URL). Use the download below until it is.'));
    } else {
      kids.push(ui.el('p', null, last
        ? `Last backup: ${when(last.at)} (${last.records} records). A backup is made every day and kept ${info.keepDays} days, in ${info.where}. Signed copies backed up: ${info.copiesSaved} of ${info.copies}.`
        : `No backup has been made yet. One is made every day and kept ${info.keepDays} days, in ${info.where}.`));
      if (failed) kids.push(ui.el('div', { class: 'notice notice--warn' }, `The latest backup, at ${when(failed.at)}, failed: ${failed.error}. The system tries again every hour.`));
    }
    const runBtn = ui.el('button', { class: 'btn btn--primary', disabled: info.enabled ? null : true, onclick: async () => {
      runBtn.disabled = true; runBtn.textContent = 'Backing up…';
      try { await api.post('/admin/backups', {}); ui.toast('Backup saved.', 'success'); }
      catch (e) { ui.toast(e.message, 'error', 8000); }
      renderBackups(box, ctx);
    } }, '⟳ Back up now');
    kids.push(ui.el('div', { class: 'dash-links' }, [
      runBtn,
      ui.el('a', { class: 'btn btn--ghost', href: '/api/admin/export', download: '' }, '⬇ Download all records now (JSON)')
    ]));
    const kept = info.backups.filter(b => b.ok).slice(0, 10);
    if (kept.length) {
      kids.push(ui.table([
        { label: 'Made', value: b => when(b.at) },
        { label: 'How', value: b => b.reason === 'manual' ? `Back up now (${b.by || ''})` : 'Daily' },
        { label: 'Records', value: b => b.records ?? '' },
        { label: 'New signed copies', value: b => b.copiesAdded || 0 },
        { label: 'Size', value: b => size(b.bytes) }
      ], kept, [{ label: '⬇ Download', onClick: b => {
        const a = ui.el('a', { href: `/api/admin/backups/${b.id}/download`, download: '' });
        document.body.appendChild(a); a.click(); a.remove();
      } }]));
    }
    box.replaceChildren(...kids);
  }

  // Before going live: clear the documents made while testing, once. The
  // section disappears for good once it has been used.
  async function renderTestData(dash, ctx) {
    const { ui, api } = ctx;
    let st;
    try { st = await api.get('/admin/test-data'); } catch (e) { return; }
    if (!st.available) return;
    const c = st.counts;
    const open = () => {
      const word = ui.el('input', { type: 'text', autocomplete: 'off', 'aria-label': 'Confirmation' });
      ui.modal('Clear Test Data', ui.el('div', null, [
        ui.el('div', { class: 'notice notice--warn' }, `This permanently removes all ${c.records} form(s) in the system (${c.signed} of them signed), their saved copies and notifications, and their entries in Reports. It can be done once only.`),
        ui.el('p', null, 'Kept: users, units, form access, signing rules, signatures and PINs. A backup of everything is made first; if it fails, nothing is cleared.'),
        ui.el('p', null, 'QR codes on printed test documents will then show "Not found".'),
        ui.field(`Type ${st.confirmWord} to confirm`, word)
      ]), {
        confirmText: 'Clear Test Data', confirmClass: 'btn--danger',
        onConfirm: async () => {
          if (word.value.trim().toUpperCase() !== st.confirmWord) { ui.toast(`Type ${st.confirmWord} to confirm.`, 'error'); return undefined; }
          const r = await api.post('/admin/test-data/clear', { confirm: word.value });
          ui.toast(`Test data cleared: ${r.counts.records} form(s) removed. A backup was saved first.`, 'success', 8000);
          window.App.router.loadDashboard();
          return true;
        }
      });
    };
    dash.appendChild(section(ui, 'Before Going Live', ui.el('div', null, [
      ui.el('p', null, `The system holds ${c.records} form(s) (${c.signed} signed). If these were made while testing, clear them once before staff start using the system for real cases, so test documents and their QR codes do not pass as genuine.`),
      ui.el('div', { class: 'dash-links' }, [ui.el('button', { class: 'btn btn--danger', onclick: open }, '🗑 Clear Test Data')])
    ])));
  }

  // Court dates fixed in signed documents, soonest first.
  async function renderHearings(box, ctx, showUnit) {
    const { ui, workflow: wf } = ctx;
    let r;
    try { r = await ctx.api.get('/hearings?days=14'); } catch (e) { box.remove(); return; }
    const all = r.hearings;
    if (!all.length) { box.replaceChildren(ui.el('p', { class: 'muted' }, 'No court dates in the next 14 days in signed documents.')); return; }
    const dayLabel = (s) => {
      const d = new Date(s + 'T00:00:00');
      const t = new Date(); t.setHours(0, 0, 0, 0);
      const diff = Math.round((d - t) / 86400000);
      const name = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      return diff === 0 ? `Today, ${name}` : diff === 1 ? `Tomorrow, ${name}` : name;
    };
    const shown = all.slice(0, 50);
    box.replaceChildren(
      ui.table([
        { label: 'Day', value: h => dayLabel(h.date) },
        { label: 'Time', value: h => h.time || '' },
        { label: 'Case No.', value: h => h.caseNo },
        { label: 'Parties', value: h => h.parties },
        { label: 'What', value: h => h.what },
        ...(showUnit ? [{ label: 'Unit', value: h => h.unitName }] : [])
      ], shown, [{ label: 'Open', onClick: h => wf.openDocument(h.id) }]),
      ...(all.length > shown.length ? [ui.el('p', { class: 'muted' }, `Showing the first ${shown.length} of ${all.length}.`)] : [])
    );
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

      // ── Upcoming court dates (the user's courts; every unit for admins) ──
      if (stats && (isAdmin || user.unitKeys.length)) {
        const box = ui.el('div');
        dash.appendChild(section(ui, 'Upcoming Court Dates · next 14 days', box));
        renderHearings(box, ctx, isAdmin || user.unitKeys.length > 1);
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
        const backups = ui.el('div');
        dash.appendChild(section(ui, 'Backups', backups));
        renderBackups(backups, ctx);
        renderTestData(dash, ctx);
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
            else if (n.kind === 'case' && n.link) {
              // A case notice opens its screen: assignment, the Process Registry or a court's register.
              if (n.link === 'assign') router.loadModule('assign');
              else if (n.link.startsWith('register:')) { const u = units.find(x => x.key === n.link.slice(9)); if (u) router.loadModule('caseRegister', { unit: u }); }
              else { const u = units.find(x => x.type === 'process'); if (u) router.loadUnit(u); }
            }
          } }, [
            ui.el('span', { class: 'note__kind note__kind--' + n.kind }, { submitted: 'For signature', approved: 'Approved', signed: 'Signed', returned: 'Returned', revoked: 'Revoked', case: 'Case' }[n.kind] || n.kind),
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
