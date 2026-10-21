/*
 * modules/assign.js — the Hon. Chief Judge's Awaiting Assignment.
 * Each registered case shows the court proposed in turn; the Chief Judge
 * keeps it or chooses another court, and assigns with their signing PIN.
 * The Process Registry then prints the slip for the file.
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
      container.appendChild(el('div', { class: 'page-head' }, [
        el('h1', null, '⚖ Awaiting Assignment'),
        el('p', { class: 'muted' }, 'New cases registered at the Process Registry. Each shows the court next in turn; keep it or choose another, then assign with your signing PIN.')
      ]));
      const tabsBar = el('div', { class: 'tabs', role: 'tablist' });
      const panel = el('div', { class: 'tab-panel' });
      container.append(tabsBar, panel);
      let current = 'awaiting_assignment';

      async function load() {
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
            : { label: 'Assigned to', value: c => c.assigned ? `High Court No. ${c.assigned.roman}, ${P.day(c.assignedAt)}` : '' }
        ], r.cases, current === 'awaiting_assignment' ? [{ label: 'Review & Assign', class: 'btn--ok', onClick: c => review(c.id) }] : []));
      }

      async function review(id) {
        let c;
        try { c = (await api.get(`/process/cases/${id}`)).case; } catch (e) { ui.toast(e.message, 'error'); return; }
        const court = el('select', { 'aria-label': 'Court' }, settings.courts.map(k => el('option', { value: k.key },
          `High Court No. ${k.roman} (${k.name})${c.proposed && k.key === c.proposed.key ? ': next in turn' : ''}`)));
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
            router.refreshBadges();
            load();
            return true;
          }
        });
      }

      [['awaiting_assignment', 'Awaiting Assignment'], ['assigned,received,disposed', 'Assigned']].forEach(([key, name], i) => {
        const btn = el('button', { class: 'tab' + (i === 0 ? ' is-active' : ''), role: 'tab', onclick: () => {
          tabsBar.querySelectorAll('.tab').forEach(t => t.classList.remove('is-active'));
          btn.classList.add('is-active');
          current = key;
          load();
        } }, name);
        tabsBar.appendChild(btn);
      });
      load();
    }
  };
})();
