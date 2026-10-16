/*
 * modules/dashboard.js — Home / Dashboard
 * Unit users: greeting, record stats, quick-access form buttons.
 * Admins:     full control centre with stats, unit health, global records
 *             browser (search + filter + sort), quick links, and backup export.
 */
(function () {
  window.App = window.App || {};

  const STORES = {
    registry:  'registry_records',
    appeals:   'appeals_records',
    execution: 'execution_records'
  };

  function timeAgo(ts) {
    const m = Math.floor((Date.now() - ts) / 60000);
    if (m < 1)   return 'just now';
    if (m < 60)  return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24)  return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 7)   return `${d}d ago`;
    return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  window.App.dashboard = {
    async render(container, ctx) {
      const { ui, db, permissions, user } = ctx;
      const isAdmin = user.role === 'admin';

      const hour = new Date().getHours();
      const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
      const today = new Date().toLocaleDateString('en-GB', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      });

      const allUnits = await db.getAll('units');
      const myUnit   = user.unitKey ? allUnits.find(u => u.key === user.unitKey) : null;
      const unitLabel = myUnit ? myUnit.name
        : (isAdmin ? 'System Administrator' : '—');

      const dash = ui.el('div', { class: 'dashboard' });

      // ── Welcome banner ──
      dash.appendChild(ui.el('div', { class: 'dash-welcome' }, [
        ui.el('h1', null, `${greeting}, ${user.fullName}`),
        ui.el('p',  { class: 'dash-sub' }, `${unitLabel}  ·  ${today}`)
      ]));

      if (isAdmin) {
        await renderAdmin(dash, ui, db, allUnits, user);
      } else {
        await renderUnitUser(dash, ui, db, myUnit, user, permissions);
      }

      container.appendChild(dash);
    }
  };

  /* ================================================================
   * UNIT USER DASHBOARD
   * ================================================================ */
  async function renderUnitUser(dash, ui, db, myUnit, user, permissions) {
    let total = 0, drafts = 0, finals = 0;
    if (myUnit) {
      const store   = STORES[myUnit.type];
      const records = store ? await db.getByIndex(store, 'unitKey', user.unitKey) : [];
      total  = records.length;
      drafts = records.filter(r => r.status === 'draft').length;
      finals = records.filter(r => r.status === 'final').length;
    }

    dash.appendChild(ui.el('div', { class: 'dash-cards' }, [
      card(ui, '📋', total,  'Total Records'),
      card(ui, '✏️',  drafts, 'Pending Drafts'),
      card(ui, '✅', finals, 'Finalised')
    ]));

    if (myUnit && permissions.can('create', user)) {
      const allForms = window.App.allForms || {};
      const modForms = myUnit.allowedForms
        ? myUnit.allowedForms.reduce((o, k) => { if (allForms[k]) o[k] = allForms[k]; return o; }, {})
        : ((window.App.modules[myUnit.type] || {}).forms || {});

      const keys = Object.keys(modForms);
      if (keys.length) {
        const grid = ui.el('div', { class: 'dash-form-grid' });
        keys.forEach(key => {
          grid.appendChild(ui.el('button', {
            class: 'dash-form-btn',
            onclick: () => window.App.router.loadUnitWithForm(myUnit, key)
          }, modForms[key].label));
        });
        dash.appendChild(section(ui, 'Quick Access — ' + myUnit.name, grid));
      }
    }
  }

  /* ================================================================
   * ADMIN DASHBOARD
   * ================================================================ */
  async function renderAdmin(dash, ui, db, allUnits, user) {
    // Fetch all records from all stores
    const allUsers   = await db.getAll('users');
    const regRecs    = await db.getAll(STORES.registry);
    const appRecs    = await db.getAll(STORES.appeals);
    const exeRecs    = await db.getAll(STORES.execution);
    const allRecords = [...regRecs, ...appRecs, ...exeRecs];

    const total   = allRecords.length;
    const drafts  = allRecords.filter(r => r.status === 'draft').length;
    const finals  = allRecords.filter(r => r.status === 'final').length;

    // ── Summary stats ──
    dash.appendChild(ui.el('div', { class: 'dash-cards' }, [
      card(ui, '📋', total,           'Total Records'),
      card(ui, '✏️',  drafts,          'Pending Drafts'),
      card(ui, '✅', finals,          'Finalised'),
      card(ui, '👤', allUsers.length, 'Users'),
      card(ui, '🏛', allUnits.length, 'Units')
    ]));

    // ── Quick links ──
    const linkBar = ui.el('div', { class: 'dash-links' });
    [
      ['⚙ Users',       () => openSettingsTab(0)],
      ['🏛 Units',       () => openSettingsTab(1)],
      ['🔑 Form Access', () => openSettingsTab(2)]
    ].forEach(([label, fn]) => {
      linkBar.appendChild(ui.el('button', { class: 'btn btn--ghost dash-link-btn', onclick: fn }, label));
    });
    dash.appendChild(section(ui, 'Quick Links', linkBar));

    // ── Unit health ──
    const unitHealthWrap = ui.el('div', { class: 'dash-unit-health' });
    allUnits.forEach(u => {
      const store = STORES[u.type];
      const uRecs = allRecords.filter(r => r.unitKey === u.key);
      const uDraft = uRecs.filter(r => r.status === 'draft').length;
      const pct    = uRecs.length ? Math.round((uDraft / uRecs.length) * 100) : 0;
      const bar    = ui.el('div', { class: 'dash-health-bar' }, [
        ui.el('div', { class: 'dash-health-fill' + (uDraft > 0 ? ' has-drafts' : ''),
          style: `width: ${pct}%` })
      ]);
      unitHealthWrap.appendChild(ui.el('div', { class: 'dash-health-row' }, [
        ui.el('span', { class: 'dash-health-name' }, u.name),
        ui.el('span', { class: 'dash-health-counts' },
          `${uRecs.length} records · ${uDraft} draft${uDraft !== 1 ? 's' : ''}`),
        bar
      ]));
    });
    dash.appendChild(section(ui, 'Unit Health', unitHealthWrap));

    // ── Global records browser ──
    const allForms = window.App.allForms || {};
    const unitMap  = Object.fromEntries(allUnits.map(u => [u.key, u.name]));

    // Annotate records with their unit type store source
    const tagged = allRecords.map(r => ({ ...r, _unitName: unitMap[r.unitKey] || r.unitKey }));

    let filterStatus = 'all';
    let filterUnit   = 'all';
    let searchTerm   = '';
    let sortMode     = 'newest';
    let records      = tagged;

    const searchInput = ui.el('input', {
      type: 'text', class: 'search-input',
      placeholder: '🔍  Search form, suit no., party, creator…',
      oninput: e => { searchTerm = e.target.value.toLowerCase(); renderTable(); }
    });

    const statusBtns = {};
    const statusWrap = ui.el('div', { class: 'filter-btns' });
    ['all', 'draft', 'final'].forEach(s => {
      const b = ui.el('button', {
        class: 'btn btn--small filter-btn' + (s === 'all' ? ' filter-btn--active' : ''),
        onclick: () => {
          filterStatus = s;
          Object.values(statusBtns).forEach(b2 => b2.classList.remove('filter-btn--active'));
          statusBtns[s].classList.add('filter-btn--active');
          renderTable();
        }
      }, { all: 'All', draft: 'Drafts', final: 'Finalised' }[s]);
      statusBtns[s] = b;
      statusWrap.appendChild(b);
    });

    const unitSel = ui.el('select', { class: 'sort-select',
      onchange: e => { filterUnit = e.target.value; renderTable(); }
    }, [
      ui.el('option', { value: 'all' }, 'All Units'),
      ...allUnits.map(u => ui.el('option', { value: u.key }, u.name))
    ]);

    const sortSel = ui.el('select', { class: 'sort-select',
      onchange: e => { sortMode = e.target.value; renderTable(); }
    }, [
      ui.el('option', { value: 'newest' }, 'Newest First'),
      ui.el('option', { value: 'oldest' }, 'Oldest First'),
      ui.el('option', { value: 'formtype' }, 'Form Type A–Z')
    ]);

    const exportAllBtn = ui.el('button', { class: 'btn btn--ghost', title: 'Export all records as JSON backup',
      onclick: () => {
        const blob = new Blob([JSON.stringify(allRecords, null, 2)], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url;
        a.download = `GSHC_full_backup_${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        window.App.ui.toast(`Exported ${allRecords.length} records.`, 'success');
      }
    }, '⬇ Backup All');

    // unitKey -> store, derived from the actual unit configuration
    const unitKeyToStore = Object.fromEntries(allUnits.map(u => [u.key, STORES[u.type]]));

    const importAllInput = ui.el('input', { type: 'file', accept: '.json', style: 'display:none' });
    importAllInput.onchange = async () => {
      const file = importAllInput.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (!Array.isArray(data)) { ui.toast('Invalid backup file format.', 'error'); return; }
        let count = 0, skipped = 0;
        for (const rec of data) {
          const targetStore = unitKeyToStore[rec.unitKey];
          if (!targetStore) { skipped++; continue; } // unit no longer exists on this system
          const { id, ...rest } = rec; // strip old id so a fresh one is assigned
          await db.add(targetStore, rest);
          count++;
        }
        ui.toast(`Restored ${count} record(s).` + (skipped ? ` ${skipped} skipped (unit not found).` : ''), 'success');
        window.App.router.loadModule('dashboard', null); // refresh the dashboard
      } catch (err) {
        ui.toast('Could not restore backup: ' + (err.message || 'invalid JSON'), 'error');
      }
      importAllInput.value = '';
    };
    const importAllBtn = ui.el('button', { class: 'btn btn--ghost',
      title: 'Restore records from a full system backup JSON file',
      onclick: () => importAllInput.click()
    }, '⬆ Restore All');

    const countLbl  = ui.el('div', { class: 'record-count' });
    const tableWrap = ui.el('div');

    function renderTable() {
      let recs = [...tagged];
      if (filterStatus !== 'all') recs = recs.filter(r => r.status === filterStatus);
      if (filterUnit   !== 'all') recs = recs.filter(r => r.unitKey === filterUnit);
      if (searchTerm) {
        recs = recs.filter(r => [
          allForms[r.formType]?.label || r.formType,
          r.ref || '', r.summary || '', r.createdBy || '', r._unitName || ''
        ].join(' ').toLowerCase().includes(searchTerm));
      }
      if (sortMode === 'newest')   recs.sort((a, b) => b.createdAt - a.createdAt);
      else if (sortMode === 'oldest') recs.sort((a, b) => a.createdAt - b.createdAt);
      else recs.sort((a, b) => (allForms[a.formType]?.label || a.formType)
                               .localeCompare(allForms[b.formType]?.label || b.formType));

      countLbl.textContent = recs.length === tagged.length
        ? `${tagged.length} record${tagged.length !== 1 ? 's' : ''} system-wide`
        : `${recs.length} of ${tagged.length} records`;

      ui.clear(tableWrap);
      if (!recs.length) {
        tableWrap.appendChild(ui.el('p', { class: 'muted' }, 'No records match your search.'));
        return;
      }
      const recent = recs.slice(0, 50); // cap at 50 rows on dashboard
      tableWrap.appendChild(ui.table(
        [
          { label: 'Form',      value: r => allForms[r.formType]?.label || r.formType },
          { label: 'Unit',      value: r => r._unitName || '—' },
          { label: 'Reference', value: r => r.ref || '—' },
          { label: 'Party / Title', value: r => r.summary || '—' },
          { label: 'Created By', value: r => r.createdBy || '—' },
          { label: 'When',      value: r => timeAgo(r.createdAt) },
          { label: 'Status',    value: () => '' }
        ],
        recent, []
      ));
      // inject status badges
      const trs = tableWrap.querySelectorAll('tbody tr');
      recent.forEach((r, i) => {
        const td = trs[i]?.children[6];
        if (td) { ui.clear(td); td.appendChild(ui.statusBadge(r.status)); }
      });
      if (recs.length > 50) {
        tableWrap.appendChild(ui.el('p', { class: 'muted' },
          `Showing 50 of ${recs.length} matching records. Use filters or search to narrow down.`));
      }
    }

    const filterRow = ui.el('div', { class: 'filter-bar' },
      [searchInput, statusWrap, unitSel, sortSel, exportAllBtn, importAllBtn, importAllInput]);

    const browserWrap = ui.el('div', null, [filterRow, countLbl, tableWrap]);
    dash.appendChild(section(ui, 'Records Browser', browserWrap));
    renderTable();
  }

  /* ── helpers ── */
  function card(ui, icon, value, label) {
    return ui.el('div', { class: 'dash-card' }, [
      ui.el('div', { class: 'dash-card__icon'  }, icon),
      ui.el('div', { class: 'dash-card__value' }, String(value)),
      ui.el('div', { class: 'dash-card__label' }, label)
    ]);
  }
  function section(ui, title, bodyNode) {
    return ui.el('div', { class: 'dash-section' }, [
      ui.el('h2', { class: 'dash-section__title' }, title),
      bodyNode
    ]);
  }
  function openSettingsTab(index) {
    window.App.router.loadModule('settings', null);
    // Let settings render, then click the nth tab
    setTimeout(() => {
      const tabs = document.querySelectorAll('.tabs .tab');
      if (tabs[index]) tabs[index].click();
    }, 80);
  }

})();
