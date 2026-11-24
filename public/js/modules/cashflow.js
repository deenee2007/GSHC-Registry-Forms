/*
 * modules/cashflow.js — the monthly cash flow.
 *
 * The Hon. Chief Judge: the month's money (released, brought forward,
 * approved, paid, balance) and the list of items (S/No, item, amount, who
 * submitted it, status), each with Details: approve (in full or less, with
 * the PIN), decline, or return with a query; carry forward or dismiss an
 * item not approved. Requesters (the CJ's aide, the Chief Registrar, the
 * DCR Admin and Finance): New Request, their own requests (answering a
 * query), and the month's list. The Accountant: the approved items, to
 * record each payment. Print: the month's approved cash flow, with the
 * Chief Judge's signature.
 */
(function () {
  window.App = window.App || {};
  window.App.modules = window.App.modules || {};

  const naira = (n) => `₦${Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const STATUS = { pending: ['Awaiting the CJ', 'pending'], returned: ['Returned with a query', 'returned'], approved: ['Approved', 'final'],
    declined: ['Not approved', 'declined'], paid: ['Paid', 'final'], dismissed: ['Dismissed', 'draft'] };
  const ACTION = { requested: 'Requested', answered: 'Query answered', approved: 'Approved', declined: 'Not approved', returned: 'Returned with a query',
    paid: 'Paid', carried: 'Carried forward', dismissed: 'Dismissed', moved: 'Moved to the new month' };

  window.App.modules.cashflow = {
    async render(container, ctx) {
      const { ui, api, router } = ctx;
      const el = ui.el;
      let me;
      try { me = await api.get('/cashflow/me'); } catch (e) { container.appendChild(ui.empty(e.offline ? 'The cash flow needs the internet.' : e.message)); return; }
      const badge = (s) => { const [t, c] = STATUS[s] || [s, 'draft']; return el('span', { class: 'badge badge--' + c }, t); };
      const day = (d) => d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

      container.appendChild(el('div', { class: 'page-head' }, [
        el('h1', null, '💵 Cash Flow'),
        el('p', { class: 'muted' }, me.cj ? 'Items placed on the monthly cash flow for your approval. Open Details to approve, decline or return an item with a query.'
          : me.admin && !me.requester && !me.accountant ? 'The monthly cash flow, for oversight: every item, the money and the balance. Decisions are the Hon. Chief Judge\'s; requests and payments are made by the officers concerned.'
          : me.accountant && !me.seesAll ? 'Items approved by the Hon. Chief Judge, for payment.'
            : 'Items requested on the monthly cash flow, for the approval of the Hon. Chief Judge.')
      ]));
      const tabsBar = el('div', { class: 'tabs', role: 'tablist' });
      const panel = el('div', { class: 'tab-panel' });
      container.append(tabsBar, panel);
      const TABS = [
        me.seesAll ? ['month', me.cj ? 'This Month\'s Cash Flow' : 'The Cash Flow', monthView] : null,
        me.requester ? ['mine', 'My Requests', mineView] : null,
        me.accountant ? ['pay', 'For Payment', payView] : null
      ].filter(Boolean);
      TABS.forEach(([key, label, fn], i) => {
        const b = el('button', { class: 'tab' + (i ? '' : ' is-active'), role: 'tab', onclick: () => { tabsBar.querySelectorAll('.tab').forEach(t => t.classList.remove('is-active')); b.classList.add('is-active'); fn(); } }, label);
        tabsBar.appendChild(b);
      });
      let month = me.month;
      if (TABS.length) TABS[0][2]();

      // ── The month's list (and, for the CJ, the money) ──
      async function monthView() {
        panel.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
        let r;
        try { r = await api.get(`/cashflow?month=${month}`); } catch (e) { panel.replaceChildren(ui.empty(e.message)); return; }
        const pick = el('select', { 'aria-label': 'Month', onchange: () => { month = pick.value; monthView(); } }, r.months.map(m => el('option', { value: m.month }, m.name)));
        pick.value = r.month;
        const kids = [el('div', { class: 'toolbar' }, [
          ui.field('Month', pick),
          me.requester ? el('button', { class: 'btn btn--primary', onclick: () => requestForm() }, '+ New Request') : null,
          el('button', { class: 'btn btn--ghost', onclick: () => printApproved(r) }, '🖨 Print Approved Cash Flow')
        ])];
        if (r.summary) {
          const s = r.summary;
          const card = (v, l, cls) => el('div', { class: 'dash-card ' + (cls || '') }, [el('div', { class: 'dash-card__num cash-num' }, naira(v)), el('div', { class: 'dash-card__label' }, l)]);
          kids.push(el('div', { class: 'dash-stats cash-stats' }, [
            card(s.broughtForward, 'Brought forward'), card(s.released, `Released for ${r.monthName}`), card(s.available, 'Available'),
            card(s.approved, 'Approved'), card(s.paid, 'Paid', 'dash-card--ok'), card(s.balance, 'Balance', s.balance < 0 ? 'dash-card--warn' : '')
          ]));
          if (s.approved > s.available) kids.push(el('div', { class: 'notice notice--warn' }, 'The items approved this month are more than the amount available.'));
        }
        kids.push(r.items.length ? ui.table([
          { label: 'S/No', value: x => String(x.sn) },
          { label: 'Item', value: x => x.item, primary: true },
          { label: 'Amount', value: x => naira(x.amount) + (x.decision && x.decision.kind === 'approved' && x.decision.amount < x.amount ? ` (approved ${naira(x.decision.amount)})` : '') },
          { label: 'Submitted by', value: x => `${x.requestedByName}${x.requestedByRole ? `, ${x.requestedByRole}` : ''}` },
          { label: 'Status', node: x => el('span', null, [badge(x.status), x.carriedFrom ? el('div', { class: 'muted cash-from' }, `from ${x.carriedFrom}`) : null]) }
        ], r.items, [{ label: 'Details', onClick: x => details(x.id, monthView) }]) : ui.empty(`Nothing on the ${r.monthName} cash flow yet.`));
        panel.replaceChildren(...kids);
      }

      // ── A requester's own items ──
      async function mineView() {
        panel.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
        let r;
        try { r = await api.get('/cashflow/mine'); } catch (e) { panel.replaceChildren(ui.empty(e.message)); return; }
        panel.replaceChildren(
          el('div', { class: 'toolbar' }, [el('button', { class: 'btn btn--primary', onclick: () => requestForm() }, '+ New Request')]),
          r.items.length ? ui.table([
            { label: 'Month', value: x => x.monthName }, { label: 'S/No', value: x => String(x.sn) }, { label: 'Item', value: x => x.item, primary: true },
            { label: 'Amount', value: x => naira(x.amount) }, { label: 'Status', node: x => badge(x.status) }
          ], r.items, [{ label: x => x.can.answer ? 'Answer Query' : x.can.carry ? 'Carry or Dismiss' : 'Details', onClick: x => details(x.id, mineView) }]) : ui.empty('You have not requested anything yet. Use + New Request.')
        );
      }

      // ── The Accountant: approved items to pay ──
      async function payView() {
        panel.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
        let r;
        try { r = await api.get(`/cashflow?month=${month}`); } catch (e) { panel.replaceChildren(ui.empty(e.message)); return; }
        const todo = r.items.filter(x => x.status === 'approved'), done = r.items.filter(x => x.status === 'paid');
        const cols = [{ label: 'S/No', value: x => String(x.sn) }, { label: 'Item', value: x => x.item, primary: true },
          { label: 'Approved', value: x => naira(x.decision && x.decision.amount) }, { label: 'Requested by', value: x => x.requestedByName }];
        panel.replaceChildren(
          el('h3', { class: 'settings-group' }, `To pay (${todo.length})`),
          todo.length ? ui.table(cols, todo, [{ label: 'Record Payment', class: 'btn--primary', onClick: x => payDialog(x, payView) }, { label: 'Details', onClick: x => details(x.id, payView) }]) : ui.empty('Nothing waiting for payment.'),
          el('h3', { class: 'settings-group' }, `Paid (${done.length})`),
          done.length ? ui.table([...cols, { label: 'Paid', value: x => `${naira(x.payment.amount)}, PV ${x.payment.pvNo}, ${day(x.payment.date)}` }], done, [{ label: 'Details', onClick: x => details(x.id, payView) }]) : ui.empty('Nothing paid yet this month.')
        );
      }

      // ── A new request (or the answer to a query) ──
      function requestForm(x) {
        const v = x || {};
        const item = el('input', { type: 'text', value: v.item || '', maxlength: '200' });
        const desc = el('textarea', { rows: 3, maxlength: '3000' }); desc.value = v.description || '';
        const qty = el('input', { type: 'number', min: '0', step: 'any', value: v.quantity ?? '' });
        const unit = el('input', { type: 'number', min: '0', step: '0.01', value: v.unitPrice ?? '' });
        const amount = el('input', { type: 'number', min: '0', step: '0.01', value: v.amount ?? '' });
        const total = el('div', { class: 'muted' });
        const sync = () => { if (qty.value && unit.value) { amount.value = String(Math.round(Number(qty.value) * Number(unit.value) * 100) / 100); amount.readOnly = true; } else amount.readOnly = false; total.textContent = amount.value ? `Total: ${naira(amount.value)}` : ''; };
        [qty, unit, amount].forEach(i => i.addEventListener('input', sync)); sync();
        const dept = el('input', { type: 'text', value: v.department || '', placeholder: 'e.g. Works, High Court No. III, Registry' });
        const just = el('textarea', { rows: 3, maxlength: '3000' }); just.value = v.justification || '';
        const files = el('input', { type: 'file', multiple: 'multiple', accept: 'application/pdf,image/*' });
        const answer = el('textarea', { rows: 3, maxlength: '2000' });
        ui.modal(x ? `Answer the Query · ${v.item}` : 'New Request', el('div', { class: 'form-grid' }, [
          x ? el('div', { class: 'notice notice--warn form-field--full' }, [el('strong', null, 'Query from the Hon. Chief Judge: '), v.query ? v.query.text : '']) : null,
          x ? el('div', { class: 'form-field--full' }, ui.field('Your answer', answer)) : null,
          el('div', { class: 'form-field--full' }, ui.field('Item', item)),
          el('div', { class: 'form-field--full' }, ui.field('Description', desc)),
          ui.field('Quantity (optional)', qty), ui.field('Unit price, ₦ (optional)', unit),
          ui.field('Amount, ₦', amount, 'Worked out from the quantity and unit price when both are given'), total,
          ui.field('Department or purpose', dept),
          el('div', { class: 'form-field--full' }, ui.field('Justification', just)),
          el('div', { class: 'form-field--full' }, ui.field('Attachments (optional)', files, 'Memo, invoice or quotation: PDF or photo, up to 5 files of 10 MB'))
        ]), {
          wide: true, confirmText: x ? 'Send Back to the CJ' : 'Submit to the Cash Flow',
          onConfirm: async () => {
            if (!item.value.trim()) throw new Error('Enter the item requested.');
            if (!(Number(amount.value) > 0)) throw new Error('Enter the amount.');
            if (x && !answer.value.trim()) throw new Error('Answer the query.');
            const f = new FormData();
            Object.entries({ item: item.value.trim(), description: desc.value, quantity: qty.value, unitPrice: unit.value, amount: amount.value, department: dept.value, justification: just.value, answer: answer.value })
              .forEach(([k, val]) => f.append(k, val));
            [...files.files].forEach(file => f.append('files', file));
            if (x) await api.put(`/cashflow/${x.id}`, f); else await api.post('/cashflow', f);
            ui.toast(x ? 'Sent back to the Hon. Chief Judge.' : 'Placed on this month\'s cash flow. The Hon. Chief Judge is notified.', 'success', 6000);
            router.refreshBadges(); TABS.length && TABS[0][2](); return true;
          }
        });
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
          x.can.decide ? btn('✔  Approve', 'btn--ok', () => approve(x, done)) : null,
          x.can.decide ? btn('↩  Return with Query', 'btn--ghost', () => query(x, done)) : null,
          x.can.decide ? btn('✕  Decline', 'btn--danger', () => decline(x, done)) : null,
          x.can.answer ? btn('Answer Query', 'btn--primary', () => { dialog.close(); requestForm(x); }) : null,
          x.can.carry ? btn('➜  Carry to Next Cash Flow', 'btn--primary', async () => { try { await api.post(`/cashflow/${x.id}/carry`); ui.toast('Carried to the next cash flow.', 'success'); done(); } catch (e) { ui.toast(e.message, 'error'); } }) : null,
          x.can.carry ? btn('Dismiss', 'btn--danger', async () => { if (!confirm(`Dismiss ${x.item}? It leaves the cash flow for good.`)) return; try { await api.post(`/cashflow/${x.id}/dismiss`); ui.toast('Dismissed.', 'info'); done(); } catch (e) { ui.toast(e.message, 'error'); } }) : null,
          x.can.pay ? btn('Record Payment', 'btn--primary', () => { dialog.close(); payDialog(x, after); }) : null
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
            el('div', { class: 'cfx-hero__by' }, [badge(x.status), el('span', null, `Requested by ${x.requestedByName}${x.requestedByRole ? `, ${x.requestedByRole}` : ''}`)])
          ]),
          el('div', { class: 'cfx-hero__money' }, [
            el('div', { class: 'cfx-hero__label' }, 'Amount requested'),
            el('div', { class: 'cfx-hero__amount' + (lower ? ' cfx-hero__amount--struck' : '') }, naira(x.amount)),
            approved !== null ? el('div', { class: 'cfx-hero__approved' }, `Approved ${naira(approved)}`) : null,
            x.payment ? el('div', { class: 'cfx-hero__paid' }, `Paid ${naira(x.payment.amount)}`) : null
          ])
        ]);
        // Progress: requested, the Chief Judge's decision, payment.
        const decided = x.decision ? x.decision.kind : (x.status === 'returned' ? 'query' : null);
        const step = (name, state, sub) => el('li', { class: 'cd-step ' + state }, [
          el('span', { class: 'cd-dot' }, state === 'is-done' ? '✓' : state === 'is-stop' ? '✕' : ''),
          el('span', { class: 'cd-step__name' }, name), sub ? el('span', { class: 'cd-step__date' }, sub) : null]);
        const steps = el('ol', { class: 'cd-steps cfx-steps' }, [
          step('Requested', 'is-done', day(x.createdAt)),
          x.status === 'returned' ? step('Query from the CJ', 'is-next', x.query ? day(x.query.at) : '')
            : decided === 'approved' ? step('Approved by the CJ', 'is-done', day(x.decision.at))
              : decided === 'declined' ? step('Not approved', 'is-stop', day(x.decision.at))
                : step('Decision of the CJ', 'is-next', 'Waiting'),
          decided === 'declined' ? step(x.status === 'dismissed' ? 'Dismissed' : 'Carry or dismiss', x.status === 'dismissed' ? 'is-stop' : 'is-next', '')
            : step('Paid', x.payment ? 'is-done' : decided === 'approved' ? 'is-next' : '', x.payment ? day(x.payment.date) : decided === 'approved' ? 'With the Accountant' : '')
        ]);
        const notice = (cls, title, text, by) => el('div', { class: 'cfx-note cfx-note--' + cls }, [el('div', { class: 'cfx-note__title' }, title), el('div', null, text), by ? el('div', { class: 'cfx-note__by' }, by) : null]);
        const notes = [
          x.status === 'returned' && x.query ? notice('query', '↩ Query from the Hon. Chief Judge', x.query.text, `${x.query.byName}, ${when(x.query.at)}`) : null,
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
            field('Quantity × unit price', x.quantity && x.unitPrice ? `${x.quantity} × ${naira(x.unitPrice)}` : '—'),
            field('Approved', approved !== null ? naira(approved) + (lower ? ` (${naira(x.amount - approved)} less)` : '') : decided === 'declined' ? 'Not approved' : 'Awaiting decision'),
            field('Paid', x.payment ? `${naira(x.payment.amount)} · PV ${x.payment.pvNo}` : approved !== null ? 'Not yet' : '—'),
            x.payment ? field('Payment recorded', `${day(x.payment.date)} by ${x.payment.byName}`, true) : null
          ])])
        ]);
        const text = (title, body) => body ? el('div', { class: 'cfx-text' }, [el('h4', null, title), el('p', null, body)]) : null;
        const fileIcon = (n) => /\.pdf$/i.test(n) ? '📄' : /\.(png|jpe?g|gif|webp|heic)$/i.test(n) ? '🖼' : '📎';
        const files = x.attachments.length ? el('div', { class: 'cfx-files' }, [el('h4', null, `Attachments (${x.attachments.length})`),
          el('div', { class: 'cfx-files__list' }, x.attachments.map(a => el('a', { class: 'cfx-file', href: a.url, target: '_blank', rel: 'noopener' }, [
            el('span', { class: 'cfx-file__icon' }, fileIcon(a.name)), el('span', { class: 'cfx-file__name' }, a.name), el('span', { class: 'cfx-file__open' }, 'Open')])))]) : null;
        const TONE = { requested: 'info', answered: 'info', approved: 'ok', paid: 'ok', declined: 'bad', dismissed: 'bad', returned: 'warn', carried: 'info', moved: 'info' };
        const timeline = el('div', { class: 'cfx-timeline' }, [el('h4', null, 'History'), el('ol', null, x.history.map(h => el('li', { class: 'cfx-tl cfx-tl--' + (TONE[h.action] || 'info') }, [
          el('div', { class: 'cfx-tl__head' }, [el('strong', null, ACTION[h.action] || h.action), el('span', null, `${h.byName} · ${when(h.at)}`)]),
          h.note ? el('div', { class: 'cfx-tl__note' }, h.note) : null
        ])))]);
        const body = el('div', { class: 'cfx' }, [actions, hero, steps, ...notes, cards,
          (x.description || x.justification) ? el('div', { class: 'cfx-texts' }, [text('Description', x.description), text('Justification', x.justification)]) : null,
          files, timeline]);
        ui.modal('Cash Flow Item', body, { noFooter: true, wide: true, onOpen: (o) => { dialog = o; } });
      }

      function approve(x, done) {
        const amount = el('input', { type: 'number', min: '0', step: '0.01', value: String(x.amount) });
        const note = el('input', { type: 'text', maxlength: '500', placeholder: 'Optional' });
        const pin = el('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: '8', placeholder: 'Signing PIN' });
        ui.modal(`Approve · ${x.item}`, el('div', null, [
          el('p', null, `Requested: ${naira(x.amount)}. You may approve a lower amount.`),
          ui.field('Amount approved, ₦', amount), ui.field('Remark (optional)', note), ui.field('Your signing PIN', pin)
        ]), { confirmText: 'Approve', confirmClass: 'btn--ok', onConfirm: async () => {
          if (!pin.value) throw new Error('Enter your signing PIN.');
          await api.post(`/cashflow/${x.id}/decide`, { action: 'approve', amount: amount.value, note: note.value, pin: pin.value });
          ui.toast('Approved. The Accountant is notified.', 'success'); setTimeout(done, 0); return true;
        } });
      }
      function query(x, done) {
        const note = el('textarea', { rows: 3, maxlength: '2000', placeholder: 'What should the requester clarify or correct?' });
        ui.modal(`Return with Query · ${x.item}`, ui.field('Query', note), { confirmText: 'Return', onConfirm: async () => {
          if (!note.value.trim()) throw new Error('Write the query.');
          await api.post(`/cashflow/${x.id}/decide`, { action: 'return', note: note.value.trim() });
          ui.toast(`Returned to ${x.requestedByName} with your query.`, 'info'); setTimeout(done, 0); return true;
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
      function payDialog(x, after) {
        const pv = el('input', { type: 'text', maxlength: '60', placeholder: 'e.g. PV/112/2026' });
        const date = el('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
        const amount = el('input', { type: 'number', min: '0', step: '0.01', value: String(x.decision.amount) });
        ui.modal(`Record Payment · ${x.item}`, el('div', null, [
          el('p', null, `Approved: ${naira(x.decision.amount)}.`),
          ui.field('Payment voucher number', pv), ui.field('Date paid', date), ui.field('Amount paid, ₦', amount)
        ]), { confirmText: 'Record Payment', onConfirm: async () => {
          if (!pv.value.trim()) throw new Error('Enter the payment voucher number.');
          await api.post(`/cashflow/${x.id}/pay`, { pvNo: pv.value.trim(), date: date.value, amount: amount.value });
          ui.toast('Payment recorded. The Hon. Chief Judge is notified.', 'success'); router.refreshBadges(); setTimeout(after, 0); return true;
        } });
      }

      // ── The month's approved cash flow, signed by the Chief Judge ──
      async function printApproved(r) {
        const list = r.items.filter(x => ['approved', 'paid'].includes(x.status));
        if (!list.length) { ui.toast('Nothing approved on this cash flow yet.', 'info'); return; }
        // What is printed is fixed under a verification code, for its QR code.
        let sheet;
        try { sheet = await api.post('/cashflow/sheet', { month: r.month }); } catch (e) { ui.toast(e.message, 'error'); return; }
        const total = list.reduce((n, x) => n + x.decision.amount, 0);
        const signer = list.slice().reverse().find(x => x.decision && x.decision.signatureUrl);
        const rows = list.map((x, i) => `<tr><td>${i + 1}</td><td>${esc(x.item)}${x.department ? `<div class="muted">${esc(x.department)}</div>` : ''}</td><td>${esc(x.requestedByName)}</td><td style="text-align:right">${esc(naira(x.amount))}</td><td style="text-align:right">${esc(naira(x.decision.amount))}</td><td>${esc(day(x.decision.at))}</td><td>${x.payment ? `Paid, PV ${esc(x.payment.pvNo)}` : 'To be paid'}</td></tr>`).join('');
        window.App.processUi.printPage(`<article class="court-doc report-print">
          <header class="doc-masthead"><img class="doc-emblem" src="/assets/highcourt.png" alt=""><div class="doc-titleblock"><div class="doc-line1">THE JUDICIARY</div><div class="doc-line2">GOMBE STATE HIGH COURT OF JUSTICE</div><div class="doc-line3">APPROVED CASH FLOW · ${esc(r.monthName.toUpperCase())}</div></div><img class="doc-emblem" src="/assets/coat.png" alt=""></header><div class="doc-rule"></div>
          <table class="doc-table"><thead><tr><th>S/No</th><th>Item</th><th>Requested by</th><th>Requested</th><th>Approved</th><th>Date approved</th><th>Payment</th></tr></thead>
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
