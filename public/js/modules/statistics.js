/*
 * modules/statistics.js — Court Statistics, for the Hon. Chief Judge and
 * administrators: for each court in a period, cases assigned and disposed
 * of, sittings and adjournments; and now, cases pending and how long they
 * have been pending. Each court's pending cases open oldest first. Print,
 * or download for Excel (CSV).
 */
(function () {
  window.App = window.App || {};
  window.App.modules = window.App.modules || {};
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const years = (y) => y >= 1 ? `${y} yr${y === 1 ? '' : 's'}` : y > 0 ? `${Math.max(1, Math.round(y * 12))} mth` : '';
  const age = (days) => days >= 365 ? `${Math.round(days / 365.25 * 10) / 10} yrs` : days >= 30 ? `${Math.floor(days / 30.44)} months` : `${days} day${days === 1 ? '' : 's'}`;

  function download(name, rows) {
    const blob = new Blob(['﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  window.App.modules.statistics = {
    async render(container, ctx) {
      const { ui, api } = ctx;
      const el = ui.el;
      const P = window.App.processUi;
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const from = el('input', { type: 'date', value: `${now.getFullYear()}-01-01`, 'aria-label': 'From' });
      const to = el('input', { type: 'date', value: iso(now), 'aria-label': 'To' });
      const out = el('div');
      let data = null;
      container.append(
        el('div', { class: 'page-head' }, [el('h1', null, '📈 Court Statistics'),
          el('p', { class: 'muted' }, 'The work of each court from its Case Register and Court Diary. Assigned, disposed of, sittings and adjournments count within the period; pending cases are as they stand today.')]),
        el('div', { class: 'report-filters' }, [
          el('label', { class: 'report-filter' }, [el('span', null, 'From'), from]),
          el('label', { class: 'report-filter' }, [el('span', null, 'To'), to]),
          el('div', { class: 'report-actions' }, [
            el('button', { class: 'btn btn--ghost', onclick: () => data && print() }, '🖨 Print'),
            el('button', { class: 'btn btn--ghost', onclick: () => data && csv() }, '⬇ Excel (CSV)')
          ])
        ]),
        out
      );
      [from, to].forEach(x => x.addEventListener('change', load));

      async function load() {
        try { data = await api.get(`/statistics?from=${from.value}&to=${to.value}`); }
        catch (e) { out.replaceChildren(ui.empty(e.offline ? 'Statistics need the internet.' : e.message)); return; }
        const t = data.totals;
        const card = (n, label, mod) => el('div', { class: 'dash-card' + (mod ? ' ' + mod : '') }, [el('div', { class: 'dash-card__num' }, String(n)), el('div', { class: 'dash-card__label' }, label)]);
        const rate = t.assigned ? Math.round(t.disposed / t.assigned * 100) : null;
        out.replaceChildren(
          el('div', { class: 'dash-stats' }, [
            card(t.assigned, 'Assigned in the period'), card(t.disposed, 'Disposed of in the period', 'dash-card--ok'),
            card(t.pending, 'Pending now', t.pending ? 'dash-card--warn' : ''), card(t.sittings, 'Sittings in the period'),
            card(t.adjournments, 'Adjournments in the period'), card(t.toCome, 'Dates fixed to come')
          ]),
          rate === null ? null : el('p', { class: 'muted' }, `Disposed of in the period as a share of cases assigned in it: ${rate}%. (Cases disposed of may have been assigned earlier.)`),
          el('h2', { class: 'stats-h' }, 'By court'),
          ui.table([
            { label: 'High Court', value: r => `No. ${r.roman}` },
            { label: 'Assigned', value: r => String(r.assigned) },
            { label: 'Disposed of', value: r => String(r.disposed) },
            { label: 'Pending now', value: r => String(r.pending) },
            { label: 'Average age', value: r => years(r.averageYears) },
            { label: 'Oldest', value: r => years(r.oldestYears) },
            { label: 'Sittings', value: r => String(r.sittings) },
            { label: 'Adjournments', value: r => String(r.adjournments) },
            { label: 'Dates to come', value: r => String(r.toCome) }
          ], data.courts, [{ label: 'Pending cases', show: r => r.pending > 0, onClick: r => pending(r) }]),
          el('h2', { class: 'stats-h' }, 'Pending cases by how long they have been pending'),
          ui.table([
            { label: 'High Court', value: r => r.name === 'All courts' ? r.name : `No. ${r.roman}` },
            ...data.bands.map(b => ({ label: b.label, value: r => String(r.bands[b.key]) })),
            { label: 'Total', value: r => String(r.pending) }
          ], [...data.courts, { name: 'All courts', bands: t.bands, pending: t.pending }])
        );
      }

      async function pending(court) {
        let r;
        try { r = await api.get(`/statistics/pending?unitKey=${encodeURIComponent(court.key)}`); } catch (e) { ui.toast(e.message, 'error'); return; }
        const dl = el('button', { class: 'btn btn--ghost btn--small', onclick: () => download(`pending-high-court-${r.court.roman}.csv`, [
          ['Suit number', 'Name of case', 'Type of case', 'Pending since', 'Years', 'Sittings', 'Adjournments', 'Last sitting', 'Next date', 'Coming up for'],
          ...r.cases.map(c => [c.suitNumber, c.parties, c.nature, c.since, c.years, c.sittings, c.adjournments, c.lastSitting, c.nextDate, c.nextBusiness])]) }, '⬇ Excel (CSV)');
        let dialog;
        ui.modal(`Pending cases · High Court No. ${r.court.roman}`, el('div', null, [
          el('div', { class: 'doc-preview__actions' }, [el('button', { class: 'btn btn--ghost', onclick: () => dialog.close() }, '✕  Close'), dl]),
          el('p', { class: 'muted' }, `${r.cases.length} case${r.cases.length === 1 ? '' : 's'}, oldest first. Sittings and adjournments are those recorded in the Court Diary.`),
          ui.table([
            { label: 'Suit number', node: c => P.caseNo(ui, c.suitNumber) },
            { label: 'Name of case', value: c => c.parties },
            { label: 'Type of case', value: c => c.nature },
            { label: 'Pending since', value: c => P.day(c.since) },
            { label: 'Age', value: c => age(c.days) },
            { label: 'Adjournments', value: c => String(c.adjournments) },
            { label: 'Next date', value: c => c.nextDate ? `${P.day(c.nextDate)} (${c.nextBusiness})` : 'None fixed' }
          ], r.cases)
        ]), { wide: true, noFooter: true, onOpen: (o) => { dialog = o; } });
      }

      const head = ['Court', 'Assigned', 'Disposed of', 'Pending now', 'Average age (years)', 'Oldest (years)', 'Sittings', 'Adjournments', 'Dates to come'];
      const line = (r) => [`High Court No. ${r.roman}`, r.assigned, r.disposed, r.pending, r.averageYears, r.oldestYears, r.sittings, r.adjournments, r.toCome];
      function csv() {
        const t = data.totals;
        download(`court-statistics-${data.from}-to-${data.to}.csv`, [
          [`Court statistics, ${data.from} to ${data.to}`], head, ...data.courts.map(line),
          ['All courts', t.assigned, t.disposed, t.pending, '', '', t.sittings, t.adjournments, t.toCome], [],
          ['Court', ...data.bands.map(b => b.label), 'Total'],
          ...data.courts.map(r => [`High Court No. ${r.roman}`, ...data.bands.map(b => r.bands[b.key]), r.pending]),
          ['All courts', ...data.bands.map(b => t.bands[b.key]), t.pending]
        ]);
      }
      function print() {
        const t = data.totals;
        const row = (cells, tag = 'td') => `<tr>${cells.map(c => `<${tag}>${esc(c)}</${tag}>`).join('')}</tr>`;
        P.printPage(`<article class="court-doc report-print">
          <header class="doc-masthead"><img class="doc-emblem" src="/assets/highcourt.png" alt="">
            <div class="doc-titleblock"><div class="doc-line1">THE JUDICIARY</div><div class="doc-line2">GOMBE STATE HIGH COURT OF JUSTICE</div><div class="doc-line3">COURT STATISTICS</div></div>
            <img class="doc-emblem" src="/assets/coat.png" alt=""></header><div class="doc-rule"></div>
          <p>Period: ${esc(P.day(data.from))} to ${esc(P.day(data.to))}. Pending cases as at ${esc(P.day(new Date()))}.</p>
          <h3>By court</h3>
          <table class="doc-table"><thead>${row(head, 'th')}</thead><tbody>${data.courts.map(r => row(line(r))).join('')}
            ${row(['All courts', t.assigned, t.disposed, t.pending, '', '', t.sittings, t.adjournments, t.toCome])}</tbody></table>
          <h3>Pending cases by how long they have been pending</h3>
          <table class="doc-table"><thead>${row(['Court', ...data.bands.map(b => b.label), 'Total'], 'th')}</thead><tbody>
            ${data.courts.map(r => row([`High Court No. ${r.roman}`, ...data.bands.map(b => r.bands[b.key]), r.pending])).join('')}
            ${row(['All courts', ...data.bands.map(b => t.bands[b.key]), t.pending])}</tbody></table>
          <footer class="doc-footer"><span>Printed ${esc(P.day(new Date()))}</span><span>Powered by the Directorate of ICT, Gombe State High Court of Justice</span></footer>
        </article>`, '@page { size: A4 landscape; margin: 10mm; }');
      }
      load();
    }
  };
})();
