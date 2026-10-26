/*
 * modules/leave.js — Leave. Tabs, as the person's work needs:
 *   Awaiting My Action  for the Staff Officer, Director Personnel, Chief Registrar
 *   My Leave            for an officer whose account is linked to their record
 *   Applications        for the Directorate of Personnel
 *   Leave Roster        who is away, by station
 * window.App.leaveUi gives the Nominal Roll its Apply for Leave dialog, the
 * officer's leave on the record, and the approval letter.
 */
(function () {
  window.App = window.App || {};
  window.App.modules = window.App.modules || {};
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const long = (d) => d ? new Date(String(d).length === 10 ? d + 'T12:00:00Z' : d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const ordinal = (d) => { if (!d) return ''; const x = new Date(String(d).length === 10 ? d + 'T12:00:00Z' : d), n = x.getDate(), s = ['th', 'st', 'nd', 'rd'], m = n % 100; return `${n}${s[(m - 20) % 10] || s[m] || s[0]} ${x.toLocaleDateString('en-GB', { month: 'long' })}, ${x.getFullYear()}`; };
  const STATUS = { pending: ['Pending', 'pending'], approved: ['Approved', 'final'], declined: ['Declined', 'returned'], withdrawn: ['Withdrawn', 'draft'] };
  const daysText = (l) => `${l.days} ${l.working ? 'working ' : ''}day${l.days === 1 ? '' : 's'}`;
  let SETTINGS = null;
  const settings = async (api) => SETTINGS || (SETTINGS = await api.get('/leave/settings'));

  function badge(ui, l) {
    const [t, c] = STATUS[l.status] || [l.status, 'draft'];
    return ui.el('span', { class: 'badge badge--' + c }, l.status === 'pending' && l.waiting ? `With the ${l.waiting.label}` : t);
  }

  // The days of each kind allowed, taken, applied for and left.
  function balanceCards(ui, list) {
    const el = ui.el;
    return el('div', { class: 'dash-stats' }, list.filter(b => b.allowed || b.used || b.pending).map(b => el('div', { class: 'dash-card' + (b.allowed && !b.left ? ' dash-card--warn' : '') }, [
      el('div', { class: 'dash-card__num' }, b.allowed ? `${b.left}` : String(b.used)),
      el('div', { class: 'dash-card__label' }, b.allowed ? `${b.name}: days left of ${b.allowed}${b.pending ? ` (${b.pending} applied for)` : ''}` : `${b.name}: days taken`)
    ])));
  }

  // Apply for leave for an officer (staff: { id, name, psn, ... }).
  async function applyDialog(ctx, staff, onDone) {
    const { ui, api } = ctx;
    const el = ui.el;
    const s = await settings(api);
    let bal;
    try { bal = (await api.get(`/leave/balance/${staff.id}`)).balances; } catch (e) { ui.toast(e.message, 'error'); return; }
    const type = el('select', null, s.types.filter(t => bal.some(b => b.key === t.key)).map(t => el('option', { value: t.key }, t.name)));
    const from = el('input', { type: 'date' });
    const days = el('input', { type: 'number', min: '1', max: '400', placeholder: 'Number of days' });
    const reason = el('textarea', { rows: '2', maxlength: '500', placeholder: 'Optional: reason or details' });
    const address = el('input', { type: 'text', maxlength: '300', placeholder: 'Where you can be reached while on leave' });
    const phone = el('input', { type: 'tel', maxlength: '40' });
    const relief = el('input', { type: 'text', maxlength: '200', placeholder: 'The officer who will cover the duties' });
    const info = el('div', { class: 'notice' });
    const holidays = s.holidays || [];
    const working = (d) => d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && !holidays.includes(d.toISOString().slice(0, 10));
    function span() {
      const t = s.types.find(x => x.key === type.value), n = Number(days.value);
      if (!from.value || !(n >= 1)) return null;
      const d = new Date(from.value + 'T12:00:00Z');
      if (t.working) while (!working(d)) d.setUTCDate(d.getUTCDate() + 1);
      const first = d.toISOString().slice(0, 10);
      let c = 0, last = first;
      for (let g = 0; c < n && g < 2000; g++) { if (!t.working || working(d)) { c++; last = d.toISOString().slice(0, 10); } d.setUTCDate(d.getUTCDate() + 1); }
      const r = new Date(last + 'T12:00:00Z'); r.setUTCDate(r.getUTCDate() + 1);
      while (!working(r)) r.setUTCDate(r.getUTCDate() + 1);
      return { first, last, resume: r.toISOString().slice(0, 10) };
    }
    function sync() {
      const t = s.types.find(x => x.key === type.value), b = bal.find(x => x.key === type.value) || {};
      const sp = span();
      info.replaceChildren(
        b.allowed ? `${t.name}: ${b.left} of ${b.allowed} ${t.working ? 'working ' : ''}days left this year${b.pending ? ` (${b.pending} already applied for)` : ''}.` : `${t.name}: no fixed number of days; ${b.used ? `${b.used} taken this year` : 'none taken this year'}. ${t.working ? 'Working days.' : 'Calendar days.'}`,
        sp ? el('div', null, `From ${long(sp.first)} to ${long(sp.last)}; resume duty on ${long(sp.resume)}.`) : el('span')
      );
      info.className = 'notice' + (b.allowed && Number(days.value) > b.left ? ' notice--warn' : '');
    }
    [type, from, days].forEach(x => x.addEventListener('input', sync)); sync();
    ui.modal(`Apply for Leave · ${staff.name}`, el('div', { class: 'form-grid' }, [
      el('p', { class: 'muted form-field--full' }, `PSN ${staff.psn}${staff.rank ? `, ${staff.rank}` : ''}${staff.gl ? `, GL ${staff.gl}` : ''}. The application goes through the Staff Officer for approval.`),
      ui.field('Kind of leave', type), ui.field('First day of leave', from), ui.field('Number of days', days), info,
      ui.field(`Relief officer${s.reliefRequired ? ' *' : ''}`, relief), ui.field('Address while on leave', address), ui.field('Phone while on leave', phone), ui.field('Reason or details', reason)
    ]), {
      confirmText: 'Submit Application',
      onConfirm: async () => {
        const r = await api.post('/leave', { staffId: staff.id, type: type.value, from: from.value, days: days.value, reason: reason.value, address: address.value, phone: phone.value, relief: relief.value });
        ui.toast(`Application submitted: ${daysText(r.leave)} from ${long(r.leave.from)}. It is with the ${r.leave.waiting.label}.`, 'success', 7000);
        if (onDone) onDone(r.leave);
        return true;
      }
    });
  }

  // One application: its details, the steps, and the actions open to this person.
  async function openLeave(ctx, id, onDone) {
    const { ui, api } = ctx;
    const el = ui.el;
    let l;
    try { l = (await api.get(`/leave/${id}`)).leave; } catch (e) { ui.toast(e.message, 'error'); return; }
    let dialog, bal = null;
    try { bal = (await api.get(`/leave/balance/${l.staffId}?year=${l.year}`)).balances; } catch (e) { /* the applicant's own view */ }
    const kv = (k, v) => v ? el('div', { class: 'doc-kv' }, [el('strong', null, k + ': '), v]) : null;
    const done = () => { dialog.close(); if (onDone) onDone(); };
    const pin = el('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: '8', placeholder: 'Signing PIN' });
    const comment = el('textarea', { rows: '2', maxlength: '500', placeholder: 'Comment (needed to decline)' });
    const act = (decision) => async () => {
      try {
        const r = await api.post(`/leave/${l.id}/act`, { decision, comment: comment.value, pin: pin.value });
        ui.toast(decision === 'decline' ? 'Application declined. The officer has been told.' : r.leave.status === 'approved' ? `Approved. Ref. ${r.leave.reference}.` : `Sent on to the ${r.leave.waiting.label}.`, 'success', 6000);
        window.App.router.refreshBadges(); done();
      } catch (e) { ui.toast(e.message, 'error'); }
    };
    const actions = [el('button', { class: 'btn btn--ghost', onclick: () => dialog.close() }, '✕  Close'),
      l.status === 'approved' ? el('button', { class: 'btn btn--primary', onclick: () => letter(l) }, '🖨 Approval Letter') : null,
      l.canWithdraw ? el('button', { class: 'btn btn--ghost', onclick: async () => {
        if (!confirm('Withdraw this application?')) return;
        try { await api.post(`/leave/${l.id}/withdraw`); ui.toast('Application withdrawn.', 'success'); done(); } catch (e) { ui.toast(e.message, 'error'); }
      } }, 'Withdraw') : null];
    const b = bal && bal.find(x => x.key === l.type);
    ui.modal(`${l.typeName} · ${l.name}`, el('div', null, [
      el('div', { class: 'doc-preview__actions' }, actions),
      badge(ui, l),
      el('div', { class: 'case-details' }, [
        kv('Officer', `${l.name}, PSN ${l.psn}${l.rank ? `, ${l.rank}` : ''}${l.gl ? `, GL ${l.gl}` : ''}`), kv('Station', l.station),
        kv('Leave', `${daysText(l)}, ${long(l.from)} to ${long(l.to)}`), kv('Resumes duty', long(l.resume)),
        b && b.allowed ? kv(`${l.typeName} for ${l.year}`, `${b.allowed} allowed, ${b.used} taken, ${b.pending} applied for (this included while pending)`) : null,
        kv('Relief officer', l.relief), kv('Address while on leave', l.address), kv('Phone', l.phone), kv('Reason or details', l.reason),
        kv('Applied', `${long(l.createdAt)} by ${l.appliedByName}${l.forSelf ? '' : ' (for the officer)'}`), kv('Reference', l.reference)
      ]),
      el('div', { class: 'case-docs' }, [el('h3', null, 'Route'), ui.table([
        { label: 'Step', value: s => s.label },
        { label: 'Action', value: s => s.status === 'done' ? (s.action === 'Forward' ? 'Forwarded' : s.action === 'Recommend' ? 'Recommended' : 'Approved') : s.status === 'declined' ? 'Declined' : l.status === 'pending' ? 'Waiting' : '' },
        { label: 'By', value: s => [s.title, s.byName].filter(Boolean).join(' ') + (s.at ? `, ${long(s.at)}` : '') },
        { label: 'Comment', value: s => s.comment }
      ], l.steps)]),
      l.canAct ? el('div', { class: 'leave-act' }, [
        el('h3', null, `As ${l.waiting.label}`), ui.field('Comment', comment), ui.field('Your signing PIN', pin),
        el('div', { class: 'card__actions' }, [
          el('button', { class: 'btn btn--danger', onclick: act('decline') }, 'Decline'),
          el('button', { class: 'btn btn--ok', onclick: act('approve') }, l.waiting.action === 'Approve' ? '✔ Approve' : l.waiting.action === 'Recommend' ? '✔ Recommend and send on' : '✔ Forward')
        ])
      ]) : null
    ]), { noFooter: true, wide: true, onOpen: (o) => { dialog = o; } });
  }

  // The approval letter, signed by the approver.
  function letter(l) {
    const P = window.App.processUi;
    const last = l.steps[l.steps.length - 1];
    const others = l.steps.slice(0, -1).map(s => s.label);
    P.printPage(`<article class="court-doc leave-letter">
      <header class="doc-masthead"><img class="doc-emblem" src="/assets/highcourt.png" alt="">
        <div class="doc-titleblock"><div class="doc-line1">THE JUDICIARY</div><div class="doc-line2">GOMBE STATE HIGH COURT OF JUSTICE</div><div class="doc-line3">DIRECTORATE OF PERSONNEL</div></div>
        <img class="doc-emblem" src="/assets/coat.png" alt=""></header><div class="doc-rule"></div>
      <div class="leave-meta"><div>Ref: ${esc(l.reference)}</div><div>${esc(ordinal(last.at))}</div></div>
      <p>${esc(l.name)}<br>${esc(l.rank || '')}${l.gl ? `, GL ${esc(l.gl)}` : ''}<br>${esc(l.station || '')}<br>PSN ${esc(l.psn)}</p>
      <h3 class="leave-subject">APPROVAL OF ${esc(l.typeName.toUpperCase())}</h3>
      <p>I am directed to convey approval of your application for ${esc(daysText(l))} ${esc(l.typeName.toLowerCase())} with effect from ${esc(ordinal(l.from))} to ${esc(ordinal(l.to))}.</p>
      <p>You are to resume duty on ${esc(ordinal(l.resume))}.${l.relief ? ` ${esc(l.relief)} will relieve you of your duties during this period.` : ''}</p>
      <div class="leave-sign"><img src="${esc(l.signatureUrl)}" alt="Signature"><div class="slip-line"></div>
        <div>${esc([last.title, last.byName].filter(Boolean).join(' '))}</div><div><b>${esc(last.label)}</b></div></div>
      <p class="leave-cc">cc:<br>${others.map(x => esc(x)).join('<br>')}${l.station ? `<br>The Head, ${esc(l.station)}` : ''}<br>Personal file</p>
      <footer class="doc-footer"><span>Printed ${esc(P.day(new Date()))}</span><span>Powered by the Directorate of ICT, Gombe State High Court of Justice</span></footer>
    </article>`, '@page { size: A4; margin: 16mm; }');
  }

  // An officer's leave, on their record: balances, applications, and Apply.
  function forRecord(ctx, staff, canApply) {
    const { ui, api } = ctx;
    const el = ui.el;
    const box = el('div', { class: 'case-docs' }, el('p', { class: 'muted' }, 'Loading leave…'));
    async function load() {
      let bal, list;
      try { [bal, list] = await Promise.all([api.get(`/leave/balance/${staff.id}`), api.get(`/leave?scope=all&staffId=${staff.id}`)]); }
      catch (e) { box.replaceChildren(el('p', { class: 'muted' }, e.message)); return; }
      box.replaceChildren(
        el('div', { class: 'case-docs__head' }, [el('h3', null, `Leave (${bal.year})`),
          canApply ? el('button', { class: 'btn btn--small btn--primary', onclick: () => applyDialog(ctx, staff, load) }, '🌴 Apply for Leave') : null]),
        balanceCards(ui, bal.balances),
        list.leaves.length ? table(ctx, list.leaves, load) : el('p', { class: 'muted' }, 'No leave applied for yet.')
      );
    }
    load();
    return box;
  }

  function table(ctx, leaves, reload, withOfficer) {
    const { ui } = ctx;
    return ui.table([
      ...(withOfficer ? [{ label: 'Officer', value: l => `${l.name} (PSN ${l.psn})` }, { label: 'Station', value: l => l.station }] : []),
      { label: 'Leave', value: l => l.typeName }, { label: 'Days', value: l => daysText(l) },
      { label: 'From', value: l => long(l.from) }, { label: 'To', value: l => long(l.to) }, { label: 'Resumes', value: l => long(l.resume) },
      { label: 'Status', node: l => badge(ui, l) }
    ], leaves, [{ label: l => l.canAct ? 'Review' : 'Open', class: 'btn--primary', onClick: l => openLeave(ctx, l.id, reload) }]);
  }

  window.App.leaveUi = { applyDialog, openLeave, letter, forRecord };

  window.App.modules.leave = {
    async render(container, ctx) {
      const { ui, api } = ctx;
      const el = ui.el;
      let s;
      try { SETTINGS = null; s = await settings(api); } catch (e) { container.appendChild(ui.empty(e.offline ? 'Leave needs the internet.' : e.message)); return; }
      const me = s.me;
      container.appendChild(el('div', { class: 'page-head' }, [el('h1', null, '🌴 Leave'),
        el('p', { class: 'muted' }, 'Applications for leave go through the Staff Officer to the Director Personnel (or the Chief Registrar for senior officers), each step signed with the PIN. The approval letter prints from the application.')]));
      const tabsBar = el('div', { class: 'tabs', role: 'tablist' });
      const panel = el('div', { class: 'tab-panel' });
      container.append(tabsBar, panel);
      const TABS = [
        me.roles.length ? ['waiting', 'Awaiting My Action', waiting] : null,
        me.hasRecord ? ['mine', 'My Leave', mine] : null,
        me.viewRoll || me.roles.length ? ['all', 'Applications', all] : null,
        me.viewRoll || me.roles.length ? ['roster', 'Leave Roster', roster] : null
      ].filter(Boolean);
      if (!TABS.length) { panel.appendChild(ui.empty('Your sign in account is not linked to a record on the Nominal Roll yet. Ask the administrator to link it, then you can apply for leave here.')); return; }

      async function waiting() {
        let r;
        try { r = await api.get('/leave?scope=waiting'); } catch (e) { panel.replaceChildren(ui.empty(e.message)); return; }
        panel.replaceChildren(r.leaves.length ? table(ctx, r.leaves, waiting, true) : ui.empty('No application is waiting for you.'));
      }
      async function mine() {
        let r;
        try { r = await api.get('/leave/me'); } catch (e) { panel.replaceChildren(ui.empty(e.message)); return; }
        panel.replaceChildren(
          el('div', { class: 'toolbar' }, [el('button', { class: 'btn btn--primary', onclick: () => applyDialog(ctx, r.staff, mine) }, '🌴 Apply for Leave')]),
          el('p', { class: 'muted' }, `${r.staff.name}, PSN ${r.staff.psn}${r.staff.rank ? `, ${r.staff.rank}` : ''}. Leave for ${r.year}:`),
          balanceCards(ui, r.balances),
          r.leaves.length ? table(ctx, r.leaves, mine) : ui.empty('You have not applied for leave yet.')
        );
      }
      async function all() {
        const year = el('select', { 'aria-label': 'Year' }, [0, 1, 2].map(n => { const y = new Date().getFullYear() + 1 - n; return el('option', { value: y }, String(y)); }));
        year.value = String(new Date().getFullYear());
        const status = el('select', { 'aria-label': 'Status' }, [['', 'All'], ['pending', 'Pending'], ['approved', 'Approved'], ['declined', 'Declined'], ['withdrawn', 'Withdrawn']].map(([v, t]) => el('option', { value: v }, t)));
        const type = el('select', { 'aria-label': 'Kind' }, [el('option', { value: '' }, 'All kinds'), ...s.types.map(t => el('option', { value: t.key }, t.name))]);
        const out = el('div');
        panel.replaceChildren(el('div', { class: 'report-filters' }, [['Year', year], ['Status', status], ['Kind of leave', type]].map(([t, n]) => el('label', { class: 'report-filter' }, [el('span', null, t), n]))), out);
        async function show() {
          let r;
          try { r = await api.get(`/leave?scope=all&year=${year.value}${status.value ? '&status=' + status.value : ''}${type.value ? '&type=' + type.value : ''}`); } catch (e) { out.replaceChildren(ui.empty(e.message)); return; }
          out.replaceChildren(el('p', { class: 'muted' }, `${r.leaves.length} application${r.leaves.length === 1 ? '' : 's'}.`), r.leaves.length ? table(ctx, r.leaves, show, true) : ui.empty('No applications.'));
        }
        [year, status, type].forEach(x => x.addEventListener('change', show));
        show();
      }
      async function roster() {
        const iso = new Date().toISOString().slice(0, 10);
        const from = el('input', { type: 'date', value: iso, 'aria-label': 'From' }), to = el('input', { type: 'date', value: iso, 'aria-label': 'To' });
        const out = el('div');
        let data = null;
        panel.replaceChildren(el('div', { class: 'report-filters' }, [
          el('label', { class: 'report-filter' }, [el('span', null, 'From'), from]), el('label', { class: 'report-filter' }, [el('span', null, 'To'), to]),
          el('div', { class: 'report-actions' }, [el('button', { class: 'btn btn--ghost', onclick: () => data && print() }, '🖨 Print')])]), out);
        async function show() {
          try { data = await api.get(`/leave/roster?from=${from.value}&to=${to.value || from.value}`); } catch (e) { out.replaceChildren(ui.empty(e.message)); return; }
          out.replaceChildren(el('p', { class: 'muted' }, `${data.leaves.length} officer${data.leaves.length === 1 ? '' : 's'} on leave in this period.`),
            data.leaves.length ? table(ctx, data.leaves, show, true) : ui.empty('No one is on approved leave in this period.'));
        }
        function print() {
          const P = window.App.processUi;
          const period = data.from === data.to ? long(data.from) : `${long(data.from)} to ${long(data.to)}`;
          P.printPage(`<article class="court-doc report-print"><header class="doc-masthead"><img class="doc-emblem" src="/assets/highcourt.png" alt="">
            <div class="doc-titleblock"><div class="doc-line1">THE JUDICIARY</div><div class="doc-line2">GOMBE STATE HIGH COURT OF JUSTICE</div><div class="doc-line3">LEAVE ROSTER</div></div>
            <img class="doc-emblem" src="/assets/coat.png" alt=""></header><div class="doc-rule"></div><p>Officers on leave: ${esc(period)}.</p>
            <table class="doc-table"><thead><tr><th>S/No</th><th>Name</th><th>PSN</th><th>Station</th><th>Leave</th><th>From</th><th>To</th><th>Resumes</th><th>Relief officer</th></tr></thead><tbody>
            ${data.leaves.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.name)}</td><td>${esc(l.psn)}</td><td>${esc(l.station)}</td><td>${esc(l.typeName)} (${esc(daysText(l))})</td><td>${esc(long(l.from))}</td><td>${esc(long(l.to))}</td><td>${esc(long(l.resume))}</td><td>${esc(l.relief)}</td></tr>`).join('')}
            </tbody></table><footer class="doc-footer"><span>Printed ${esc(P.day(new Date()))}</span><span>Powered by the Directorate of ICT, Gombe State High Court of Justice</span></footer></article>`, '@page { size: A4 landscape; margin: 10mm; }');
        }
        from.addEventListener('change', () => { if (!to.value || to.value < from.value) to.value = from.value; show(); });
        to.addEventListener('change', show);
        show();
      }

      let current = TABS.some(t => t[0] === ctx.tab) ? ctx.tab : TABS[0][0];
      TABS.forEach(([key, name, fn]) => {
        const btn = el('button', { class: 'tab' + (key === current ? ' is-active' : ''), role: 'tab', onclick: () => {
          tabsBar.querySelectorAll('.tab').forEach(t => t.classList.remove('is-active')); btn.classList.add('is-active');
          current = key; fn();
        } }, name);
        tabsBar.appendChild(btn);
      });
      TABS.find(t => t[0] === current)[2]();
    }
  };
})();
