/*
 * modules/cases.js — the case file: type a suit, case or appeal number and
 * see every document for it across all units, oldest first, with its
 * status. Documents in units the user cannot open are listed without
 * their contents.
 */
(function () {
  window.App = window.App || {};
  window.App.modules = window.App.modules || {};

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const day = (v) => v ? new Date(v).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

  window.App.modules.cases = {
    async render(container, ctx) {
      const { ui, api, workflow: wf } = ctx;
      const el = ui.el;
      let last = null;

      const input = el('input', { class: 'search-input', type: 'search', placeholder: 'Suit, case or appeal number, e.g. GM/45/2026', 'aria-label': 'Suit or case number' });
      const go = el('button', { class: 'btn btn--primary', onclick: () => search() }, 'Find');
      const out = el('div', { class: 'case-out' });
      input.addEventListener('keydown', e => { if (e.key === 'Enter') search(); });
      container.append(
        el('div', { class: 'page-head' }, [
          el('h1', null, '📁 Case File'),
          el('p', { class: 'muted' }, 'Every document for a suit, case or appeal number, in all units, oldest first. Part of a number also works (for example 45/2026).')
        ]),
        el('div', { class: 'filter-bar' }, [input, go]),
        out
      );

      async function search(exact) {
        const q = input.value.trim();
        if (q.replace(/\s+/g, '').length < 3) { ui.toast('Type at least 3 characters of the number.', 'error'); return; }
        go.disabled = true;
        out.replaceChildren(el('p', { class: 'muted' }, 'Searching…'));
        try {
          last = await api.get(`/cases?q=${encodeURIComponent(q)}${exact ? '&exact=1' : ''}`);
          show(last);
        } catch (e) {
          out.replaceChildren(ui.empty(e.offline ? 'The case file needs the internet.' : e.message));
        } finally { go.disabled = false; }
      }

      function show(r) {
        if (!r.cases.length) { out.replaceChildren(ui.empty(`No documents mention ${r.query}.`)); return; }
        const kids = [];
        if (r.cases.length > 1) {
          kids.push(el('p', { class: 'muted' }, `${r.cases.length}${r.moreCases ? '+' : ''} numbers contain "${r.query}". Choose one to see only that case:`));
          kids.push(el('div', { class: 'case-picks' }, r.cases.map(c =>
            el('button', { class: 'btn btn--small btn--ghost', onclick: () => { input.value = c.caseNo; search(true); } }, `${c.caseNo} (${c.documents.length})`))));
        }
        r.cases.forEach(c => kids.push(caseBlock(c)));
        if (r.truncated) kids.push(el('p', { class: 'muted' }, 'Only the first 500 documents are shown. Type the full number to narrow the list.'));
        out.replaceChildren(...kids);
      }

      function caseBlock(c) {
        const count = (s) => c.documents.filter(d => d.status === s).length;
        const facts = [`${c.documents.length} document(s)`, `${count('final')} signed`, count('pending') && `${count('pending')} awaiting signature`,
          count('returned') && `${count('returned')} returned`, count('draft') && `${count('draft')} draft(s)`, count('revoked') && `${count('revoked')} revoked`]
          .filter(Boolean).join(' · ');
        return el('div', { class: 'dash-section case-block' }, [
          el('div', { class: 'case-head' }, [
            el('div', null, [
              el('h2', null, c.caseNo),
              c.parties ? el('div', { class: 'case-parties' }, c.parties) : null,
              el('div', { class: 'muted' }, `${facts}  ·  ${c.units.join(', ')}`)
            ]),
            el('button', { class: 'btn btn--ghost btn--small', onclick: () => wf.fillFromCase({ caseNo: c.caseNo }) }, '📝 Fill a Form'),
            el('button', { class: 'btn btn--ghost btn--small', onclick: () => printCase(c) }, '🖨 Print list')
          ]),
          ui.table([
            { label: 'Date', value: d => day(d.date) },
            { label: 'Form', value: d => d.formLabel },
            { label: 'Unit', value: d => d.unitName },
            { label: 'Status', node: d => d.formType === 'scan' ? ui.el('span', { class: 'badge badge--final' }, 'Scanned') : ui.statusBadge(d.status) },
            { label: 'Prepared by', value: d => d.canOpen || d.fileUrl ? d.createdByName : 'Not in your unit' }
          ], c.documents, [{ label: 'Open', show: d => d.canOpen || !!d.fileUrl, onClick: d => d.fileUrl ? window.open(d.fileUrl, '_blank', 'noopener') : wf.openDocument(d.id) }])
        ]);
      }

      function printCase(c) {
        const rows = c.documents.map(d => `<tr><td>${esc(day(d.date))}</td><td>${esc(d.formLabel)}</td><td>${esc(d.unitName)}</td><td>${esc(ui.STATUS_LABELS[d.status] || d.status)}</td><td>${esc(d.canOpen ? d.createdByName : '')}</td></tr>`).join('');
        const root = document.getElementById('print-root');
        root.innerHTML = `<article class="court-doc report-print">
          <header class="doc-masthead"><img class="doc-emblem" src="/assets/highcourt.png" alt="">
            <div class="doc-titleblock"><div class="doc-line1">THE JUDICIARY</div><div class="doc-line2">GOMBE STATE HIGH COURT OF JUSTICE</div><div class="doc-line3">Case File</div></div>
            <img class="doc-emblem" src="/assets/coat.png" alt=""></header><div class="doc-rule"></div>
          <p><strong>Suit / Case No.:</strong> ${esc(c.caseNo)}${c.parties ? `<br><strong>Parties:</strong> ${esc(c.parties)}` : ''}</p>
          <table class="doc-table"><thead><tr><th>Date</th><th>Form</th><th>Unit</th><th>Status</th><th>Prepared by</th></tr></thead><tbody>${rows}</tbody></table>
          <footer class="doc-footer"><span>Generated ${esc(ui.fmtDate(new Date()))}</span><span>Powered by the Directorate of ICT, Gombe State High Court of Justice</span></footer>
        </article>`;
        document.body.classList.add('is-printing');
        const done = () => { document.body.classList.remove('is-printing'); root.innerHTML = ''; window.removeEventListener('afterprint', done); };
        window.addEventListener('afterprint', done);
        setTimeout(() => { window.print(); setTimeout(done, 1000); }, 300);
      }

      if (ctx.q) { input.value = ctx.q; search(true); } else input.focus();
    }
  };
})();
