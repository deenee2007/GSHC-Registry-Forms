/*
 * modules/fees.js — the Fees List: every payment of a day or a period, new
 * filings at the Process Registry and processes filed later at the courts,
 * with the invoice and receipt numbers, for reconciling with revenue. The
 * Process Registry sees its own, each court its own, the Chief Judge and
 * administrators all. Print, or download for Excel.
 */
(function () {
  window.App = window.App || {};
  window.App.modules = window.App.modules || {};
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const feesText = (r) => r.fees.map(f => `${f.item}${f.qty > 1 ? ' × ' + f.qty : ''}`).join('; ');

  async function render(box, ctx, unitKey) {
    const { ui, api } = ctx;
    const el = ui.el;
    const P = window.App.processUi;
    const pad = (n) => String(n).padStart(2, '0');
    const d = new Date(), today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const from = el('input', { type: 'date', value: today, 'aria-label': 'From' });
    const to = el('input', { type: 'date', value: today, 'aria-label': 'To' });
    const unit = el('select', { 'aria-label': 'Unit', hidden: 'hidden' });
    const out = el('div');
    let data = null, unitsLoaded = false;
    box.append(
      el('div', { class: 'report-filters' }, [
        el('label', { class: 'report-filter' }, [el('span', null, 'From'), from]),
        el('label', { class: 'report-filter' }, [el('span', null, 'To'), to]),
        el('label', { class: 'report-filter' }, [el('span', null, 'Unit'), unit]),
        el('div', { class: 'report-actions' }, [
          el('button', { class: 'btn btn--ghost', onclick: () => data && print() }, '🖨 Print'),
          el('button', { class: 'btn btn--ghost', onclick: () => data && csv() }, '⬇ Excel (CSV)')
        ])
      ]),
      out
    );
    [from, to, unit].forEach(x => x.addEventListener('change', load));

    async function load() {
      const q = `from=${from.value}&to=${to.value || from.value}${unit.value ? '&unitKey=' + encodeURIComponent(unit.value) : ''}`;
      try { data = await api.get(`/process/fees-list?${q}`); }
      catch (e) { out.replaceChildren(ui.empty(e.offline ? 'The fees list needs the internet.' : e.message)); return; }
      if (!unitsLoaded) {
        unitsLoaded = true;
        if (data.units.length > 1) {
          unit.replaceChildren(el('option', { value: '' }, 'All'), ...data.units.map(u => el('option', { value: u.key }, u.name)));
          unit.hidden = false; unit.parentNode.hidden = false;
          if (unitKey && data.units.some(u => u.key === unitKey)) { unit.value = unitKey; return load(); }
        } else unit.parentNode.hidden = true;
      }
      const many = new Set(data.rows.map(r => r.unitKey)).size > 1 || !unit.value && data.units.length > 1;
      out.replaceChildren(
        el('div', { class: 'dash-stats' }, [
          el('div', { class: 'dash-card dash-card--ok' }, [el('div', { class: 'dash-card__num dash-card__num--money' }, P.naira(data.total)), el('div', { class: 'dash-card__label' }, 'Total of the fees')]),
          el('div', { class: 'dash-card' }, [el('div', { class: 'dash-card__num' }, String(data.rows.length)), el('div', { class: 'dash-card__label' }, 'Filings with fees')]),
          el('div', { class: 'dash-card' + (data.withoutReceipt ? ' dash-card--warn' : '') }, [el('div', { class: 'dash-card__num' }, String(data.withoutReceipt)), el('div', { class: 'dash-card__label' }, 'Without a receipt number yet')])
        ]),
        data.rows.length ? ui.table([
          { label: 'Date', value: r => P.day(r.date) },
          ...(many ? [{ label: 'Unit', value: r => r.unitName }] : []),
          { label: 'Suit number', node: r => P.caseNo(ui, r.suitNumber) },
          { label: 'Name of case', value: r => r.parties },
          { label: 'Filed', value: r => r.what },
          { label: 'Invoice', value: r => r.invoice },
          { label: 'Receipt', node: r => r.receiptNumber ? el('span', null, r.receiptNumber) : el('span', { class: 'badge badge--pending' }, 'None yet') },
          { label: 'Fees', value: r => feesText(r) },
          { label: 'Amount', value: r => P.naira(r.amount) }
        ], data.rows) : ui.empty('No fees in this period.')
      );
    }
    const head = ['Date', 'Unit', 'Suit number', 'Name of case', 'Filed', 'Invoice', 'Receipt number', 'Fees', 'Amount (₦)'];
    const line = (r) => [r.date, r.unitName, r.suitNumber, r.parties, r.what, r.invoice, r.receiptNumber, feesText(r), r.amount.toFixed(2)];
    function csv() {
      const rows = [[`Fees list, ${data.from} to ${data.to}`], head, ...data.rows.map(line), ['', '', '', '', '', '', '', 'Total', data.total.toFixed(2)]];
      const blob = new Blob(['﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `fees-${data.from}-to-${data.to}.csv` });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }
    function print() {
      const period = data.from === data.to ? P.day(data.from) : `${P.day(data.from)} to ${P.day(data.to)}`;
      const who = unit.value ? (data.units.find(u => u.key === unit.value) || {}).name : (data.units.length === 1 ? data.units[0].name : 'All units');
      P.printPage(`<article class="court-doc report-print">
        <header class="doc-masthead"><img class="doc-emblem" src="/assets/highcourt.png" alt="">
          <div class="doc-titleblock"><div class="doc-line1">THE JUDICIARY</div><div class="doc-line2">GOMBE STATE HIGH COURT OF JUSTICE</div><div class="doc-line3">FEES LIST · ${esc(String(who || '').toUpperCase())}</div></div>
          <img class="doc-emblem" src="/assets/coat.png" alt=""></header><div class="doc-rule"></div>
        <p>${esc(period)}. ${data.rows.length} filing(s) with fees; ${data.withoutReceipt} without a receipt number yet.</p>
        <table class="doc-table"><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>
          ${data.rows.map(r => `<tr><td>${esc(P.day(r.date))}</td><td>${esc(r.unitName)}</td><td>${P.caseNoHtml(r.suitNumber)}</td><td>${esc(r.parties)}</td><td>${esc(r.what)}</td><td>${esc(r.invoice)}</td><td>${esc(r.receiptNumber)}</td><td>${esc(feesText(r))}</td><td style="text-align:right">${esc(P.naira(r.amount))}</td></tr>`).join('')}
          <tr><th colspan="8" style="text-align:right">TOTAL</th><th style="text-align:right">${esc(P.naira(data.total))}</th></tr></tbody></table>
        <footer class="doc-footer"><span>Printed ${esc(P.day(new Date()))}</span><span>Powered by the Directorate of ICT, Gombe State High Court of Justice</span></footer>
      </article>`, '@page { size: A4 landscape; margin: 10mm; }');
    }
    load();
  }

  window.App.feesUi = { render };
  window.App.modules.fees = {
    async render(container, ctx) {
      const { ui } = ctx;
      container.appendChild(ui.el('div', { class: 'page-head' }, [ui.el('h1', null, '💰 Fees List'),
        ui.el('p', { class: 'muted' }, 'Every payment of the day or period, with its invoice and receipt numbers, to reconcile with revenue.')]));
      const box = ui.el('div');
      container.appendChild(box);
      render(box, ctx, ctx.unitKey);
    }
  };
})();
