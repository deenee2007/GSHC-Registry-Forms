/*
 * modules/caseRegister.js — a court's register books, kept as on paper:
 * one book for civil matters and one for criminal matters, each numbered
 * from 1 (S/No) in order of assignment, with the name of the case, suit
 * number, date of filing, date of assignment, type of case, date
 * received, date of disposal and remarks. File received when the file
 * arrives; the remark when the case is disposed of; earlier cases added
 * by hand. Which book a case goes in is set per case type (Settings,
 * Process Registry).
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
        const time = (c) => new Date(c.assignedAt || c.filedOn || (c.earlier && c.receivedAt) || c.createdAt || 0).getTime();
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
        const received = (c) => c.receivedAt ? P.day(c.receivedAt)
          : canWork && c.status === 'assigned' ? btn('File received', 'btn--ok', async () => {
            try { await api.post(`/process/cases/${c.id}/received`); ui.toast(`File ${c.suitNumber} received.`, 'success'); load(); router.refreshBadges(); } catch (e) { ui.toast(e.message, 'error'); }
          }) : el('span', { class: 'reg-pending' }, 'Not yet received');
        const remarks = (c) => el('div', { class: 'reg-remark' }, [
          c.disposal ? el('span', null, c.disposal.remark) : null,
          canWork ? btn(c.disposal ? 'Change' : 'Record Remark', 'btn--ghost', () => remark(c)) : null
        ]);
        const COLS = [
          ['S/No', 'c-sn', c => String(c.sn)], ['Name of case', 'c-name', c => P.parties(c)], ['Suit number', 'c-suit', c => P.caseNo(ui, c.suitNumber)],
          ['Date of filing', 'c-date', c => P.day(c.filedOn)], ['Date of assignment', 'c-date', c => P.day(c.assignedAt)], ['Type of case', 'c-type', c => c.nature || ''],
          ['Date received', 'c-date', received], ['Date of disposal', 'c-date', c => c.disposal ? P.day(c.disposal.date) : ''], ['Remarks', 'c-remark', remarks]
        ];
        list.replaceChildren(el('div', { class: 'table-scroll' }, [el('table', { class: 'data-table register-table' }, [
          el('thead', null, el('tr', null, COLS.map(([label, cls]) => el('th', { class: cls }, label)))),
          el('tbody', null, rows.map(c => el('tr', null, COLS.map(([label, cls, value]) => {
            const v = value(c);
            return el('td', { class: cls, 'data-label': label }, typeof v === 'string' ? v : [v]);
          }))))
        ])]));
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
        const rows = shown().map(c => `<tr><td>${c.sn}</td><td>${esc(P.parties(c))}</td><td>${P.caseNoHtml(c.suitNumber)}</td><td>${esc(P.day(c.filedOn))}</td><td>${esc(P.day(c.assignedAt))}</td><td>${esc(c.nature)}</td><td>${esc(P.day(c.receivedAt))}</td><td>${esc(c.disposal ? P.day(c.disposal.date) : '')}</td><td>${esc(c.disposal ? c.disposal.remark : '')}</td></tr>`).join('');
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
