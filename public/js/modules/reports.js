/*
 * modules/reports.js — activity reports with filters, print and a download
 * that opens in Excel. Administrators can choose the court; other users
 * with the "reports" privilege see their own unit only.
 */
(function () {
  window.App = window.App || {};
  window.App.modules = window.App.modules || {};

  const STATUSES = [['', 'All statuses'], ['draft', 'Draft'], ['pending', 'Awaiting Signature'], ['returned', 'Returned'], ['final', 'Signed'], ['revoked', 'Revoked']];
  const STATUS_LABEL = Object.fromEntries(STATUSES);

  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  function presetRange(p) {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (p === 'today') return [d, d];
    if (p === 'week') { const s = new Date(d); s.setDate(d.getDate() - ((d.getDay() + 6) % 7)); const e = new Date(s); e.setDate(s.getDate() + 6); return [s, e]; }
    if (p === 'month') return [new Date(d.getFullYear(), d.getMonth(), 1), new Date(d.getFullYear(), d.getMonth() + 1, 0)];
    if (p === 'lastmonth') return [new Date(d.getFullYear(), d.getMonth() - 1, 1), new Date(d.getFullYear(), d.getMonth(), 0)];
    if (p === 'year') return [new Date(d.getFullYear(), 0, 1), new Date(d.getFullYear(), 11, 31)];
    return null;
  }

  function duration(h) {
    if (h === null || h === undefined) return '—';
    if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
    if (h < 48) return `${h.toFixed(1)} hours`;
    return `${(h / 24).toFixed(1)} days`;
  }
  const day = (s) => new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  window.App.modules.reports = {
    async render(container, ctx) {
      const { ui, api } = ctx;
      const el = ui.el;
      const opts = await api.get('/reports/options');

      container.appendChild(el('div', { class: 'page-head' }, [
        el('h1', null, '📊 Reports'),
        el('p', { class: 'muted' }, opts.isAdmin ? 'Activity across all courts and units.' : `Activity in ${opts.units.map(u => u.name).join(', ')}.`)
      ]));

      // ── Filters ──
      const preset = el('select', { 'aria-label': 'Period' }, [
        ['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['lastmonth', 'Last month'], ['year', 'This year'], ['custom', 'Choose dates']
      ].map(([v, t]) => el('option', { value: v }, t)));
      preset.value = 'month';
      const from = el('input', { type: 'date', 'aria-label': 'From' });
      const to = el('input', { type: 'date', 'aria-label': 'To' });
      const court = el('select', { 'aria-label': 'Court' }, [el('option', { value: '' }, 'All courts and units'), ...opts.units.map(u => el('option', { value: u.key }, u.name))]);
      const form = el('select', { 'aria-label': 'Form' }, [el('option', { value: '' }, 'All forms'), ...opts.forms.map(f => el('option', { value: f.formType }, f.label))]);
      const status = el('select', { 'aria-label': 'Status' }, STATUSES.map(([v, t]) => el('option', { value: v }, t)));
      const signer = el('select', { 'aria-label': 'Signer' }, [el('option', { value: '' }, 'All signers'), ...opts.signers.map(s => el('option', { value: s.id }, s.name))]);
      const basis = el('select', { 'aria-label': 'Documents list' }, [el('option', { value: 'signed' }, 'List documents signed'), el('option', { value: 'created' }, 'List forms created')]);

      const applyPreset = () => { const r = presetRange(preset.value); if (r) { from.value = iso(r[0]); to.value = iso(r[1]); } };
      applyPreset();
      preset.addEventListener('change', () => { applyPreset(); run(); });
      [from, to].forEach(i => i.addEventListener('change', () => { preset.value = 'custom'; run(); }));
      [court, form, status, signer, basis].forEach(s => s.addEventListener('change', run));

      const f = (label, input) => el('label', { class: 'report-filter' }, [el('span', { class: 'form-field__label' }, label), input]);
      const printBtn = el('button', { class: 'btn btn--ghost', onclick: () => last && printReport(last) }, '🖨 Print');
      const csvBtn = el('button', { class: 'btn btn--ghost', onclick: () => last && downloadCsv(last) }, '⬇ Download for Excel');
      container.appendChild(el('div', { class: 'report-filters' }, [
        f('Period', preset), f('From', from), f('To', to),
        opts.isAdmin ? f('Court / unit', court) : null,
        f('Form', form), f('Status', status), f('Signer', signer), f('Documents list', basis),
        el('div', { class: 'report-actions' }, [printBtn, csvBtn])
      ]));

      const out = el('div', { class: 'report-out' });
      container.appendChild(out);
      let last = null;

      function filterText(r) {
        const parts = [];
        if (opts.isAdmin) parts.push(court.value ? court.selectedOptions[0].text : 'All courts and units');
        else parts.push(r.scope.units.map(u => u.name).join(', '));
        if (form.value) parts.push(form.selectedOptions[0].text);
        if (status.value) parts.push('Status: ' + STATUS_LABEL[status.value]);
        if (signer.value) parts.push('Signer: ' + signer.selectedOptions[0].text);
        return parts.join(' · ');
      }

      async function run() {
        if (!from.value || !to.value) return;
        ui.clear(out).appendChild(ui.empty('Loading…'));
        try {
          const r = await api.get('/reports' + api.qs({ from: from.value, to: to.value, unitKey: court.value, formType: form.value, status: status.value, signer: signer.value, basis: basis.value }));
          r.filterText = filterText(r);
          last = r;
          draw(r);
        } catch (e) { ui.clear(out).appendChild(ui.empty(e.offline ? 'Reports need an internet connection.' : e.message)); }
      }

      function card(value, label, mod) {
        return el('div', { class: 'dash-card' + (mod ? ' ' + mod : '') }, [el('div', { class: 'dash-card__num' }, String(value)), el('div', { class: 'dash-card__label' }, label)]);
      }
      const countCols = [
        { label: 'Created', key: 'created' }, { label: 'Submitted', key: 'submitted' }, { label: 'Signed', key: 'signed' },
        { label: 'Returned', key: 'returned' }, { label: 'Revoked', key: 'revoked' }
      ];

      function draw(r) {
        ui.clear(out);
        const t = r.totals;
        out.appendChild(el('p', { class: 'report-head' }, [el('strong', null, `${day(r.period.from)} to ${day(r.period.to)}`), `  ·  ${r.filterText}`]));
        out.appendChild(el('div', { class: 'dash-stats' }, [
          card(t.created, 'Forms Created'), card(t.submitted, 'Submitted'), card(t.signed, 'Signed / Issued', 'dash-card--ok'),
          card(t.returned, 'Returned', t.returned ? 'dash-card--warn' : ''), card(t.revoked, 'Revoked'),
          card(t.pendingNow, 'Awaiting Signature Now', t.pendingNow ? 'dash-card--warn' : '')
        ]));
        out.appendChild(el('p', { class: 'muted' }, t.approvals
          ? `Approval time (submission to final signature), ${t.approvals} form${t.approvals > 1 ? 's' : ''}: average ${duration(t.avgApprovalHours)}, median ${duration(t.medianApprovalHours)}.`
          : 'No forms were approved by a signer in this period.'));
        if (t.oldestPendingSince) out.appendChild(el('p', { class: 'muted' }, `The oldest form still awaiting signature was submitted ${ui.fmtDate(t.oldestPendingSince)}.`));

        const section = (title, node) => el('div', { class: 'dash-section' }, [el('h2', null, title), node]);
        const sumRow = (rows) => countCols.reduce((o, c) => ({ ...o, [c.key]: rows.reduce((n, x) => n + x[c.key], 0) }), {});
        const withTotal = (rows, labelKey) => (rows.length > 1 ? [...rows, { [labelKey]: 'Total', ...sumRow(rows), _total: true }] : rows);

        out.appendChild(section('By Form', r.byForm.length
          ? ui.table([{ label: 'Form', key: 'label' }, ...countCols], withTotal(r.byForm, 'label'), null)
          : ui.empty('No activity in this period.')));
        if (r.byUnit) {
          out.appendChild(section('By Court / Unit', r.byUnit.length
            ? ui.table([{ label: 'Court / Unit', key: 'name' }, ...countCols], withTotal(r.byUnit, 'name'), null)
            : ui.empty('No activity in this period.')));
        }
        out.appendChild(section('By Signer', r.bySigner.length
          ? ui.table([{ label: 'Signer', key: 'name' }, { label: 'Signatures', key: 'signatures' }, { label: 'Average Wait to Sign', value: s => duration(s.avgWaitHours) }], r.bySigner, null)
          : ui.empty('No signatures in this period.')));
        out.appendChild(section(r.basis === 'created' ? 'Forms Created' : 'Documents Signed', r.records.length
          ? ui.table([
              { label: 'Date', value: x => ui.fmtDate(r.basis === 'created' ? x.createdAt : x.finalizedAt) },
              { label: 'Form', key: 'form' }, { label: 'Reference', value: x => x.ref || '—' }, { label: 'Party / Title', value: x => x.summary || '—' },
              ...(opts.isAdmin ? [{ label: 'Court / Unit', key: 'unit' }] : []),
              { label: 'Prepared By', key: 'createdByName' }, { label: 'Signed By', value: x => x.signedBy || '—' },
              { label: 'Status', node: x => ui.statusBadge(x.status) }
            ], r.records, [{ label: 'Open', onClick: x => ctx.workflow.openDocument(x.id) }])
          : ui.empty('None in this period.')));
        if (r.truncated) out.appendChild(el('p', { class: 'muted' }, 'Only the first 2,000 documents are listed. Narrow the period or filters to see the rest.'));
        out.querySelectorAll('tbody tr').forEach(tr => { if (tr.firstChild && tr.firstChild.textContent === 'Total') tr.classList.add('report-total'); });
      }

      // ── Print: a plain A4 report through the print root ──
      function printReport(r) {
        const t = r.totals;
        const table = (head, rows) => `<table class="doc-table"><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${
          rows.map(row => `<tr>${row.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
        const counts = (x) => [x.created, x.submitted, x.signed, x.returned, x.revoked];
        const H = ['Created', 'Submitted', 'Signed', 'Returned', 'Revoked'];
        let html = `<article class="court-doc report-print">
          <header class="doc-masthead"><img class="doc-emblem" src="/assets/highcourt.png" alt="">
            <div class="doc-titleblock"><div class="doc-line1">THE JUDICIARY</div><div class="doc-line2">GOMBE STATE HIGH COURT OF JUSTICE</div><div class="doc-line3">Activity Report</div></div>
            <img class="doc-emblem" src="/assets/coat.png" alt=""></header><div class="doc-rule"></div>
          <p><strong>Period:</strong> ${esc(day(r.period.from))} to ${esc(day(r.period.to))}<br><strong>Covering:</strong> ${esc(r.filterText)}</p>
          ${table(['Created', 'Submitted', 'Signed / Issued', 'Returned', 'Revoked', 'Awaiting signature now'], [[t.created, t.submitted, t.signed, t.returned, t.revoked, t.pendingNow]])}
          <p>${t.approvals ? `Approval time for ${t.approvals} form(s): average ${esc(duration(t.avgApprovalHours))}, median ${esc(duration(t.medianApprovalHours))}.` : 'No forms were approved by a signer in this period.'}</p>
          <h3>By Form</h3>${r.byForm.length ? table(['Form', ...H], r.byForm.map(x => [x.label, ...counts(x)])) : '<p>No activity.</p>'}`;
        if (r.byUnit) html += `<h3>By Court / Unit</h3>${r.byUnit.length ? table(['Court / Unit', ...H], r.byUnit.map(x => [x.name, ...counts(x)])) : '<p>No activity.</p>'}`;
        html += `<h3>By Signer</h3>${r.bySigner.length ? table(['Signer', 'Signatures', 'Average wait to sign'], r.bySigner.map(s => [s.name, s.signatures, duration(s.avgWaitHours)])) : '<p>No signatures.</p>'}
          <h3>${r.basis === 'created' ? 'Forms Created' : 'Documents Signed'}</h3>${r.records.length ? table(
            ['Date', 'Form', 'Reference', 'Party / Title', ...(r.byUnit ? ['Court / Unit'] : []), 'Signed By', 'Status'],
            r.records.map(x => [ui.fmtDate(r.basis === 'created' ? x.createdAt : x.finalizedAt), x.form, x.ref || '', x.summary || '', ...(r.byUnit ? [x.unit] : []), x.signedBy || '', STATUS_LABEL[x.status] || x.status])
          ) : '<p>None.</p>'}
          <footer class="doc-footer"><span>Generated ${esc(ui.fmtDate(new Date()))}</span><span>Powered by the Directorate of ICT, Gombe State High Court of Justice</span></footer>
        </article>`;
        const root = document.getElementById('print-root');
        root.innerHTML = html;
        document.body.classList.add('is-printing');
        const done = () => { document.body.classList.remove('is-printing'); root.innerHTML = ''; window.removeEventListener('afterprint', done); };
        window.addEventListener('afterprint', done);
        setTimeout(() => { window.print(); setTimeout(done, 1000); }, 300); // let the emblems load
      }

      // ── Download: CSV with a byte order mark, so Excel opens it correctly ──
      function downloadCsv(r) {
        const cell = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
        const lines = [];
        const row = (...cells) => lines.push(cells.map(cell).join(','));
        const t = r.totals;
        row('GSHC Registry Activity Report');
        row('Period', `${r.period.from} to ${r.period.to}`);
        row('Covering', r.filterText);
        row();
        row('Created', 'Submitted', 'Signed / Issued', 'Returned', 'Revoked', 'Awaiting signature now', 'Average approval time', 'Median approval time');
        row(t.created, t.submitted, t.signed, t.returned, t.revoked, t.pendingNow, duration(t.avgApprovalHours), duration(t.medianApprovalHours));
        const H = ['Created', 'Submitted', 'Signed', 'Returned', 'Revoked'];
        const counts = (x) => [x.created, x.submitted, x.signed, x.returned, x.revoked];
        row(); row('By Form'); row('Form', ...H); r.byForm.forEach(x => row(x.label, ...counts(x)));
        if (r.byUnit) { row(); row('By Court / Unit'); row('Court / Unit', ...H); r.byUnit.forEach(x => row(x.name, ...counts(x))); }
        row(); row('By Signer'); row('Signer', 'Signatures', 'Average wait to sign'); r.bySigner.forEach(s => row(s.name, s.signatures, duration(s.avgWaitHours)));
        row(); row(r.basis === 'created' ? 'Forms Created' : 'Documents Signed');
        row('Date', 'Form', 'Reference', 'Party / Title', 'Court / Unit', 'Prepared By', 'Signed By', 'Status', 'Verification Code');
        r.records.forEach(x => row(ui.fmtDate(r.basis === 'created' ? x.createdAt : x.finalizedAt), x.form, x.ref, x.summary, x.unit, x.createdByName, x.signedBy, STATUS_LABEL[x.status] || x.status, x.verifyCode));
        const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `GSHC_report_${r.period.from}_to_${r.period.to}.csv`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      }

      run();
    }
  };
})();
