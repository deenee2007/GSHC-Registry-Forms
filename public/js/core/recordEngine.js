/*
 * core/recordEngine.js — the page every unit module uses: its records,
 * search and filters, new entries, and offline drafts waiting to sync.
 * What happens to a single record lives in core/workflow.js.
 */
(function () {
  window.App = window.App || {};

  const STATUS_FILTERS = [
    ['all', 'All'], ['draft', 'Drafts'], ['pending', 'Awaiting Signature'],
    ['returned', 'Returned'], ['final', 'Signed'], ['revoked', 'Revoked']
  ];

  function render(container, ctx, config) {
    const { ui, api, permissions, unit } = ctx;
    const wf = window.App.workflow;
    const can = (a) => permissions.can(a);
    const all = window.App.allForms || {};
    const formKeys = (unit.forms && unit.forms.length ? unit.forms : Object.keys(config.forms)).filter(k => all[k] || config.forms[k]);
    const defOf = (k) => all[k] || config.forms[k];

    container.appendChild(ui.el('div', { class: 'page-head' }, [
      ui.el('h1', null, unit.name),
      ui.el('p', { class: 'muted' }, config.subtitle || '')
    ]));

    // ── New entry toolbar ──
    const formPicker = ui.el('select', { class: 'form-picker', 'aria-label': 'Form' },
      formKeys.map(k => ui.el('option', { value: k }, defOf(k).label)));
    const newBtn = ui.el('button', {
      class: 'btn btn--primary', disabled: can('create') ? null : 'disabled',
      onclick: () => wf.openForm({ unitKey: unit.key, formType: formPicker.value })
    }, '+ New Entry');
    const refreshBtn = ui.el('button', { class: 'btn btn--ghost', onclick: () => refresh() }, '↻ Refresh');
    container.appendChild(ui.el('div', { class: 'toolbar' }, [formPicker, newBtn, refreshBtn]));

    // ── Search / filter / sort ──
    let filterStatus = 'all', searchTerm = '', sortMode = 'newest';
    let records = [], offline = [];

    const searchInput = ui.el('input', {
      type: 'search', class: 'search-input', placeholder: '🔍  Search form, suit no., party, staff…',
      oninput: (e) => { searchTerm = e.target.value.toLowerCase(); renderList(); }
    });
    const btnWrap = ui.el('div', { class: 'filter-btns' });
    const filterBtns = {};
    STATUS_FILTERS.forEach(([s, label]) => {
      filterBtns[s] = ui.el('button', {
        class: 'btn btn--small filter-btn' + (s === 'all' ? ' filter-btn--active' : ''),
        onclick: () => {
          filterStatus = s;
          Object.values(filterBtns).forEach(b => b.classList.remove('filter-btn--active'));
          filterBtns[s].classList.add('filter-btn--active');
          renderList();
        }
      }, label);
      btnWrap.appendChild(filterBtns[s]);
    });
    const sortSelect = ui.el('select', { class: 'sort-select', 'aria-label': 'Sort', onchange: (e) => { sortMode = e.target.value; renderList(); } }, [
      ui.el('option', { value: 'newest' }, 'Newest First'),
      ui.el('option', { value: 'oldest' }, 'Oldest First'),
      ui.el('option', { value: 'formtype' }, 'Form Type A to Z')
    ]);
    container.appendChild(ui.el('div', { class: 'filter-bar' }, [searchInput, btnWrap, sortSelect]));

    const countLabel = ui.el('div', { class: 'record-count' }, '');
    const listWrap = ui.el('div', { class: 'list-wrap' });
    container.append(countLabel, listWrap);

    function rows() {
      const local = offline.map(e => ({
        ...e, id: e.localId, status: 'offline', ref: '', summary: summaryOf(e),
        formLabel: defOf(e.formType) ? defOf(e.formType).label : e.formType,
        createdByName: e.userName, createdAt: e.savedAt
      }));
      // a server draft with unsynced offline edits shows once, as offline
      const edited = new Set(offline.filter(e => e.recordId).map(e => e.recordId));
      return [...local, ...records.filter(r => !edited.has(r.id))];
    }

    function summaryOf(e) {
      const def = defOf(e.formType);
      if (!def) return '';
      const f = def.schema.find(s => s.name && /title|party|name|plaintiff|appellant|suit/i.test(s.name));
      return f ? String(e.data[f.name] || '') : '';
    }

    function renderList() {
      let recs = rows();
      const total = recs.length;
      if (filterStatus !== 'all') recs = recs.filter(r => r.status === filterStatus || (filterStatus === 'draft' && r.status === 'offline'));
      if (searchTerm) {
        recs = recs.filter(r => [r.formLabel, r.ref, r.summary, r.createdByName, r.submittedByName, r.verifyCode]
          .join(' ').toLowerCase().includes(searchTerm));
      }
      const time = (r) => new Date(r.createdAt).getTime();
      if (sortMode === 'newest') recs.sort((a, b) => time(b) - time(a));
      else if (sortMode === 'oldest') recs.sort((a, b) => time(a) - time(b));
      else recs.sort((a, b) => (a.formLabel || '').localeCompare(b.formLabel || ''));

      countLabel.textContent = total === recs.length ? `${total} record${total !== 1 ? 's' : ''}` : `${recs.length} of ${total} records`;
      ui.clear(listWrap);
      if (!recs.length) {
        listWrap.appendChild(ui.empty(searchTerm || filterStatus !== 'all' ? 'No records match your search or filter.' : 'No records yet for this unit.'));
        return;
      }

      listWrap.appendChild(ui.table(
        [
          { label: 'Form', value: r => r.formLabel },
          { label: 'Reference', value: r => r.ref || '—' },
          { label: 'Party / Title', value: r => r.summary || '—' },
          { label: 'By', value: r => r.createdByName || '' },
          { label: 'Date', value: r => ui.fmtDate(r.createdAt) },
          { label: 'Status', node: r => ui.statusBadge(r.status) }
        ],
        recs,
        [
          { label: 'Open', onClick: r => wf.openDocument(r.localId ? r : r.id) },
          { label: 'Edit', show: r => wf.abilities(r).edit, onClick: r => editRecord(r) },
          { label: r => wf.submitLabel(r).replace(/^\W+/, ''), class: 'btn--ok', show: r => wf.abilities(r).submit, onClick: r => submitRecord(r) },
          { label: 'Delete', class: 'btn--danger', show: r => wf.abilities(r).remove, onClick: r => wf.deleteRecord(r).then(ok => ok && wf.changed()) }
        ]
      ));
    }

    async function editRecord(r) {
      if (r.localId) return wf.openForm({ unitKey: r.unitKey, formType: r.formType, record: r });
      try {
        const { record } = await api.get('/records/' + r.id);
        wf.openForm({ unitKey: unit.key, formType: record.formType, record });
      } catch (e) { ui.toast(e.offline ? 'This draft is not available offline.' : e.message, 'error'); }
    }

    async function submitRecord(r) {
      const done = await wf.submitDialog(r);
      if (done) wf.changed();
    }

    async function refresh() {
      offline = (await window.App.offline.all()).filter(e => e.unitKey === unit.key);
      try {
        records = (await api.get('/records' + api.qs({ unitKey: unit.key }))).records;
      } catch (e) {
        if (!e.offline) ui.toast(e.message, 'error');
        else countLabel.textContent = 'Offline: showing the last list saved on this computer.';
      }
      renderList();
    }

    // Refresh while this page is on screen; stop once it is replaced.
    const stop1 = wf.onChange(() => (document.body.contains(container) ? refresh() : (stop1(), stop2())));
    const stop2 = window.App.offline.onChange(() => (document.body.contains(container) ? refresh() : (stop1(), stop2())));

    refresh();
    if (ctx.initialFormKey && formKeys.includes(ctx.initialFormKey) && can('create')) {
      setTimeout(() => wf.openForm({ unitKey: unit.key, formType: ctx.initialFormKey }), 80);
    }
  }

  window.App.recordEngine = { render };
})();
