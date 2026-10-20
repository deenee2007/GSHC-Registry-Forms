/*
 * modules/process.js — the Process Registry.
 * Staff file new cases (fees, receipt, or Official for no fee) and send
 * them to the Process Registrar, who registers each one: the next suit
 * number of its type, and the next court in turn proposed to the Hon.
 * Chief Judge. Once assigned, the Process Registry prints the small
 * assignment slip for the file. Also a summary of the period.
 *
 * window.App.processUi holds what the Chief Judge's screen and the court
 * Case Register share: case number display, status badge, case details,
 * the receipt viewer and the slip.
 */
(function () {
  window.App = window.App || {};
  window.App.modules = window.App.modules || {};

  const STATUS = {
    draft: ['Draft', 'draft'], submitted: ['With Process Registrar', 'pending'], returned: ['Returned', 'returned'],
    awaiting_assignment: ['Awaiting Assignment', 'pending'], assigned: ['Assigned', 'final'],
    received: ['File received', 'final'], disposed: ['Disposed', 'final']
  };
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const naira = (n) => '₦' + Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const day = (v) => v ? new Date(String(v).length === 10 ? v + 'T00:00:00' : v).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  function ordinalDate(v) {
    const d = new Date(v), n = d.getDate(), s = ['th', 'st', 'nd', 'rd'], m = n % 100;
    return `${n}${s[(m - 20) % 10] || s[m] || s[0]} ${d.toLocaleDateString('en-GB', { month: 'long' })} ${d.getFullYear()}`;
  }

  // GM/45c/2026 with the letter raised.
  function caseNoHtml(s) {
    const m = /^(.*\/\d+)([a-z]+)(\/\d{4})$/i.exec(String(s || ''));
    return m ? `${esc(m[1])}<sup>${esc(m[2].toLowerCase())}</sup>${esc(m[3])}` : esc(s || '');
  }
  const caseNo = (ui, s) => ui.el('span', { class: 'case-no', html: s ? caseNoHtml(s) : '<span class="muted">Not yet numbered</span>' });
  const badge = (ui, status) => { const [t, c] = STATUS[status] || [status, 'draft']; return ui.el('span', { class: 'badge badge--' + c }, t); };
  const parties = (c) => `${c.firstParty} v. ${c.secondParty}`;
  const typeLabel = (settings, key) => (settings.caseTypes.find(t => t.key === key) || { label: key }).label;

  function viewReceipt(id) { window.open(`/api/process/cases/${id}/receipt`, '_blank', 'noopener'); }

  // The facts of a case, for the review screens.
  function details(ui, c, settings) {
    const row = (k, v) => v ? ui.el('div', { class: 'doc-kv' }, [ui.el('strong', null, k + ': '), typeof v === 'string' ? v : v]) : null;
    return ui.el('div', { class: 'case-details' }, [
      row('Suit number', caseNo(ui, c.suitNumber)),
      row('Case type', typeLabel(settings, c.caseType) + (c.efcc ? ' · EFCC matter' : '')),
      row('Parties', parties(c)),
      row('Nature of case', c.nature),
      row('Originating process', c.process),
      row('Counsel', [c.counsel, c.counselAddress].filter(Boolean).join(', ')),
      row('Date of filing', day(c.filedOn)),
      c.official ? row('Fees', 'Official: no filing fee') : row('Fees', `${c.fees.map(f => `${f.item}${f.qty > 1 ? ' × ' + f.qty : ''} ${naira(f.amount * f.qty)}`).join('; ')} · Total ${naira(c.feeTotal)}`),
      c.official ? null : row('Receipt', ui.el('span', null, [c.receiptNumber || 'No number',
        c.receipt ? ui.el('button', { class: 'btn btn--small btn--ghost', type: 'button', onclick: () => viewReceipt(c.id) }, '📄 View receipt') : ' · not uploaded'])),
      row('Filed by', c.createdByName),
      row('Registered', c.registeredAt ? `${day(c.registeredAt)} by ${c.registeredByName}` : ''),
      row('Proposed court', c.proposed && c.status === 'awaiting_assignment' ? c.proposed.name : ''),
      row('Assigned to', c.assigned ? `High Court No. ${c.assigned.roman} on ${day(c.assignedAt)}${c.assignment ? ', by ' + [c.assignment.title, c.assignment.name].filter(Boolean).join(' ') : ''}` : ''),
      row('File received', c.receivedAt ? `${day(c.receivedAt)} by ${c.receivedByName}` : ''),
      row('Remark', c.disposal ? `${c.disposal.remark} (${day(c.disposal.date)})` : ''),
      c.status === 'returned' && c.returnComment ? ui.el('div', { class: 'notice notice--warn' }, `Returned by ${c.returnedByName}: ${c.returnComment}`) : null
    ]);
  }

  // The small slip fixed to the file: the court, the date, the Chief
  // Judge's signature and the QR code (and, in small print, the suit
  // number, so a slip that comes off can be matched to its file).
  async function printSlip(id) {
    const { api, ui } = window.App;
    let c;
    try { c = (await api.get(`/process/cases/${id}`)).case; } catch (e) { ui.toast(e.message, 'error'); return; }
    if (!c.assigned || !c.assignment) { ui.toast('The case is not assigned yet.', 'error'); return; }
    const root = document.getElementById('print-root') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'print-root' }));
    root.innerHTML = `<article class="case-slip">
      <div class="slip-court">GOMBE STATE HIGH COURT OF JUSTICE</div>
      <div class="slip-label">ASSIGNED TO</div>
      <div class="slip-assigned">HIGH COURT No. ${esc(c.assigned.roman)}</div>
      <div class="slip-date">Date of assignment: ${esc(ordinalDate(c.assignedAt))}</div>
      <div class="slip-foot">
        <div class="slip-sign"><img src="${esc(c.signatureUrl)}" alt="Signature"><div class="slip-line"></div>
          <div>${esc([c.assignment.title, c.assignment.name].filter(Boolean).join(' '))}</div><div class="slip-cap">Chief Judge</div></div>
        <div class="slip-qr"><img src="${esc(c.qrDataUrl)}" alt="QR code"><div>${esc(c.verifyCode)}</div></div>
      </div>
      <div class="slip-ref">${caseNoHtml(c.suitNumber)}</div>
    </article>`;
    await Promise.all([...root.querySelectorAll('img')].map(i => i.complete ? null : new Promise(r => { i.onload = i.onerror = r; setTimeout(r, 8000); })));
    const page = Object.assign(document.createElement('style'), { textContent: '@page { size: 148mm 105mm; margin: 0; }' });
    document.head.appendChild(page);
    document.body.classList.add('is-printing', 'is-printing-slip');
    const done = () => { document.body.classList.remove('is-printing', 'is-printing-slip'); root.innerHTML = ''; page.remove(); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print();
    setTimeout(done, 1000);
  }

  window.App.processUi = { caseNoHtml, caseNo, badge, details, viewReceipt, printSlip, parties, day, naira, STATUS };

  // ── The filing form ──
  function filingForm(ctx, settings, existing) {
    const { ui, api } = ctx;
    const el = ui.el;
    const v = existing || { caseType: settings.caseTypes[0].key, fees: [], filedOn: new Date().toISOString().slice(0, 10) };
    const input = (val, attrs) => el('input', { type: 'text', value: val || '', ...(attrs || {}) });
    const caseType = el('select', null, settings.caseTypes.map(t => el('option', { value: t.key }, t.label)));
    caseType.value = v.caseType;
    const first = el('textarea', { rows: 2 }, v.firstParty || ''), second = el('textarea', { rows: 2 }, v.secondParty || '');
    const nature = input(v.nature, { placeholder: 'e.g. Land, Contract, Matrimonial' });
    const proc = input(v.process, { placeholder: 'e.g. Writ of summons, Originating summons, Petition, Charge' });
    const counsel = input(v.counsel), counselAddress = el('textarea', { rows: 2 }, v.counselAddress || '');
    const filedOn = el('input', { type: 'date', value: v.filedOn || '' });
    const efcc = el('input', { type: 'checkbox' }); efcc.checked = !!v.efcc;
    const official = el('input', { type: 'checkbox' }); official.checked = !!v.official;
    const receiptNumber = input(v.receiptNumber);
    const receiptFile = el('input', { type: 'file', accept: 'image/png,image/jpeg,application/pdf' });

    // Fee lines from the schedule, or Other with a typed amount.
    const lines = el('div', { class: 'fee-lines' });
    const totalEl = el('div', { class: 'fee-total' });
    const lineRows = [];
    function addLine(f) {
      const item = el('select', null, [...settings.fees.map(x => el('option', { value: x.item }, `${x.item} (${naira(x.amount)})`)), el('option', { value: '__other' }, 'Other (type it)')]);
      const otherText = input(f && !settings.fees.some(x => x.item === f.item) ? f.item : '', { placeholder: 'Description' });
      const otherAmt = el('input', { type: 'number', min: '0', step: '0.01', placeholder: 'Amount', value: f && !settings.fees.some(x => x.item === f.item) ? f.amount : '' });
      const qty = el('input', { type: 'number', min: '1', value: String((f && f.qty) || 1), class: 'fee-qty', 'aria-label': 'Quantity' });
      const remove = el('button', { class: 'btn btn--small btn--ghost', type: 'button' }, '✕');
      item.value = f ? (settings.fees.some(x => x.item === f.item) ? f.item : '__other') : (settings.fees[0] ? settings.fees[0].item : '__other');
      const row = el('div', { class: 'fee-line' }, [item, otherText, otherAmt, el('span', { class: 'muted' }, '×'), qty, remove]);
      const sync = () => { const o = item.value === '__other'; otherText.hidden = !o; otherAmt.hidden = !o; total(); };
      [item, otherAmt, qty].forEach(x => x.addEventListener('input', sync));
      item.addEventListener('change', sync);
      remove.addEventListener('click', () => { row.remove(); lineRows.splice(lineRows.indexOf(rec), 1); total(); });
      const rec = { row, value: () => item.value === '__other' ? { item: otherText.value.trim(), amount: Number(otherAmt.value), qty: Number(qty.value) || 1 } : { item: item.value, qty: Number(qty.value) || 1 } };
      lineRows.push(rec);
      lines.appendChild(row);
      sync();
    }
    function total() {
      const t = lineRows.reduce((n, r) => { const x = r.value(); const listed = settings.fees.find(f => f.item === x.item); return n + (listed ? listed.amount : (x.amount || 0)) * (x.qty || 1); }, 0);
      totalEl.textContent = `Total: ${naira(t)}`;
    }
    (v.fees.length ? v.fees : [null]).forEach(addLine);
    const feeBox = el('div', { class: 'form-field form-field--full' }, [
      el('span', { class: 'form-field__label' }, 'Filing fees (from the schedule)'), lines,
      el('div', { class: 'fee-actions' }, [el('button', { class: 'btn btn--small btn--ghost', type: 'button', onclick: () => addLine(null) }, '+ Add fee'), totalEl]),
      settings.fees.length ? null : el('span', { class: 'form-field__help' }, 'No fee schedule yet: an administrator sets it in Settings, Process Registry. Use Other meanwhile.')
    ]);
    const paidBox = el('div', { class: 'form-grid form-field--full' }, [
      feeBox,
      el('label', { class: 'form-field' }, [el('span', { class: 'form-field__label' }, 'Receipt number'), receiptNumber]),
      el('label', { class: 'form-field' }, [el('span', { class: 'form-field__label' }, existing && existing.receipt ? `Receipt file (uploaded: ${existing.receipt.name}; choose to replace)` : 'Receipt file (photo or PDF)'), receiptFile])
    ]);
    const syncOfficial = () => { if (efcc.checked) official.checked = true; official.disabled = efcc.checked; paidBox.hidden = official.checked; };
    efcc.addEventListener('change', syncOfficial); official.addEventListener('change', syncOfficial); syncOfficial();

    const f = (label, node, full) => el('label', { class: 'form-field' + (full ? ' form-field--full' : '') }, [el('span', { class: 'form-field__label' }, label), node]);
    const body = el('div', { class: 'form-grid' }, [
      f('Case type *', caseType), f('Date of filing', filedOn),
      f('First party * (Plaintiff, Claimant, Complainant, Petitioner)', first, true),
      f('Second party * (Defendant, Respondent, Accused)', second, true),
      f('Nature of case *', nature), f('Originating process', proc),
      f('Counsel', counsel), f('Counsel address', counselAddress),
      el('label', { class: 'check check--plain form-field--full' }, [efcc, ' EFCC matter (goes in turn to the courts that hear EFCC matters)']),
      el('label', { class: 'check check--plain form-field--full' }, [official, ' Official: no filing fee (criminal cases filed by the State, EFCC matters)']),
      paidBox
    ]);
    return ui.modal(existing ? 'Edit Filing' : 'New Case Filing', body, {
      confirmText: 'Save', noBackdropClose: true,
      onConfirm: async () => {
        const payload = { caseType: caseType.value, firstParty: first.value, secondParty: second.value, nature: nature.value, process: proc.value,
          counsel: counsel.value, counselAddress: counselAddress.value, filedOn: filedOn.value, efcc: efcc.checked, official: official.checked,
          fees: official.checked ? [] : lineRows.map(r => r.value()).filter(x => x.item), receiptNumber: receiptNumber.value };
        let r = existing ? await api.put(`/process/cases/${existing.id}`, payload) : await api.post('/process/cases', payload);
        if (!official.checked && receiptFile.files[0]) {
          const form = new FormData();
          form.append('file', receiptFile.files[0]);
          r = await api.post(`/process/cases/${r.case.id}/receipt`, form);
        }
        ui.toast(existing ? 'Filing updated.' : 'Filing saved. Send it to the Process Registrar when complete.', 'success', 5000);
        return r.case;
      }
    });
  }

  // ── One case: details and what this person can do with it ──
  async function openCase(ctx, settings, id, onDone) {
    const { ui, api } = ctx;
    let c;
    try { c = (await api.get(`/process/cases/${id}`)).case; } catch (e) { ui.toast(e.message, 'error'); return; }
    const me = settings.me;
    let dialog;
    const after = (msg) => (r) => { if (r) { ui.toast(msg, 'success', 6000); dialog && dialog.close(); onDone(); } };
    const act = (label, cls, fn, show) => show ? ui.el('button', { class: 'btn ' + cls, onclick: async () => { try { await fn(); } catch (e) { ui.toast(e.message, 'error', 8000); } } }, label) : null;
    const draftish = ['draft', 'returned'].includes(c.status);
    const actions = ui.el('div', { class: 'doc-preview__actions' }, [
      act('✕  Close', 'btn--ghost', async () => dialog.close(), true),
      act('Edit', 'btn--ghost', async () => { dialog.close(); const r = await filingForm(ctx, settings, c); if (r) onDone(); }, draftish || (c.status === 'submitted' && me.registrar)),
      act('Delete', 'btn--danger', async () => { if (!confirm('Delete this filing?')) return; await api.del(`/process/cases/${c.id}`); after('Filing deleted.')(true); }, draftish),
      act('➤  Send to Process Registrar', 'btn--primary', async () => { await api.post(`/process/cases/${c.id}/submit`); after('Sent to the Process Registrar.')(true); }, draftish && !me.registrar),
      act('Return with Comments', 'btn--danger', async () => {
        const comment = prompt('What must be corrected?');
        if (!comment) return;
        await api.post(`/process/cases/${c.id}/return`, { comment });
        after('Returned to the filer.')(true);
      }, c.status === 'submitted' && me.registrar),
      act('✔  Register and Give Number', 'btn--ok', async () => {
        if (!confirm(`Register this ${typeLabel(settings, c.caseType).toLowerCase()} case? It gets the next suit number and goes to the Hon. Chief Judge for assignment.`)) return;
        const r = await api.post(`/process/cases/${c.id}/register`);
        after(`Registered as ${r.case.suitNumber}. Proposed for ${r.case.proposed.name}; awaiting the Chief Judge.`)(true);
      }, (draftish || c.status === 'submitted') && me.registrar),
      act('🖨  Print Assignment Slip', 'btn--primary', async () => printSlip(c.id), !!c.assigned && !c.earlier)
    ]);
    ui.modal(c.suitNumber ? `Case ${c.suitNumber}` : 'Case Filing', ui.el('div', null, [actions, badge(ui, c.status), details(ui, c, settings)]),
      { noFooter: true, wide: true, onOpen: (o) => { dialog = o; } });
  }

  // ── Summary of a period ──
  async function renderSummary(box, ctx) {
    const { ui, api } = ctx;
    const el = ui.el;
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const now = new Date();
    const from = el('input', { type: 'date', value: iso(new Date(now.getFullYear(), now.getMonth(), 1)), 'aria-label': 'From' });
    const to = el('input', { type: 'date', value: iso(now), 'aria-label': 'To' });
    const out = el('div');
    async function run() {
      let s;
      try { s = await api.get(`/process/summary?from=${from.value}&to=${to.value}`); } catch (e) { out.replaceChildren(ui.empty(e.message)); return; }
      const card = (n, label, mod) => el('div', { class: 'dash-card' + (mod ? ' ' + mod : '') }, [el('div', { class: 'dash-card__num' }, String(n)), el('div', { class: 'dash-card__label' }, label)]);
      out.replaceChildren(
        el('div', { class: 'dash-stats' }, [card(s.registered, 'Cases registered'), card(s.official, 'Official (no fee)'), card(naira(s.fees), 'Fees recorded'),
          card(s.toRegister, 'Waiting to register', s.toRegister ? 'dash-card--warn' : ''), card(s.awaiting, 'Awaiting assignment now', s.awaiting ? 'dash-card--warn' : ''), card(s.disposed, 'Disposed of')]),
        el('div', { class: 'cols-2' }, [
          ui.table([{ label: 'Case type', key: 'label' }, { label: 'Registered', value: r => String(r.count) }], s.byType),
          s.byCourt.length ? ui.table([{ label: 'Court', key: 'name' }, { label: 'Cases assigned', value: r => String(r.count) }], s.byCourt) : ui.empty('No cases assigned in this period.')
        ])
      );
    }
    from.addEventListener('change', run); to.addEventListener('change', run);
    box.replaceChildren(el('div', { class: 'report-filters' }, [
      el('label', { class: 'report-filter' }, [el('span', null, 'From'), from]), el('label', { class: 'report-filter' }, [el('span', null, 'To'), to])
    ]), out);
    run();
  }

  window.App.modules.process = {
    async render(container, ctx) {
      const { ui, api, unit } = ctx;
      const el = ui.el;
      const settings = await api.get('/process/settings');
      container.appendChild(el('div', { class: 'page-head' }, [
        el('h1', null, unit.name),
        el('p', { class: 'muted' }, 'New cases: filing, fees and receipts, registration with the suit number, and assignment to a court by the Hon. Chief Judge.')
      ]));
      const tabsBar = el('div', { class: 'tabs', role: 'tablist' });
      const panel = el('div', { class: 'tab-panel' });
      container.append(tabsBar, panel);

      let filter = settings.me.registrar ? 'submitted' : 'draft,returned,submitted', term = '';
      async function renderFilings() {
        const status = el('select', { 'aria-label': 'Status' }, [
          ['draft,returned,submitted', 'Not yet registered'], ['submitted', 'With Process Registrar'], ['returned', 'Returned'],
          ['awaiting_assignment', 'Awaiting assignment'], ['assigned', 'Assigned (print the slip)'], ['received,disposed', 'With the courts'], ['', 'All']
        ].map(([v, t]) => el('option', { value: v }, t)));
        status.value = filter;
        const search = el('input', { type: 'search', class: 'search-input', placeholder: '🔍  Search suit no., party, nature, receipt no.', value: term });
        const list = el('div');
        const canFile = settings.me.inProcess;
        panel.replaceChildren(
          el('div', { class: 'toolbar' }, [
            canFile ? el('button', { class: 'btn btn--primary', onclick: async () => { const r = await filingForm(ctx, settings); if (r) load(); } }, '+ New Filing') : null,
            el('button', { class: 'btn btn--ghost', onclick: () => load() }, '↻ Refresh')
          ]),
          el('div', { class: 'filter-bar' }, [search, status]),
          list
        );
        status.addEventListener('change', () => { filter = status.value; load(); });
        search.addEventListener('change', () => { term = search.value.trim(); load(); });
        async function load() {
          let r;
          try { r = await api.get(`/process/cases?status=${encodeURIComponent(filter)}&q=${encodeURIComponent(term)}`); }
          catch (e) { list.replaceChildren(ui.empty(e.offline ? 'The Process Registry needs the internet.' : e.message)); return; }
          if (!r.cases.length) { list.replaceChildren(ui.empty('No cases here.')); return; }
          list.replaceChildren(ui.table([
            { label: 'Suit No.', node: c => caseNo(ui, c.suitNumber) },
            { label: 'Parties', value: c => parties(c) },
            { label: 'Type', value: c => typeLabel(settings, c.caseType) + (c.efcc ? ' (EFCC)' : '') },
            { label: 'Filed', value: c => day(c.filedOn) },
            { label: 'Fees', value: c => c.official ? 'Official' : naira(c.feeTotal) },
            { label: 'Status', node: c => badge(ui, c.status) },
            { label: 'Court', value: c => c.assigned ? `High Court No. ${c.assigned.roman}` : c.proposed ? `Proposed: ${c.proposed.name}` : '' }
          ], r.cases, [
            { label: 'Open', onClick: c => openCase(ctx, settings, c.id, load) },
            { label: '🖨 Slip', show: c => c.status === 'assigned', onClick: c => printSlip(c.id) }
          ]));
        }
        load();
      }
      const tabs = [['Filings', renderFilings], ['Summary', () => renderSummary(panel, ctx)]];
      tabs.forEach(([name, fn], i) => {
        const btn = el('button', { class: 'tab' + (i === 0 ? ' is-active' : ''), role: 'tab', onclick: () => {
          tabsBar.querySelectorAll('.tab').forEach(t => t.classList.remove('is-active'));
          btn.classList.add('is-active');
          fn();
        } }, name);
        tabsBar.appendChild(btn);
      });
      renderFilings();
    }
  };
})();
