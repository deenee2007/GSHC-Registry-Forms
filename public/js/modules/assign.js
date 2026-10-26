/*
 * modules/assign.js — the Hon. Chief Judge's Awaiting Assignment.
 * Each registered case shows the court proposed in turn; the Chief Judge
 * keeps it or chooses another court, and assigns with their signing PIN.
 * The Process Registry then prints the slip for the file.
 *
 * Also reassignment: the courts' requests (reassign or decline), and
 * Reassign, to move one case or many cases of a court, each to the court
 * chosen (or spread across courts in turn), with the reason and the PIN.
 */
(function () {
  window.App = window.App || {};
  window.App.modules = window.App.modules || {};

  window.App.modules.assign = {
    async render(container, ctx) {
      const { ui, api, router } = ctx;
      const el = ui.el;
      const P = window.App.processUi;
      const settings = await api.get('/process/settings');
      const reasons = settings.reassignReasons || [];
      const courtLabel = (k) => `High Court No. ${k.roman} (${k.name})`;
      container.appendChild(el('div', { class: 'page-head' }, [
        el('h1', null, '⚖ Awaiting Assignment'),
        el('p', { class: 'muted' }, 'New cases registered at the Process Registry. Each shows the court next in turn; keep it or choose another, then assign with your signing PIN. Requests and Reassign move cases already in a court.')
      ]));
      const tabsBar = el('div', { class: 'tabs', role: 'tablist' });
      const panel = el('div', { class: 'tab-panel' });
      container.append(tabsBar, panel);
      const TABS = [['awaiting_assignment', 'Awaiting Assignment'], ['requests', 'Requests to Reassign'], ['reassign', 'Reassign'], ['assigned,dispatched,received,disposed', 'Assigned']];
      let current = TABS.some(t => t[0] === ctx.tab) ? ctx.tab : 'awaiting_assignment';
      const changed = () => { router.refreshBadges(); countRequests(); load(); };
      // The number of requests on their tab.
      const countRequests = () => api.get('/process/counts').then(n => {
        const t = tabsBar.querySelector('[data-tab=requests]');
        if (t) t.textContent = `Requests to Reassign${n.reassignRequests ? ` (${n.reassignRequests})` : ''}`;
      }).catch(() => {});

      async function load() {
        if (current === 'requests') return requests();
        if (current === 'reassign') return reassignTab();
        let r;
        try { r = await api.get(`/process/cases?status=${current}`); } catch (e) { panel.replaceChildren(ui.empty(e.offline ? 'Assigning needs the internet.' : e.message)); return; }
        if (!r.cases.length) { panel.replaceChildren(ui.empty(current === 'awaiting_assignment' ? 'No case is awaiting assignment.' : 'No cases.')); return; }
        panel.replaceChildren(ui.table([
          { label: 'Suit No.', node: c => P.caseNo(ui, c.suitNumber) },
          { label: 'Parties', value: c => P.parties(c) },
          { label: 'Nature', value: c => c.nature + (c.efcc ? ' (EFCC)' : '') },
          { label: 'Registered', value: c => P.day(c.registeredAt) },
          current === 'awaiting_assignment'
            ? { label: 'Proposed court', value: c => c.proposed ? c.proposed.name : '' }
            : { label: 'Assigned to', value: c => c.assigned ? `High Court No. ${c.assigned.roman}, ${P.day(c.assignedAt)}${c.reassignedFrom ? ` (reassigned from No. ${c.reassignedFrom.roman})` : ''}` : '' }
        ], r.cases, current === 'awaiting_assignment' ? [{ label: 'Review & Assign', class: 'btn--ok', onClick: c => review(c.id) }] : []));
      }

      async function review(id) {
        let c;
        try { c = (await api.get(`/process/cases/${id}`)).case; } catch (e) { ui.toast(e.message, 'error'); return; }
        const court = el('select', { 'aria-label': 'Court' }, settings.courts.map(k => el('option', { value: k.key },
          `${courtLabel(k)}${c.proposed && k.key === c.proposed.key ? ': next in turn' : ''}`)));
        if (c.proposed) court.value = c.proposed.key;
        const pin = el('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: '8', placeholder: 'Signing PIN' });
        const body = el('div', null, [
          P.details(ui, c, settings),
          ui.field('Assign to', court, c.efcc ? 'EFCC matter: the courts proposed in turn are those set to hear EFCC matters.' : 'The court next in turn is chosen; the rotation continues from it whichever court you choose.'),
          ui.field('Your signing PIN', pin, 'Your signature is placed on the assignment, and the slip carries a QR code to check it.'),
          P.documentsPanel(ui, api, c.id)
        ]);
        ui.modal(`Assign ${c.suitNumber}`, body, {
          confirmText: '✔ Assign', confirmClass: 'btn--ok',
          onConfirm: async () => {
            if (!pin.value) { ui.toast('Enter your signing PIN.', 'error'); return undefined; }
            const r = await api.post(`/process/cases/${c.id}/assign`, { unitKey: court.value, pin: pin.value });
            ui.toast(`${r.case.suitNumber} assigned to High Court No. ${r.case.assigned.roman}. The Process Registry has been told to print the slip.`, 'success', 7000);
            changed();
            return true;
          }
        });
      }

      // The reason (from the list, or typed under Other) for a reassignment.
      function reasonPicker(initial) {
        const select = el('select', { 'aria-label': 'Reason' }, [el('option', { value: '' }, 'Choose the reason'), ...reasons.map(x => el('option', { value: x }, x))]);
        const other = el('input', { type: 'text', maxlength: '200', placeholder: 'Type the reason' });
        const otherField = ui.field('Other reason', other);
        if (initial) { if (reasons.includes(initial) && initial !== 'Other') select.value = initial; else { select.value = 'Other'; other.value = initial; } }
        const sync = () => { otherField.hidden = select.value !== 'Other'; };
        select.addEventListener('change', sync); sync();
        return { nodes: [ui.field('Reason for reassignment', select), otherField], value: () => ({ reason: select.value, other: other.value.trim() }),
          ok: () => select.value && (select.value !== 'Other' || other.value.trim()) };
      }
      const pinInput = () => el('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: '8', placeholder: 'Signing PIN' });

      // Send the moves to the server, with the reason and PIN.
      async function send(moves, picker, pin) {
        if (!picker.ok()) throw new Error('Choose the reason, or type it under Other.');
        if (!pin.value) throw new Error('Enter your signing PIN.');
        const r = await api.post('/process/reassign', { moves, ...picker.value(), pin: pin.value });
        ui.toast(`${r.reassigned} case${r.reassigned === 1 ? '' : 's'} reassigned. The courts, the Process Registry and the parties have been told; the Process Registry prints the new slip${r.reassigned === 1 ? '' : 's'}.`, 'success', 8000);
        changed();
        return r;
      }

      // ── The courts' requests ──
      async function requests() {
        let r;
        try { r = await api.get('/process/cases?requested=1&status=assigned,dispatched,received'); } catch (e) { panel.replaceChildren(ui.empty(e.offline ? 'This needs the internet.' : e.message)); return; }
        if (!r.cases.length) { panel.replaceChildren(ui.empty('No court has asked for a case to be reassigned.')); return; }
        panel.replaceChildren(ui.table([
          { label: 'Suit No.', node: c => P.caseNo(ui, c.suitNumber) },
          { label: 'Parties', value: c => P.parties(c) },
          { label: 'Now in', value: c => c.assigned ? `High Court No. ${c.assigned.roman}` : '' },
          { label: 'Reason', value: c => c.reassignRequest.reason + (c.reassignRequest.note ? `. ${c.reassignRequest.note}` : '') },
          { label: 'Asked by', value: c => `${c.reassignRequest.byName}, ${P.day(c.reassignRequest.at)}` }
        ], r.cases, [
          { label: 'Reassign', class: 'btn--ok', onClick: c => reassignOne(c) },
          { label: 'Decline', class: 'btn--danger', onClick: c => decline(c) }
        ]));
      }

      async function reassignOne(c) {
        const others = settings.courts.filter(k => !c.assigned || k.key !== c.assigned.key);
        const court = el('select', { 'aria-label': 'Court' }, [el('option', { value: '' }, 'Choose the court'), ...others.map(k => el('option', { value: k.key }, courtLabel(k)))]);
        const picker = reasonPicker(c.reassignRequest && c.reassignRequest.reason);
        const pin = pinInput();
        ui.modal(`Reassign ${c.suitNumber}`, el('div', null, [
          P.details(ui, c, settings),
          ui.field('Reassign to', court),
          ...picker.nodes,
          ui.field('Your signing PIN', pin, 'A new slip with a new QR code is made; the old slip will show as replaced when checked.')
        ]), {
          confirmText: '✔ Reassign', confirmClass: 'btn--ok',
          onConfirm: async () => {
            if (!court.value) throw new Error('Choose the court.');
            return send([{ id: c.id, unitKey: court.value }], picker, pin);
          }
        });
      }

      async function decline(c) {
        const comment = el('textarea', { rows: '3', maxlength: '500', placeholder: 'Optional: why the case stays where it is' });
        ui.modal(`Decline the request for ${c.suitNumber}`, el('div', null, [
          el('p', null, `${c.reassignRequest.byName} asked that this case be reassigned: ${c.reassignRequest.reason}. The case will stay in High Court No. ${c.assigned.roman}, and the court will be told.`),
          ui.field('Comment to the court', comment)
        ]), {
          confirmText: 'Decline', confirmClass: 'btn--danger',
          onConfirm: async () => {
            await api.post(`/process/cases/${c.id}/decline-reassignment`, { comment: comment.value.trim() });
            ui.toast('Request declined. The court has been told.', 'success');
            changed();
            return true;
          }
        });
      }

      // ── Reassign: the pending cases of one court, one or many at once ──
      let fromKey = '';
      async function reassignTab() {
        const from = el('select', { 'aria-label': 'Court' }, [el('option', { value: '' }, 'Choose the court'), ...settings.courts.map(k => el('option', { value: k.key }, courtLabel(k)))]);
        from.value = fromKey;
        const list = el('div');
        panel.replaceChildren(
          el('p', { class: 'muted' }, 'Choose the court the cases are now in. Tick the cases to move and choose the court for each, or send them all to one court, or spread them across courts in turn. Disposed cases are not listed. The suit numbers do not change.'),
          el('div', { class: 'report-filters' }, [el('label', { class: 'report-filter' }, [el('span', null, 'Cases now in'), from])]),
          list
        );
        from.addEventListener('change', () => { fromKey = from.value; show(); });
        async function show() {
          if (!fromKey) { list.replaceChildren(ui.empty('Choose a court to see its pending cases.')); return; }
          let r;
          try { r = await api.get(`/process/cases?unitKey=${encodeURIComponent(fromKey)}&status=assigned,dispatched,received`); } catch (e) { list.replaceChildren(ui.empty(e.message)); return; }
          if (!r.cases.length) { list.replaceChildren(ui.empty('This court has no pending case.')); return; }
          const targets = settings.courts.filter(k => k.key !== fromKey);
          const rows = r.cases.map(c => {
            const tick = el('input', { type: 'checkbox', 'aria-label': `Reassign ${c.suitNumber}` });
            const to = el('select', { 'aria-label': `Court for ${c.suitNumber}` }, [el('option', { value: '' }, 'Choose'), ...targets.map(k => el('option', { value: k.key }, `No. ${k.roman}`))]);
            to.addEventListener('change', () => { if (to.value) tick.checked = true; count(); });
            tick.addEventListener('change', count);
            return { c, tick, to };
          });
          const all = el('input', { type: 'checkbox', 'aria-label': 'All' });
          all.addEventListener('change', () => { rows.forEach(x => { x.tick.checked = all.checked; }); count(); });
          const one = el('select', { 'aria-label': 'One court for all ticked' }, [el('option', { value: '' }, 'Choose the court'), ...targets.map(k => el('option', { value: k.key }, courtLabel(k)))]);
          const spreadBoxes = targets.map(k => { const b = el('input', { type: 'checkbox', value: k.key }); b.checked = true; return { k, b }; });
          const summary = el('p', { class: 'muted' });
          const picked = () => rows.filter(x => x.tick.checked);
          function count() {
            const p = picked(), ready = p.filter(x => x.to.value).length;
            summary.textContent = p.length ? `${p.length} case${p.length === 1 ? '' : 's'} ticked; ${ready} with a court chosen.` : 'No case ticked.';
          }
          const sendAll = () => {
            if (!one.value) { ui.toast('Choose the court.', 'error'); return; }
            const p = picked();
            if (!p.length) { ui.toast('Tick the cases first.', 'error'); return; }
            p.forEach(x => { x.to.value = one.value; }); count();
          };
          // In turn across the courts ticked.
          const spread = () => {
            const ring = spreadBoxes.filter(x => x.b.checked).map(x => x.k.key);
            const p = picked();
            if (!p.length) { ui.toast('Tick the cases first.', 'error'); return; }
            if (!ring.length) { ui.toast('Tick at least one court to spread across.', 'error'); return; }
            p.forEach((x, i) => { x.to.value = ring[i % ring.length]; }); count();
          };
          list.replaceChildren(
            el('div', { class: 'reassign-tools' }, [
              el('div', { class: 'reassign-tool' }, [el('strong', null, 'Send all ticked to one court: '), one, el('button', { class: 'btn btn--small btn--ghost', onclick: sendAll }, 'Apply')]),
              el('div', { class: 'reassign-tool' }, [el('strong', null, 'Or spread them in turn across: '),
                el('div', { class: 'reassign-courts' }, spreadBoxes.map(x => el('label', { class: 'check check--plain' }, [x.b, ` No. ${x.k.roman}`]))),
                el('button', { class: 'btn btn--small btn--ghost', onclick: spread }, 'Spread')])
            ]),
            el('label', { class: 'check check--plain' }, [all, ` All ${rows.length} pending case${rows.length === 1 ? '' : 's'}`]),
            ui.table([
              { label: '', node: x => x.tick },
              { label: 'Suit No.', node: x => P.caseNo(ui, x.c.suitNumber) },
              { label: 'Parties', value: x => P.parties(x.c) },
              { label: 'Since', value: x => P.day(x.c.assignedAt || x.c.filedOn) },
              { label: 'Stage', node: x => P.badge(ui, x.c.status) },
              { label: 'Reassign to', node: x => x.to }
            ], rows),
            summary,
            el('div', { class: 'reassign-actions' }, [el('button', { class: 'btn btn--ok', onclick: confirm }, '✔ Reassign the ticked cases')])
          );
          count();
          async function confirm() {
            const p = picked();
            if (!p.length) { ui.toast('Tick the cases to reassign.', 'error'); return; }
            const missing = p.filter(x => !x.to.value);
            if (missing.length) { ui.toast(`Choose the court for ${missing.map(x => x.c.suitNumber).join(', ')}.`, 'error'); return; }
            const by = {};
            p.forEach(x => { by[x.to.value] = (by[x.to.value] || 0) + 1; });
            const picker = reasonPicker(), pin = pinInput();
            ui.modal(`Reassign ${p.length} case${p.length === 1 ? '' : 's'}`, el('div', null, [
              el('p', null, `From ${courtLabel(settings.courts.find(k => k.key === fromKey))}:`),
              el('ul', null, Object.entries(by).map(([k, n]) => el('li', null, `${n} to ${courtLabel(settings.courts.find(x => x.key === k))}`))),
              ...picker.nodes,
              ui.field('Your signing PIN', pin, 'Each case gets a new slip and QR code. Dates fixed ahead in the former court\'s diary are taken out; the new court fixes its own.')
            ]), {
              confirmText: '✔ Reassign', confirmClass: 'btn--ok',
              onConfirm: () => send(p.map(x => ({ id: x.c.id, unitKey: x.to.value })), picker, pin)
            });
          }
        }
        show();
      }

      TABS.forEach(([key, name]) => {
        const btn = el('button', { class: 'tab' + (key === current ? ' is-active' : ''), role: 'tab', 'data-tab': key.split(',')[0], onclick: () => {
          tabsBar.querySelectorAll('.tab').forEach(t => t.classList.remove('is-active'));
          btn.classList.add('is-active');
          current = key;
          load();
        } }, name);
        tabsBar.appendChild(btn);
      });
      countRequests();
      load();
    }
  };
})();
