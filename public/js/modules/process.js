/*
 * modules/process.js — the Process Registry.
 * Staff file new cases (fees, the invoice the filer takes to pay, then
 * the receipt; or Official for no fee) and send them to the Process
 * Registrar, who registers each one: the next suit
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
    awaiting_assignment: ['Awaiting Assignment', 'pending'], assigned: ['Assigned, file at Process Registry', 'pending'], dispatched: ['File dispatched', 'final'],
    received: ['File received', 'final'], disposed: ['Disposed', 'final']
  };
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const naira = (n) => '₦' + Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const day = (v) => v ? new Date(String(v).length === 10 ? v + 'T00:00:00' : v).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  function ordinalDate(v) {
    const d = new Date(v), n = d.getDate(), s = ['th', 'st', 'nd', 'rd'], m = n % 100;
    return `${n}${s[(m - 20) % 10] || s[m] || s[0]} ${d.toLocaleDateString('en-GB', { month: 'long' })} ${d.getFullYear()}`;
  }

  // 7500.5 → "Seven thousand, five hundred naira, fifty kobo only".
  function amountWords(total) {
    const ones = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
    const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
    const under100 = (n) => n < 20 ? ones[n] : tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '');
    const under1000 = (n) => [n >= 100 ? ones[Math.floor(n / 100)] + ' hundred' : '', n % 100 ? under100(n % 100) : ''].filter(Boolean).join(' and ');
    const words = (n) => {
      if (!n) return 'zero';
      const parts = [];
      [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand'], [1, '']].forEach(([k, name]) => {
        const x = Math.floor(n / k) % 1000;
        if (x) parts.push(under1000(x) + (name ? ' ' + name : ''));
      });
      return parts.join(', ');
    };
    const kobo = Math.round(Number(total || 0) * 100), n = Math.floor(kobo / 100), k = kobo % 100;
    const s = `${words(n)} naira${k ? ', ' + words(k) + ' kobo' : ''} only`;
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // Print some HTML on its own page size, then tidy up.
  async function printPage(html, pageCss, bodyClass) {
    const root = document.getElementById('print-root') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'print-root' }));
    root.innerHTML = html;
    await Promise.all([...root.querySelectorAll('img')].map(i => i.complete ? null : new Promise(r => { i.onload = i.onerror = r; setTimeout(r, 8000); })));
    const page = Object.assign(document.createElement('style'), { textContent: pageCss });
    document.head.appendChild(page);
    const classes = ['is-printing', ...(bodyClass ? [bodyClass] : [])];
    document.body.classList.add(...classes);
    const done = () => { document.body.classList.remove(...classes); root.innerHTML = ''; page.remove(); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print();
    setTimeout(done, 1000);
  }

  // GM/45c/2026 with the letter raised.
  function caseNoHtml(s) {
    const m = /^(.*\/\d+)([a-z]+)(\/\d{4})$/i.exec(String(s || ''));
    return m ? `${esc(m[1])}<sup>${esc(m[2].toLowerCase())}</sup>${esc(m[3])}` : esc(s || '');
  }
  const caseNo = (ui, s) => ui.el('span', { class: 'case-no', html: s ? caseNoHtml(s) : '<span class="muted">Not yet numbered</span>' });
  const badge = (ui, status) => { const [t, c] = STATUS[status] || [status, 'draft']; return ui.el('span', { class: 'badge badge--' + c }, t); };
  const parties = (c) => [c.firstParty, c.secondParty].filter(Boolean).join(' v. ');
  const typeLabel = (settings, key) => (settings.caseTypes.find(t => t.key === key) || { label: key }).label;

  function viewReceipt(id) { window.open(`/api/process/cases/${id}/receipt`, '_blank', 'noopener'); }

  // The facts of a case, for the review screens.
  function details(ui, c, settings) {
    const row = (k, v) => v ? ui.el('div', { class: 'doc-kv' }, [ui.el('strong', null, k + ': '), typeof v === 'string' ? v : v]) : null;
    return ui.el('div', { class: 'case-details' }, [
      row('Suit number', caseNo(ui, c.suitNumber)),
      row('Case type', typeLabel(settings, c.caseType) + (c.efcc ? ' · EFCC matter' : '')),
      row('Parties', parties(c)),
      row('Addresses', [c.firstPartyAddress && `First party: ${c.firstPartyAddress}`, c.secondPartyAddress && `Second party: ${c.secondPartyAddress}`].filter(Boolean).join('; ')),
      row('Nature of case', c.nature),
      row('Originating process', c.process),
      row('Counsel', [c.counsel, c.counselAddress].filter(Boolean).join(', ')),
      row('Date of filing', day(c.filedOn)),
      c.official ? row('Fees', 'Official: no filing fee') : row('Fees', `${c.fees.map(f => `${f.item}${f.qty > 1 ? ' × ' + f.qty : ''} ${naira(f.amount * f.qty)}`).join('; ')} · Total ${naira(c.feeTotal)}`),
      c.official ? null : row('Invoice', c.invoice ? `${c.invoice.reference}, issued ${day(c.invoice.issuedAt)} by ${c.invoice.issuedByName}` : 'Not yet issued'),
      invoiceStale(c) ? ui.el('div', { class: 'notice notice--warn' }, 'The fees changed after the invoice was issued. Print the invoice again so it shows the new fees (the reference stays the same).') : null,
      c.official ? null : row('Receipt', ui.el('span', null, [c.receiptNumber || 'No number',
        c.receipt ? (settings.me && (settings.me.inProcess || settings.me.chiefJudge) ? ui.el('button', { class: 'btn btn--small btn--ghost', type: 'button', onclick: () => viewReceipt(c.id) }, '📄 View receipt') : ' · uploaded') : ' · not uploaded'])),
      row('Email updates to', emailList(c)),
      row('Emails sent', emailSent(c)),
      row('Filed by', c.createdByName),
      row('Registered', c.registeredAt ? `${day(c.registeredAt)} by ${c.registeredByName}` : ''),
      row('Proposed court', c.proposed && c.status === 'awaiting_assignment' ? c.proposed.name : ''),
      row('Assigned to', c.assigned ? `High Court No. ${c.assigned.roman} on ${day(c.assignedAt)}${c.assignment ? ', by ' + [c.assignment.title, c.assignment.name].filter(Boolean).join(' ') : ''}` : ''),
      row('File dispatched', c.dispatchedAt ? `${day(c.dispatchedAt)} by ${c.dispatchedByName}` : ''),
      row('File received', c.receivedAt ? `${day(c.receivedAt)} by ${c.receivedByName}` : ''),
      row('Remark', c.disposal ? `${c.disposal.remark} (${day(c.disposal.date)})` : ''),
      c.status === 'returned' && c.returnComment ? ui.el('div', { class: 'notice notice--warn' }, `Returned by ${c.returnedByName}: ${c.returnComment}`) : null
    ]);
  }

  const emailList = (c) => { const e = c.emails || {}; return [['First party', e.firstParty], ['Second party', e.secondParty], ['Counsel', e.counsel]].filter(([, l]) => l && l.length).map(([k, l]) => `${k}: ${l.join(', ')}`).join('; '); };
  // "Registered 21 Oct 2026 (3 sent)", one per stage, latest first.
  function emailSent(c) {
    const by = {};
    (c.emailLog || []).forEach(e => { const k = e.stage + day(e.at); (by[k] = by[k] || { label: e.label, at: e.at, ok: 0, failed: 0 })[e.ok ? 'ok' : 'failed']++; });
    return Object.values(by).reverse().map(g => `${g.label} ${day(g.at)} (${g.ok} sent${g.failed ? `, ${g.failed} failed` : ''})`).join('; ');
  }
  const feeKey = (fees) => JSON.stringify((fees || []).map(f => [f.item, Number(f.amount), Number(f.qty)]));
  const invoiceStale = (c) => !c.official && c.invoice && feeKey(c.invoice.fees) !== feeKey(c.fees);

  // The invoice the filer takes to pay: the fees chosen, the total and a
  // reference to quote when they bring the receipt back.
  // office: who issues it (the Process Registry, or a court registry for a later process).
  function printInvoice(c, settings, office) {
    const inv = c.invoice;
    const at = office || 'Process Registry';
    const rows = inv.fees.map((f, i) => `<tr><td>${i + 1}</td><td>${esc(f.item)}</td><td class="num">${f.qty}</td><td class="num">${esc(naira(f.amount))}</td><td class="num">${esc(naira(f.amount * f.qty))}</td></tr>`).join('');
    const kv = (k, v) => v ? `<div class="doc-kv"><strong>${esc(k)}:</strong> ${esc(v)}</div>` : '';
    return printPage(`<article class="court-doc invoice-print">
      <header class="doc-masthead"><img class="doc-emblem" src="/assets/highcourt.png" alt="">
        <div class="doc-titleblock"><div class="doc-line1">THE JUDICIARY</div><div class="doc-line2">GOMBE STATE HIGH COURT OF JUSTICE</div><div class="doc-line3">${esc(at.toUpperCase())}</div></div>
        <img class="doc-emblem" src="/assets/coat.png" alt=""></header><div class="doc-rule"></div>
      <h2 class="invoice-title">INVOICE</h2>
      <div class="invoice-meta"><div><strong>Reference:</strong> ${esc(inv.reference)}</div><div><strong>Date:</strong> ${esc(day(inv.issuedAt))}</div></div>
      ${kv('Suit number', c.suitNumber)}${kv('Name of case', parties(c))}${kv('Case type', typeLabel(settings, c.caseType))}${kv('Nature of case', c.nature)}${kv(c.laterProcess ? 'Process' : 'Originating process', c.laterProcess || c.process)}${kv('Counsel', c.counsel)}
      <table class="doc-table invoice-table"><thead><tr><th>S/No</th><th>Item</th><th class="num">Qty</th><th class="num">Amount</th><th class="num">Total</th></tr></thead>
        <tbody>${rows}</tbody><tfoot><tr><th colspan="4">TOTAL</th><th class="num">${esc(naira(inv.total))}</th></tr></tfoot></table>
      <div class="doc-kv"><strong>Amount in words:</strong> ${esc(amountWords(inv.total))}</div>
      ${settings.paymentNote ? `<div class="invoice-pay"><strong>Payment details</strong><div>${esc(settings.paymentNote)}</div></div>` : ''}
      <p class="invoice-note">After payment, bring the receipt to the ${esc(at)} and quote the reference ${esc(inv.reference)}.</p>
      <div class="doc-kv">Issued by: ${esc(inv.issuedByName)}</div>
      <footer class="doc-footer"><span>Printed ${esc(day(new Date()))}</span><span>Powered by the Directorate of ICT, Gombe State High Court of Justice</span></footer>
    </article>`, '@page { size: A5; margin: 10mm; }');
  }

  // "Musa Bello and others" when a side has several parties (one per line).
  function shortParty(s) {
    const lines = String(s || '').split(/\n+/).map(x => x.trim().replace(/^\(?\d+[.)]\s*/, '')).filter(Boolean);
    if (!lines.length) return '';
    const first = lines[0].length > 60 ? lines[0].slice(0, 57).trim() + '…' : lines[0];
    return lines.length > 1 ? `${first} and others` : first;
  }
  const slipParties = (c) => [shortParty(c.firstParty), shortParty(c.secondParty)].filter(Boolean).join(' v. ');

  // The small slip fixed to the file: the court, the suit number and the
  // parties (so a slip that comes off can be traced to its file), the date,
  // the Chief Judge's signature and the QR code.
  function slipHtml(c) {
    return `<article class="case-slip">
      <div class="slip-court">GOMBE STATE HIGH COURT OF JUSTICE</div>
      <div class="slip-label">ASSIGNED TO</div>
      <div class="slip-assigned">HIGH COURT No. ${esc(c.assigned.roman)}</div>
      <div class="slip-suit">Suit No. ${caseNoHtml(c.suitNumber)}</div>
      <div class="slip-parties">${esc(slipParties(c))}</div>
      <div class="slip-date">Date of assignment: ${esc(ordinalDate(c.assignedAt))}</div>
      <div class="slip-foot">
        <div class="slip-sign"><img src="${esc(c.signatureUrl)}" alt="Signature"><div class="slip-line"></div>
          <div>${esc([c.assignment.title, c.assignment.name].filter(Boolean).join(' '))}</div><div class="slip-cap">Chief Judge</div></div>
        <div class="slip-qr"><img src="${esc(c.qrDataUrl)}" alt="QR code"><div>${esc(c.verifyCode)}</div></div>
      </div>
    </article>`;
  }

  // One slip, or several at once (one A6 page each).
  async function printSlips(ids) {
    const { api, ui } = window.App;
    let list;
    try { list = await Promise.all(ids.map(id => api.get(`/process/cases/${id}`).then(r => r.case))); } catch (e) { ui.toast(e.message, 'error'); return; }
    list = list.filter(c => c.assigned && c.assignment);
    if (!list.length) { ui.toast('The case is not assigned yet.', 'error'); return; }
    await printPage(list.map(slipHtml).join(''), '@page { size: 148mm 105mm; margin: 0; }', 'is-printing-slip');
  }
  const printSlip = (id) => printSlips([id]);

  // Optional: a list of the files dispatched, by court, for the receiving clerk to sign.
  function printDispatchList(cases) {
    const byCourt = {};
    cases.forEach(c => (byCourt[c.assigned.key] = byCourt[c.assigned.key] || { court: c.assigned, list: [] }).list.push(c));
    const groups = Object.values(byCourt).sort((a, b) => a.court.courtNo - b.court.courtNo).map(g => `
      <h3>High Court No. ${esc(g.court.roman)}</h3>
      <table class="doc-table"><thead><tr><th>S/No</th><th>Suit number</th><th>Name of case</th><th>Received by (name and signature)</th><th>Date</th></tr></thead>
      <tbody>${g.list.map((c, i) => `<tr><td>${i + 1}</td><td>${caseNoHtml(c.suitNumber)}</td><td>${esc(slipParties(c))}</td><td class="dispatch-sign"></td><td></td></tr>`).join('')}</tbody></table>`).join('');
    return printPage(`<article class="court-doc report-print">
      <header class="doc-masthead"><img class="doc-emblem" src="/assets/highcourt.png" alt="">
        <div class="doc-titleblock"><div class="doc-line1">THE JUDICIARY</div><div class="doc-line2">GOMBE STATE HIGH COURT OF JUSTICE</div><div class="doc-line3">PROCESS REGISTRY · DISPATCH LIST</div></div>
        <img class="doc-emblem" src="/assets/coat.png" alt=""></header><div class="doc-rule"></div>
      <p>Files dispatched on ${esc(ordinalDate(cases[0].dispatchedAt || new Date()))} by ${esc(cases[0].dispatchedByName || '')}.</p>
      ${groups}
      <footer class="doc-footer"><span>Printed ${esc(day(new Date()))}</span><span>Powered by the Directorate of ICT, Gombe State High Court of Justice</span></footer>
    </article>`, '@page { size: A4; margin: 12mm; }');
  }

  // Choose assigned cases to print slips for, or to dispatch.
  async function pickAssigned(ctx, mode, onDone) {
    const { ui, api } = ctx;
    const el = ui.el;
    let list;
    try { list = (await api.get('/process/cases?status=assigned')).cases; } catch (e) { ui.toast(e.message, 'error'); return; }
    if (!list.length) { ui.toast('No assigned case is waiting at the Process Registry.', 'info'); return; }
    const boxes = list.map(c => { const b = el('input', { type: 'checkbox', value: c.id }); b.checked = true; return b; });
    const all = el('input', { type: 'checkbox' }); all.checked = true;
    all.addEventListener('change', () => boxes.forEach(b => { b.checked = all.checked; }));
    const withList = el('input', { type: 'checkbox' });
    const body = el('div', null, [
      el('p', { class: 'muted' }, mode === 'dispatch'
        ? 'Tick the files leaving the Process Registry now. Each court is told, and can then mark the file received.'
        : 'Tick the cases to print. Each slip prints on its own A6 card with the suit number and parties, to match it to its file.'),
      el('label', { class: 'check check--plain' }, [all, ' All']),
      el('div', { class: 'pick-list' }, list.map((c, i) => el('label', { class: 'check check--plain pick-row' }, [boxes[i],
        el('span', null, [caseNo(ui, c.suitNumber), ` ${slipParties(c)} · High Court No. ${c.assigned.roman}`])]))),
      mode === 'dispatch' ? el('label', { class: 'check check--plain' }, [withList, ' Also print a Dispatch List for the receiving clerks to sign (optional)']) : null
    ]);
    const picked = await ui.modal(mode === 'dispatch' ? 'Dispatch Files' : 'Print Slips', body, {
      confirmText: mode === 'dispatch' ? 'Dispatch' : 'Print',
      onConfirm: async () => {
        const ids = boxes.filter(b => b.checked).map(b => b.value);
        if (!ids.length) throw new Error('Tick at least one case.');
        if (mode !== 'dispatch') return ids;
        const r = await api.post('/process/dispatch', { ids });
        ui.toast(`${r.dispatched} file${r.dispatched > 1 ? 's' : ''} dispatched. The courts have been told.`, 'success', 6000);
        return r;
      }
    });
    if (!picked) return;
    if (mode === 'dispatch') { if (withList.checked) await printDispatchList(picked.cases); }
    else await printSlips(picked);
    if (onDone) onDone();
  }

  // ── Scanned documents of a case: the list, Open, Delete, and + Add Document ──
  const size = (n) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
  // processId: the documents of one process filed later (others of the case are not listed).
  function documentsPanel(ui, api, caseId, processId, processType) {
    const el = ui.el;
    const box = el('div', { class: 'case-docs' }, el('p', { class: 'muted' }, 'Loading documents…'));
    async function load() {
      let r;
      try { r = await api.get(`/process/cases/${caseId}/documents`); } catch (e) { box.replaceChildren(el('p', { class: 'muted' }, e.offline ? 'Documents need the internet.' : e.message)); return; }
      if (processId) r.documents = r.documents.filter(d => d.processId === processId);
      box.replaceChildren(
        el('div', { class: 'case-docs__head' }, [el('h3', null, `${processId ? 'Documents of this process' : 'Documents'} (${r.documents.length})`),
          r.canUpload ? el('button', { class: 'btn btn--small btn--primary', type: 'button', onclick: () => add(r.docTypes) }, '+ Add Document') : null]),
        r.documents.length ? ui.table([
          { label: 'Date filed', value: d => day(d.filedOn) },
          { label: 'Title', value: d => d.title },
          { label: 'Type', value: d => d.docType && d.docType !== d.title ? d.docType : '' },
          { label: 'Size', value: d => size(d.bytes) },
          { label: 'Added by', value: d => `${d.uploadedByName}, ${day(d.uploadedAt)}` }
        ], r.documents, [
          { label: 'Open', onClick: d => window.open(d.url, '_blank', 'noopener') },
          { label: 'Delete', class: 'btn--danger', show: d => d.canDelete, onClick: async d => {
            if (!confirm(`Delete "${d.title}" from this case?`)) return;
            try { await api.del(`/process/documents/${d.id}`); ui.toast('Document deleted.', 'success'); load(); } catch (e) { ui.toast(e.message, 'error'); }
          } }
        ]) : el('p', { class: 'muted' }, r.canUpload ? 'No scanned documents yet. Use + Add Document to attach the writ, motions, affidavits, exhibits and so on.' : 'No scanned documents yet.')
      );
    }
    function add(types) {
      const type = el('select', null, [...types, 'Others'].map(t => el('option', { value: t }, t === 'Others' ? 'Others (type it)' : t)));
      const other = el('input', { type: 'text', placeholder: 'Type of document' });
      const title = el('input', { type: 'text', placeholder: 'e.g. Motion on notice for interlocutory injunction (optional)', value: processType || '' });
      const filed = el('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
      const files = el('input', { type: 'file', accept: 'application/pdf,image/png,image/jpeg', multiple: 'multiple' });
      const otherRow = ui.field('Type of document', other);
      const sync = () => { otherRow.hidden = type.value !== 'Others'; };
      type.addEventListener('change', sync); sync();
      ui.modal('Add Document', el('div', null, [
        ui.field('Document', type), otherRow, ui.field('Title', title, 'Leave empty to use the type of document.'), ui.field('Date filed', filed),
        ui.field('Scanned file(s)', files, 'PDF or photo, up to 10 MB each. Scan at 200 dpi in greyscale. Choose several files for a long document: each is kept as a part.')
      ]), {
        confirmText: 'Upload',
        onConfirm: async () => {
          const list = [...files.files];
          if (!list.length) throw new Error('Choose the scanned file.');
          const big = list.find(f => f.size > 10 * 1024 * 1024);
          if (big) throw new Error(`${big.name} is over 10 MB. Scan at 200 dpi in greyscale, or split it into parts.`);
          for (let i = 0; i < list.length; i++) {
            const form = new FormData();
            form.append('docType', type.value); form.append('other', other.value); form.append('filedOn', filed.value);
            if (processId) form.append('process', processId);
            const t = title.value.trim() || (type.value === 'Others' ? other.value.trim() : type.value);
            form.append('title', list.length > 1 ? `${t} (part ${i + 1} of ${list.length})` : t);
            form.append('file', list[i]);
            ui.toast(`Uploading ${list.length > 1 ? `part ${i + 1} of ${list.length}` : list[i].name}…`, 'info', 3000);
            await api.post(`/process/cases/${caseId}/documents`, form);
          }
          ui.toast(list.length > 1 ? `${list.length} parts added.` : 'Document added.', 'success');
          load();
          return true;
        }
      });
    }
    load();
    return box;
  }

  // ── Processes filed later in a case, at the court's registry ──
  // The list (in the case's View), + File a Process, and each process:
  // fees, invoice, receipt, its documents.
  function processesPanel(ctx, c, settings, unit) {
    const { ui, api } = ctx;
    const el = ui.el;
    const box = el('div', { class: 'case-docs' }, el('p', { class: 'muted' }, 'Loading processes…'));
    async function load() {
      let r;
      try { r = await api.get(`/process/cases/${c.id}/processes`); } catch (e) { box.replaceChildren(el('p', { class: 'muted' }, e.message)); return; }
      box.replaceChildren(
        el('div', { class: 'case-docs__head' }, [el('h3', null, `Processes filed (${r.processes.length})`),
          r.canFile ? el('button', { class: 'btn btn--small btn--primary', type: 'button', onclick: async () => { if (await processForm(null, r.processTypes)) load(); } }, '📎 File a Process') : null]),
        r.processes.length ? ui.table([
          { label: 'Date filed', value: p => day(p.filedOn) },
          { label: 'Process', value: p => p.processType },
          { label: 'Fees', value: p => p.feeTotal ? naira(p.feeTotal) : 'None' },
          { label: 'Invoice', value: p => p.invoice ? p.invoice.reference : '' },
          { label: 'Receipt', node: p => p.paid ? el('span', null, p.receiptNumber) : el('span', { class: 'badge badge--pending' }, p.feeTotal ? 'Awaiting payment' : 'No fee') }
        ], r.processes, [{ label: 'Open', onClick: p => openProcess(p, r) }])
          : el('p', { class: 'muted' }, r.canFile ? 'No process filed yet in this case. Use 📎 File a Process for a motion or any other process filed later.' : 'No process filed yet in this case.')
      );
    }
    // New or edit: the process, the date, the fees, the receipt.
    async function processForm(existing, types) {
      const v = existing || { fees: [], filedOn: new Date().toISOString().slice(0, 10) };
      const type = el('select', null, [...types, 'Others'].map(t => el('option', { value: t }, t === 'Others' ? 'Others (type it)' : t)));
      const other = el('input', { type: 'text', placeholder: 'e.g. Notice of preliminary objection' });
      if (existing) { if (types.includes(existing.processType)) type.value = existing.processType; else { type.value = 'Others'; other.value = existing.processType; } }
      const otherRow = ui.field('The process', other);
      const sync = () => { otherRow.hidden = type.value !== 'Others'; };
      type.addEventListener('change', sync); sync();
      const filedOn = el('input', { type: 'date', value: v.filedOn || '' });
      const fees = feeEditor(ui, settings, v.fees, 'Fees (from the schedule)');
      const receiptNumber = el('input', { type: 'text', value: v.receiptNumber || '' });
      const receiptFile = el('input', { type: 'file', accept: 'image/png,image/jpeg,application/pdf' });
      return ui.modal(existing ? `Edit Process · ${c.suitNumber}` : `File a Process · ${c.suitNumber}`, el('div', { class: 'form-grid' }, [
        el('p', { class: 'muted form-field--full' }, `${parties(c)}. Recorded against the suit number. Save, then open it and print the invoice for the filer to pay at revenue; enter the receipt when they bring it.`),
        ui.field('Process *', type), otherRow, ui.field('Date filed', filedOn), fees.node,
        ui.field('Receipt number', receiptNumber),
        ui.field(existing && existing.receipt ? `Receipt file (uploaded: ${existing.receipt.name}; choose to replace)` : `Receipt file (photo or PDF${settings.receiptRequired ? '' : ', optional'})`, receiptFile)
      ]), {
        confirmText: 'Save', noBackdropClose: true,
        onConfirm: async () => {
          const payload = { processType: type.value, other: other.value, filedOn: filedOn.value, fees: fees.values(), receiptNumber: receiptNumber.value };
          let r = await withReceiptCheck((x) => existing ? api.put(`/process/processes/${existing.id}`, { ...payload, ...x }) : api.post(`/process/cases/${c.id}/processes`, { ...payload, ...x }));
          if (!r) return undefined;
          if (receiptFile.files[0]) {
            const form = new FormData(); form.append('file', receiptFile.files[0]);
            r = await api.post(`/process/processes/${r.process.id}/receipt`, form);
          }
          ui.toast(existing ? 'Process updated.' : 'Process recorded. Open it to print the invoice.', 'success', 5000);
          return r.process;
        }
      });
    }
    function openProcess(p, r) {
      let dialog;
      const act = (label, cls, fn, show) => show ? el('button', { class: 'btn ' + cls, onclick: async () => { try { await fn(); } catch (e) { ui.toast(e.message, 'error', 8000); } } }, label) : null;
      const reopen = (x) => { dialog.close(); load(); if (x) openProcess(x, r); };
      const row = (k, val) => val ? el('div', { class: 'doc-kv' }, [el('strong', null, k + ': '), val]) : null;
      ui.modal(`${p.processType} · ${c.suitNumber}`, el('div', null, [
        el('div', { class: 'doc-preview__actions' }, [
          act('✕  Close', 'btn--ghost', async () => dialog.close(), true),
          act('Edit', 'btn--ghost', async () => { dialog.close(); const x = await processForm(p, r.processTypes); load(); if (x) openProcess(x, r); }, r.canFile),
          act('🧾  Print Invoice', 'btn--primary', async () => {
            let x = p;
            if (!p.invoice || JSON.stringify(p.invoice.fees.map(f => [f.item, f.amount, f.qty])) !== JSON.stringify(p.fees.map(f => [f.item, f.amount, f.qty]))) x = (await api.post(`/process/processes/${p.id}/invoice`)).process;
            await printInvoice({ ...c, laterProcess: x.processType, invoice: x.invoice }, settings, unit ? `${unit.name}` : 'Court Registry');
            if (x !== p) reopen(x);
          }, r.canFile && p.feeTotal > 0),
          act('Delete', 'btn--danger', async () => { if (!confirm('Delete this process? It has no receipt yet.')) return; await api.del(`/process/processes/${p.id}`); ui.toast('Process deleted.', 'success'); reopen(); }, r.canFile && !p.receiptNumber)
        ]),
        el('div', { class: 'case-details' }, [
          row('Suit number', caseNo(ui, c.suitNumber)), row('Name of case', parties(c)), row('Process', p.processType), row('Date filed', day(p.filedOn)),
          row('Fees', p.fees.length ? `${p.fees.map(f => `${f.item}${f.qty > 1 ? ' × ' + f.qty : ''} ${naira(f.amount * f.qty)}`).join('; ')} · Total ${naira(p.feeTotal)}` : 'None'),
          row('Invoice', p.invoice ? `${p.invoice.reference}, issued ${day(p.invoice.issuedAt)} by ${p.invoice.issuedByName}` : (p.feeTotal ? 'Not yet issued' : '')),
          row('Receipt', p.receiptNumber ? el('span', null, [p.receiptNumber, p.receipt ? el('button', { class: 'btn btn--small btn--ghost', type: 'button', onclick: () => window.open(`/api/process/processes/${p.id}/receipt`, '_blank', 'noopener') }, '📄 View receipt') : ' · file not uploaded']) : 'Not yet entered'),
          row('Recorded by', `${p.createdByName}, ${day(p.createdAt)}`)
        ]),
        documentsPanel(ui, api, c.id, p.id, p.processType)
      ]), { noFooter: true, wide: true, onOpen: (o) => { dialog = o; } });
    }
    load();
    return box;
  }

  window.App.processUi = { caseNoHtml, caseNo, badge, details, documentsPanel, processesPanel, feeEditor, withReceiptCheck, viewReceipt, printSlip, printSlips, printPage, amountWords, shortParty, parties, day, naira, STATUS };

  // Fee lines from the schedule (or Other with a typed amount), their total,
  // and + Add fee: for a new filing and for a process filed later.
  function feeEditor(ui, settings, fees, label) {
    const el = ui.el;
    const input = (val, attrs) => el('input', { type: 'text', value: val || '', ...(attrs || {}) });
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
    ((fees && fees.length) ? fees : [null]).forEach(addLine);
    const node = el('div', { class: 'form-field form-field--full' }, [
      el('span', { class: 'form-field__label' }, label), lines,
      el('div', { class: 'fee-actions' }, [el('button', { class: 'btn btn--small btn--ghost', type: 'button', onclick: () => addLine(null) }, '+ Add fee'), totalEl]),
      settings.fees.length ? null : el('span', { class: 'form-field__help' }, 'No fee schedule yet: an administrator sets it in Settings, Process Registry. Use Other meanwhile.')
    ]);
    return { node, values: () => lineRows.map(r => r.value()).filter(x => x.item) };
  }

  // Save, and where the receipt number is already on another filing, let a
  // registrar (or an administrator) confirm a genuine exception.
  async function withReceiptCheck(send) {
    try { return await send({}); }
    catch (e) {
      if (!(e.body && e.body.duplicateReceipt) || !e.body.canConfirm) throw e;
      if (!confirm(e.message + '\n\nConfirm that this receipt truly pays for this filing too?')) return null;
      return send({ confirmDuplicateReceipt: true });
    }
  }

  // ── The filing form ──
  function filingForm(ctx, settings, existing) {
    const { ui, api } = ctx;
    const el = ui.el;
    const v = existing || { caseType: settings.caseTypes[0].key, fees: [], filedOn: new Date().toISOString().slice(0, 10) };
    const input = (val, attrs) => el('input', { type: 'text', value: val || '', ...(attrs || {}) });
    const caseType = el('select', null, settings.caseTypes.map(t => el('option', { value: t.key }, t.label)));
    caseType.value = v.caseType;
    const several = 'Where there are several, one per line (the slip shows the first and "and others")';
    const first = el('textarea', { rows: 2, placeholder: several }, v.firstParty || ''), second = el('textarea', { rows: 2, placeholder: several }, v.secondParty || '');
    const nature = input(v.nature, { placeholder: 'e.g. Land, Contract, Matrimonial' });
    const proc = input(v.process, { placeholder: 'e.g. Writ of summons, Originating summons, Petition, Charge' });
    const counsel = input(v.counsel), counselAddress = el('textarea', { rows: 2 }, v.counselAddress || '');
    const firstAddress = el('textarea', { rows: 2, placeholder: 'Optional: filled into summonses and notices' }, v.firstPartyAddress || '');
    const secondAddress = el('textarea', { rows: 2, placeholder: 'Optional: filled into summonses and notices' }, v.secondPartyAddress || '');
    const filedOn = el('input', { type: 'date', value: v.filedOn || '' });
    const efcc = el('input', { type: 'checkbox' }); efcc.checked = !!v.efcc;
    const official = el('input', { type: 'checkbox' }); official.checked = !!v.official;
    const receiptNumber = input(v.receiptNumber);
    const ve = v.emails || {};
    const emailBox = (list) => input((list || []).join(', '), { type: 'email', multiple: 'multiple', placeholder: 'name@example.com (several: separate with commas)' });
    const firstEmail = emailBox(ve.firstParty), secondEmail = emailBox(ve.secondParty), counselEmail = emailBox(ve.counsel);
    const receiptFile = el('input', { type: 'file', accept: 'image/png,image/jpeg,application/pdf' });

    const feeEd = feeEditor(ui, settings, v.fees, 'Filing fees (from the schedule)');
    const feeBox = feeEd.node;
    const paidBox = el('div', { class: 'form-grid form-field--full' }, [
      feeBox,
      el('p', { class: 'form-field__help form-field--full' }, 'Save the filing, then open it and click Print Invoice for the filer to go and pay. Enter the receipt number when they bring the receipt.'),
      el('label', { class: 'form-field' }, [el('span', { class: 'form-field__label' }, 'Receipt number'), receiptNumber]),
      el('label', { class: 'form-field' }, [el('span', { class: 'form-field__label' }, existing && existing.receipt ? `Receipt file (uploaded: ${existing.receipt.name}; choose to replace)` : `Receipt file (photo or PDF${settings.receiptRequired ? '' : ', optional'})`), receiptFile])
    ]);
    const syncOfficial = () => { if (efcc.checked) official.checked = true; official.disabled = efcc.checked; paidBox.hidden = official.checked; };
    efcc.addEventListener('change', syncOfficial); official.addEventListener('change', syncOfficial); syncOfficial();

    const f = (label, node, full) => el('label', { class: 'form-field' + (full ? ' form-field--full' : '') }, [el('span', { class: 'form-field__label' }, label), node]);
    const body = el('div', { class: 'form-grid' }, [
      f('Case type *', caseType), f('Date of filing', filedOn),
      f('First party * (Plaintiff, Claimant, Complainant, Petitioner)', first, true),
      f('Second party * (Defendant, Respondent, Accused)', second, true),
      f('First party address', firstAddress), f('Second party address', secondAddress),
      f('Nature of case *', nature), f('Originating process', proc),
      f('Counsel', counsel), f('Counsel address', counselAddress),
      settings.partyEmails === false ? null : el('div', { class: 'form-grid form-field--full' }, [
        el('p', { class: 'form-field__help form-field--full' }, 'Email updates (optional): each address given gets a short email when the invoice is issued, the case is registered, assigned to a court and the file received there.'),
        f('First party email', firstEmail), f('Second party email', secondEmail), f('Counsel email', counselEmail)
      ]),
      el('label', { class: 'check check--plain form-field--full' }, [efcc, ' EFCC matter (goes in turn to the courts that hear EFCC matters)']),
      el('label', { class: 'check check--plain form-field--full' }, [official, ' Official: no filing fee (criminal cases filed by the State, EFCC matters)']),
      paidBox
    ]);
    return ui.modal(existing ? 'Edit Filing' : 'New Case Filing', body, {
      confirmText: 'Save', noBackdropClose: true,
      onConfirm: async () => {
        const payload = { caseType: caseType.value, firstParty: first.value, secondParty: second.value, nature: nature.value, process: proc.value,
          counsel: counsel.value, counselAddress: counselAddress.value, firstPartyAddress: firstAddress.value, secondPartyAddress: secondAddress.value, filedOn: filedOn.value, efcc: efcc.checked, official: official.checked,
          fees: official.checked ? [] : feeEd.values(), receiptNumber: receiptNumber.value,
          ...(settings.partyEmails === false ? {} : { emails: { firstParty: firstEmail.value, secondParty: secondEmail.value, counsel: counselEmail.value } }) };
        let r = await withReceiptCheck((x) => existing ? api.put(`/process/cases/${existing.id}`, { ...payload, ...x }) : api.post('/process/cases', { ...payload, ...x }));
        if (!r) return undefined;
        if (!official.checked && receiptFile.files[0]) {
          const form = new FormData();
          form.append('file', receiptFile.files[0]);
          r = await api.post(`/process/cases/${r.case.id}/receipt`, form);
        }
        ui.toast(existing ? 'Filing updated.' : 'Filing saved.', 'success', 5000);
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
    const after = (msg) => (r) => { if (r) { ui.toast(msg, 'success', 6000); dialog && dialog.close(); onDone(); window.App.router.refreshBadges(); } };
    const act = (label, cls, fn, show) => show ? ui.el('button', { class: 'btn ' + cls, onclick: async () => { try { await fn(); } catch (e) { ui.toast(e.message, 'error', 8000); } } }, label) : null;
    const draftish = ['draft', 'returned'].includes(c.status);
    const editable = draftish || (c.status === 'submitted' && me.registrar);
    const actions = ui.el('div', { class: 'doc-preview__actions' }, [
      act('✕  Close', 'btn--ghost', async () => dialog.close(), true),
      act('Edit', 'btn--ghost', async () => { dialog.close(); const r = await filingForm(ctx, settings, c); if (r) onDone(); }, draftish || (c.status === 'submitted' && me.registrar)),
      act('🧾  Print Invoice', 'btn--primary', async () => {
        // Issued (or brought up to date) while the filing can change; printed as issued after that.
        const issue = editable && (!c.invoice || invoiceStale(c));
        if (issue) c = (await api.post(`/process/cases/${c.id}/invoice`)).case;
        await printInvoice(c, settings);
        if (issue) { dialog.close(); onDone(); openCase(ctx, settings, c.id, onDone); } // show the reference now issued
      }, !c.official && c.feeTotal > 0 && me.inProcess && (editable || !!c.invoice)),
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
      act('🖨  Print Assignment Slip', 'btn--primary', async () => printSlip(c.id), !!c.assigned && !c.earlier),
      act('📦  Dispatch File', 'btn--ok', async () => {
        if (!confirm(`Dispatch the file of ${c.suitNumber} to High Court No. ${c.assigned.roman}? The court can then mark it received.`)) return;
        await api.post('/process/dispatch', { ids: [c.id] });
        after(`File ${c.suitNumber} dispatched. The court has been told.`)(true);
      }, c.status === 'assigned' && me.inProcess)
    ]);
    ui.modal(c.suitNumber ? `Case ${c.suitNumber}` : 'Case Filing', ui.el('div', null, [actions, badge(ui, c.status), details(ui, c, settings), documentsPanel(ui, api, c.id)]),
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
          ['awaiting_assignment', 'Awaiting assignment'], ['assigned', 'Assigned (slip and dispatch)'], ['dispatched', 'Dispatched'], ['received,disposed', 'With the courts'], ['', 'All']
        ].map(([v, t]) => el('option', { value: v }, t)));
        status.value = filter;
        const search = el('input', { type: 'search', class: 'search-input', placeholder: '🔍  Search suit no., party, nature, invoice or receipt no.', value: term });
        const list = el('div');
        const canFile = settings.me.inProcess;
        panel.replaceChildren(
          el('div', { class: 'toolbar' }, [
            canFile ? el('button', { class: 'btn btn--primary', onclick: async () => { const r = await filingForm(ctx, settings); if (r) { load(); openCase(ctx, settings, r.id, load); } } }, '+ New Filing') : null,
            canFile ? el('button', { class: 'btn btn--ghost', onclick: () => pickAssigned(ctx, 'slips', load) }, '🖨 Print Slips') : null,
            canFile ? el('button', { class: 'btn btn--ghost', onclick: () => pickAssigned(ctx, 'dispatch', () => { load(); window.App.router.refreshBadges(); }) }, '📦 Dispatch Files') : null,
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
            { label: '🖨 Slip', show: c => ['assigned', 'dispatched'].includes(c.status), onClick: c => printSlip(c.id) }
          ]));
        }
        load();
      }
      const tabs = [['Filings', renderFilings], ['Summary', () => renderSummary(panel, ctx)],
        ['Fees List', () => { panel.replaceChildren(); window.App.feesUi.render(panel, ctx, 'process'); }]];
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
