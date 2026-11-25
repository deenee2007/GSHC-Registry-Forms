/*
 * modules/cashflow.js — the monthly cash flow.
 *
 * Requesters (the CJ's aide, the Chief Registrar, the DCR Admin and
 * Finance) request items; each goes to the DCR Admin and Finance, who may
 * correct it or return it with a query, enters its beneficiaries (bank,
 * account number, amount: the request for the release of funds), and
 * submits it to the Hon. Chief Judge (the month's cash flow, selected
 * items, or a supplementary submission). The Chief Judge approves (all,
 * part, or a lower amount, with the PIN; several at once), declines, or
 * returns an item to the DCR with a query. The DCR transmits the approved
 * item to the Chief Registrar (all, or in instalments), who sends it to the
 * Chief Accountant, who pays each beneficiary. The monthly mandatories have
 * their own tab. Print: the submission memo, an item, the month's approved
 * cash flow with the Chief Judge's signature and a QR code.
 */
(function () {
  window.App = window.App || {};
  window.App.modules = window.App.modules || {};

  const naira = (n) => `₦${Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const STATUS = { with_dcr: ['With the DCR', 'pending'], pending: ['Awaiting the CJ', 'pending'], returned: ['Returned with a query', 'returned'], approved: ['Approved', 'final'],
    declined: ['Not approved', 'declined'], paid: ['Paid', 'final'], dismissed: ['Dismissed', 'draft'] };
  const ACTION = { requested: 'Requested', answered: 'Query answered', approved: 'Approved', declined: 'Not approved', returned: 'Returned with a query',
    paid: 'Paid', carried: 'Carried forward', dismissed: 'Dismissed', moved: 'Moved to the new month', completed: 'Closed as paid', transmitted: 'Transmitted to the Chief Registrar',
    prepared: 'Prepared by the DCR', submitted: 'Submitted to the Hon. Chief Judge', sent: 'Sent to the Chief Accountant' };
  // Nigerian banks, as suggestions (any name may be typed).
  const BANKS = ['Access Bank', 'Citibank Nigeria', 'Ecobank Nigeria', 'Fidelity Bank', 'First Bank of Nigeria', 'First City Monument Bank (FCMB)', 'Globus Bank',
    'Guaranty Trust Bank (GTBank)', 'Jaiz Bank', 'Keystone Bank', 'Lotus Bank', 'Optimus Bank', 'Parallex Bank', 'Polaris Bank', 'PremiumTrust Bank', 'Providus Bank',
    'Signature Bank', 'Stanbic IBTC Bank', 'Standard Chartered Bank', 'Sterling Bank', 'SunTrust Bank', 'TAJBank', 'Titan Trust Bank', 'Union Bank of Nigeria',
    'United Bank for Africa (UBA)', 'Unity Bank', 'Wema Bank', 'Zenith Bank'];

  window.App.modules.cashflow = {
    async render(container, ctx) {
      const { ui, api, router } = ctx;
      const el = ui.el;
      let me;
      try { me = await api.get('/cashflow/me'); } catch (e) { container.appendChild(ui.empty(e.offline ? 'The cash flow needs the internet.' : e.message)); return; }
      const badge = (s) => { const [t, c] = STATUS[s] || [s, 'draft']; return el('span', { class: 'badge badge--' + c }, t); };
      const pill = (t, c) => el('span', { class: 'badge badge--' + c }, t);
      // Where an item is: with the DCR, the CJ, the Chief Registrar, the Chief Accountant…
      const itemBadge = (x) => {
        if (x.status === 'returned') return pill('Returned to the requester', 'returned');
        if (x.status !== 'approved') return badge(x.status);
        const t = x.tranches || [];
        if (t.some(y => !y.sent)) return pill('With the Chief Registrar', 'pending');
        if (t.some(y => y.payees.some(p => !p.paid))) return pill(x.paid > 0 ? 'Part paid' : 'With the Chief Accountant', 'final');
        if (x.paid > 0) return pill('Part paid', 'final');
        return pill('Approved, to transmit', 'final');
      };
      // The beneficiaries of an item, in a few words.
      const payeesNote = (x) => !x.payees.length ? 'Not entered' : x.ready ? `${x.payees.length}, ${naira(x.payeesTotal)}` : `${x.payees.length}, ${naira(x.payeesTotal)} of ${naira(x.amount)}`;
      const day = (d) => d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

      container.appendChild(el('div', { class: 'page-head' }, [
        el('h1', null, '💵 Cash Flow'),
        el('p', { class: 'muted' }, me.cj ? 'Items placed on the monthly cash flow for your approval. Open Details to approve, decline or return an item with a query.'
          : me.admin && !me.requester && !me.accountant ? 'The monthly cash flow, for oversight: every item, the money and the balance. Decisions are the Hon. Chief Judge\'s; requests and payments are made by the officers concerned.'
          : me.accountant && !me.seesAll ? 'Prepare the monthly mandatories, and pay what the Chief Registrar sends (cash flow items and mandatories approved by the Hon. Chief Judge), recording each payment voucher.'
          : me.dcr ? 'Items requested come to you: check them, enter who is to be paid, and submit them to the Hon. Chief Judge. Once approved, transmit them to the Chief Registrar for payment.'
            : 'Items requested on the monthly cash flow, for the approval of the Hon. Chief Judge.')
      ]));
      const tabsBar = el('div', { class: 'tabs', role: 'tablist' });
      const panel = el('div', { class: 'tab-panel' });
      container.append(tabsBar, panel);
      const TABS = [
        me.seesAll ? ['month', me.cj ? 'This Month\'s Cash Flow' : 'The Cash Flow', monthView] : null,
        me.requester ? ['mine', 'My Requests', mineView] : null,
        me.dcr ? ['submit', 'To Submit to the CJ', submitView] : null,
        me.dcr ? ['transmit', 'To Transmit', transmitView] : null,
        me.cr ? ['send', 'Send for Payment', sendView] : null,
        me.mandatories ? ['mandatories', 'Mandatories', mandatoriesView] : null,
        me.accountant ? ['pay', 'For Payment', payView] : null
      ].filter(Boolean);
      TABS.forEach(([key, label, fn], i) => {
        const b = el('button', { class: 'tab' + (i ? '' : ' is-active'), role: 'tab', onclick: () => { tabsBar.querySelectorAll('.tab').forEach(t => t.classList.remove('is-active')); b.classList.add('is-active'); fn(); } }, label);
        tabsBar.appendChild(b);
      });
      // The panel's contents, leaving out what is not shown.
      const show = (...kids) => panel.replaceChildren(...kids.filter(Boolean));
      let month = me.month;
      if (TABS.length) TABS[0][2]();

      // ── The month's list (and, for the CJ, the money) ──
      async function monthView() {
        panel.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
        let r;
        try { r = await api.get(`/cashflow?month=${month}`); } catch (e) { panel.replaceChildren(ui.empty(e.message)); return; }
        const pick = el('select', { 'aria-label': 'Month', onchange: () => { month = pick.value; monthView(); } }, r.months.map(m => el('option', { value: m.month }, m.name)));
        pick.value = r.month;
        // The CJ ticks items waiting for him and approves them together.
        const pend = r.items.filter(x => x.can.decide);
        const picked = new Set();
        const many = el('button', { class: 'btn btn--ok', disabled: 'disabled', onclick: () => approveMany(r.items.filter(x => picked.has(x.id)), monthView) }, '✔ Approve Selected');
        const setMany = () => { many.disabled = !picked.size; many.textContent = picked.size ? `✔ Approve Selected (${picked.size})` : '✔ Approve Selected'; };
        const tick = (x) => x.can.decide ? el('input', { type: 'checkbox', class: 'cf-tick', 'aria-label': `Select ${x.item}`, onchange: (e) => { e.target.checked ? picked.add(x.id) : picked.delete(x.id); setMany(); } }) : el('span');
        const all = pend.length > 1 ? el('label', { class: 'check check--plain cf-all' }, [el('input', { type: 'checkbox', onchange: (e) => { panel.querySelectorAll('.cf-tick').forEach(b => { b.checked = e.target.checked; }); pend.forEach(x => e.target.checked ? picked.add(x.id) : picked.delete(x.id)); setMany(); } }), ` Select all ${pend.length} awaiting you`]) : null;
        const kids = [el('div', { class: 'toolbar' }, [
          ui.field('Month', pick),
          me.requester ? el('button', { class: 'btn btn--primary', onclick: () => requestForm() }, '+ New Request') : null,
          me.setsOverhead ? el('button', { class: 'btn btn--ghost', onclick: () => overheadDialog(r) }, '₦ Overhead Received') : null,
          pend.length ? many : null,
          el('button', { class: 'btn btn--ghost', onclick: () => printApproved(r) }, '🖨 Print Approved Cash Flow')
        ]), all];
        if (r.summary) {
          const s = r.summary;
          const card = (v, l, cls) => el('div', { class: 'dash-card ' + (cls || '') }, [el('div', { class: 'dash-card__num cash-num' }, naira(v)), el('div', { class: 'dash-card__label' }, l)]);
          kids.push(el('div', { class: 'dash-stats cash-stats' }, [
            card(s.broughtForward, 'Brought forward'), card(s.released, `Overhead received, ${r.monthName}`), card(s.available, 'Available'),
            card(s.mandatories, 'Mandatories approved'), card(s.forCashflow, 'Left for the cash flow', s.forCashflow < 0 ? 'dash-card--warn' : ''),
            card(s.approved, 'Cash flow approved'), card(s.paid, 'Paid (all)', 'dash-card--ok'), card(s.balance, 'Balance', s.balance < 0 ? 'dash-card--warn' : '')
          ]));
          if (s.approved > s.forCashflow) kids.push(el('div', { class: 'notice notice--warn' }, 'The cash flow items approved this month are more than what is left after the mandatories.'));
        }
        kids.push(r.items.length ? ui.table([
          ...(pend.length ? [{ label: '', node: tick }] : []),
          { label: 'S/No', value: x => String(x.sn) },
          { label: 'Item', value: x => x.item, primary: true },
          { label: 'Amount', value: x => naira(x.amount) + (x.decision && x.decision.kind === 'approved' && x.decision.amount < x.amount ? ` (approved ${naira(x.decision.amount)})` : '') },
          { label: 'Submitted by', value: x => `${x.requestedByName}${x.requestedByRole ? `, ${x.requestedByRole}` : ''}` },
          { label: 'Status', node: x => el('span', null, [itemBadge(x), x.carriedFrom ? el('div', { class: 'muted cash-from' }, `from ${x.carriedFrom}`) : null]) }
        ], r.items, [{ label: 'Details', onClick: x => details(x.id, monthView) }]) : ui.empty(`Nothing on the ${r.monthName} cash flow yet.`));
        panel.replaceChildren(...kids.filter(Boolean));
      }

      // ── A requester's own items ──
      async function mineView() {
        panel.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
        let r;
        try { r = await api.get('/cashflow/mine'); } catch (e) { panel.replaceChildren(ui.empty(e.message)); return; }
        show(
          el('div', { class: 'toolbar' }, [el('button', { class: 'btn btn--primary', onclick: () => requestForm() }, '+ New Request')]),
          r.items.length ? ui.table([
            { label: 'Month', value: x => x.monthName }, { label: 'S/No', value: x => String(x.sn) }, { label: 'Item', value: x => x.item, primary: true },
            { label: 'Amount', value: x => naira(x.amount) }, { label: 'Status', node: itemBadge }
          ], r.items, [{ label: x => x.can.answer ? 'Answer Query' : x.can.carry ? 'Carry or Dismiss' : 'Details', onClick: x => details(x.id, mineView) }]) : ui.empty('You have not requested anything yet. Use + New Request.')
        );
      }

      // A list with tick boxes and one action for those ticked (approve, submit, transmit, send).
      function tickTable(rows, can, word, act, cols, actions, allLabel) {
        const ok = rows.filter(can);
        const picked = new Set();
        const btn = el('button', { class: 'btn btn--ok', disabled: 'disabled', onclick: () => act(rows.filter(x => picked.has(x.id))) }, word);
        const set = () => { btn.disabled = !picked.size; btn.textContent = picked.size ? `${word} (${picked.size})` : word; };
        const tick = (x) => can(x) ? el('input', { type: 'checkbox', class: 'cf-tick', 'aria-label': `Select ${x.item}`, onchange: (e) => { e.target.checked ? picked.add(x.id) : picked.delete(x.id); set(); } }) : el('span');
        const box = el('div');
        const all = ok.length > 1 ? el('label', { class: 'check check--plain cf-all' }, [el('input', { type: 'checkbox', onchange: (e) => {
          box.querySelectorAll('.cf-tick').forEach(b => { b.checked = e.target.checked; }); ok.forEach(x => e.target.checked ? picked.add(x.id) : picked.delete(x.id)); set();
        } }), ` ${allLabel || 'Select all'} (${ok.length})`]) : null;
        box.appendChild(ui.table([...(ok.length ? [{ label: '', node: tick }] : []), ...cols], rows, actions));
        return { button: ok.length ? btn : null, all, table: box };
      }
      const desk = async () => api.get('/cashflow/desk');

      // ── The DCR: items to check, prepare and submit to the CJ ──
      async function submitView() {
        show(el('p', { class: 'muted' }, 'Loading…'));
        let r;
        try { r = await desk(); } catch (e) { show(ui.empty(e.message)); return; }
        const t = tickTable(r.toSubmit, x => x.can.submit, '➜ Submit Selected to the CJ', (list) => submitDialog(list, submitView), [
          { label: 'Month', value: x => x.monthName }, { label: 'S/No', value: x => String(x.sn) },
          { label: 'Item', value: x => x.item, primary: true }, { label: 'Amount', value: x => naira(x.amount), num: true },
          { label: 'Requested by', value: x => `${x.requestedByName}${x.requestedByRole ? `, ${x.requestedByRole}` : ''}` },
          { label: 'Beneficiaries', node: x => el('span', { class: x.ready ? '' : 'cf-warn' }, payeesNote(x)) },
          { label: 'Status', node: x => el('span', null, [itemBadge(x), x.query && x.status === 'with_dcr' && x.query.by === 'Hon. Chief Judge' ? el('div', { class: 'cash-from' }, 'Query from the CJ') : null]) }
        ], [{ label: x => x.can.prepare ? (x.payees.length ? 'Prepare' : 'Enter Beneficiaries') : 'Details', class: '', onClick: x => x.can.prepare ? prepareForm(x, submitView) : details(x.id, submitView) }],
        'Select all ready to submit');
        show(
          el('p', { class: 'muted' }, 'Items requested come here. Check each, correct it or return it to the requester with a query, and enter who is to be paid (their amounts must add up to the item). Then submit to the Hon. Chief Judge: the month\'s cash flow at once, selected items, or later a supplementary submission.'),
          el('div', { class: 'toolbar' }, [me.requester ? el('button', { class: 'btn btn--primary', onclick: () => requestForm() }, '+ New Request') : null, t.button]), t.all,
          r.toSubmit.length ? t.table : ui.empty('Nothing waiting for you to submit.')
        );
      }
      function submitDialog(list, after) {
        const total = list.reduce((n, x) => n + x.amount, 0);
        const note = el('textarea', { rows: 2, maxlength: '3000', placeholder: 'Optional, e.g. The cash flow for November' });
        ui.modal(`Submit ${list.length} Item${list.length > 1 ? 's' : ''} to the Hon. Chief Judge`, el('div', null, [
          el('p', null, 'The items go up with their beneficiaries: the request for the release of funds. Once the Hon. Chief Judge approves an item, no separate request is needed.'),
          el('div', { class: 'cfa-list' }, list.map(x => el('div', { class: 'cfa-line cfa-line--plain' }, [el('span', null, String(x.sn)), el('span', null, `${x.item} · ${x.payees.length} beneficiar${x.payees.length === 1 ? 'y' : 'ies'}`), el('span', { class: 'cfa-line__amt' }, naira(x.amount))]))),
          el('div', { class: 'cfa-kept' }, `Total: ${naira(total)}`),
          ui.field('Remarks to the Hon. Chief Judge (optional)', note)
        ]), { wide: true, confirmText: `Submit ${list.length}`, confirmClass: 'btn--ok', onConfirm: async () => {
          const r = await api.post('/cashflow/submit', { ids: list.map(x => x.id), note: note.value });
          ui.toast(`${r.submission.refNo}${r.submission.supplementary ? ' (supplementary)' : ''} submitted to the Hon. Chief Judge.`, 'success', 6000);
          router.refreshBadges(); setTimeout(after, 0);
          if (confirm(`Print the submission memo ${r.submission.refNo} now?`)) printSubmission(r.submission.id);
          return true;
        } });
      }

      // ── The DCR: approved items to transmit to the Chief Registrar ──
      async function transmitView() {
        show(el('p', { class: 'muted' }, 'Loading…'));
        let r;
        try { r = await desk(); } catch (e) { show(ui.empty(e.message)); return; }
        const t = tickTable(r.toTransmit, x => x.can.transmit, '➜ Transmit Selected to the CR', (list) => transmitDialog(list, transmitView), [
          { label: 'Month', value: x => x.monthName }, { label: 'Item', value: x => x.item, primary: true },
          { label: 'Approved', value: x => naira(x.decision.amount), num: true }, { label: 'Left to transmit', value: x => naira(x.leftToTransmit), num: true },
          { label: 'Beneficiaries', value: x => String(x.payees.length) }, { label: 'Status', node: itemBadge }
        ], [{ label: 'Instalment', onClick: x => instalmentDialog(x, transmitView) }, { label: 'Details', onClick: x => details(x.id, transmitView) }], 'Select all');
        show(
          el('p', { class: 'muted' }, 'Items approved by the Hon. Chief Judge, with the release of their funds. Transmit them to the Chief Registrar, who sends them to the Chief Accountant: in full (tick and transmit), or an instalment when an item is paid in parts.'),
          el('div', { class: 'toolbar' }, [t.button]), t.all,
          r.toTransmit.length ? t.table : ui.empty('Nothing waiting to be transmitted.')
        );
      }
      function transmitDialog(list, after) {
        const total = list.reduce((n, x) => n + x.leftToTransmit, 0);
        const note = el('input', { type: 'text', maxlength: '500', placeholder: 'Optional' });
        ui.modal(`Transmit ${list.length} Item${list.length > 1 ? 's' : ''} to the Chief Registrar`, el('div', null, [
          el('p', null, 'Each item in full: all that is left to transmit, to each beneficiary. For part of an item, use Instalment instead.'),
          el('div', { class: 'cfa-list' }, list.map(x => el('div', { class: 'cfa-line cfa-line--plain' }, [el('span'), el('span', null, `${x.item} · ${x.payees.length} beneficiar${x.payees.length === 1 ? 'y' : 'ies'}`), el('span', { class: 'cfa-line__amt' }, naira(x.leftToTransmit))]))),
          el('div', { class: 'cfa-kept' }, `Total: ${naira(total)}`), ui.field('Note to the Chief Registrar (optional)', note)
        ]), { wide: true, confirmText: `Transmit ${list.length}`, confirmClass: 'btn--ok', onConfirm: async () => {
          await api.post('/cashflow/transmit', { items: list.map(x => ({ id: x.id })), note: note.value });
          ui.toast(`Transmitted to the Chief Registrar, ${naira(total)}.`, 'success', 6000); router.refreshBadges(); setTimeout(after, 0); return true;
        } });
      }
      // Part of an approved item: the amount for each beneficiary this time.
      function instalmentDialog(x, after) {
        const rows = x.payees.map(p => {
          const left = Math.round(((p.approved || 0) - (p.transmitted || 0)) * 100) / 100;
          return { p, left, input: el('input', { type: 'number', min: '0', step: '0.01', max: String(left), value: '', placeholder: `Up to ${naira(left)}`, disabled: left > 0 ? null : 'disabled' }) };
        });
        const sum = el('div', { class: 'cfa-kept' });
        const sync = () => { sum.textContent = `This instalment: ${naira(rows.reduce((n, r) => n + (Number(r.input.value) || 0), 0))} of ${naira(x.leftToTransmit)} left`; };
        rows.forEach(r => r.input.addEventListener('input', sync)); sync();
        const note = el('input', { type: 'text', maxlength: '500', placeholder: 'Optional, e.g. First instalment, on mobilisation' });
        ui.modal(`Instalment · ${x.item}`, el('div', null, [
          el('p', null, `Approved: ${naira(x.decision.amount)}. Already transmitted: ${naira(x.decision.amount - x.leftToTransmit)}. Enter the amount for each beneficiary this time.`),
          ui.table([{ label: 'Beneficiary', value: r => `${r.p.name} · ${r.p.bank} · ${r.p.accountNo}` }, { label: 'Approved', value: r => naira(r.p.approved), num: true },
            { label: 'Left', value: r => naira(r.left), num: true }, { label: 'This time, ₦', node: r => r.input }], rows),
          sum, ui.field('Note to the Chief Registrar (optional)', note)
        ]), { wide: true, confirmText: 'Transmit the Instalment', confirmClass: 'btn--ok', onConfirm: async () => {
          const parts = rows.map(r => ({ id: r.p.id, amount: Number(r.input.value) || 0 })).filter(r => r.amount > 0);
          if (!parts.length) throw new Error('Enter the amount for at least one beneficiary.');
          for (const r of rows) if ((Number(r.input.value) || 0) > r.left + 0.004) throw new Error(`${r.p.name}: no more than ${naira(r.left)}.`);
          await api.post('/cashflow/transmit', { items: [{ id: x.id, payees: parts }], note: note.value });
          ui.toast('Instalment transmitted to the Chief Registrar.', 'success'); router.refreshBadges(); setTimeout(after, 0); return true;
        } });
      }

      // ── The Chief Registrar: transmitted items to send to the Chief Accountant ──
      async function sendView() {
        show(el('p', { class: 'muted' }, 'Loading…'));
        let r;
        try { r = await desk(); } catch (e) { show(ui.empty(e.message)); return; }
        const waiting = (x) => x.tranches.filter(t => !t.sent).reduce((n, t) => n + t.amount, 0);
        const t = tickTable(r.toSend, x => x.can.send, '➜ Send Selected to the Chief Accountant', (list) => sendDialog(list, sendView), [
          { label: 'Month', value: x => x.monthName }, { label: 'Item', value: x => x.item, primary: true },
          { label: 'Approved', value: x => naira(x.decision.amount), num: true }, { label: 'To send now', value: x => naira(waiting(x)), num: true },
          { label: 'Beneficiaries', value: x => [...new Set(x.tranches.filter(t => !t.sent).flatMap(t => t.payees.map(p => p.name)))].join(', ') },
          { label: 'Transmitted by', value: x => { const last = x.tranches.filter(t => !t.sent).pop(); return last ? `${last.byName}, ${day(last.at)}` : ''; } }
        ], [{ label: 'Details', onClick: x => details(x.id, sendView) }], 'Select all');
        show(
          el('p', { class: 'muted' }, 'Items approved by the Hon. Chief Judge and transmitted by the DCR Admin and Finance. Send them to the Chief Accountant for payment.'),
          el('div', { class: 'toolbar' }, [t.button]), t.all,
          r.toSend.length ? t.table : ui.empty('Nothing waiting to be sent.')
        );
      }
      function sendDialog(list, after) {
        const waiting = (x) => x.tranches.filter(t => !t.sent).reduce((n, t) => n + t.amount, 0);
        const total = list.reduce((n, x) => n + waiting(x), 0);
        const note = el('input', { type: 'text', maxlength: '500', placeholder: 'Optional, e.g. Pay before Friday' });
        ui.modal(`Send ${list.length} Item${list.length > 1 ? 's' : ''} to the Chief Accountant`, el('div', null, [
          el('div', { class: 'cfa-list' }, list.flatMap(x => x.tranches.filter(t => !t.sent).flatMap(t => t.payees.map(p => el('div', { class: 'cfa-line cfa-line--plain' }, [el('span'), el('span', null, `${x.item}: ${p.name} · ${p.bank} · ${p.accountNo}`), el('span', { class: 'cfa-line__amt' }, naira(p.amount))]))))),
          el('div', { class: 'cfa-kept' }, `Total: ${naira(total)}`), ui.field('Note to the Chief Accountant (optional)', note)
        ]), { wide: true, confirmText: `Send ${list.length}`, confirmClass: 'btn--ok', onConfirm: async () => {
          await api.post('/cashflow/send', { ids: list.map(x => x.id), note: note.value });
          ui.toast(`Sent to the Chief Accountant, ${naira(total)}.`, 'success', 6000); router.refreshBadges(); setTimeout(after, 0); return true;
        } });
      }

      // ── The Chief Accountant: the beneficiaries sent for payment ──
      async function payView() {
        show(el('p', { class: 'muted' }, 'Loading…'));
        let r, mand;
        try { [r, mand] = await Promise.all([desk(), api.get('/cashflow/mandatories')]); } catch (e) { show(ui.empty(e.message)); return; }
        const lines = [];
        (r.payments || []).forEach(x => x.tranches.filter(t => t.sent).forEach(t => t.payees.forEach(p =>
          lines.push({ owner: x, kind: 'item', ref: `${x.monthName}, item ${x.sn}${x.tranches.length > 1 ? `, instalment ${t.no}` : ''}`, what: x.item, p }))));
        // The mandatories transmitted by the Chief Registrar, the same way.
        mand.lists.filter(x => ['approved', 'paid'].includes(x.status) && x.transmitted).forEach(m => m.items.filter(it => !it.struck).forEach(it => it.payees.forEach(p =>
          lines.push({ owner: m, kind: 'mandatory', ref: `${m.refNo} (${m.monthName} mandatories)`, what: it.title, p }))));
        const todo = lines.filter(l => !l.p.paid), done = lines.filter(l => l.p.paid).slice(0, 100);
        const cols = [
          { label: 'Reference', value: l => l.ref },
          { label: 'Item', value: l => l.what },
          { label: 'Beneficiary', value: l => l.p.name, primary: true },
          { label: 'Bank', value: l => l.p.bank },
          { label: 'Account No.', node: l => el('span', { class: 'cf-acct' }, l.p.accountNo) },
          { label: 'Account name', value: l => l.p.accountName || l.p.name },
          { label: 'Amount', value: l => naira(l.p.amount), num: true }
        ];
        const total = todo.reduce((n, l) => n + l.p.amount, 0);
        const open = (l) => l.kind === 'mandatory' ? mandatoryDetails(l.owner.id, payView) : details(l.owner.id, payView);
        show(
          el('h3', { class: 'settings-group' }, `To pay (${todo.length})${todo.length ? ` · ${naira(total)}` : ''}`),
          todo.length ? ui.table(cols, todo, [{ label: 'Record Payment', class: 'btn--primary', onClick: l => payDialog(l.owner, l.p, payView, l.kind) }, { label: 'Open', onClick: open }]) : ui.empty('Nothing waiting for payment.'),
          el('h3', { class: 'settings-group' }, `Paid (${done.length})`),
          done.length ? ui.table([...cols.slice(0, 3), { label: 'Paid', value: l => `${naira(l.p.paid.amount)}, PV ${l.p.paid.pvNo}, ${day(l.p.paid.date)}` }], done, [{ label: 'Open', onClick: open }]) : ui.empty('Nothing paid yet.')
        );
      }

      // ── A new request (or the answer to a query) ──
      // The breakdown: sections (Roofing, Painting…) with their lines; a
      // simple item is one section with no heading. Quantity and unit price
      // on every line; the line, section and item totals are worked out.
      // A new request; the answer to a query (the requester); or the DCR's preparation (mode 'prepare'): correcting it and entering its beneficiaries.
      function requestForm(x, mode, after) {
        const v = x || {};
        const prep = mode === 'prepare';
        const item = el('input', { type: 'text', value: v.item || '', maxlength: '200', placeholder: 'e.g. Renovation of High Court No. II' });
        const desc = el('textarea', { rows: 2, maxlength: '3000' }); desc.value = v.description || '';
        const dept = el('input', { type: 'text', value: v.department || '', placeholder: 'e.g. Works, High Court No. III, Registry' });
        const just = el('textarea', { rows: 3, maxlength: '3000' }); just.value = v.justification || '';
        const files = el('input', { type: 'file', multiple: 'multiple', accept: 'application/pdf,image/*' });
        const answer = el('textarea', { rows: 3, maxlength: '2000' });
        const blankLine = () => ({ description: '', quantity: '', unitPrice: '' });
        const sections = (v.sections && v.sections.length ? v.sections : [{ title: '', lines: [blankLine()] }])
          .map(sec => ({ title: sec.title || '', lines: sec.lines.map(l => ({ description: l.description, quantity: String(l.quantity), unitPrice: String(l.unitPrice) })) }));
        const lineAmt = (l) => Math.round((Number(l.quantity) || 0) * (Number(l.unitPrice) || 0) * 100) / 100;
        const secAmt = (sec) => sec.lines.reduce((n, l) => n + lineAmt(l), 0);
        const breakdown = el('div', { class: 'cfb' });
        const grand = el('div', { class: 'cfb-grand' });
        const totals = () => {
          breakdown.querySelectorAll('[data-line]').forEach(n => { const [i, j] = n.dataset.line.split('.').map(Number); n.textContent = naira(lineAmt(sections[i].lines[j])); });
          breakdown.querySelectorAll('[data-sub]').forEach(n => { n.textContent = naira(secAmt(sections[Number(n.dataset.sub)])); });
          grand.replaceChildren(el('span', null, 'Total amount requested'), el('strong', null, naira(sections.reduce((n, sec) => n + secAmt(sec), 0))));
        };
        function draw() {
          const many = sections.length > 1;
          breakdown.replaceChildren(...sections.map((sec, i) => {
            const input = (l, key, attrs) => { const n = el('input', { ...attrs, value: l[key] }); n.addEventListener('input', () => { l[key] = n.value; totals(); }); return n; };
            const head = el('div', { class: 'cfb-sec__head' }, [
              el('input', { class: 'cfb-sec__title', type: 'text', maxlength: '200', value: sec.title, 'aria-label': `Heading of section ${i + 1}`,
                placeholder: many ? `Section ${i + 1} heading, e.g. Roofing` : 'Section heading (optional), e.g. Roofing',
                oninput: (e) => { sec.title = e.target.value; } }),
              many ? el('button', { class: 'btn btn--ghost btn--small', type: 'button', title: 'Remove this section', onclick: () => { if (secAmt(sec) && !confirm(`Remove ${sec.title || 'this section'} and its lines?`)) return; sections.splice(i, 1); draw(); } }, '✕ Remove section') : null
            ]);
            const rows = sec.lines.map((l, j) => el('div', { class: 'cfb-line' }, [
              el('span', { class: 'cfb-line__no' }, String(j + 1)),
              input(l, 'description', { type: 'text', maxlength: '300', placeholder: 'Description, e.g. Roofing sheets', 'aria-label': 'Description', class: 'cfb-line__desc' }),
              input(l, 'quantity', { type: 'number', min: '0', step: 'any', placeholder: 'Qty', 'aria-label': 'Quantity', class: 'cfb-line__qty' }),
              input(l, 'unitPrice', { type: 'number', min: '0', step: '0.01', placeholder: 'Unit price ₦', 'aria-label': 'Unit price', class: 'cfb-line__price' }),
              el('span', { class: 'cfb-line__amt', 'data-line': `${i}.${j}` }),
              el('button', { class: 'cfb-line__del', type: 'button', title: 'Remove this line', 'aria-label': 'Remove this line', disabled: sec.lines.length === 1 ? 'disabled' : null, onclick: () => { sec.lines.splice(j, 1); draw(); } }, '✕')
            ]));
            return el('div', { class: 'cfb-sec' }, [head,
              el('div', { class: 'cfb-line cfb-line--head' }, [el('span'), el('span', null, 'Description'), el('span', null, 'Quantity'), el('span', null, 'Unit price, ₦'), el('span', null, 'Amount'), el('span')]),
              ...rows,
              el('div', { class: 'cfb-sec__foot' }, [
                el('button', { class: 'btn btn--ghost btn--small', type: 'button', onclick: () => { sec.lines.push(blankLine()); draw(); const d = breakdown.querySelectorAll('.cfb-sec')[i].querySelectorAll('.cfb-line__desc'); d[d.length - 1].focus(); } }, '+ Add a line'),
                el('span', { class: 'cfb-sub' }, [many || sec.title ? `Subtotal${sec.title ? `, ${sec.title}` : ''}: ` : 'Total: ', el('strong', { 'data-sub': String(i) })])
              ])
            ]);
          }), el('button', { class: 'btn btn--ghost cfb-add', type: 'button', onclick: () => { sections.push({ title: '', lines: [blankLine()] }); draw(); const t = breakdown.querySelectorAll('.cfb-sec__title'); t[t.length - 1].focus(); } }, '+ Add a section (e.g. Roofing, Painting)'));
          totals();
        }
        draw();
        // The beneficiaries (the DCR): who is to be paid, adding up to the item.
        const blankPayee = (amount) => ({ name: '', bank: '', accountNo: '', accountName: '', amount: amount ? String(amount) : '' });
        const payees = (v.payees || []).map(p => ({ name: p.name, bank: p.bank, accountNo: p.accountNo, accountName: p.accountName === p.name ? '' : (p.accountName || ''), amount: String(p.amount) }));
        if (prep && !payees.length) payees.push(blankPayee(v.amount));
        const payeeBox = el('div', { class: 'cfr' });
        const payeeSum = el('div', { class: 'cfb-grand' });
        const itemTotal = () => sections.reduce((n, sec) => n + secAmt(sec), 0);
        const payTotals = () => {
          const t = payees.reduce((n, p) => n + (Number(p.amount) || 0), 0), it = itemTotal();
          payeeSum.classList.toggle('cfb-grand--off', Math.abs(t - it) > 0.004);
          payeeSum.replaceChildren(el('span', null, Math.abs(t - it) > 0.004 ? `Beneficiaries: ${naira(t)}, the item is ${naira(it)}. They must add up to it before it can be submitted.` : 'Beneficiaries: they add up to the item'), el('strong', null, naira(t)));
        };
        function drawPayees() {
          const input = (p, key, attrs) => { const n = el('input', { ...attrs, value: p[key] }); n.addEventListener('input', () => { p[key] = n.value; payTotals(); }); return n; };
          payeeBox.replaceChildren(el('div', { class: 'cfr-item is-on' }, [
            ...payees.map((p, j) => el('div', { class: 'cfr-payee' }, [
              el('span', { class: 'cfr-payee__no' }, String(j + 1)),
              input(p, 'name', { type: 'text', maxlength: '150', placeholder: 'Beneficiary', 'aria-label': 'Beneficiary', class: 'cfr-payee__name' }),
              input(p, 'bank', { type: 'text', maxlength: '100', placeholder: 'Bank', list: 'cf-banks-i', 'aria-label': 'Bank', class: 'cfr-payee__bank' }),
              input(p, 'accountNo', { type: 'text', inputmode: 'numeric', maxlength: '10', placeholder: 'Account no. (10 digits)', 'aria-label': 'Account number', class: 'cfr-payee__acct' }),
              input(p, 'accountName', { type: 'text', maxlength: '150', placeholder: 'Account name, if different', 'aria-label': 'Account name', class: 'cfr-payee__aname' }),
              input(p, 'amount', { type: 'number', min: '0', step: '0.01', placeholder: 'Amount ₦', 'aria-label': 'Amount', class: 'cfr-payee__amt' }),
              el('button', { class: 'cfb-line__del', type: 'button', title: 'Remove this beneficiary', 'aria-label': 'Remove this beneficiary', disabled: payees.length === 1 ? 'disabled' : null, onclick: () => { payees.splice(j, 1); drawPayees(); } }, '✕')
            ])),
            el('div', { class: 'cfb-sec__foot' }, [el('button', { class: 'btn btn--ghost btn--small', type: 'button', onclick: () => { payees.push(blankPayee()); drawPayees(); } }, '+ Add a beneficiary')])
          ]));
          payTotals();
        }
        if (prep) { drawPayees(); breakdown.addEventListener('input', payTotals); }
        const queryBy = v.query && v.query.by ? v.query.by : 'Hon. Chief Judge';
        ui.modal(prep ? `Prepare for the Hon. Chief Judge · ${v.item}` : x ? `Answer the Query · ${v.item}` : 'New Request', el('div', { class: 'form-grid' }, [
          prep ? el('datalist', { id: 'cf-banks-i' }, BANKS.map(b => el('option', { value: b }))) : null,
          prep ? el('p', { class: 'muted form-field--full' }, `Requested by ${v.requestedByName}${v.requestedByRole ? `, ${v.requestedByRole}` : ''}. Correct the item if need be, and enter who is to be paid: the request for the release of funds goes up with it.`) : null,
          x && v.query && (!prep || v.query.by === 'Hon. Chief Judge') ? el('div', { class: 'notice notice--warn form-field--full' }, [el('strong', null, `Query from the ${queryBy}: `), v.query.text]) : null,
          x && !prep ? el('div', { class: 'form-field--full' }, ui.field('Your answer', answer)) : null,
          el('div', { class: 'form-field--full' }, ui.field('Item', item, 'As it will appear on the cash flow')),
          el('div', { class: 'form-field--full' }, ui.field('Description', desc)),
          el('div', { class: 'form-field--full' }, [el('div', { class: 'cfb-label' }, 'Breakdown'), el('p', { class: 'muted cfb-hint' }, 'Quantity and unit price on every line; the amounts and totals are worked out. For an item with parts, add a section for each part (e.g. Roofing, Painting), each with its own lines and subtotal.'), breakdown, grand]),
          ui.field('Department or purpose', dept),
          el('div', { class: 'form-field--full' }, ui.field('Justification', just)),
          el('div', { class: 'form-field--full' }, ui.field('Attachments (optional)', files, 'Memo, invoice or quotation: PDF or photo, up to 5 files of 10 MB')),
          prep ? el('div', { class: 'form-field--full' }, [el('div', { class: 'cfb-label' }, 'Beneficiaries (the release of funds)'), el('p', { class: 'muted cfb-hint' }, 'Who is to be paid: name, bank, 10 digit account number and amount. If the Hon. Chief Judge approves less, each is reduced in the same proportion.'), payeeBox, payeeSum]) : null
        ]), {
          wide: true, confirmText: prep ? 'Save' : x ? 'Send Back to the DCR' : 'Submit to the Cash Flow',
          onConfirm: async () => {
            if (!item.value.trim()) throw new Error('Enter the item requested.');
            const many = sections.length > 1;
            for (const [i, sec] of sections.entries()) {
              if (many && !sec.title.trim()) throw new Error(`Give section ${i + 1} a heading (for example, Roofing).`);
              for (const [j, l] of sec.lines.entries()) {
                const where = `${sec.title.trim() ? `${sec.title.trim()}, ` : ''}line ${j + 1}`;
                if (!l.description.trim()) throw new Error(`Describe ${where}.`);
                if (!(Number(l.quantity) > 0)) throw new Error(`Enter the quantity for ${where}.`);
                if (!(Number(l.unitPrice) > 0)) throw new Error(`Enter the unit price for ${where}.`);
              }
            }
            if (x && !prep && !answer.value.trim()) throw new Error('Answer the query.');
            if (prep) for (const [j, p] of payees.entries()) {
              const where = `beneficiary ${j + 1}`;
              if (!p.name.trim()) throw new Error(`Enter the name of ${where}.`);
              if (!p.bank.trim()) throw new Error(`Enter the bank of ${where}.`);
              if (!/^\d{10}$/.test(String(p.accountNo).replace(/\s/g, ''))) throw new Error(`The account number of ${where} must be 10 digits.`);
              if (!(Number(p.amount) > 0)) throw new Error(`Enter the amount for ${where}.`);
            }
            const f = new FormData();
            if (prep) f.append('payees', JSON.stringify(payees.map(p => ({ ...p, name: p.name.trim(), accountNo: String(p.accountNo).replace(/\s/g, '') }))));
            Object.entries({ item: item.value.trim(), description: desc.value, department: dept.value, justification: just.value, answer: answer.value,
              sections: JSON.stringify(sections.map(sec => ({ title: sec.title.trim(), lines: sec.lines.map(l => ({ description: l.description.trim(), quantity: l.quantity, unitPrice: l.unitPrice })) }))) })
              .forEach(([k, val]) => f.append(k, val));
            [...files.files].forEach(file => f.append('files', file));
            if (prep) {
              const r = await api.put(`/cashflow/${x.id}/prepare`, f);
              ui.toast(r.item.ready ? 'Saved. It is ready to submit to the Hon. Chief Judge.' : 'Saved. The beneficiaries must add up to the item before it can be submitted.', r.item.ready ? 'success' : 'info', 6000);
            } else if (x) await api.put(`/cashflow/${x.id}`, f); else await api.post('/cashflow', f);
            if (!prep) ui.toast(x ? 'Sent back to the DCR Admin and Finance.' : 'Placed on this month\'s cash flow. The DCR Admin and Finance is notified.', 'success', 6000);
            router.refreshBadges(); setTimeout(after || (TABS.length ? TABS[0][2] : () => {}), 0); return true;
          }
        });
      }

      const prepareForm = (x, after) => requestForm(x, 'prepare', after);

      // The breakdown of an item, to read: sections, lines, subtotals; lines
      // the CJ struck out shown as not approved.
      function breakdownView(x) {
        const many = x.sections.length > 1 || (x.sections[0] && x.sections[0].title);
        const part = x.decision && x.decision.kind === 'approved' && x.sections.some(sec => sec.lines.some(l => l.struck));
        return el('div', { class: 'cfx-break' }, [
          el('h4', null, 'Breakdown'),
          ...x.sections.map(sec => el('div', { class: 'cfx-break__sec' }, [
            many ? el('div', { class: 'cfx-break__title' }, sec.title) : null,
            el('table', { class: 'cfx-break__table' }, [
              el('thead', null, el('tr', null, [el('th', null, 'S/No'), el('th', null, 'Description'), el('th', { class: 'num' }, 'Qty'), el('th', { class: 'num' }, 'Unit price'), el('th', { class: 'num' }, 'Amount')])),
              el('tbody', null, sec.lines.map((l, j) => el('tr', { class: l.struck ? 'is-struck' : '' }, [
                el('td', null, String(j + 1)),
                el('td', null, [l.description, l.struck ? el('span', { class: 'cfx-break__out' }, 'Not approved') : null]),
                el('td', { class: 'num' }, Number(l.quantity).toLocaleString('en-NG')), el('td', { class: 'num' }, naira(l.unitPrice)), el('td', { class: 'num' }, naira(l.amount))
              ]))),
              el('tfoot', null, [
                el('tr', null, [el('td', { colspan: '4' }, many ? `Subtotal, ${sec.title}` : 'Total'), el('td', { class: 'num' }, naira(sec.subtotal))]),
                part && sec.approvedSubtotal !== sec.subtotal ? el('tr', { class: 'cfx-break__ok' }, [el('td', { colspan: '4' }, 'Lines approved'), el('td', { class: 'num' }, naira(sec.approvedSubtotal))]) : null
              ])
            ])
          ])),
          many ? el('div', { class: 'cfx-break__grand' }, [el('span', null, 'Grand total'), el('strong', null, naira(x.amount))]) : null,
          part ? el('div', { class: 'cfx-break__grand cfx-break__grand--ok' }, [el('span', null, 'Total of the lines approved'), el('strong', null, naira(x.sections.reduce((n, sec) => n + sec.approvedSubtotal, 0)))]) : null
        ]);
      }

      // One item with its breakdown, on paper.
      function printItem(x) {
        const many = x.sections.length > 1 || (x.sections[0] && x.sections[0].title);
        const secs = x.sections.map(sec => `${many ? `<h3 class="cfp-sec">${esc(sec.title)}</h3>` : ''}<table class="doc-table"><thead><tr><th>S/No</th><th>Description</th><th style="text-align:right">Qty</th><th style="text-align:right">Unit price</th><th style="text-align:right">Amount</th></tr></thead><tbody>${
          sec.lines.map((l, j) => `<tr${l.struck ? ' style="text-decoration:line-through;color:#888"' : ''}><td>${j + 1}</td><td>${esc(l.description)}${l.struck ? ' (not approved)' : ''}</td><td style="text-align:right">${esc(Number(l.quantity).toLocaleString('en-NG'))}</td><td style="text-align:right">${esc(naira(l.unitPrice))}</td><td style="text-align:right">${esc(naira(l.amount))}</td></tr>`).join('')
        }<tr><td colspan="4" style="text-align:right"><strong>${many ? `Subtotal, ${esc(sec.title)}` : 'Total'}</strong></td><td style="text-align:right"><strong>${esc(naira(sec.subtotal))}</strong></td></tr></tbody></table>`).join('');
        const ok = x.decision && x.decision.kind === 'approved';
        window.App.processUi.printPage(`<article class="court-doc report-print">
          <header class="doc-masthead"><img class="doc-emblem" src="/assets/highcourt.png" alt=""><div class="doc-titleblock"><div class="doc-line1">THE JUDICIARY</div><div class="doc-line2">GOMBE STATE HIGH COURT OF JUSTICE</div><div class="doc-line3">CASH FLOW · ${esc(x.monthName.toUpperCase())} · ITEM ${esc(x.sn)}</div></div><img class="doc-emblem" src="/assets/coat.png" alt=""></header><div class="doc-rule"></div>
          <h2 style="margin:6px 0 2px">${esc(x.item)}</h2>
          <p style="margin:0 0 8px">Requested by ${esc(x.requestedByName)}${x.requestedByRole ? `, ${esc(x.requestedByRole)}` : ''}${x.department ? ` · ${esc(x.department)}` : ''}</p>
          ${x.description ? `<p><strong>Description:</strong> ${esc(x.description)}</p>` : ''}
          ${secs}
          <table class="doc-table" style="margin-top:8px"><tbody>
            <tr><td><strong>Total amount requested</strong></td><td style="text-align:right"><strong>${esc(naira(x.amount))}</strong></td></tr>
            ${ok ? `<tr><td><strong>Amount approved</strong></td><td style="text-align:right"><strong>${esc(naira(x.decision.amount))}</strong></td></tr>` : ''}
            ${(x.payments || []).map(pm => `<tr><td>Paid to ${esc(pm.payee || '')}, PV ${esc(pm.pvNo)}, ${esc(day(pm.date))}</td><td style="text-align:right">${esc(naira(pm.amount))}</td></tr>`).join('')}
          </tbody></table>
          ${x.payees.length ? `<h3 class="cfp-sec">Beneficiaries (the release of funds)</h3><table class="doc-table"><thead><tr><th>Beneficiary</th><th>Bank</th><th>Account No.</th><th style="text-align:right">Requested</th>${ok ? '<th style="text-align:right">Approved</th>' : ''}</tr></thead><tbody>${
            x.payees.map(p => `<tr><td>${esc(p.name)}</td><td>${esc(p.bank)}</td><td>${esc(p.accountNo)}</td><td style="text-align:right">${esc(naira(p.amount))}</td>${ok ? `<td style="text-align:right">${esc(naira(p.approved))}</td>` : ''}</tr>`).join('')}</tbody></table>` : ''}
          ${x.justification ? `<p><strong>Justification:</strong> ${esc(x.justification)}</p>` : ''}
          ${ok ? `<div class="doc-sign-wrap"><div class="doc-sign-block">${x.decision.signatureUrl ? `<img class="doc-sig-img" src="${x.decision.signatureUrl}" alt="Signature">` : ''}<div class="doc-sign">${esc([x.decision.title, x.decision.byName].filter(Boolean).join(' '))}<br>Hon. Chief Judge</div><div class="doc-sig-meta">Approved ${esc(day(x.decision.at))}${x.decision.note ? `: ${esc(x.decision.note)}` : ''}</div></div></div>`
            : `<p class="muted">Status: ${esc((STATUS[x.status] || [x.status])[0])}</p>`}
          <footer class="doc-footer"><span>Printed ${esc(day(new Date()))}</span><span>Powered by the Directorate of ICT, Gombe State High Court of Justice</span></footer></article>`);
      }

      // ── The details of an item, with the actions this person may take ──
      async function details(id, after) {
        let x;
        try { x = (await api.get(`/cashflow/${id}`)).item; } catch (e) { ui.toast(e.message, 'error'); return; }
        let dialog;
        const done = () => { dialog.close(); router.refreshBadges(); after(); };
        const btn = (label, cls, fn) => el('button', { class: 'btn ' + cls, type: 'button', onclick: fn }, label);
        const actions = el('div', { class: 'doc-preview__actions' }, [
          btn('✕  Close', 'btn--ghost', () => dialog.close()),
          btn('🖨  Print', 'btn--ghost', () => printItem(x)),
          x.can.decide ? btn('✔  Approve', 'btn--ok', () => approve(x, done)) : null,
          x.can.decide ? btn('↩  Return with Query', 'btn--ghost', () => query(x, done)) : null,
          x.can.decide ? btn('✕  Decline', 'btn--danger', () => decline(x, done)) : null,
          x.can.prepare ? btn(x.payees.length ? '✎  Prepare' : '✎  Enter Beneficiaries', 'btn--primary', () => { dialog.close(); prepareForm(x, after); }) : null,
          x.can.submit ? btn('➜  Submit to the CJ', 'btn--ok', () => { dialog.close(); submitDialog([x], after); }) : null,
          x.can.returnToRequester ? btn('↩  Return to the Requester', 'btn--ghost', () => askNote(`Return to ${x.requestedByName} · ${x.item}`, 'Query to the requester', 'Return', async (n) => { await api.post(`/cashflow/${x.id}/return`, { note: n }); ui.toast(`Returned to ${x.requestedByName} with your query.`, 'info'); }, done)) : null,
          x.can.answer ? btn('Answer Query', 'btn--primary', () => { dialog.close(); requestForm(x, null, after); }) : null,
          x.can.transmit ? btn('➜  Transmit All to the CR', 'btn--ok', () => { dialog.close(); transmitDialog([x], after); }) : null,
          x.can.transmit ? btn('Transmit an Instalment', 'btn--ghost', () => { dialog.close(); instalmentDialog(x, after); }) : null,
          x.can.send ? btn('➜  Send to the Chief Accountant', 'btn--ok', () => { dialog.close(); sendDialog([x], after); }) : null,
          x.submission ? btn('🖨  Submission Memo', 'btn--ghost', () => printSubmission(x.submission.id)) : null,
          x.can.carry ? btn('➜  Carry to Next Cash Flow', 'btn--primary', async () => { try { await api.post(`/cashflow/${x.id}/carry`); ui.toast('Carried to the next cash flow.', 'success'); done(); } catch (e) { ui.toast(e.message, 'error'); } }) : null,
          x.can.carry ? btn('Dismiss', 'btn--danger', async () => { if (!confirm(`Dismiss ${x.item}? It leaves the cash flow for good.`)) return; try { await api.post(`/cashflow/${x.id}/dismiss`); ui.toast('Dismissed.', 'info'); done(); } catch (e) { ui.toast(e.message, 'error'); } }) : null,
          x.can.complete ? btn('Close as Paid', 'btn--ghost', () => complete(x, done)) : null
        ]);
        // ── The item, laid out: header, progress, notices, cards, attachments, timeline ──
        const when = (d) => d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
        const field = (label, value, wide) => value ? el('div', { class: 'cd-field' + (wide ? ' cd-field--wide' : '') }, [el('div', { class: 'cd-label' }, label), el('div', { class: 'cd-value' }, value)]) : null;
        const approved = x.decision && x.decision.kind === 'approved' ? x.decision.amount : null;
        const lower = approved !== null && approved < x.amount;
        const hero = el('div', { class: 'cfx-hero cfx-hero--' + x.status }, [
          el('div', { class: 'cfx-hero__main' }, [
            el('div', { class: 'cfx-hero__over' }, `Item ${x.sn} · ${x.monthName} cash flow${x.carriedFrom ? ` · carried from ${x.carriedFrom}` : ''}`),
            el('div', { class: 'cfx-hero__title' }, x.item),
            el('div', { class: 'cfx-hero__by' }, [itemBadge(x), el('span', null, `Requested by ${x.requestedByName}${x.requestedByRole ? `, ${x.requestedByRole}` : ''}`)])
          ]),
          el('div', { class: 'cfx-hero__money' }, [
            el('div', { class: 'cfx-hero__label' }, 'Amount requested'),
            el('div', { class: 'cfx-hero__amount' + (lower ? ' cfx-hero__amount--struck' : '') }, naira(x.amount)),
            approved !== null ? el('div', { class: 'cfx-hero__approved' }, `Approved ${naira(approved)}`) : null,
            x.paid > 0 ? el('div', { class: 'cfx-hero__paid' }, x.status === 'paid' ? `Paid ${naira(x.paid)}` : `Paid so far ${naira(x.paid)}`) : null
          ])
        ]);
        // Progress: requested, the DCR's submission, the Chief Judge's decision, transmission, payment.
        const decided = x.decision ? x.decision.kind : null;
        const step = (name, state, sub) => el('li', { class: 'cd-step ' + state }, [
          el('span', { class: 'cd-dot' }, state === 'is-done' ? '✓' : state === 'is-stop' ? '✕' : ''),
          el('span', { class: 'cd-step__name' }, name), sub ? el('span', { class: 'cd-step__date' }, sub) : null]);
        const tr = x.tranches || [];
        const steps = el('ol', { class: 'cd-steps cfx-steps' }, [
          step('Requested', 'is-done', day(x.createdAt)),
          x.status === 'returned' ? step('DCR Admin and Finance', 'is-next', 'Returned to the requester')
            : x.status === 'with_dcr' ? step('DCR Admin and Finance', 'is-next', x.query && x.query.by === 'Hon. Chief Judge' ? 'Query from the CJ' : x.ready ? 'Ready to submit' : 'Preparing')
              : step('Submitted by the DCR', 'is-done', x.submission ? day(x.submission.at) : ''),
          decided === 'approved' ? step('Approved by the CJ', 'is-done', day(x.decision.at))
            : decided === 'declined' ? step('Not approved', 'is-stop', day(x.decision.at))
              : step('Decision of the CJ', x.status === 'pending' ? 'is-next' : '', x.status === 'pending' ? 'Waiting' : ''),
          decided === 'declined' ? step(x.status === 'dismissed' ? 'Dismissed' : 'Carry or dismiss', x.status === 'dismissed' ? 'is-stop' : 'is-next', '') : null,
          decided === 'declined' ? null : step('Transmitted and sent', tr.length && x.leftToTransmit === 0 && tr.every(t => t.sent) ? 'is-done' : decided === 'approved' ? 'is-next' : '',
            tr.length ? (tr.some(t => !t.sent) ? 'With the Chief Registrar' : x.leftToTransmit > 0 ? `${naira(x.decision.amount - x.leftToTransmit)} of ${naira(x.decision.amount)}` : day(tr[tr.length - 1].sent.at)) : decided === 'approved' ? 'With the DCR' : ''),
          decided === 'declined' ? null : step(x.status === 'paid' ? 'Paid' : x.paid > 0 ? 'Part paid' : 'Paid', x.status === 'paid' ? 'is-done' : x.paid > 0 ? 'is-next' : '',
            x.status === 'paid' && x.payments.length ? day(x.payments[x.payments.length - 1].date) : x.paid > 0 ? `${naira(x.paid)} of ${naira(approved)}` : tr.some(t => t.sent) ? 'With the Chief Accountant' : '')
        ].filter(Boolean));
        const notice = (cls, title, text, by) => el('div', { class: 'cfx-note cfx-note--' + cls }, [el('div', { class: 'cfx-note__title' }, title), el('div', null, text), by ? el('div', { class: 'cfx-note__by' }, by) : null]);
        const notes = [
          (x.status === 'returned' || x.status === 'with_dcr') && x.query ? notice('query', `↩ Query from the ${x.query.by || 'Hon. Chief Judge'}`, x.query.text, `${x.query.byName}, ${when(x.query.at)}`) : null,
          decided === 'declined' ? notice('declined', '✕ Not approved', x.decision.note || 'No reason given.',
            `${x.decision.byName}, ${when(x.decision.at)}${x.status === 'declined' ? (x.requesterDecides ? ' · Left to the requester to carry forward or dismiss' : ' · The Hon. Chief Judge carries it forward or dismisses it') : ''}`) : null,
          decided === 'approved' && x.decision.note ? notice('approved', '✔ Remark of the Hon. Chief Judge', x.decision.note, `${x.decision.byName}, ${when(x.decision.at)}`) : null
        ].filter(Boolean);
        const cards = el('div', { class: 'cd-grid' }, [
          el('div', { class: 'cd-box' }, [el('h4', null, 'The request'), el('div', { class: 'cd-fields' }, [
            field('Requested by', x.requestedByName), field('Office', x.requestedByRole),
            field('Date', when(x.createdAt)), field('Department or purpose', x.department || '—')
          ])]),
          el('div', { class: 'cd-box' }, [el('h4', null, 'The money'), el('div', { class: 'cd-fields' }, [
            field('Requested', naira(x.amount)),
            field('Breakdown', `${x.sections.length > 1 ? `${x.sections.length} sections, ` : ''}${x.sections.reduce((n, sec) => n + sec.lines.length, 0)} line(s)`),
            field('Approved', approved !== null ? naira(approved) + (lower ? ` (${naira(x.amount - approved)} less)` : '') : decided === 'declined' ? 'Not approved' : 'Awaiting decision'),
            approved !== null ? field('Transmitted', naira(approved - (x.leftToTransmit || 0)) + (x.leftToTransmit > 0 && x.status === 'approved' ? ` (${naira(x.leftToTransmit)} still to transmit)` : '')) : null,
            field('Paid', x.paid > 0 ? naira(x.paid) : approved !== null ? 'Not yet' : '—')
          ])])
        ]);
        const text = (title, body) => body ? el('div', { class: 'cfx-text' }, [el('h4', null, title), el('p', null, body)]) : null;
        const fileIcon = (n) => /\.pdf$/i.test(n) ? '📄' : /\.(png|jpe?g|gif|webp|heic)$/i.test(n) ? '🖼' : '📎';
        const files = x.attachments.length ? el('div', { class: 'cfx-files' }, [el('h4', null, `Attachments (${x.attachments.length})`),
          el('div', { class: 'cfx-files__list' }, x.attachments.map(a => el('a', { class: 'cfx-file', href: a.url, target: '_blank', rel: 'noopener' }, [
            el('span', { class: 'cfx-file__icon' }, fileIcon(a.name)), el('span', { class: 'cfx-file__name' }, a.name), el('span', { class: 'cfx-file__open' }, 'Open')])))]) : null;
        const TONE = { requested: 'info', answered: 'info', approved: 'ok', paid: 'ok', declined: 'bad', dismissed: 'bad', returned: 'warn', carried: 'info', moved: 'info',
          prepared: 'info', submitted: 'info', transmitted: 'info', sent: 'info', completed: 'ok' };
        const timeline = el('div', { class: 'cfx-timeline' }, [el('h4', null, 'History'), el('ol', null, x.history.map(h => el('li', { class: 'cfx-tl cfx-tl--' + (TONE[h.action] || 'info') }, [
          el('div', { class: 'cfx-tl__head' }, [el('strong', null, ACTION[h.action] || h.action), el('span', null, `${h.byName} · ${when(h.at)}`)]),
          h.note ? el('div', { class: 'cfx-tl__note' }, h.note) : null
        ])))]);
        // Who is to be paid: as requested, as approved, transmitted, paid.
        const payeesPanel = x.payees.length ? el('div', { class: 'cfx-break' }, [el('h4', null, `Beneficiaries: the release of funds (${x.payees.length})`),
          el('div', { class: 'table-scroll' }, el('table', { class: 'cfx-break__table' }, [
            el('thead', null, el('tr', null, [el('th', null, 'Beneficiary'), el('th', null, 'Bank'), el('th', null, 'Account No.'), el('th', { class: 'num' }, 'Requested'),
              approved !== null ? el('th', { class: 'num' }, 'Approved') : null, approved !== null ? el('th', { class: 'num' }, 'Transmitted') : null, approved !== null ? el('th', { class: 'num' }, 'Paid') : null])),
            el('tbody', null, x.payees.map(p => el('tr', null, [
              el('td', null, [p.name, p.accountName && p.accountName !== p.name ? el('div', { class: 'muted' }, `Account name: ${p.accountName}`) : null]),
              el('td', null, p.bank), el('td', null, el('span', { class: 'cf-acct' }, p.accountNo)), el('td', { class: 'num' + (p.approved != null && p.approved < p.amount ? ' cd-struck' : '') }, naira(p.amount)),
              approved !== null ? el('td', { class: 'num' }, el('strong', null, naira(p.approved))) : null,
              approved !== null ? el('td', { class: 'num' }, naira(p.transmitted)) : null, approved !== null ? el('td', { class: 'num' }, naira(p.paid)) : null
            ]))),
            el('tfoot', null, el('tr', null, [el('td', { colspan: '3' }, x.ready || approved !== null ? 'Total' : `Total (the item is ${naira(x.amount)})`), el('td', { class: 'num' }, naira(x.payeesTotal)),
              approved !== null ? el('td', { class: 'num' }, naira(approved)) : null, approved !== null ? el('td', { class: 'num' }, naira(approved - (x.leftToTransmit || 0))) : null, approved !== null ? el('td', { class: 'num' }, naira(x.paid)) : null]))
          ])),
          lower ? el('p', { class: 'muted' }, `The Hon. Chief Judge approved ${naira(approved)} of ${naira(x.amount)}: each beneficiary was reduced in the same proportion.`) : null
        ]) : (x.can.prepare ? el('div', { class: 'cfx-note cfx-note--query' }, [el('div', { class: 'cfx-note__title' }, 'Beneficiaries not entered'), el('div', null, 'Enter who is to be paid before submitting to the Hon. Chief Judge.')]) : null);
        // Each transmission (in full, or an instalment): sent by the Chief Registrar, paid by the Chief Accountant.
        const trPanel = tr.length ? el('div', { class: 'cfx-rels' }, [el('h4', null, tr.length > 1 ? `Instalments (${tr.length})` : 'Transmission and payment'),
          ...tr.map(t => el('div', { class: 'cfx-rel' }, [
            el('div', { class: 'cfx-rel__head' }, [el('strong', null, tr.length > 1 ? `Instalment ${t.no}` : 'Transmitted'), el('span', { class: 'muted' }, `by ${t.byName}, ${day(t.at)}`),
              t.sent ? pill(`Sent to the Chief Accountant, ${day(t.sent.at)}`, 'final') : pill('With the Chief Registrar', 'pending'), el('span', { class: 'cfx-rel__amt' }, naira(t.amount))]),
            t.note ? el('div', { class: 'muted' }, t.note) : null,
            el('div', { class: 'cfx-rel__payees' }, t.payees.map(p => el('div', { class: 'cfx-payee' }, [
              el('span', { class: 'cfx-payee__name' }, p.name), el('span', { class: 'muted' }, `${p.bank} · ${p.accountNo}`), el('span', { class: 'cfx-payee__amt' }, naira(p.amount)),
              p.paid ? pill(`Paid, PV ${p.paid.pvNo}`, 'final')
                : x.can.pay && t.sent ? el('button', { class: 'btn btn--primary btn--small', type: 'button', onclick: () => { dialog.close(); payDialog(x, p, after || payView, 'item'); } }, 'Record Payment')
                  : pill(t.sent ? 'To be paid' : 'Awaiting the Chief Registrar', 'draft')
            ])))
          ]))]) : null;
        const submitted = x.submission ? el('p', { class: 'muted' }, `Submitted to the Hon. Chief Judge by ${x.submission.byName}, ${day(x.submission.at)}, in ${x.submission.refNo}.`) : null;
        const body = el('div', { class: 'cfx' }, [actions, hero, steps, ...notes, cards, payeesPanel, trPanel, submitted, x.sections.length ? breakdownView(x) : null,
          (x.description || x.justification) ? el('div', { class: 'cfx-texts' }, [text('Description', x.description), text('Justification', x.justification)]) : null,
          files, timeline]);
        ui.modal('Cash Flow Item', body, { noFooter: true, wide: true, onOpen: (o) => { dialog = o; } });
      }

      // Approve the whole item, or part of it: untick the lines (or a whole
      // section) not approved; the amount follows, and may be lowered further.
      function approve(x, done) {
        const many = x.sections.length > 1 || (x.sections[0] && x.sections[0].title);
        const ticks = [];
        const amount = el('input', { type: 'number', min: '0', step: '0.01', value: String(x.amount) });
        const kept = el('div', { class: 'cfa-kept' });
        const sync = () => {
          const n = Math.round(ticks.filter(t => t.box.checked).reduce((m, t) => m + t.amount, 0) * 100) / 100;
          amount.value = String(n);
          kept.replaceChildren(el('span', null, n < x.amount ? `Approving ${naira(n)} of ${naira(x.amount)}` : `Approving the full ${naira(x.amount)}`));
          x.sections.forEach((sec, i) => { const all = ticks.filter(t => t.i === i); const box = secBoxes[i]; if (box) { box.checked = all.every(t => t.box.checked); box.indeterminate = !box.checked && all.some(t => t.box.checked); } });
        };
        const secBoxes = [];
        const list = el('div', { class: 'cfa-list' }, x.sections.map((sec, i) => {
          const sbox = el('input', { type: 'checkbox', checked: 'checked', onchange: () => { ticks.filter(t => t.i === i).forEach(t => { t.box.checked = sbox.checked; }); sync(); } });
          secBoxes[i] = many ? sbox : null;
          return el('div', { class: 'cfa-sec' }, [
            many ? el('label', { class: 'cfa-sec__head' }, [sbox, el('strong', null, sec.title), el('span', null, naira(sec.subtotal))]) : null,
            ...sec.lines.map((l, j) => {
              const box = el('input', { type: 'checkbox', checked: 'checked', onchange: sync });
              ticks.push({ i, key: `${i}.${j}`, box, amount: l.amount });
              return el('label', { class: 'cfa-line' }, [box, el('span', null, `${l.description} (${Number(l.quantity).toLocaleString('en-NG')} × ${naira(l.unitPrice)})`), el('span', { class: 'cfa-line__amt' }, naira(l.amount))]);
            })
          ]);
        }));
        const note = el('input', { type: 'text', maxlength: '500', placeholder: 'Optional' });
        const pin = el('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: '8', placeholder: 'Signing PIN' });
        sync();
        ui.modal(`Approve · ${x.item}`, el('div', null, [
          el('p', null, `Requested: ${naira(x.amount)}. Untick any line${many ? ' or section' : ''} you do not approve; you may also approve a lower amount.`),
          list, kept,
          ui.field('Amount approved, ₦', amount), ui.field('Remark (optional)', note), ui.field('Your signing PIN', pin)
        ]), { wide: true, confirmText: 'Approve', confirmClass: 'btn--ok', onConfirm: async () => {
          if (!ticks.some(t => t.box.checked)) throw new Error('Every line is unticked. Decline the item instead.');
          if (!pin.value) throw new Error('Enter your signing PIN.');
          await api.post(`/cashflow/${x.id}/decide`, { action: 'approve', amount: amount.value, note: note.value, pin: pin.value, struck: ticks.filter(t => !t.box.checked).map(t => t.key) });
          ui.toast('Approved. The Accountant is notified.', 'success'); setTimeout(done, 0); return true;
        } });
      }
      // The CJ returns an item to the DCR Admin and Finance with a query.
      function query(x, done) {
        const note = el('textarea', { rows: 3, maxlength: '2000', placeholder: 'What should the DCR Admin and Finance clarify or correct?' });
        ui.modal(`Return with Query · ${x.item}`, el('div', null, [el('p', { class: 'muted' }, 'It goes back to the DCR Admin and Finance, who answers it (or asks the requester) and submits it again.'), ui.field('Query', note)]), { confirmText: 'Return', onConfirm: async () => {
          if (!note.value.trim()) throw new Error('Write the query.');
          await api.post(`/cashflow/${x.id}/decide`, { action: 'return', note: note.value.trim() });
          ui.toast('Returned to the DCR Admin and Finance with your query.', 'info'); setTimeout(done, 0); return true;
        } });
      }
      // A short note, then an action (the DCR returning an item to its requester).
      function askNote(title, label, confirmText, fn, done) {
        const note = el('textarea', { rows: 3, maxlength: '2000' });
        ui.modal(title, ui.field(label, note), { confirmText, onConfirm: async () => {
          if (!note.value.trim()) throw new Error('Write the query.');
          await fn(note.value.trim()); setTimeout(done, 0); return true;
        } });
      }
      function decline(x, done) {
        const note = el('input', { type: 'text', maxlength: '500', placeholder: 'Optional' });
        const leave = el('input', { type: 'checkbox' });
        ui.modal(`Decline · ${x.item}`, el('div', null, [
          ui.field('Reason (optional)', note),
          el('label', { class: 'check check--plain' }, [leave, ` Let ${x.requestedByName} carry it to the next cash flow or dismiss it`]),
          el('p', { class: 'muted' }, 'Otherwise you carry it forward or dismiss it yourself, from Details.')
        ]), { confirmText: 'Decline', confirmClass: 'btn--danger', onConfirm: async () => {
          await api.post(`/cashflow/${x.id}/decide`, { action: 'decline', note: note.value, requesterDecides: leave.checked });
          ui.toast('Not approved.', 'info'); setTimeout(done, 0); return true;
        } });
      }
      // The Accountant pays one beneficiary of an approved release.
      // The Chief Accountant pays one beneficiary: of a cash flow item (an instalment sent) or of the mandatories.
      function payDialog(owner, p, after, kind) {
        const mandatory = kind === true || kind === 'mandatory';
        const pv = el('input', { type: 'text', maxlength: '60', placeholder: 'e.g. PV/112/2026' });
        const date = el('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
        ui.modal(`Record Payment · ${p.name}`, el('div', null, [
          el('div', { class: 'cf-paycard' }, [
            el('div', null, [el('span', { class: 'muted' }, 'Beneficiary'), el('strong', null, p.name)]),
            el('div', null, [el('span', { class: 'muted' }, 'Bank'), el('strong', null, p.bank)]),
            el('div', null, [el('span', { class: 'muted' }, 'Account number'), el('strong', { class: 'cf-acct' }, p.accountNo)]),
            el('div', null, [el('span', { class: 'muted' }, 'Account name'), el('strong', null, p.accountName || p.name)]),
            el('div', null, [el('span', { class: 'muted' }, 'Amount to pay (as approved)'), el('strong', null, naira(p.amount))]),
            el('div', null, [el('span', { class: 'muted' }, mandatory ? 'Mandatories' : 'Cash flow item'), el('strong', null, mandatory ? owner.refNo : `${owner.item} (${owner.monthName}, item ${owner.sn})`)])
          ]),
          el('p', { class: 'muted' }, 'The amount is fixed: it is what the Hon. Chief Judge approved for this beneficiary.'),
          ui.field('Payment voucher number', pv), ui.field('Date paid', date)
        ]), { confirmText: `Record Payment of ${naira(p.amount)}`, onConfirm: async () => {
          if (!pv.value.trim()) throw new Error('Enter the payment voucher number.');
          await (mandatory ? api.post(`/cashflow/mandatories/${owner.id}/pay`, { payee: p.id, pvNo: pv.value.trim(), date: date.value })
            : api.post(`/cashflow/${owner.id}/pay`, { line: p.id, pvNo: pv.value.trim(), date: date.value }));
          ui.toast('Payment recorded. The Hon. Chief Judge is notified.', 'success'); router.refreshBadges(); setTimeout(after, 0); return true;
        } });
      }

      // An approved item paid in part, with nothing more to come.
      function complete(x, done) {
        const note = el('input', { type: 'text', maxlength: '500', placeholder: 'e.g. The balance was not needed' });
        ui.modal(`Close as Paid · ${x.item}`, el('div', null, [
          el('p', null, `${naira(x.paid)} has been paid of the ${naira(x.decision.amount)} approved. Closing the item marks it paid; nothing more can be released for it.`),
          ui.field('Reason (optional)', note)
        ]), { confirmText: 'Close as Paid', onConfirm: async () => {
          await api.post(`/cashflow/${x.id}/complete`, { note: note.value });
          ui.toast('Closed as paid.', 'success'); setTimeout(done, 0); return true;
        } });
      }

      // The Chief Registrar (or the administrator) enters the overhead received each month.
      async function overheadDialog(r) {
        let list;
        try { list = await api.get('/cashflow/admin/releases'); } catch (e) { ui.toast(e.message, 'error'); return; }
        const month = el('input', { type: 'month', value: r.month });
        const known = (m) => (list.releases.find(x => x.month === m) || {}).amount;
        const amount = el('input', { type: 'number', min: '0', step: '0.01', placeholder: 'Amount received, ₦', value: known(r.month) != null ? String(known(r.month)) : '' });
        month.addEventListener('change', () => { const k = known(month.value); amount.value = k != null ? String(k) : ''; });
        ui.modal('Overhead Received', el('div', null, [
          el('p', { class: 'muted' }, 'The overhead received from the government for the month. With the balance brought forward from the month before, it is what is available for the cash flow. To correct a month, enter it again; the Hon. Chief Judge is notified.'),
          ui.field('Month', month), ui.field('Amount received, ₦', amount),
          list.releases.length ? ui.table([{ label: 'Month', key: 'name' }, { label: 'Overhead received', value: x => naira(x.amount) }, { label: 'Entered by', value: x => [x.byName, x.at ? day(x.at) : ''].filter(Boolean).join(', ') }], list.releases) : null
        ]), { confirmText: 'Save', onConfirm: async () => {
          if (!(Number(amount.value) >= 0) || amount.value === '') throw new Error('Enter the amount received.');
          await api.put('/cashflow/admin/releases', { month: month.value, amount: amount.value });
          ui.toast('Saved.', 'success'); setTimeout(monthView, 0); return true;
        } });
      }

      // The Hon. Chief Judge approves several items at once, each in full.
      function approveMany(list, after) {
        if (!list.length) return;
        const total = list.reduce((n, x) => n + x.amount, 0);
        const note = el('input', { type: 'text', maxlength: '500', placeholder: 'Optional' });
        const pin = el('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: '8', placeholder: 'Signing PIN' });
        ui.modal(`Approve ${list.length} Item${list.length > 1 ? 's' : ''}`, el('div', null, [
          el('p', null, 'Each item is approved in full, as requested. To approve part of an item, open its Details instead.'),
          el('div', { class: 'cfa-list' }, list.map(x => el('div', { class: 'cfa-line cfa-line--plain' }, [el('span', null, String(x.sn)), el('span', null, `${x.item} · ${x.requestedByName}`), el('span', { class: 'cfa-line__amt' }, naira(x.amount))]))),
          el('div', { class: 'cfa-kept' }, `Total: ${naira(total)}`),
          ui.field('Remark (optional)', note), ui.field('Your signing PIN', pin)
        ]), { wide: true, confirmText: `Approve ${list.length}`, confirmClass: 'btn--ok', onConfirm: async () => {
          if (!pin.value) throw new Error('Enter your signing PIN.');
          const r = await api.post('/cashflow/decide-many', { ids: list.map(x => x.id), pin: pin.value, note: note.value });
          ui.toast(`${r.approved} item(s) approved, ${naira(r.total)}. The DCR Admin and Finance is notified.`, 'success', 6000);
          router.refreshBadges(); setTimeout(after, 0); return true;
        } });
      }

      // ── The monthly mandatories ──
      // Prepared by the Chief Accountant, approved by the Chief Registrar and
      // then the Hon. Chief Judge (with the PIN), transmitted by the Chief
      // Registrar, paid by the Chief Accountant.
      const MSTATUS = { with_cr: ['With the Chief Registrar', 'pending'], pending: ['Awaiting the CJ', 'pending'], returned: ['Returned with a query', 'returned'], paid: ['Paid', 'final'] };
      const mbadge = (m) => {
        if (m.status === 'approved') return m.transmitted ? el('span', { class: 'badge badge--final' }, m.paid > 0 ? 'Part paid' : 'With the Chief Accountant') : el('span', { class: 'badge badge--pending' }, 'To transmit');
        const [t, c] = MSTATUS[m.status] || [m.status, 'draft']; return el('span', { class: 'badge badge--' + c }, t);
      };

      async function mandatoriesView() {
        panel.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
        let r;
        try { r = await api.get('/cashflow/mandatories'); } catch (e) { panel.replaceChildren(ui.empty(e.message)); return; }
        const count = (m) => m.items.reduce((n, x) => n + x.payees.length, 0);
        show(
          el('p', { class: 'muted' }, 'The standing payments made every month (casual staff, subscriptions, allowances…), approved directly by the Hon. Chief Judge, not on the cash flow. The Chief Accountant prepares the month\'s list; the Chief Registrar approves it and sends it to the Chief Judge; once approved, the Chief Registrar transmits it to the Chief Accountant for payment. They are paid from the month\'s overhead, before the cash flow items.'),
          r.prepares ? el('div', { class: 'toolbar' }, [el('button', { class: 'btn btn--primary', onclick: () => mandatoryForm() }, '+ Prepare the Month\'s Mandatories')]) : null,
          r.lists.length ? ui.table([
            { label: 'Month', value: m => m.monthName },
            { label: 'Reference', value: m => m.refNo },
            { label: 'Mandatories', value: m => m.items.map(x => x.title).join('; '), primary: true },
            { label: 'Beneficiaries', value: m => String(count(m)) },
            { label: 'Total', value: m => ['approved', 'paid'].includes(m.status) && m.approvedTotal < m.total ? `${naira(m.approvedTotal)} of ${naira(m.total)}` : naira(['approved', 'paid'].includes(m.status) ? m.approvedTotal : m.total) },
            { label: 'Status', node: mbadge }
          ], r.lists, [{ label: m => m.can.answer ? 'Answer Query' : m.can.forward || m.can.decide || m.can.transmit ? 'Open to Act' : 'Details', class: '', onClick: m => mandatoryDetails(m.id, mandatoriesView) }])
            : ui.empty(r.prepares ? 'No mandatories yet. Use + Prepare the Month\'s Mandatories.' : 'No mandatories have been submitted yet.')
        );
      }

      // The Chief Accountant's list: a copy of last month's, changed as needed.
      async function mandatoryForm(m, after) {
        let items, from = null;
        if (m) items = m.items.map(x => ({ title: x.title, payees: x.payees.map(p => ({ name: p.name, bank: p.bank, accountNo: p.accountNo, accountName: p.accountName === p.name ? '' : (p.accountName || ''), amount: String(p.amount) })) }));
        else {
          try { const t = await api.get('/cashflow/mandatories/template'); from = t.from; items = t.items.map(x => ({ title: x.title, payees: x.payees.map(p => ({ ...p, accountName: p.accountName || '', amount: String(p.amount) })) })); }
          catch (e) { ui.toast(e.message, 'error'); return; }
        }
        const blank = () => ({ name: '', bank: '', accountNo: '', accountName: '', amount: '' });
        if (!items.length) items = [{ title: '', payees: [blank()] }];
        const month = el('input', { type: 'month', value: m ? m.month : me.month, disabled: m ? 'disabled' : null });
        const banks = el('datalist', { id: 'cf-banks-m' }, BANKS.map(b => el('option', { value: b })));
        const wrap = el('div', { class: 'cfr' });
        const grand = el('div', { class: 'cfb-grand' });
        const sumOf = (x) => x.payees.reduce((n, p) => n + (Number(p.amount) || 0), 0);
        const totals = () => {
          wrap.querySelectorAll('[data-sum]').forEach(n => { n.textContent = `Total: ${naira(sumOf(items[Number(n.dataset.sum)]))}`; });
          grand.replaceChildren(el('span', null, `Total of the mandatories (${items.length})`), el('strong', null, naira(items.reduce((n, x) => n + sumOf(x), 0))));
        };
        function draw() {
          wrap.replaceChildren(...items.map((x, i) => {
            const input = (p, key, attrs) => { const n = el('input', { ...attrs, value: p[key] }); n.addEventListener('input', () => { p[key] = n.value; totals(); }); return n; };
            return el('div', { class: 'cfr-item is-on' }, [
              el('div', { class: 'cfb-sec__head' }, [
                el('input', { class: 'cfb-sec__title', type: 'text', maxlength: '200', value: x.title, placeholder: `Mandatory ${i + 1}, e.g. Casual staff, Starlink subscription`, 'aria-label': `Title of mandatory ${i + 1}`, oninput: (e) => { x.title = e.target.value; } }),
                el('button', { class: 'btn btn--ghost btn--small', type: 'button', title: 'Beneficiaries from an Excel or CSV file', onclick: () => importSheet((r) => {
                  const filled = x.payees.filter(p => p.name || p.accountNo || p.amount).length;
                  const add = filled && !confirm(`${x.title || 'This mandatory'} already has ${filled} beneficiar${filled === 1 ? 'y' : 'ies'}. OK replaces them with the ${r.payees.length} from the file; Cancel adds the file's to them.`);
                  x.payees = [...(add ? x.payees.filter(p => p.name || p.accountNo || p.amount) : []), ...r.payees.map(asRow)];
                  draw();
                  report(r, `${r.payees.length} beneficiar${r.payees.length === 1 ? 'y' : 'ies'} imported into ${x.title || 'the mandatory'}.`);
                }) }, '⬆ Import'),
                items.length > 1 ? el('button', { class: 'btn btn--ghost btn--small', type: 'button', onclick: () => { if (!confirm(`Remove ${x.title || 'this mandatory'} from this month's list?`)) return; items.splice(i, 1); draw(); } }, '✕ Remove') : null
              ]),
              ...x.payees.map((p, j) => el('div', { class: 'cfr-payee' }, [
                el('span', { class: 'cfr-payee__no' }, String(j + 1)),
                input(p, 'name', { type: 'text', maxlength: '150', placeholder: 'Beneficiary', 'aria-label': 'Beneficiary', class: 'cfr-payee__name' }),
                input(p, 'bank', { type: 'text', maxlength: '100', placeholder: 'Bank', list: 'cf-banks-m', 'aria-label': 'Bank', class: 'cfr-payee__bank' }),
                input(p, 'accountNo', { type: 'text', inputmode: 'numeric', maxlength: '10', placeholder: 'Account no. (10 digits)', 'aria-label': 'Account number', class: 'cfr-payee__acct' }),
                input(p, 'accountName', { type: 'text', maxlength: '150', placeholder: 'Account name, if different', 'aria-label': 'Account name', class: 'cfr-payee__aname' }),
                input(p, 'amount', { type: 'number', min: '0', step: '0.01', placeholder: 'Amount ₦', 'aria-label': 'Amount', class: 'cfr-payee__amt' }),
                el('button', { class: 'cfb-line__del', type: 'button', title: 'Remove this beneficiary', 'aria-label': 'Remove this beneficiary', disabled: x.payees.length === 1 ? 'disabled' : null, onclick: () => { x.payees.splice(j, 1); draw(); } }, '✕')
              ])),
              el('div', { class: 'cfb-sec__foot' }, [
                el('button', { class: 'btn btn--ghost btn--small', type: 'button', onclick: () => { x.payees.push(blank()); draw(); } }, '+ Add a beneficiary'),
                el('span', { class: 'cfr-sum', 'data-sum': String(i) })
              ])
            ]);
          }), el('button', { class: 'btn btn--ghost cfb-add', type: 'button', onclick: () => { items.push({ title: '', payees: [blank()] }); draw(); const t = wrap.querySelectorAll('.cfb-sec__title'); t[t.length - 1].focus(); } }, '+ Add a mandatory'));
          totals();
        }
        // ── From a spreadsheet ──
        const asRow = (p) => ({ name: p.name, bank: p.bank, accountNo: p.accountNo, accountName: p.accountName && p.accountName !== p.name ? p.accountName : '', amount: String(p.amount) });
        function importSheet(then) {
          const pick = el('input', { type: 'file', accept: '.xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv', style: 'display:none' });
          pick.addEventListener('change', async () => {
            const file = pick.files[0]; pick.remove();
            if (!file) return;
            const f = new FormData(); f.append('file', file);
            try {
              const r = await api.post('/cashflow/mandatories/import', f);
              if (!r.payees.length) { report(r, 'No beneficiary could be imported from this file.'); return; }
              then(r);
            } catch (e) { ui.toast(e.message, 'error', 8000); }
          });
          document.body.appendChild(pick); pick.click();
        }
        // What was imported, and the rows left out with the reason.
        function report(r, head) {
          ui.modal('Spreadsheet Import', el('div', null, [
            el('p', null, [el('strong', null, head), ' Check them before submitting.']),
            r.problems.length ? el('div', { class: 'notice notice--warn' }, `${r.problems.length} row${r.problems.length === 1 ? ' was' : 's were'} left out. Correct ${r.problems.length === 1 ? 'it' : 'them'} in the file and import again, or add ${r.problems.length === 1 ? 'it' : 'them'} by hand.`) : null,
            r.problems.length ? ui.table([{ label: 'Row', value: p => String(p.row) }, { label: 'Beneficiary', value: p => p.name || '—' }, { label: 'Why', value: p => p.reason }], r.problems) : null,
            r.notes.length ? el('p', { class: 'muted' }, `For ${r.notes.length} account number${r.notes.length === 1 ? '' : 's'} the leading zero, dropped by Excel, was put back (rows ${r.notes.map(n => n.row).join(', ')}). Confirm ${r.notes.length === 1 ? 'it' : 'them'}.`) : null
          ]), { confirmText: 'OK', cancelText: 'Close' });
        }
        // The whole list: rows grouped by the Mandatory column; a mandatory of the same name has its beneficiaries replaced.
        const importAll = () => importSheet((r) => {
          if (!r.hasMandatory) { ui.toast('This file has no Mandatory column. Use ⬆ Import on the mandatory the beneficiaries belong to, or add a Mandatory column (see the template).', 'info', 9000); return; }
          const groups = new Map();
          r.payees.forEach(p => { const t = p.mandatory || 'Untitled'; groups.set(t, [...(groups.get(t) || []), p]); });
          items = items.filter(x => x.title.trim() || x.payees.some(p => p.name || p.accountNo || p.amount));
          let added = 0, replaced = 0;
          for (const [title, ps] of groups) {
            const same = items.find(x => x.title.trim().toLowerCase() === title.toLowerCase());
            if (same) { same.payees = ps.map(asRow); replaced++; } else { items.push({ title: title === 'Untitled' ? '' : title, payees: ps.map(asRow) }); added++; }
          }
          draw();
          report(r, `${r.payees.length} beneficiar${r.payees.length === 1 ? 'y' : 'ies'} imported: ${[added ? `${added} new mandator${added === 1 ? 'y' : 'ies'}` : '', replaced ? `${replaced} replaced` : ''].filter(Boolean).join(', ')}.`);
        });
        draw();
        const note = el('textarea', { rows: 2, maxlength: '3000', placeholder: 'Optional, e.g. Two casual staff added this month' }); note.value = m ? m.note : '';
        const answer = el('textarea', { rows: 3, maxlength: '2000' });
        ui.modal(m ? `Answer the Query · ${m.refNo}` : 'Prepare the Month\'s Mandatories', el('div', null, [banks,
          m ? el('div', { class: 'notice notice--warn' }, [el('strong', null, `Query from the ${m.query ? m.query.by : ''}: `), m.query ? m.query.text : '']) : null,
          m ? ui.field('Your answer', answer) : null,
          ui.field('Month', month),
          el('div', { class: 'toolbar cfm-import' }, [
            el('button', { class: 'btn btn--ghost', type: 'button', onclick: importAll }, '⬆ Import from Spreadsheet'),
            el('a', { class: 'btn btn--ghost', href: '/api/cashflow/mandatories/import-template', download: 'mandatories-template.csv' }, '⬇ Download the Template'),
            el('span', { class: 'muted' }, 'Excel (.xlsx) or CSV, with columns Mandatory, Beneficiary, Bank, Account Number, Account Name (optional), Amount.')
          ]),
          el('p', { class: 'muted' }, from ? `Started from the ${from.monthName} list (${from.refNo}). Change any amount, add or remove beneficiaries or mandatories, then submit to the Chief Registrar.` : 'Add each mandatory with its beneficiaries, bank, 10 digit account number and amount. Next month\'s list will start as a copy of this one.'),
          wrap, grand,
          ui.field('Remarks (optional)', note)
        ]), {
          wide: true, confirmText: m ? 'Send Back to the Chief Registrar' : 'Submit to the Chief Registrar',
          onConfirm: async () => {
            for (const [i, x] of items.entries()) {
              if (!x.title.trim()) throw new Error(`Give mandatory ${i + 1} a title.`);
              for (const [j, p] of x.payees.entries()) {
                const where = `${x.title.trim()}, beneficiary ${j + 1}`;
                if (!p.name.trim()) throw new Error(`Enter the name of ${where}.`);
                if (!p.bank.trim()) throw new Error(`Enter the bank of ${where}.`);
                if (!/^\d{10}$/.test(String(p.accountNo).replace(/\s/g, ''))) throw new Error(`The account number of ${where} must be 10 digits.`);
                if (!(Number(p.amount) > 0)) throw new Error(`Enter the amount for ${where}.`);
              }
            }
            if (m && !answer.value.trim()) throw new Error('Answer the query.');
            const body = { month: month.value, note: note.value, answer: answer.value, items: items.map(x => ({ title: x.title.trim(), payees: x.payees.map(p => ({ ...p, accountNo: String(p.accountNo).replace(/\s/g, '') })) })) };
            const r = m ? await api.put(`/cashflow/mandatories/${m.id}`, body) : await api.post('/cashflow/mandatories', body);
            ui.toast(m ? 'Sent back to the Chief Registrar.' : `${r.list.refNo} submitted to the Chief Registrar.`, 'success', 6000);
            router.refreshBadges(); setTimeout(after || mandatoriesView, 0); return true;
          }
        });
      }

      async function mandatoryDetails(id, after) {
        let x;
        try { x = (await api.get(`/cashflow/mandatories/${id}`)).list; } catch (e) { ui.toast(e.message, 'error'); return; }
        let dialog;
        const back = after || mandatoriesView;
        const done = () => { dialog.close(); router.refreshBadges(); back(); };
        const btn = (label, cls, fn) => el('button', { class: 'btn ' + cls, type: 'button', onclick: fn }, label);
        const when = (d) => d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
        const ask = (title, label, confirmText, fn, required) => {
          const note = el('textarea', { rows: 3, maxlength: '2000' });
          ui.modal(title, ui.field(label, note), { confirmText, onConfirm: async () => {
            if (required && !note.value.trim()) throw new Error('Write the query.');
            await fn(note.value.trim()); setTimeout(done, 0); return true;
          } });
        };
        const ok = ['approved', 'paid'].includes(x.status);
        const actions = el('div', { class: 'doc-preview__actions' }, [
          btn('✕  Close', 'btn--ghost', () => dialog.close()),
          btn('🖨  Print', 'btn--ghost', () => printMandatory(x)),
          x.can.forward ? btn('✔  Approve and Send to the CJ', 'btn--ok', () => ask(`Send to the Hon. Chief Judge · ${x.refNo}`, 'Note to the Hon. Chief Judge (optional)', 'Send to the CJ', async (n) => { await api.post(`/cashflow/mandatories/${x.id}/forward`, { note: n }); ui.toast('Sent to the Hon. Chief Judge.', 'success'); })) : null,
          x.can.decide ? btn('✔  Approve', 'btn--ok', () => approveMandatory(x, done)) : null,
          x.can.forward || x.can.decide ? btn('↩  Return with Query', 'btn--ghost', () => ask(`Return with Query · ${x.refNo}`, 'Query to the Chief Accountant', 'Return', async (n) => { await api.post(`/cashflow/mandatories/${x.id}/return`, { note: n }); ui.toast('Returned to the Chief Accountant.', 'info'); }, true)) : null,
          x.can.transmit ? btn('➜  Transmit to the Chief Accountant', 'btn--primary', () => ask(`Transmit for Payment · ${x.refNo}`, 'Note to the Chief Accountant (optional)', 'Transmit', async (n) => { await api.post(`/cashflow/mandatories/${x.id}/transmit`, { note: n }); ui.toast('Transmitted to the Chief Accountant.', 'success'); })) : null,
          x.can.answer ? btn('Answer Query', 'btn--primary', () => { dialog.close(); mandatoryForm(x, after); }) : null
        ]);
        const hero = el('div', { class: 'cfx-hero cfx-hero--' + (x.status === 'with_cr' ? 'pending' : x.status) }, [
          el('div', { class: 'cfx-hero__main' }, [
            el('div', { class: 'cfx-hero__over' }, `Monthly mandatories · ${x.refNo}`),
            el('div', { class: 'cfx-hero__title' }, `Mandatories for ${x.monthName}`),
            el('div', { class: 'cfx-hero__by' }, [mbadge(x), el('span', null, `Prepared by ${x.preparedByName}, Chief Accountant · ${day(x.createdAt)}`)])
          ]),
          el('div', { class: 'cfx-hero__money' }, [
            el('div', { class: 'cfx-hero__label' }, 'Total'),
            el('div', { class: 'cfx-hero__amount' + (ok && x.approvedTotal < x.total ? ' cfx-hero__amount--struck' : '') }, naira(x.total)),
            ok ? el('div', { class: 'cfx-hero__approved' }, `Approved ${naira(x.approvedTotal)}`) : null,
            x.paid > 0 ? el('div', { class: 'cfx-hero__paid' }, x.status === 'paid' ? `Paid ${naira(x.paid)}` : `Paid so far ${naira(x.paid)}`) : null
          ])
        ]);
        const step = (name, state, sub) => el('li', { class: 'cd-step ' + state }, [
          el('span', { class: 'cd-dot' }, state === 'is-done' ? '✓' : ''), el('span', { class: 'cd-step__name' }, name), sub ? el('span', { class: 'cd-step__date' }, sub) : null]);
        const steps = el('ol', { class: 'cd-steps cfx-steps' }, [
          step('Prepared', 'is-done', day(x.createdAt)),
          step('Chief Registrar', x.forwarded ? 'is-done' : x.status === 'with_cr' ? 'is-next' : '', x.forwarded ? day(x.forwarded.at) : x.status === 'returned' ? 'Query' : 'Waiting'),
          step('Hon. Chief Judge', ok ? 'is-done' : x.status === 'pending' ? 'is-next' : '', ok ? day(x.decision.at) : x.status === 'pending' ? 'Waiting' : ''),
          step('Transmitted', x.transmitted ? 'is-done' : ok ? 'is-next' : '', x.transmitted ? day(x.transmitted.at) : ok ? 'With the Chief Registrar' : ''),
          step('Paid', x.status === 'paid' ? 'is-done' : x.transmitted ? 'is-next' : '', x.status === 'paid' ? '' : x.transmitted ? 'With the Chief Accountant' : '')
        ]);
        const notice = (cls, title, text, by) => el('div', { class: 'cfx-note cfx-note--' + cls }, [el('div', { class: 'cfx-note__title' }, title), el('div', null, text), by ? el('div', { class: 'cfx-note__by' }, by) : null]);
        const notes = [
          x.status === 'returned' && x.query ? notice('query', `↩ Query from the ${x.query.by}`, x.query.text, `${x.query.byName}, ${when(x.query.at)}`) : null,
          x.forwarded && x.forwarded.note ? notice('info', 'Note of the Chief Registrar', x.forwarded.note, `${x.forwarded.byName}, ${when(x.forwarded.at)}`) : null,
          ok && x.decision.note ? notice('approved', '✔ Remark of the Hon. Chief Judge', x.decision.note, `${x.decision.byName}, ${when(x.decision.at)}`) : null,
          x.transmitted && x.transmitted.note ? notice('info', 'Transmitted by the Chief Registrar', x.transmitted.note, `${x.transmitted.byName}, ${when(x.transmitted.at)}`) : null,
          x.note ? notice('info', 'Remarks of the Chief Accountant', x.note, '') : null
        ].filter(Boolean);
        const list = el('div', { class: 'cfx-break' }, [el('h4', null, `Mandatories (${x.items.length})`),
          ...x.items.map(it => el('div', { class: 'cfx-break__sec' }, [
            el('div', { class: 'cfx-break__title' }, [it.title, it.struck ? el('span', { class: 'cfx-break__out' }, 'Not approved') : null]),
            el('div', { class: 'table-scroll' }, el('table', { class: 'cfx-break__table' + (it.struck ? ' is-out' : '') }, [
              el('thead', null, el('tr', null, [el('th', null, 'S/No'), el('th', null, 'Beneficiary'), el('th', null, 'Bank'), el('th', null, 'Account No.'), el('th', { class: 'num' }, 'Amount'), el('th', null, 'Payment'), x.can.pay ? el('th') : null])),
              el('tbody', null, it.payees.map((p, j) => el('tr', { class: it.struck ? 'is-struck' : '' }, [
                el('td', null, String(j + 1)),
                el('td', null, [p.name, p.accountName && p.accountName !== p.name ? el('div', { class: 'muted' }, `Account name: ${p.accountName}`) : null]),
                el('td', null, p.bank), el('td', null, el('span', { class: 'cf-acct' }, p.accountNo)), el('td', { class: 'num' }, naira(p.amount)),
                el('td', null, p.paid ? `PV ${p.paid.pvNo}, ${day(p.paid.date)}` : it.struck ? '—' : x.transmitted ? 'To be paid' : ok ? 'Awaiting transmission' : '—'),
                x.can.pay ? el('td', null, p.paid || it.struck ? null : el('button', { class: 'btn btn--primary btn--small', type: 'button', onclick: () => { dialog.close(); payDialog(x, p, after || payView, true); } }, 'Record Payment')) : null
              ]))),
              el('tfoot', null, el('tr', null, [el('td', { colspan: '4' }, `Total, ${it.title}`), el('td', { class: 'num' }, naira(it.amount)), el('td'), x.can.pay ? el('td') : null]))
            ]))
          ])),
          el('div', { class: 'cfx-break__grand' }, [el('span', null, 'Total of the mandatories'), el('strong', null, naira(x.total))]),
          ok && x.approvedTotal < x.total ? el('div', { class: 'cfx-break__grand cfx-break__grand--ok' }, [el('span', null, 'Approved by the Hon. Chief Judge'), el('strong', null, naira(x.approvedTotal))]) : null
        ]);
        const MACT = { submitted: 'Submitted to the Chief Registrar', answered: 'Query answered', forwarded: 'Approved by the Chief Registrar', returned: 'Returned with a query', approved: 'Approved by the Hon. Chief Judge', transmitted: 'Transmitted to the Chief Accountant', paid: 'Paid' };
        const TONE = { submitted: 'info', answered: 'info', forwarded: 'ok', returned: 'warn', approved: 'ok', transmitted: 'info', paid: 'ok' };
        const timeline = el('div', { class: 'cfx-timeline' }, [el('h4', null, 'History'), el('ol', null, x.history.map(h => el('li', { class: 'cfx-tl cfx-tl--' + (TONE[h.action] || 'info') }, [
          el('div', { class: 'cfx-tl__head' }, [el('strong', null, MACT[h.action] || h.action), el('span', null, `${h.byName} · ${when(h.at)}`)]),
          h.note ? el('div', { class: 'cfx-tl__note' }, h.note) : null
        ])))]);
        ui.modal('Monthly Mandatories', el('div', { class: 'cfx' }, [actions, hero, steps, ...notes, list, timeline]), { noFooter: true, wide: true, onOpen: (o) => { dialog = o; } });
      }

      // The Hon. Chief Judge approves the month's list: all of it, or without some mandatories.
      function approveMandatory(x, done) {
        const ticks = x.items.map((it, i) => ({ i, box: el('input', { type: 'checkbox', checked: 'checked' }), amount: it.amount }));
        const kept = el('div', { class: 'cfa-kept' });
        const sync = () => { const n = ticks.filter(t => t.box.checked).reduce((m, t) => m + t.amount, 0); kept.textContent = n < x.total ? `Approving ${naira(n)} of ${naira(x.total)}` : `Approving the full ${naira(x.total)}`; };
        ticks.forEach(t => t.box.addEventListener('change', sync));
        const note = el('input', { type: 'text', maxlength: '500', placeholder: 'Optional' });
        const pin = el('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: '8', placeholder: 'Signing PIN' });
        sync();
        ui.modal(`Approve the ${x.monthName} Mandatories`, el('div', null, [
          el('p', null, 'Untick any mandatory you do not approve this month.'),
          el('div', { class: 'cfa-list' }, x.items.map((it, i) => el('label', { class: 'cfa-sec__head' }, [ticks[i].box, el('strong', null, `${it.title} (${it.payees.length} beneficiar${it.payees.length === 1 ? 'y' : 'ies'})`), el('span', null, naira(it.amount))]))),
          kept, ui.field('Remark (optional)', note), ui.field('Your signing PIN', pin)
        ]), { wide: true, confirmText: 'Approve', confirmClass: 'btn--ok', onConfirm: async () => {
          if (!ticks.some(t => t.box.checked)) throw new Error('Every mandatory is unticked. Return the list with a query instead.');
          if (!pin.value) throw new Error('Enter your signing PIN.');
          await api.post(`/cashflow/mandatories/${x.id}/approve`, { pin: pin.value, note: note.value, struck: ticks.filter(t => !t.box.checked).map(t => t.i) });
          ui.toast('Approved. The Chief Registrar is notified to transmit it.', 'success', 6000); setTimeout(done, 0); return true;
        } });
      }

      // The month's list on paper, with the approval and the QR code.
      async function printMandatory(x) {
        const ok = ['approved', 'paid'].includes(x.status);
        let qr = null;
        if (ok) { try { qr = await api.get(`/cashflow/mandatories/${x.id}/qr`); } catch (e) { ui.toast(e.message, 'error'); return; } }
        const secs = x.items.map((it, i) => `<h3 class="cfp-sec">${i + 1}. ${esc(it.title)}${it.struck ? ' (not approved)' : ''}</h3><table class="doc-table"${it.struck ? ' style="color:#888;text-decoration:line-through"' : ''}><thead><tr><th>S/No</th><th>Beneficiary</th><th>Bank</th><th>Account No.</th><th style="text-align:right">Amount</th></tr></thead><tbody>${
          it.payees.map((p, j) => `<tr><td>${j + 1}</td><td>${esc(p.name)}</td><td>${esc(p.bank)}</td><td>${esc(p.accountNo)}</td><td style="text-align:right">${esc(naira(p.amount))}</td></tr>`).join('')
        }<tr><td colspan="4" style="text-align:right"><strong>Total</strong></td><td style="text-align:right"><strong>${esc(naira(it.amount))}</strong></td></tr></tbody></table>`).join('');
        window.App.processUi.printPage(`<article class="court-doc report-print">
          <header class="doc-masthead"><img class="doc-emblem" src="/assets/highcourt.png" alt=""><div class="doc-titleblock"><div class="doc-line1">THE JUDICIARY</div><div class="doc-line2">GOMBE STATE HIGH COURT OF JUSTICE</div><div class="doc-line3">MONTHLY MANDATORIES · ${esc(x.monthName.toUpperCase())}</div></div><img class="doc-emblem" src="/assets/coat.png" alt=""></header><div class="doc-rule"></div>
          <p style="margin:4px 0 8px">Ref: <strong>${esc(x.refNo)}</strong> · Prepared by ${esc(x.preparedByName)}, Chief Accountant, ${esc(day(x.createdAt))}</p>
          ${secs}
          <table class="doc-table" style="margin-top:8px"><tbody>
            <tr><td><strong>Total of the mandatories</strong></td><td style="text-align:right"><strong>${esc(naira(x.total))}</strong></td></tr>
            ${ok ? `<tr><td><strong>Approved by the Hon. Chief Judge</strong></td><td style="text-align:right"><strong>${esc(naira(x.approvedTotal))}</strong></td></tr>` : ''}
          </tbody></table>
          ${x.forwarded ? `<p style="font-size:9.5pt">Approved and sent to the Hon. Chief Judge by ${esc(x.forwarded.byName)}, Chief Registrar, on ${esc(day(x.forwarded.at))}.</p>` : ''}
          ${ok ? `<div class="doc-sign-wrap"><div class="doc-sign-block"><div class="doc-sig-meta" style="font-weight:700">APPROVED</div>${x.decision.signatureUrl ? `<img class="doc-sig-img" src="${x.decision.signatureUrl}" alt="Signature">` : ''}<div class="doc-sign">${esc([x.decision.title, x.decision.byName].filter(Boolean).join(' '))}<br>Hon. Chief Judge</div><div class="doc-sig-meta">${esc(day(x.decision.at))}${x.decision.note ? `: ${esc(x.decision.note)}` : ''}</div></div></div>`
            : `<p class="muted">Status: ${esc((MSTATUS[x.status] || [x.status])[0])}. Not yet approved: no payment may be made on this list.</p>`}
          ${x.transmitted ? `<p style="font-size:9.5pt">Transmitted to the Chief Accountant for payment by ${esc(x.transmitted.byName)}, Chief Registrar, on ${esc(day(x.transmitted.at))}.</p>` : ''}
          ${qr ? `<div class="doc-verify"><img class="doc-qr" src="${qr.qrDataUrl}" alt="Verification QR code"><div class="doc-verify__text">
            <strong>Verification code: ${esc(qr.verifyCode)}</strong><br>Scan the QR code, or visit ${esc(qr.verifyUrl)}, to confirm this list was approved by the Hon. Chief Judge and has not been altered.</div></div>` : ''}
          <footer class="doc-footer"><span>Printed ${esc(day(new Date()))}</span><span>Powered by the Directorate of ICT, Gombe State High Court of Justice</span></footer></article>`,
          '@page { size: A4; margin: 12mm; } .cfp-sec { font-size: 11pt; margin: 10px 0 4px; }');
      }

      // ── The month's approved cash flow, signed by the Chief Judge ──
      // The DCR's submission to the Hon. Chief Judge, with the request for the
      // release of funds: each item with its beneficiaries, and, once decided,
      // the CJ's decision on each.
      async function printSubmission(id) {
        let r;
        try { r = await api.get(`/cashflow/submissions/${id}`); } catch (e) { ui.toast(e.message, 'error'); return; }
        const sub = r.submission;
        let n = 0;
        const decision = (x) => !x.decision ? 'Awaiting decision' : x.decision.kind === 'approved' ? `Approved ${naira(x.decision.amount)}, ${day(x.decision.at)}` : 'Not approved';
        const rows = r.items.map(x => {
          const ps = x.payees.length ? x.payees : [{ name: '', bank: '', accountNo: '', amount: x.amount }];
          return ps.map((p, j) => `<tr><td>${j ? '' : ++n}</td><td>${j ? '' : `${esc(x.item)}<div class="muted">Item ${esc(x.sn)} · ${esc(x.requestedByName)}</div>`}</td><td>${esc(p.name)}</td><td>${esc(p.bank)}</td><td>${esc(p.accountNo)}</td><td style="text-align:right">${esc(naira(p.amount))}</td><td style="text-align:right">${j ? '' : `<strong>${esc(naira(x.amount))}</strong>`}</td><td>${j ? '' : esc(decision(x))}</td></tr>`).join('');
        }).join('');
        window.App.processUi.printPage(`<article class="court-doc report-print">
          <header class="doc-masthead"><img class="doc-emblem" src="/assets/highcourt.png" alt=""><div class="doc-titleblock"><div class="doc-line1">THE JUDICIARY</div><div class="doc-line2">GOMBE STATE HIGH COURT OF JUSTICE</div><div class="doc-line3">INTERNAL MEMO</div></div><img class="doc-emblem" src="/assets/coat.png" alt=""></header><div class="doc-rule"></div>
          <table class="cfp-memo"><tbody>
            <tr><td>From:</td><td>The Deputy Chief Registrar (Admin and Finance)</td><td>Ref:</td><td>${esc(sub.refNo)}</td></tr>
            <tr><td>To:</td><td>The Hon. Chief Judge</td><td>Date:</td><td>${esc(day(sub.at))}</td></tr>
          </tbody></table>
          <h3 style="text-align:center;text-decoration:underline;margin:10px 0">${sub.supplementary ? 'SUPPLEMENTARY ' : ''}CASH FLOW FOR ${esc(sub.monthName.toUpperCase())} AND REQUEST FOR RELEASE OF FUNDS</h3>
          <p>I submit the following item(s) on the ${esc(sub.monthName)} cash flow for your kind approval, together with the release of funds to the beneficiaries named below:</p>
          <table class="doc-table"><thead><tr><th>S/No</th><th>Item</th><th>Beneficiary</th><th>Bank</th><th>Account No.</th><th style="text-align:right">Amount</th><th style="text-align:right">Item total</th><th>Decision</th></tr></thead>
          <tbody>${rows}<tr><td colspan="6" style="text-align:right"><strong>Total</strong></td><td style="text-align:right"><strong>${esc(naira(sub.total))}</strong></td><td></td></tr></tbody></table>
          ${sub.note ? `<p>${esc(sub.note)}</p>` : ''}
          <p>Submitted for your kind consideration and approval, please.</p>
          <div class="cfp-from"><strong>${esc(sub.byName)}</strong><br>Deputy Chief Registrar (Admin and Finance)</div>
          <footer class="doc-footer"><span>Printed ${esc(day(new Date()))}</span><span>Powered by the Directorate of ICT, Gombe State High Court of Justice</span></footer></article>`,
          '@page { size: A4 landscape; margin: 10mm; } .cfp-memo { width: 100%; border-collapse: collapse; margin: 6px 0; } .cfp-memo td { padding: 3px 6px; vertical-align: top; } .cfp-memo td:nth-child(odd) { font-weight: 700; width: 4.5em; } .cfp-from { margin: 18px 0 8px; }');
      }

      async function printApproved(r) {
        const list = r.items.filter(x => ['approved', 'paid'].includes(x.status));
        if (!list.length) { ui.toast('Nothing approved on this cash flow yet.', 'info'); return; }
        // What is printed is fixed under a verification code, for its QR code.
        let sheet;
        try { sheet = await api.post('/cashflow/sheet', { month: r.month }); } catch (e) { ui.toast(e.message, 'error'); return; }
        const total = list.reduce((n, x) => n + x.decision.amount, 0);
        const signer = list.slice().reverse().find(x => x.decision && x.decision.signatureUrl);
        const who = (x) => x.payees.length ? `<div class="muted" style="font-size:8.5pt">${x.payees.map(p => `${esc(p.name)}, ${esc(p.bank)} ${esc(p.accountNo)}: ${esc(naira(p.approved))}`).join('<br>')}</div>` : '';
        const rows = list.map((x, i) => `<tr><td>${i + 1}</td><td>${esc(x.item)}${x.department ? `<div class="muted">${esc(x.department)}</div>` : ''}${who(x)}</td><td>${esc(x.requestedByName)}</td><td style="text-align:right">${esc(naira(x.amount))}</td><td style="text-align:right">${esc(naira(x.decision.amount))}</td><td>${esc(day(x.decision.at))}</td><td>${x.status === 'paid' ? `Paid${x.payments.length ? `, PV ${esc(x.payments.map(pm => pm.pvNo).join(', '))}` : ''}` : x.paid > 0 ? `Part paid, ${esc(naira(x.paid))}` : 'To be paid'}</td></tr>`).join('');
        window.App.processUi.printPage(`<article class="court-doc report-print">
          <header class="doc-masthead"><img class="doc-emblem" src="/assets/highcourt.png" alt=""><div class="doc-titleblock"><div class="doc-line1">THE JUDICIARY</div><div class="doc-line2">GOMBE STATE HIGH COURT OF JUSTICE</div><div class="doc-line3">APPROVED CASH FLOW · ${esc(r.monthName.toUpperCase())}</div></div><img class="doc-emblem" src="/assets/coat.png" alt=""></header><div class="doc-rule"></div>
          <table class="doc-table"><thead><tr><th>S/No</th><th>Item and beneficiaries</th><th>Requested by</th><th>Requested</th><th>Approved</th><th>Date approved</th><th>Payment</th></tr></thead>
          <tbody>${rows}<tr><td colspan="4" style="text-align:right"><strong>Total approved</strong></td><td style="text-align:right"><strong>${esc(naira(total))}</strong></td><td colspan="2"></td></tr></tbody></table>
          <div class="doc-sign-wrap"><div class="doc-sign-block">${signer ? `<img class="doc-sig-img" src="${signer.decision.signatureUrl}" alt="Signature">` : ''}<div class="doc-sign">${esc([signer && signer.decision.title, signer && signer.decision.byName].filter(Boolean).join(' '))}<br>Hon. Chief Judge</div>${signer ? `<div class="doc-sig-meta">Each item digitally approved on the date shown</div>` : ''}</div></div>
          <div class="doc-verify"><img class="doc-qr" src="${sheet.qrDataUrl}" alt="Verification QR code"><div class="doc-verify__text">
            <strong>Verification code: ${esc(sheet.verifyCode)}</strong><br>Scan the QR code, or visit ${esc(sheet.verifyUrl)}, to confirm this cash flow is genuine and unaltered.<br>
            Total approved ${esc(naira(sheet.total))}, as at ${esc(day(sheet.printedAt))}.</div></div>
          <footer class="doc-footer"><span>Printed ${esc(day(new Date()))}</span><span>Powered by the Directorate of ICT, Gombe State High Court of Justice</span></footer></article>`, '@page { size: A4 landscape; margin: 10mm; }');
      }
    }
  };
})();
