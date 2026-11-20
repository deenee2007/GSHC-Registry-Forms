/*
 * modules/myRecord.js — Home of a personal staff account: the officer's own
 * record on the Nominal Roll (to read; corrections go through the
 * Directorate of Personnel), their leave for the year, and the way to
 * apply. Appraisal (APER) and notices about their service will come here.
 */
(function () {
  window.App = window.App || {};
  window.App.modules = window.App.modules || {};

  const long = (iso) => /^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '';
  const BY = { age: '60 years of age', service: '35 years of service', contract: 'end of contract' };

  window.App.modules.myRecord = {
    async render(container, ctx) {
      const { ui, api, router } = ctx;
      const el = ui.el;
      let s, leave = null;
      try { s = (await api.get('/mystaff')).staff; }
      catch (e) { container.appendChild(ui.empty(e.offline ? 'Your record needs the internet.' : e.message)); return; }
      try { leave = await api.get('/leave/me'); } catch (e) { /* shown without leave */ }
      const hour = new Date().getHours();
      container.appendChild(el('div', { class: 'dash-welcome' }, [
        el('h1', null, `Good ${hour < 12 ? 'morning' : hour < 16 ? 'afternoon' : 'evening'}, ${[s.title, s.name].filter(Boolean).join(' ')}`),
        el('p', null, `PSN ${s.psn} · ${[s.rank, s.gl ? `GL ${s.gl}${s.step ? ` step ${s.step}` : ''}` : '', s.station].filter(Boolean).join(' · ')}`)
      ]));
      const kv = (k, v) => v ? el('div', { class: 'doc-kv' }, [el('strong', null, k + ': '), v]) : null;
      const card = (title, kids) => el('section', { class: 'card myrec-card' }, [el('h2', { class: 'card__title' }, title), ...kids]);

      // Leave this year, and applying.
      if (leave && leave.staff) {
        const pending = (leave.leaves || []).filter(l => l.status === 'pending').length;
        container.appendChild(card('🌴 My Leave ' + leave.year, [
          el('div', { class: 'myrec-balances' }, (leave.balances || []).filter(b => b.allowed || b.used || b.pending).map(b => el('div', { class: 'myrec-balance' }, [
            el('div', { class: 'myrec-balance__num' }, b.allowed ? String(b.left) : String(b.used)),
            el('div', { class: 'myrec-balance__label' }, b.allowed ? `${b.name}: days left of ${b.allowed}` : `${b.name}: days taken`)
          ]))),
          pending ? el('p', { class: 'muted' }, `${pending} application(s) waiting for approval.`) : null,
          el('div', { class: 'dash-links' }, [el('button', { class: 'btn btn--primary', onclick: () => router.loadModule('leave') }, 'Apply for Leave or See My Applications')])
        ]));
      }

      container.appendChild(card('👤 My Record', [
        el('div', { class: 'case-details staff-details' }, [
          kv('Status', s.statusLabel), kv('Rank', s.rank), kv('Grade level', s.gl ? `GL ${s.gl}${s.step ? `, step ${s.step}` : ''}` : ''), kv('Cadre', s.cadre),
          kv('Station', s.station), kv('Date of first appointment', long(s.dofa)), kv('Date of present appointment', long(s.dopa)),
          kv('Date of confirmation', long(s.confirmedOn)), kv('Date of birth', long(s.dob)), kv('LGA', s.lga),
          kv('Highest qualification', s.qualification), kv('Phone', s.phone), kv('Email on the roll', s.email), kv('Address', s.address),
          kv('Next of kin', [s.nextOfKin.name, s.nextOfKin.relationship, s.nextOfKin.phone].filter(Boolean).join(', ')),
          kv('Retires on', s.retiresOn ? `${long(s.retiresOn)} (${BY[s.retiresBy] || s.retiresBy})` : '')
        ]),
        el('p', { class: 'muted' }, 'If anything here is wrong, write to the Directorate of Personnel with your documents; corrections are made there and recorded in your record of service.')
      ]));
      container.appendChild(card(`📜 Record of Service (${s.history.length})`, [s.history.length
        ? ui.table([{ label: 'Date', value: h => long(h.date) }, { label: 'Entry', value: h => h.text }], s.history)
        : el('p', { class: 'muted' }, 'Nothing recorded yet.')]));
    }
  };
})();
