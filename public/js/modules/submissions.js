/*
 * modules/submissions.js — "My Submissions": what happened to the forms I
 * submitted. Approved forms come back here, ready to print.
 */
(function () {
  window.App = window.App || {};
  window.App.modules = window.App.modules || {};

  const TABS = [
    ['final', 'Approved'], ['pending', 'Awaiting Signature'], ['returned', 'Returned'], ['revoked', 'Revoked']
  ];

  window.App.modules.submissions = {
    async render(container, ctx) {
      const { ui, api, workflow: wf, router } = ctx;
      let tab = ctx.tab || 'final';

      container.appendChild(ui.el('div', { class: 'page-head' }, [
        ui.el('h1', null, 'My Submissions'),
        ui.el('p', { class: 'muted' }, 'Forms you submitted for signature. Approved forms are signed and ready to print.')
      ]));
      const tabsBar = ui.el('div', { class: 'tabs', role: 'tablist' });
      const panel = ui.el('div', { class: 'tab-panel' });
      container.append(tabsBar, panel);
      await router.units();

      TABS.forEach(([key, label]) => {
        const b = ui.el('button', { class: 'tab' + (key === tab ? ' is-active' : ''), role: 'tab', onclick: () => {
          tab = key;
          tabsBar.querySelectorAll('.tab').forEach(t => t.classList.remove('is-active'));
          b.classList.add('is-active');
          load();
        } }, label);
        tabsBar.appendChild(b);
      });

      async function load() {
        let records = [];
        try { records = (await api.get('/records/submitted' + api.qs({ status: tab }))).records; }
        catch (e) { ui.clear(panel).appendChild(ui.empty(e.offline ? 'Not available offline.' : e.message)); return; }
        ui.clear(panel);
        if (!records.length) {
          panel.appendChild(ui.empty({ final: 'No approved forms yet.', pending: 'Nothing is waiting for signature.', returned: 'No forms have been returned to you.', revoked: 'No revoked forms.' }[tab]));
          return;
        }
        const cols = [
          { label: 'Form', value: r => r.formLabel },
          { label: 'Reference', value: r => r.ref || '—' },
          { label: 'Party / Title', value: r => r.summary || '—' },
          { label: 'Unit', value: r => router.unitName(r.unitKey) }
        ];
        if (tab === 'final') {
          cols.push({ label: 'Signed', value: r => ui.fmtDate(r.finalizedAt) });
          cols.push({ label: 'Printed', node: r => r.printCount
            ? ui.el('span', { class: 'muted' }, `${r.printCount} time(s)`)
            : ui.el('span', { class: 'badge badge--new' }, 'Ready to print') });
        } else if (tab === 'pending') {
          cols.push({ label: 'Waiting For', value: r => r.slots.filter(s => !s.done).map(s => s.approvers.map(a => a.fullName).join(s.rule === 'all' ? ' and ' : ' or ')).join('; ') });
          cols.push({ label: 'Submitted', value: r => ui.fmtDate(r.submittedAt) });
        } else if (tab === 'returned') {
          cols.push({ label: 'Comments', value: r => `${r.returnedBy}: ${r.returnComment || ''}` });
        } else {
          cols.push({ label: 'Reason', value: r => r.revokeReason || '' });
        }

        panel.appendChild(ui.table(cols, records, [
          { label: 'Open', onClick: r => wf.openDocument(r.id) },
          { label: '🖨 Print', class: 'btn--primary', show: () => tab === 'final', onClick: r => wf.print(r.id) },
          { label: 'Edit', show: r => wf.abilities(r).edit, onClick: async r => { const { record } = await api.get('/records/' + r.id); wf.openForm({ unitKey: r.unitKey, formType: r.formType, record }); } },
          { label: 'Resubmit', class: 'btn--ok', show: r => tab === 'returned' && wf.abilities(r).submit, onClick: r => wf.submitDialog(r).then(x => x && wf.changed()) },
          { label: 'Withdraw', show: () => tab === 'pending', onClick: r => wf.withdraw(r).then(x => x && wf.changed()) }
        ]));
      }

      const stop = wf.onChange(() => (document.body.contains(container) ? load() : stop()));
      load();
    }
  };
})();
