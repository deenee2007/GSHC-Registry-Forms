/*
 * modules/caseRegister.js — a court's Case Register: the cases assigned to
 * it (case number, nature, date filed, date assigned, remark), File
 * received when the physical file arrives, the remark when the case is
 * disposed of, and cases filed before the system added by hand.
 */
(function () {
  window.App = window.App || {};
  window.App.modules = window.App.modules || {};
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  window.App.modules.caseRegister = {
    async render(container, ctx) {
      const { ui, api, router, unit, permissions } = ctx;
      const el = ui.el;
      const P = window.App.processUi;
      const canWork = permissions.can('edit') || permissions.can('create');
      container.appendChild(el('div', { class: 'page-head' }, [
        el('h1', null, `📒 Case Register · ${unit.name}`),
        el('p', { class: 'muted' }, 'Cases assigned to this court by the Hon. Chief Judge, and earlier cases added by hand. Record the remark when a case is disposed of.')
      ]));
      const search = el('input', { type: 'search', class: 'search-input', placeholder: '🔍  Search case number, party, nature' });
      const list = el('div');
      let data = { cases: [], remarks: [] };
      container.append(
        el('div', { class: 'toolbar' }, [
          el('button', { class: 'btn btn--ghost', onclick: () => router.loadUnit(unit) }, '← Back to forms'),
          canWork ? el('button', { class: 'btn btn--primary', onclick: addEarlier }, '+ Add Earlier Case') : null,
          el('button', { class: 'btn btn--ghost', onclick: () => printRegister() }, '🖨 Print Register')
        ]),
        el('div', { class: 'filter-bar' }, [search]),
        list
      );
      search.addEventListener('input', show);

      async function load() {
        try { data = await api.get(`/process/register?unitKey=${encodeURIComponent(unit.key)}`); }
        catch (e) { list.replaceChildren(ui.empty(e.offline ? 'The register needs the internet.' : e.message)); return; }
        show();
      }
      function shown() {
        const t = search.value.trim().toLowerCase();
        return data.cases.filter(c => !t || [c.suitNumber, c.firstParty, c.secondParty, c.nature].join(' ').toLowerCase().includes(t));
      }
      function show() {
        const rows = shown();
        if (!rows.length) { list.replaceChildren(ui.empty(data.cases.length ? 'No case matches.' : 'No case has been assigned to this court yet.')); return; }
        list.replaceChildren(ui.table([
          { label: 'Case No.', node: c => P.caseNo(ui, c.suitNumber) },
          { label: 'Parties', value: c => P.parties(c) },
          { label: 'Nature of case', value: c => c.nature || '' },
          { label: 'Date filed', value: c => P.day(c.filedOn) },
          { label: 'Date assigned', value: c => P.day(c.assignedAt) },
          { label: 'File', node: c => c.status === 'assigned' ? el('span', { class: 'badge badge--pending' }, 'Not yet received') : el('span', { class: 'muted' }, c.receivedAt ? `Received ${P.day(c.receivedAt)}` : '') },
          { label: 'Remark', value: c => c.disposal ? `${c.disposal.remark} (${P.day(c.disposal.date)})` : '' }
        ], rows, canWork ? [
          { label: 'File received', class: 'btn--ok', show: c => c.status === 'assigned', onClick: async c => {
            try { await api.post(`/process/cases/${c.id}/received`); ui.toast(`File ${c.suitNumber} received.`, 'success'); load(); } catch (e) { ui.toast(e.message, 'error'); }
          } },
          { label: c => c.disposal ? 'Change Remark' : 'Record Remark', onClick: c => remark(c) }
        ] : null));
      }

      function remark(c) {
        const pick = el('select', null, [...data.remarks, 'Other'].map(r => el('option', { value: r }, r === 'Other' ? 'Other (type it)' : r)));
        const other = el('input', { type: 'text', placeholder: 'Type the remark' });
        const date = el('input', { type: 'date', value: (c.disposal && c.disposal.date) || new Date().toISOString().slice(0, 10) });
        if (c.disposal) { if (data.remarks.includes(c.disposal.remark)) pick.value = c.disposal.remark; else { pick.value = 'Other'; other.value = c.disposal.remark; } }
        const otherRow = ui.field('Other remark', other);
        const sync = () => { otherRow.hidden = pick.value !== 'Other'; };
        pick.addEventListener('change', sync); sync();
        ui.modal(`Remark · ${c.suitNumber}`, el('div', null, [ui.field('Remark', pick), otherRow, ui.field('Date', date)]), {
          confirmText: 'Save Remark',
          onConfirm: async () => {
            await api.post(`/process/cases/${c.id}/disposal`, { remark: pick.value, other: other.value, date: date.value });
            ui.toast('Remark saved.', 'success'); load(); return true;
          }
        });
      }

      function addEarlier() {
        const f = (label, node) => el('label', { class: 'form-field' }, [el('span', { class: 'form-field__label' }, label), node]);
        const num = el('input', { type: 'text', placeholder: 'e.g. GM/77/2024' }), nature = el('input', { type: 'text' });
        const first = el('input', { type: 'text' }), second = el('input', { type: 'text' });
        const filed = el('input', { type: 'date' }), assigned = el('input', { type: 'date' });
        ui.modal('Add Earlier Case', el('div', { class: 'form-grid' }, [
          el('p', { class: 'muted form-field--full' }, 'For a case filed before the system started, so the register is complete.'),
          f('Case number *', num), f('Nature of case', nature), f('First party', first), f('Second party', second), f('Date filed', filed), f('Date assigned', assigned)
        ]), {
          confirmText: 'Add to Register',
          onConfirm: async () => {
            await api.post('/process/register/earlier', { unitKey: unit.key, suitNumber: num.value, nature: nature.value, firstParty: first.value, secondParty: second.value, filedOn: filed.value, assignedOn: assigned.value });
            ui.toast('Added to the register.', 'success'); load(); return true;
          }
        });
      }

      function printRegister() {
        const rows = shown().map(c => `<tr><td>${P.caseNoHtml(c.suitNumber)}</td><td>${esc(P.parties(c))}</td><td>${esc(c.nature)}</td><td>${esc(P.day(c.filedOn))}</td><td>${esc(P.day(c.assignedAt))}</td><td>${esc(c.disposal ? c.disposal.remark : '')}</td></tr>`).join('');
        const root = document.getElementById('print-root');
        root.innerHTML = `<article class="court-doc report-print">
          <header class="doc-masthead"><img class="doc-emblem" src="/assets/highcourt.png" alt="">
            <div class="doc-titleblock"><div class="doc-line1">THE JUDICIARY</div><div class="doc-line2">GOMBE STATE HIGH COURT OF JUSTICE</div><div class="doc-line3">${esc(unit.name)} · Case Register</div></div>
            <img class="doc-emblem" src="/assets/coat.png" alt=""></header><div class="doc-rule"></div>
          <table class="doc-table"><thead><tr><th>Case No.</th><th>Parties</th><th>Nature of case</th><th>Date filed</th><th>Date assigned</th><th>Remark</th></tr></thead><tbody>${rows}</tbody></table>
          <footer class="doc-footer"><span>Printed ${esc(ui.fmtDate(new Date()))}</span><span>Powered by the Directorate of ICT, Gombe State High Court of Justice</span></footer>
        </article>`;
        document.body.classList.add('is-printing');
        const done = () => { document.body.classList.remove('is-printing'); root.innerHTML = ''; window.removeEventListener('afterprint', done); };
        window.addEventListener('afterprint', done);
        setTimeout(() => { window.print(); setTimeout(done, 1000); }, 300);
      }
      load();
    }
  };
})();
