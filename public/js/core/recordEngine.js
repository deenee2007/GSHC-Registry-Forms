/*
 * core/recordEngine.js — shared engine behind every unit module.
 * Provides: draft→finalize workflow, search, status filter, sort, view, print.
 */
(function () {
  window.App = window.App || {};

  function render(container, ctx, config) {
    const { ui, db, permissions, unit, user } = ctx;
    const { store } = config;
    const can = (a) => permissions.can(a);

    // Build effective forms — use unit.allowedForms if configured, else module defaults
    let forms = config.forms;
    if (unit && unit.allowedForms && unit.allowedForms.length > 0) {
      const all = window.App.allForms || {};
      const filtered = {};
      unit.allowedForms.forEach(key => {
        const def = all[key] || config.forms[key];
        if (def) filtered[key] = def;
      });
      if (Object.keys(filtered).length > 0) forms = filtered;
    }
    const formKeys = Object.keys(forms);

    // ── Page header ──
    container.appendChild(ui.el('div', { class: 'page-head' }, [
      ui.el('h1', null, unit.name),
      ui.el('p', { class: 'muted' }, config.subtitle || '')
    ]));

    // ── New entry toolbar ──
    const formPicker = ui.el('select', { class: 'form-picker' },
      formKeys.map(k => ui.el('option', { value: k }, forms[k].label)));
    const newBtn = ui.el('button', {
      class: 'btn btn--primary',
      disabled: can('create') ? null : 'disabled',
      onclick: () => openForm(formPicker.value)
    }, '+ New Entry');
    const exportBtn = ui.el('button', {
      class: 'btn btn--ghost',
      title: 'Export all records for this unit as a JSON backup file',
      onclick: async () => {
        const records = await db.getByIndex(store, 'unitKey', unit.key);
        if (!records.length) { ui.toast('No records to export.', 'info'); return; }
        const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `${unit.name.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        ui.toast(`Exported ${records.length} record(s).`, 'success');
      }
    }, '⬇ Export');
    const importInput = ui.el('input', { type: 'file', accept: '.json', style: 'display:none' });
    importInput.onchange = async () => {
      const file = importInput.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (!Array.isArray(data)) { ui.toast('Invalid backup file format.', 'error'); return; }
        let count = 0;
        for (const rec of data) {
          const { id, ...rest } = rec; // strip old id so a fresh one is assigned, avoiding key collisions
          rest.unitKey = unit.key;     // re-anchor record to this unit on the new system
          await db.add(store, rest);
          count++;
        }
        ui.toast(`Imported ${count} record(s).`, 'success');
        refresh();
      } catch (err) {
        ui.toast('Could not import file: ' + (err.message || 'invalid JSON'), 'error');
      }
      importInput.value = '';
    };
    const importBtn = ui.el('button', {
      class: 'btn btn--ghost',
      title: 'Import records from a previously exported JSON backup file',
      onclick: () => importInput.click()
    }, '⬆ Import');
    container.appendChild(ui.el('div', { class: 'toolbar' }, [formPicker, newBtn, exportBtn, importBtn, importInput]));

    // ── Search / filter / sort bar ──
    let filterStatus = 'all';
    let searchTerm   = '';
    let sortMode     = 'newest';
    let allRecords   = [];

    const searchInput = ui.el('input', {
      type: 'text', class: 'search-input',
      placeholder: '🔍  Search form, suit no., party…',
      oninput: (e) => { searchTerm = e.target.value.toLowerCase(); renderList(); }
    });

    const statusLabels = { all: 'All', draft: 'Drafts', final: 'Finalised' };
    const filterBtns = {};
    const btnWrap = ui.el('div', { class: 'filter-btns' });
    ['all', 'draft', 'final'].forEach(s => {
      const b = ui.el('button', {
        class: 'btn btn--small filter-btn' + (s === 'all' ? ' filter-btn--active' : ''),
        onclick: () => {
          filterStatus = s;
          Object.values(filterBtns).forEach(b2 => b2.classList.remove('filter-btn--active'));
          filterBtns[s].classList.add('filter-btn--active');
          renderList();
        }
      }, statusLabels[s]);
      filterBtns[s] = b;
      btnWrap.appendChild(b);
    });

    const sortSelect = ui.el('select', { class: 'sort-select',
      onchange: (e) => { sortMode = e.target.value; renderList(); }
    }, [
      ui.el('option', { value: 'newest' }, 'Newest First'),
      ui.el('option', { value: 'oldest' }, 'Oldest First'),
      ui.el('option', { value: 'formtype' }, 'Form Type A–Z')
    ]);

    container.appendChild(ui.el('div', { class: 'filter-bar' }, [searchInput, btnWrap, sortSelect]));

    const countLabel = ui.el('div', { class: 'record-count' }, '');
    const listWrap   = ui.el('div', { class: 'list-wrap' });
    container.appendChild(countLabel);
    container.appendChild(listWrap);

    // ── Render filtered list (client-side — no DB hit) ──
    function renderList() {
      let recs = [...allRecords];

      if (filterStatus !== 'all')
        recs = recs.filter(r => r.status === filterStatus);

      if (searchTerm) {
        recs = recs.filter(r => {
          const hay = [
            forms[r.formType]?.label || r.formType,
            r.ref || '', r.summary || '', r.createdBy || ''
          ].join(' ').toLowerCase();
          return hay.includes(searchTerm);
        });
      }

      if (sortMode === 'newest')   recs.sort((a, b) => b.createdAt - a.createdAt);
      else if (sortMode === 'oldest') recs.sort((a, b) => a.createdAt - b.createdAt);
      else recs.sort((a, b) => (forms[a.formType]?.label || a.formType)
                               .localeCompare(forms[b.formType]?.label || b.formType));

      const total    = allRecords.length;
      const showing  = recs.length;
      countLabel.textContent = total === showing
        ? `${total} record${total !== 1 ? 's' : ''}`
        : `${showing} of ${total} records`;

      ui.clear(listWrap);

      if (!recs.length) {
        listWrap.appendChild(ui.el('p', { class: 'muted' },
          searchTerm || filterStatus !== 'all'
            ? 'No records match your search or filter.'
            : 'No records yet for this unit.'));
        return;
      }

      listWrap.appendChild(ui.table(
        [
          { label: 'Form',         value: r => forms[r.formType]?.label || r.formType },
          { label: 'Reference',    value: r => r.ref || '—' },
          { label: 'Party / Title',value: r => r.summary || '—' },
          { label: 'Date',         value: r => window.App.output
              ? window.App.output.formatDateTime(r.createdAt) : '' },
          { label: 'Status',       value: () => '' }
        ],
        recs,
        [
          { label: 'View',     onClick: r => viewRecord(r) },
          { label: 'Finalize', class: 'btn--ok',
            show: r => r.status === 'draft' && can('finalize'),
            onClick: r => setStatus(r, 'final') },
          { label: 'Delete', class: 'btn--danger',
            show: r => can('delete'), onClick: r => del(r) }
        ]
      ));

      // inject status badges
      const trs = listWrap.querySelectorAll('tbody tr');
      recs.forEach((r, i) => {
        const td = trs[i]?.children[4];
        if (td) { ui.clear(td); td.appendChild(ui.statusBadge(r.status)); }
      });
    }

    // ── Load from DB then render ──
    async function refresh() {
      allRecords = await db.getByIndex(store, 'unitKey', unit.key);
      renderList();
    }

    // ── Helpers ──
    function summarise(def, data) {
      const f = def.schema.find(s => s.full) ||
                def.schema.find(s => /title|party|name|plaintiff|appellant/i.test(s.name));
      return f ? (data[f.name] || '') : '';
    }
    function refOf(def, data) {
      const f = def.schema.find(s => /no\.?$|number|ref|suitno/i.test(s.name) || /No\./i.test(s.label));
      return f ? (data[f.name] || '') : '';
    }

    // ── Open entry form ──
    async function openForm(formType, existing) {
      const def = forms[formType];
      const f   = ui.form(def.schema, existing ? existing.data : null);
      const result = await ui.modal(def.label, f.node, {
        confirmText: 'Save (Draft)',
        onConfirm: () => (f.validate() ? f.getValues() : undefined)
      });
      if (!result) return;
      if (existing) {
        existing.data    = result;
        existing.ref     = refOf(def, result);
        existing.summary = summarise(def, result);
        await db.put(store, existing);
        ui.toast('Record updated.', 'success');
      } else {
        await db.add(store, {
          unitKey: unit.key, formType, status: 'draft',
          ref: refOf(def, result), summary: summarise(def, result),
          data: result, createdAt: Date.now(), createdBy: user.fullName
        });
        ui.toast('Saved as draft.', 'success');
      }
      refresh();
    }

    // ── Preview / view record ──
    function viewRecord(r) {
      const def     = forms[r.formType];
      const docHtml = window.App.output ? window.App.output.render(r, unit.name, def) : '';
      const preview = ui.el('div', { class: 'doc-preview', html: docHtml });
      const actions = ui.el('div', { class: 'doc-preview__actions' }, [
        ui.el('button', { class: 'btn btn--ghost',
          onclick: () => document.querySelector('.modal-overlay')?.remove() }, '✕  Close'),
        (r.status === 'draft' && can('edit'))
          ? ui.el('button', { class: 'btn btn--ghost',
              onclick: () => { document.querySelector('.modal-overlay')?.remove(); openForm(r.formType, r); }
            }, 'Edit Draft')
          : null,
        can('print')
          ? ui.el('button', { class: 'btn btn--primary',
              onclick: () => window.App.output.print(r, unit.name, def) }, '🖨  Print')
          : null
      ]);
      ui.modal(
        def.label + (r.status === 'final' ? '  ·  LOCKED' : '  ·  DRAFT'),
        ui.el('div', null, [actions, preview]),
        { noFooter: true }
      );
      requestAnimationFrame(() =>
        document.querySelector('.modal-overlay .modal')?.classList.add('modal--wide'));
    }

    async function setStatus(r, s) {
      r.status = s; await db.put(store, r);
      ui.toast('Finalised & locked.', 'success'); refresh();
    }
    async function del(r) {
      if (!confirm('Delete this record permanently?')) return;
      await db.remove(store, r.id); ui.toast('Deleted.', 'info'); refresh();
    }

    refresh();
    if (ctx.initialFormKey && forms[ctx.initialFormKey] && can('create'))
      setTimeout(() => openForm(ctx.initialFormKey), 80);
  }

  window.App.recordEngine = { render };
})();
