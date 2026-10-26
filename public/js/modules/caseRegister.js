/*
 * modules/caseRegister.js — a court's register books, kept as on paper:
 * one book for civil matters and one for criminal matters, each numbered
 * from 1 (S/No) in order of assignment, with the name of the case, suit
 * number, date of filing, date of assignment, type of case, date
 * received, date of disposal and remarks. File received when the file
 * arrives; the remark when the case is disposed of; earlier cases added
 * by hand. Which book a case goes in is set per case type (Settings,
 * Process Registry). A case reassigned to another court stays in the
 * book, marked in its remarks, with nothing more to do; the court may ask
 * the Hon. Chief Judge to reassign a case (View, Request Reassignment).
 */
(function () {
  window.App = window.App || {};
  window.App.modules = window.App.modules || {};
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const BOOKS = [['civil', 'Civil Register'], ['criminal', 'Criminal Register']];

  // From the menu, for someone in more than one court: which court's register.
  async function chooseCourt(container, ctx) {
    const { ui, api, router } = ctx;
    const el = ui.el;
    const courts = (await router.units()).filter(u => u.type === 'registry');
    let fresh = [];
    try { fresh = (await api.get('/process/new-cases')).cases; } catch (e) { /* offline */ }
    container.append(
      el('div', { class: 'page-head' }, [el('h1', null, '📒 Case Register'), el('p', { class: 'muted' }, 'Choose the court whose register books to open.')]),
      el('div', { class: 'dash-stats' }, courts.map(u => {
        const n = fresh.filter(c => c.assigned && c.assigned.key === u.key).length;
        return el('button', { class: 'dash-card' + (n ? ' dash-card--warn' : ''), type: 'button', onclick: () => router.loadModule('caseRegister', { unit: u }) }, [
          el('div', { class: 'dash-card__label' }, u.name), el('div', { class: 'muted' }, n ? `${n} new case${n > 1 ? 's' : ''}` : 'Open')
        ]);
      }))
    );
  }

  window.App.modules.caseRegister = {
    async render(container, ctx) {
      const { ui, api, router, unit, permissions } = ctx;
      const el = ui.el;
      if (!unit) return chooseCourt(container, ctx);
      const P = window.App.processUi;
      const canWork = permissions.can('edit') || permissions.can('create');
      const settings = await api.get('/process/settings');
      const bookOf = (c) => (settings.caseTypes.find(t => t.key === c.caseType) || { book: 'civil' }).book;
      let book = 'civil';

      container.appendChild(el('div', { class: 'page-head' }, [
        el('h1', null, `📒 Case Register · ${unit.name}`),
        el('p', { class: 'muted' }, 'The civil and criminal register books of this court. New cases assigned by the Hon. Chief Judge appear by themselves.')
      ]));
      const tabsBar = el('div', { class: 'tabs', role: 'tablist' });
      const search = el('input', { type: 'search', class: 'search-input', placeholder: '🔍  Search name of case, suit number, type of case' });
      const list = el('div');
      let data = { cases: [], remarks: [] };
      container.append(
        el('div', { class: 'toolbar' }, [
          el('button', { class: 'btn btn--ghost', onclick: () => router.loadUnit(unit) }, '← Back to forms'),
          canWork ? el('button', { class: 'btn btn--primary', onclick: addEarlier }, '+ Add Earlier Case') : null,
          canWork ? el('button', { class: 'btn btn--ghost', onclick: importRegister }, '⬆ Import Register') : null,
          el('button', { class: 'btn btn--ghost', onclick: () => router.loadModule('fees', { unitKey: unit.key }) }, '💰 Fees List'),
          el('button', { class: 'btn btn--ghost', onclick: () => printRegister() }, '🖨 Print Register')
        ]),
        tabsBar,
        el('div', { class: 'filter-bar' }, [search]),
        list
      );
      BOOKS.forEach(([key, name], i) => {
        const btn = el('button', { class: 'tab' + (i === 0 ? ' is-active' : ''), role: 'tab', onclick: () => {
          tabsBar.querySelectorAll('.tab').forEach(t => t.classList.remove('is-active'));
          btn.classList.add('is-active');
          book = key;
          show();
        } }, name);
        tabsBar.appendChild(btn);
      });
      search.addEventListener('input', show);

      async function load() {
        try { data = await api.get(`/process/register?unitKey=${encodeURIComponent(unit.key)}`); }
        catch (e) { list.replaceChildren(ui.empty(e.offline ? 'The register needs the internet.' : e.message)); return; }
        show();
      }
      // The book's entries in order of assignment, numbered from 1 as on paper.
      function entries() {
        const time = (c) => new Date((c.reassignedAway && c.reassignedAway.assignedAt) || c.assignedAt || c.filedOn || (c.earlier && c.receivedAt) || c.createdAt || 0).getTime();
        return data.cases.filter(c => bookOf(c) === book).sort((a, b) => time(a) - time(b) || String(a.suitNumber).localeCompare(String(b.suitNumber), undefined, { numeric: true }))
          .map((c, i) => ({ ...c, sn: i + 1 }));
      }
      function shown() {
        const t = search.value.trim().toLowerCase();
        return entries().filter(c => !t || [c.suitNumber, c.firstParty, c.secondParty, c.nature].join(' ').toLowerCase().includes(t));
      }
      function show() {
        const rows = shown();
        const bookName = BOOKS.find(b => b[0] === book)[1];
        if (!rows.length) { list.replaceChildren(ui.empty(entries().length ? 'No case matches.' : `No case in the ${bookName} yet.`)); return; }
        // As in the book: the action sits in its own column (File received under
        // Date received, Record Remark under Remarks), so there is no Actions column.
        const btn = (label, cls, fn) => el('button', { class: 'btn btn--small ' + cls, type: 'button', onclick: fn }, label);
        // File received only once the Process Registry has dispatched the file.
        const received = (c) => {
          if (c.reassignedAway) return P.day(c.reassignedAway.receivedAt);
          if (c.receivedAt) return P.day(c.receivedAt);
          const note = el('span', { class: 'reg-pending' }, c.status === 'dispatched' ? `Dispatched ${P.day(c.dispatchedAt)}` : 'File still at the Process Registry');
          if (!canWork || !['assigned', 'dispatched'].includes(c.status)) return note;
          const b = btn('File received', 'btn--ok', async () => {
            try { await api.post(`/process/cases/${c.id}/received`); ui.toast(`File ${c.suitNumber} received.`, 'success'); load(); router.refreshBadges(); } catch (e) { ui.toast(e.message, 'error'); return; }
            if (window.App.diaryUi && confirm(`File ${c.suitNumber} received. Fix its first date in the Court Diary now?`)) window.App.diaryUi.fix(ctx, unit, { caseId: c.id });
          });
          if (c.status !== 'dispatched') { b.disabled = true; b.title = 'Waiting for the Process Registry to dispatch the file'; }
          return el('div', { class: 'reg-remark' }, [b, note]);
        };
        const remarks = (c) => c.reassignedAway ? el('span', null, remarkText(c)) : el('div', { class: 'reg-remark' }, [
          c.disposal ? el('span', null, c.disposal.remark) : null,
          !c.disposal && c.reassignedFrom ? el('span', { class: 'muted' }, `Reassigned from High Court No. ${c.reassignedFrom.roman}`) : null,
          !c.disposal && c.reassignRequest ? el('span', { class: 'badge badge--pending' }, 'Reassignment asked for') : null,
          canWork ? btn(c.disposal ? 'Change' : 'Record Remark', 'btn--ghost', () => remark(c)) : null
        ]);
        const COLS = [
          ['S/No', 'c-sn', c => String(c.sn)], ['Name of case', 'c-name', c => P.parties(c)], ['Suit number', 'c-suit', c => el('div', { class: 'reg-remark' }, [P.caseNo(ui, c.suitNumber), btn('View', 'btn--ghost', () => view(c))])],
          ['Date of filing', 'c-date', c => P.day(c.filedOn)], ['Date of assignment', 'c-date', c => P.day(assignedOn(c))], ['Type of case', 'c-type', c => c.nature || ''],
          ['Date received', 'c-date', received], ['Date of disposal', 'c-date', c => c.disposal ? P.day(c.disposal.date) : ''], ['Remarks', 'c-remark', remarks]
        ];
        list.replaceChildren(el('div', { class: 'table-scroll' }, [el('table', { class: 'data-table register-table' }, [
          el('thead', null, el('tr', null, COLS.map(([label, cls]) => el('th', { class: cls }, label)))),
          el('tbody', null, rows.map(c => el('tr', c.reassignedAway ? { class: 'row--away' } : null, COLS.map(([label, cls, value]) => {
            const v = value(c);
            return el('td', { class: cls, 'data-label': label }, typeof v === 'string' ? v : [v]);
          }))))
        ])]));
      }

      // A case reassigned away: its first assignment here, and the remark.
      const assignedOn = (c) => c.reassignedAway ? c.reassignedAway.assignedAt : c.assignedAt;
      const remarkText = (c) => c.reassignedAway ? `Reassigned to ${c.reassignedAway.to} on ${P.day(c.reassignedAway.at)} (${c.reassignedAway.reason})` : c.disposal ? c.disposal.remark : '';

      // The whole case: its filing, assignment, dispatch, receipt and remark.
      async function view(c) {
        let full;
        try { full = (await api.get(`/process/cases/${c.id}`)).case; } catch (e) { ui.toast(e.message, 'error'); return; }
        let dialog;
        const close = el('button', { class: 'btn btn--ghost', onclick: () => dialog.close() }, '✕  Close');
        if (c.reassignedAway) full.reassignedAway = c.reassignedAway;
        const here = !c.reassignedAway;
        const askBtn = here && ['assigned', 'dispatched', 'received'].includes(full.status) && !full.reassignRequest
          ? el('button', { class: 'btn btn--ghost', onclick: () => { dialog.close(); askReassign(full); } }, '↪ Request Reassignment') : null;
        const formBtn = canWork && here ? el('button', { class: 'btn btn--ghost', onclick: () => { dialog.close(); ctx.workflow.fillFromCase({ caseId: full.id, unitKey: unit.key }); } }, '📝 Fill a Form') : null;
        const fixBtn = canWork && here && window.App.diaryUi ? el('button', { class: 'btn btn--primary', onclick: async () => { dialog.close(); await window.App.diaryUi.fix(ctx, unit, { caseId: full.id }); } }, '📅 Fix a Date') : null;
        const dates = el('div', { class: 'case-docs' });
        api.get(`/diary?unitKey=${encodeURIComponent(unit.key)}&caseId=${full.id}`).then(r => {
          const D = window.App.diaryUi;
          dates.replaceChildren(el('h3', null, `Court dates (${r.entries.length})`), r.entries.length ? ui.table([
            { label: 'Date', value: e => D.longDay(e.date) + (e.time ? `, ${e.time}` : '') },
            { label: 'Coming up for', value: e => e.business },
            { label: 'Outcome', value: e => e.status === 'done' ? e.outcome.text : 'To come' }
          ], r.entries) : el('p', { class: 'muted' }, 'No date in the Court Diary yet.'));
        }).catch(() => dates.remove());
        ui.modal(`Case ${full.suitNumber}`, el('div', null, [el('div', { class: 'doc-preview__actions' }, [close, formBtn, fixBtn, askBtn]), P.badge(ui, full.status), P.details(ui, full, settings), dates, P.processesPanel(ctx, full, settings, unit), P.documentsPanel(ui, api, full.id)]),
          { noFooter: true, wide: true, onOpen: (o) => { dialog = o; } });
      }

      // Ask the Hon. Chief Judge to reassign the case, with the reason.
      function askReassign(c) {
        const reasons = settings.reassignReasons || [];
        const pick = el('select', null, [el('option', { value: '' }, 'Choose the reason'), ...reasons.map(r => el('option', { value: r }, r))]);
        const other = el('input', { type: 'text', maxlength: '200', placeholder: 'Type the reason' });
        const note = el('textarea', { rows: '3', maxlength: '500', placeholder: 'Optional: anything the Hon. Chief Judge should know' });
        const otherRow = ui.field('Other reason', other);
        const sync = () => { otherRow.hidden = pick.value !== 'Other'; };
        pick.addEventListener('change', sync); sync();
        ui.modal(`Request Reassignment · ${c.suitNumber}`, el('div', null, [
          el('p', { class: 'muted' }, 'The request goes to the Hon. Chief Judge, who decides whether to reassign the case and to which court. The case stays here until then.'),
          ui.field('Reason', pick), otherRow, ui.field('Note', note)
        ]), {
          confirmText: 'Send Request',
          onConfirm: async () => {
            if (!pick.value || (pick.value === 'Other' && !other.value.trim())) throw new Error('Choose the reason, or type it under Other.');
            await api.post(`/process/cases/${c.id}/request-reassignment`, { reason: pick.value, other: other.value.trim(), note: note.value.trim() });
            ui.toast('Request sent to the Hon. Chief Judge.', 'success'); load(); return true;
          }
        });
      }

      function remark(c) {
        const pick = el('select', null, [...data.remarks, 'Other'].map(r => el('option', { value: r }, r === 'Other' ? 'Other (type it)' : r)));
        const other = el('input', { type: 'text', placeholder: 'Type the remark' });
        const date = el('input', { type: 'date', value: (c.disposal && c.disposal.date) || new Date().toISOString().slice(0, 10) });
        if (c.disposal) { if (data.remarks.includes(c.disposal.remark)) pick.value = c.disposal.remark; else { pick.value = 'Other'; other.value = c.disposal.remark; } }
        const otherRow = ui.field('Other remark', other);
        const sync = () => { otherRow.hidden = pick.value !== 'Other'; };
        pick.addEventListener('change', sync); sync();
        ui.modal(`Disposal · ${c.suitNumber}`, el('div', null, [ui.field('Remarks', pick), otherRow, ui.field('Date of disposal', date)]), {
          confirmText: 'Save',
          onConfirm: async () => {
            await api.post(`/process/cases/${c.id}/disposal`, { remark: pick.value, other: other.value, date: date.value });
            ui.toast('Saved in the register.', 'success'); load(); return true;
          }
        });
      }

      // The court's existing book from Excel or CSV: the template, a check of
      // every row (nothing saved), then the import of the rows that passed.
      const TEMPLATE = ['S/No', 'Register (Civil or Criminal)', 'Name of case', 'Suit number', 'Date of filing', 'Date of assignment', 'Type of case', 'Date received', 'Date of disposal', 'Remarks', 'Next date', 'Coming up for'];
      function downloadTemplate() {
        const blob = new Blob(['\ufeff' + TEMPLATE.join(',') + '\r\n'], { type: 'text/csv;charset=utf-8' });
        const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `register-template-${unit.key}.csv` });
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      }
      function importRegister() {
        let dialog;
        const file = el('input', { type: 'file', accept: '.xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv' });
        const result = el('div');
        const send = async (commit) => {
          if (!file.files[0]) { ui.toast('Choose the Excel or CSV file first.', 'error'); return null; }
          const form = new FormData();
          form.append('unitKey', unit.key); form.append('commit', commit ? '1' : '0'); form.append('file', file.files[0]);
          return api.post('/process/register/import', form);
        };
        const check = el('button', { class: 'btn btn--primary', onclick: async () => {
          check.disabled = true; check.textContent = 'Checking…';
          try { const r = await send(false); if (r) show(r); } catch (e) { ui.toast(e.message, 'error', 9000); }
          check.disabled = false; check.textContent = '🔎 Check the File';
        } }, '🔎 Check the File');
        file.addEventListener('change', () => result.replaceChildren());
        function show(r) {
          const civil = r.rows.filter(x => x.ok && x.book === 'civil').length, criminal = r.rows.filter(x => x.ok && x.book === 'criminal').length;
          const withDate = r.rows.filter(x => x.ok && x.next).length;
          const go = el('button', { class: 'btn btn--ok', disabled: r.toAdd ? null : true, onclick: async () => {
            if (!confirm(`Add ${r.toAdd} case${r.toAdd === 1 ? '' : 's'} to the register of ${unit.name}?`)) return;
            go.disabled = true; go.textContent = 'Importing…';
            try {
              const done = await send(true);
              ui.toast(`${done.added} case${done.added === 1 ? '' : 's'} added to the register${done.dates ? `, ${done.dates} next date${done.dates === 1 ? '' : 's'} put in the Court Diary` : ''}.${done.failed.length ? ` ${done.failed.length} could not be added.` : ''}`, 'success', 9000);
              dialog.close(); load();
            } catch (e) { ui.toast(e.message, 'error', 9000); go.disabled = false; go.textContent = `⬆ Import ${r.toAdd} Cases`; }
          } }, `⬆ Import ${r.toAdd} Case${r.toAdd === 1 ? '' : 's'}`);
          const ordered = [...r.rows.filter(x => !x.ok), ...r.rows.filter(x => x.ok)];
          result.replaceChildren(
            el('div', { class: 'notice' + (r.skipped ? ' notice--warn' : '') }, `${r.toAdd} case${r.toAdd === 1 ? '' : 's'} can be added (${civil} Civil, ${criminal} Criminal${withDate ? `; ${withDate} with a next date for the Court Diary` : ''}).` +
              (r.skipped ? ` ${r.skipped} row${r.skipped === 1 ? ' has a problem' : 's have problems'} and will be left out: they are listed first. Correct them in the sheet and import them again later if you wish.` : ' No row has a problem.')),
            ui.table([
              { label: 'Row', value: x => String(x.line) },
              { label: 'Suit number', value: x => x.suitNumber },
              { label: 'Name of case', value: x => x.parties },
              { label: 'Register', value: x => x.book === 'criminal' ? 'Criminal' : 'Civil' },
              { label: 'Status', value: x => x.status + (x.next ? `; next ${P.day(x.next.date)} (${x.next.business})` : '') },
              { label: 'Check', node: x => el('div', null, [
                ...x.problems.map(p => el('div', { class: 'import-problem' }, '✕ ' + p)),
                ...x.notes.map(n => el('div', { class: 'muted' }, n)),
                x.ok && !x.notes.length ? el('span', { class: 'badge badge--final' }, 'OK') : null
              ]) }
            ], ordered.slice(0, 500)),
            ordered.length > 500 ? el('p', { class: 'muted' }, `Showing the first 500 of ${ordered.length} rows.`) : el('span'),
            el('div', { class: 'card__actions' }, [go])
          );
        }
        ui.modal(`Import Register · ${unit.name}`, el('div', null, [
          el('div', { class: 'doc-preview__actions' }, [el('button', { class: 'btn btn--ghost', onclick: () => dialog.close() }, '✕  Close')]),
          el('ol', { class: 'import-steps' }, [
            el('li', null, ['Download the template and open it in Excel. ', el('button', { class: 'btn btn--small btn--ghost', type: 'button', onclick: downloadTemplate }, '⬇ Download the template')]),
            el('li', null, 'Copy in the cases from the register book, one case per row: both the civil and the criminal book can go in the same sheet; write Civil or Criminal in the Register column. Write dates day first (12/03/2024 or 12 March 2024). For a case disposed of, give the date of disposal and the remark. Next date and Coming up for are optional: a next date still to come goes into the Court Diary.'),
            el('li', null, 'Save it (as Excel .xlsx or as CSV) and choose it below. Click Check the File: nothing is saved yet, you see every row and any problem first.')
          ]),
          ui.field('The register file', file), el('div', { class: 'card__actions' }, [check]),
          result
        ]), { noFooter: true, wide: true, onOpen: (o) => { dialog = o; } });
      }

      function addEarlier() {
        const f = (label, node) => el('label', { class: 'form-field' }, [el('span', { class: 'form-field__label' }, label), node]);
        const type = el('select', null, settings.caseTypes.map(t => el('option', { value: t.key }, `${t.label} (${t.book === 'criminal' ? 'Criminal' : 'Civil'} Register)`)));
        const preferred = settings.caseTypes.find(t => t.book === book);
        if (preferred) type.value = preferred.key;
        const num = el('input', { type: 'text', placeholder: 'e.g. GM/77/2024' }), nature = el('input', { type: 'text', placeholder: 'e.g. Land, Contract, Armed robbery' });
        const first = el('input', { type: 'text' }), second = el('input', { type: 'text' });
        const filed = el('input', { type: 'date' }), assigned = el('input', { type: 'date' }), received = el('input', { type: 'date' });
        ui.modal('Add Earlier Case', el('div', { class: 'form-grid' }, [
          el('p', { class: 'muted form-field--full' }, 'For a case filed before the system started, so the register book is complete. Add its remark afterwards if it was disposed of.'),
          f('Case type *', type), f('Suit number *', num), f('First party', first), f('Second party', second),
          f('Type of case', nature), f('Date of filing', filed), f('Date of assignment', assigned), f('Date received', received)
        ]), {
          confirmText: 'Add to Register',
          onConfirm: async () => {
            await api.post('/process/register/earlier', { unitKey: unit.key, caseType: type.value, suitNumber: num.value, nature: nature.value,
              firstParty: first.value, secondParty: second.value, filedOn: filed.value, assignedOn: assigned.value, receivedOn: received.value });
            ui.toast('Added to the register.', 'success'); load(); return true;
          }
        });
      }

      function printRegister() {
        const bookName = BOOKS.find(b => b[0] === book)[1];
        const rows = shown().map(c => `<tr><td>${c.sn}</td><td>${esc(P.parties(c))}</td><td>${P.caseNoHtml(c.suitNumber)}</td><td>${esc(P.day(c.filedOn))}</td><td>${esc(P.day(assignedOn(c)))}</td><td>${esc(c.nature)}</td><td>${esc(P.day(c.reassignedAway ? c.reassignedAway.receivedAt : c.receivedAt))}</td><td>${esc(c.disposal ? P.day(c.disposal.date) : '')}</td><td>${esc(remarkText(c))}</td></tr>`).join('');
        const root = document.getElementById('print-root');
        root.innerHTML = `<article class="court-doc report-print register-print">
          <header class="doc-masthead"><img class="doc-emblem" src="/assets/highcourt.png" alt="">
            <div class="doc-titleblock"><div class="doc-line1">THE JUDICIARY</div><div class="doc-line2">GOMBE STATE HIGH COURT OF JUSTICE</div><div class="doc-line3">${esc(unit.name)} · ${esc(bookName)}</div></div>
            <img class="doc-emblem" src="/assets/coat.png" alt=""></header><div class="doc-rule"></div>
          <table class="doc-table"><thead><tr><th>S/No</th><th>Name of case</th><th>Suit number</th><th>Date of filing</th><th>Date of assignment</th><th>Type of case</th><th>Date received</th><th>Date of disposal</th><th>Remarks</th></tr></thead><tbody>${rows}</tbody></table>
          <footer class="doc-footer"><span>Printed ${esc(ui.fmtDate(new Date()))}</span><span>Powered by the Directorate of ICT, Gombe State High Court of Justice</span></footer>
        </article>`;
        const page = Object.assign(document.createElement('style'), { textContent: '@page { size: A4 landscape; margin: 10mm; }' });
        document.head.appendChild(page);
        document.body.classList.add('is-printing');
        const done = () => { document.body.classList.remove('is-printing'); root.innerHTML = ''; page.remove(); window.removeEventListener('afterprint', done); };
        window.addEventListener('afterprint', done);
        setTimeout(() => { window.print(); setTimeout(done, 1000); }, 300);
      }
      load();
    }
  };
})();
