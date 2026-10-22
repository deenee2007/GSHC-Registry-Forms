/*
 * modules/inbox.js — "Awaiting My Signature": forms submitted to this
 * judge / registrar / bailiff, oldest first; and the signer's own history:
 * Signed by Me and Returned by Me, newest first, with a search.
 */
(function () {
  window.App = window.App || {};
  window.App.modules = window.App.modules || {};

  window.App.modules.inbox = {
    async render(container, ctx) {
      const { ui, api, workflow: wf, router } = ctx;
      const el = ui.el;
      container.appendChild(el('div', { class: 'page-head' }, [
        el('h1', null, 'Awaiting My Signature'),
        el('p', { class: 'muted' }, 'Review each form, then approve with your signing PIN or return it with comments. Signed by Me and Returned by Me keep the forms you have dealt with.')
      ]));
      const tabsBar = el('div', { class: 'tabs', role: 'tablist' });
      const search = el('input', { type: 'search', class: 'search-input', placeholder: '🔍  Search reference, party or suit number' });
      const searchBar = el('div', { class: 'filter-bar', hidden: 'hidden' }, [search]);
      const wrap = el('div');
      container.append(tabsBar, searchBar, wrap);
      await router.units();
      let tab = ctx.tab || 'waiting';
      [['waiting', 'Awaiting'], ['signed', 'Signed by Me'], ['returned', 'Returned by Me']].forEach(([key, label]) => {
        const b = el('button', { class: 'tab' + (key === tab ? ' is-active' : ''), role: 'tab', onclick: () => {
          tabsBar.querySelectorAll('.tab').forEach(t => t.classList.remove('is-active')); b.classList.add('is-active');
          tab = key; load();
        } }, label);
        tabsBar.appendChild(b);
      });
      let timer = null;
      search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 300); });

      async function load() {
        searchBar.hidden = tab === 'waiting';
        let records = [];
        try {
          records = tab === 'waiting' ? (await api.get('/records/inbox')).records
            : (await api.get(`/records/by-me?kind=${tab}&q=${encodeURIComponent(search.value.trim())}`)).records;
        } catch (e) { ui.clear(wrap).appendChild(ui.empty(e.offline ? 'This needs an internet connection.' : e.message)); return; }
        ui.clear(wrap);
        if (!records.length) {
          wrap.appendChild(ui.empty(tab === 'waiting' ? 'Nothing is waiting for your signature.' : search.value.trim() ? 'No form matches.'
            : tab === 'signed' ? 'You have not signed any form yet.' : 'You have not returned any form.'));
          return;
        }
        const common = [
          { label: 'Form', value: r => r.formLabel },
          { label: 'Reference', value: r => r.ref || '—' },
          { label: 'Party / Title', value: r => r.summary || '—' },
          { label: 'Unit', value: r => router.unitName(r.unitKey) },
          { label: 'Submitted By', value: r => r.submittedByName || '' }
        ];
        if (tab === 'waiting') {
          wrap.appendChild(ui.table([...common,
            { label: 'Submitted', value: r => ui.fmtDate(r.submittedAt) },
            { label: 'Panel', value: r => r.slots.some(s => s.approvers.length > 1) ? r.slots.map(s => s.rule === 'all' ? 'All must sign' : 'Any one').join(', ') : '' }
          ], records, [
            { label: 'Review', class: 'btn--primary', onClick: r => wf.openDocument(r.id) },
            { label: 'Approve', class: 'btn--ok', onClick: r => wf.approveDialog(r).then(x => x && wf.changed()) },
            { label: 'Return', class: 'btn--danger', onClick: r => wf.returnDialog(r).then(x => x && wf.changed()) }
          ]));
          return;
        }
        wrap.appendChild(el('p', { class: 'muted' }, `${records.length} form${records.length === 1 ? '' : 's'}${records.length === 300 ? ' (the latest 300)' : ''}.`));
        wrap.appendChild(ui.table([...common,
          { label: tab === 'signed' ? 'Signed' : 'Returned', value: r => ui.fmtDate(r.myAt) },
          tab === 'signed'
            ? { label: 'Now', node: r => ui.statusBadge(r.status) }
            : { label: 'Your comment', value: r => r.myComment || '' }
        ], records, [{ label: 'Open', class: 'btn--primary', onClick: r => wf.openDocument(r.id) }]));
      }

      const stop = wf.onChange(() => (document.body.contains(container) ? load() : stop()));
      load();
    }
  };
})();
