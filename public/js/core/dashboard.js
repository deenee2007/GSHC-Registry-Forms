/*
 * core/dashboard.js — Home / Dashboard view
 * Renders when the user clicks Home or first logs in.
 * Shows: greeting, record counts for the user's unit,
 * quick-launch buttons for each form, and (for admins)
 * a system overview with a link to Settings.
 */
(function () {
  window.App = window.App || {};

  async function render(container, ctx) {
    const { ui, db, auth, permissions } = ctx;
    const user = auth.current();

    const hr   = new Date().getHours();
    const greet = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
    const dateStr = new Date().toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });

    const isAdmin  = permissions.isAdmin(user);
    let userUnit   = null;
    let unitModule = null;

    if (!isAdmin && user.unitKey) {
      const units = await db.getAll('units');
      userUnit   = units.find(u => u.key === user.unitKey) || null;
      unitModule = userUnit ? (window.App.modules || {})[userUnit.type] : null;
    }

    // Record counts for unit user
    let total = 0, drafts = 0, finals = 0;
    if (!isAdmin && userUnit) {
      const store   = userUnit.type + '_records';
      const records = await db.getByIndex(store, 'unitKey', userUnit.key);
      total  = records.length;
      drafts = records.filter(r => r.status === 'draft').length;
      finals = records.filter(r => r.status === 'final').length;
    }

    // Admin counts
    let adminUsers = 0, adminUnits = 0;
    if (isAdmin) {
      adminUsers = (await db.getAll('users')).length;
      adminUnits = (await db.getAll('units')).length;
    }

    const wrap = ui.el('div', { class: 'dash' });

    // ---- Welcome banner ------------------------------------------------
    const roleLabel = isAdmin ? 'Administrator' : (userUnit ? userUnit.name : 'Unit User');
    const banner = ui.el('div', { class: 'dash-welcome' });
    banner.appendChild(ui.el('h1', null, greet + ', ' + user.fullName));
    banner.appendChild(ui.el('p',  null, roleLabel + '  \u00b7  ' + dateStr));
    wrap.appendChild(banner);

    // ---- Record stats (unit users only) --------------------------------
    if (!isAdmin && userUnit) {
      const statsRow = ui.el('div', { class: 'dash-stats' });
      [
        [total,  'Total Records',    ''],
        [drafts, 'Drafts Pending',   'dash-card--warn'],
        [finals, 'Finalized',        'dash-card--ok']
      ].forEach(([num, label, mod]) => {
        const card = ui.el('div', { class: 'dash-card' + (mod ? ' ' + mod : '') });
        card.appendChild(ui.el('div', { class: 'dash-card__num' },   String(num)));
        card.appendChild(ui.el('div', { class: 'dash-card__label' }, label));
        statsRow.appendChild(card);
      });
      wrap.appendChild(statsRow);
    }

    // ---- Quick Actions (unit users only) --------------------------------
    if (!isAdmin && unitModule && unitModule.forms) {
      const section = ui.el('div', { class: 'dash-section' });
      section.appendChild(ui.el('h2', null, 'Quick Actions'));
      const btns = ui.el('div', { class: 'dash-forms' });
      Object.entries(unitModule.forms).forEach(([, def]) => {
        const btn = ui.el('button', { class: 'dash-form-btn',
          onclick: () => window.App.router.loadUnit(userUnit)
        }, def.label);
        btns.appendChild(btn);
      });
      section.appendChild(btns);
      section.appendChild(ui.el('p', { class: 'muted' },
        'Click any form to open ' + (userUnit ? userUnit.name : 'your unit') + ', then use \u201c+ New Entry\u201d to begin.'));
      wrap.appendChild(section);
    }

    // ---- Admin system overview -----------------------------------------
    if (isAdmin) {
      const section = ui.el('div', { class: 'dash-section' });
      section.appendChild(ui.el('h2', null, 'System Overview'));
      const card = ui.el('div', { class: 'dash-admin' });
      const info = ui.el('div', { class: 'dash-admin__stats' });
      const line1 = ui.el('p', null, '');
      line1.innerHTML = '<strong>' + adminUsers + '</strong> user' + (adminUsers !== 1 ? 's' : '') + ' registered';
      const line2 = ui.el('p', null, '');
      line2.innerHTML = '<strong>' + adminUnits + '</strong> unit' + (adminUnits !== 1 ? 's' : '') + ' configured';
      info.appendChild(line1);
      info.appendChild(line2);
      card.appendChild(info);
      card.appendChild(ui.el('button', { class: 'btn btn--primary',
        onclick: () => window.App.router.loadModule('settings', null)
      }, '\u2699\ufe0f  Go to Settings'));
      section.appendChild(card);
      wrap.appendChild(section);
    }

    container.appendChild(wrap);
  }

  window.App.dashboard = { render };
})();
