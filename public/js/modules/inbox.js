/*
 * modules/inbox.js — "Awaiting My Signature": forms submitted to this
 * judge / registrar / bailiff, oldest first.
 */
(function () {
  window.App = window.App || {};
  window.App.modules = window.App.modules || {};

  window.App.modules.inbox = {
    async render(container, ctx) {
      const { ui, api, workflow: wf, router } = ctx;
      container.appendChild(ui.el('div', { class: 'page-head' }, [
        ui.el('h1', null, 'Awaiting My Signature'),
        ui.el('p', { class: 'muted' }, 'Review each form, then approve with your signing PIN or return it with comments.')
      ]));
      const wrap = ui.el('div');
      container.appendChild(wrap);
      await router.units();

      async function load() {
        let records = [];
        try { records = (await api.get('/records/inbox')).records; }
        catch (e) { ui.clear(wrap).appendChild(ui.empty(e.offline ? 'Signing needs an internet connection.' : e.message)); return; }
        ui.clear(wrap);
        if (!records.length) { wrap.appendChild(ui.empty('Nothing is waiting for your signature.')); return; }
        wrap.appendChild(ui.table(
          [
            { label: 'Form', value: r => r.formLabel },
            { label: 'Reference', value: r => r.ref || '—' },
            { label: 'Party / Title', value: r => r.summary || '—' },
            { label: 'Unit', value: r => router.unitName(r.unitKey) },
            { label: 'Submitted By', value: r => r.submittedByName || '' },
            { label: 'Submitted', value: r => ui.fmtDate(r.submittedAt) },
            { label: 'Panel', value: r => r.slots.some(s => s.approvers.length > 1) ? r.slots.map(s => s.rule === 'all' ? 'All must sign' : 'Any one').join(', ') : '' }
          ],
          records,
          [
            { label: 'Review', class: 'btn--primary', onClick: r => wf.openDocument(r.id) },
            { label: 'Approve', class: 'btn--ok', onClick: r => wf.approveDialog(r).then(x => x && wf.changed()) },
            { label: 'Return', class: 'btn--danger', onClick: r => wf.returnDialog(r).then(x => x && wf.changed()) }
          ]
        ));
      }

      const stop = wf.onChange(() => (document.body.contains(container) ? load() : stop()));
      load();
    }
  };
})();
