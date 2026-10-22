/*
 * modules/diary.js — a court's diary, shared by its registry and judges.
 * Day, week and month views; + Fix a Date (a case from the Case Register,
 * or one typed in); Edit or move a date; Record Outcome after the sitting
 * (an adjournment makes the next entry; a disposal goes to the Case
 * Register); and Draw Cause List, which fills the court's Cause List form
 * with the day's cases, with any others added.
 *
 * window.App.diaryUi.fix(ctx, unit, opts) lets the Case Register fix a
 * date for a case (after File received, or from View).
 */
(function () {
  window.App = window.App || {};
  window.App.modules = window.App.modules || {};

  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (s) => new Date(s + 'T00:00:00');
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
  const longDay = (s) => parse(s).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const monday = (s) => { const d = parse(s); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); return iso(d); };
  const partiesOf = (c) => [c.firstParty, c.secondParty].map(p => String(p || '').trim().replace(/\s*\n+\s*/g, ', ')).filter(Boolean).join(' v. ');

  // The court's registered cases, for choosing one (loaded once per screen).
  async function registerCases(api, unitKey) {
    try { return (await api.get(`/process/register?unitKey=${encodeURIComponent(unitKey)}`)).cases; } catch (e) { return []; }
  }

  // A search box over the register's cases; returns { node, value() }.
  function casePicker(ui, cases, initialId) {
    const el = ui.el;
    const search = el('input', { type: 'search', placeholder: 'Type part of the suit number or a party' });
    const select = el('select', { size: '6', class: 'case-pick' });
    function fill() {
      const t = search.value.trim().toLowerCase();
      const shown = cases.filter(c => !t || [c.suitNumber, c.firstParty, c.secondParty, c.nature].join(' ').toLowerCase().includes(t)).slice(0, 200);
      select.replaceChildren(...shown.map(c => el('option', { value: c.id }, `${c.suitNumber} · ${partiesOf(c)}${c.nature ? ' · ' + c.nature : ''}`)));
      if (initialId && shown.some(c => c.id === initialId)) select.value = initialId;
      else if (shown.length === 1) select.value = shown[0].id;
    }
    search.addEventListener('input', fill);
    fill();
    return { node: el('div', { class: 'case-pick-wrap' }, [search, select]), value: () => cases.find(c => c.id === select.value) || null };
  }

  function businessPick(ui, types, current) {
    const el = ui.el;
    const pick = el('select', null, [...types, 'Others'].map(t => el('option', { value: t }, t === 'Others' ? 'Others (type it)' : t)));
    const other = el('input', { type: 'text', placeholder: 'What the case is coming up for' });
    if (current) { if (types.includes(current)) pick.value = current; else { pick.value = 'Others'; other.value = current; } }
    const otherRow = ui.field('Other business', other);
    const sync = () => { otherRow.hidden = pick.value !== 'Others'; };
    pick.addEventListener('change', sync); sync();
    return { pick, other, otherRow };
  }

  // Send, and if the day is full ask whether to go ahead anyway.
  async function sendWithLimit(send) {
    try { return await send(false); }
    catch (e) {
      if (!(e.body && e.body.full)) throw e;
      if (!confirm(e.message + '\n\nFix it on that day anyway?')) return null;
      return send(true);
    }
  }

  // + Fix a Date: a case from the register (or typed in), the day, time and business.
  async function fix(ctx, unit, opts = {}) {
    const { ui, api } = ctx;
    const el = ui.el;
    const [meta, cases] = await Promise.all([api.get(`/diary?unitKey=${encodeURIComponent(unit.key)}&from=${iso(new Date())}`), registerCases(api, unit.key)]);
    const fromRegister = el('input', { type: 'radio', name: 'dsrc', checked: 'checked' });
    const typed = el('input', { type: 'radio', name: 'dsrc' });
    const picker = casePicker(ui, cases, opts.caseId);
    const suit = el('input', { type: 'text', placeholder: 'e.g. GM/77/2024' }), parties = el('input', { type: 'text', placeholder: 'e.g. Musa Bello v. Ali Sani' });
    const nature = el('input', { type: 'text' }), counsel = el('input', { type: 'text' });
    const typedBox = el('div', { class: 'form-grid' }, [ui.field('Suit number *', suit), ui.field('Name of case', parties), ui.field('Type of case', nature), ui.field('Counsel', counsel)]);
    const syncSrc = () => { picker.node.hidden = !fromRegister.checked; typedBox.hidden = fromRegister.checked; };
    [fromRegister, typed].forEach(r => r.addEventListener('change', syncSrc));
    if (!cases.length) { typed.checked = true; fromRegister.disabled = true; }
    syncSrc();
    const date = el('input', { type: 'date', value: opts.date || addDays(iso(new Date()), 1) });
    const time = el('input', { type: 'time', value: '09:00' });
    const biz = businessPick(ui, meta.businessTypes, opts.business);
    const notes = el('textarea', { rows: 2, placeholder: 'Anything to note (optional)' });
    const body = el('div', null, [
      el('div', { class: 'check-row' }, [el('label', { class: 'check check--plain' }, [fromRegister, ' A case in the Case Register']), el('label', { class: 'check check--plain' }, [typed, ' A case not in the register (type it)'])]),
      picker.node, typedBox,
      el('div', { class: 'form-grid' }, [ui.field('Date *', date), ui.field('Time', time)]),
      ui.field('Coming up for *', biz.pick), biz.otherRow, ui.field('Notes', notes),
      meta.dailyLimit ? el('p', { class: 'muted' }, `At most ${meta.dailyLimit} cases a day are set for each court; you are warned when a day is full.`) : null
    ]);
    return ui.modal(`Fix a Date · ${unit.name}`, body, {
      confirmText: 'Fix Date',
      onConfirm: async () => {
        const src = fromRegister.checked ? picker.value() : null;
        if (fromRegister.checked && !src) throw new Error('Choose the case.');
        const payload = { unitKey: unit.key, date: date.value, time: time.value, business: biz.pick.value, other: biz.other.value, notes: notes.value,
          ...(src ? { caseId: src.id } : { suitNumber: suit.value, parties: parties.value, nature: nature.value, counsel: counsel.value }) };
        const r = await sendWithLimit((force) => api.post('/diary', { ...payload, force }));
        if (!r) return undefined;
        ui.toast(`${r.entry.suitNumber} fixed for ${r.entry.business}, ${longDay(r.entry.date)}.`, 'success', 6000);
        return r.entry;
      }
    });
  }

  // Move or correct a date still to come.
  async function edit(ctx, e, types) {
    const { ui, api } = ctx;
    const el = ui.el;
    const date = el('input', { type: 'date', value: e.date }), time = el('input', { type: 'time', value: e.time || '' });
    const biz = businessPick(ui, types, e.business);
    const notes = el('textarea', { rows: 2 }, e.notes || '');
    return ui.modal(`Change Date · ${e.suitNumber}`, el('div', null, [
      el('p', { class: 'muted' }, e.parties || ''),
      el('div', { class: 'form-grid' }, [ui.field('Date', date), ui.field('Time', time)]),
      ui.field('Coming up for', biz.pick), biz.otherRow, ui.field('Notes', notes)
    ]), {
      confirmText: 'Save',
      onConfirm: async () => {
        const r = await sendWithLimit((force) => api.put(`/diary/${e.id}`, { date: date.value, time: time.value, business: biz.pick.value, other: biz.other.value, notes: notes.value, force }));
        if (!r) return undefined;
        ui.toast('Diary updated.', 'success');
        return r.entry;
      }
    });
  }

  // After the sitting: what happened, the next date, and a disposal.
  async function outcome(ctx, e, types, remarks) {
    const { ui, api } = ctx;
    const el = ui.el;
    const what = el('textarea', { rows: 2, placeholder: 'e.g. Plaintiff opened its case; PW1 testified and was cross examined. Adjourned for continuation.' });
    const nextDate = el('input', { type: 'date' }), nextTime = el('input', { type: 'time', value: e.time || '09:00' });
    const biz = businessPick(ui, types, e.business);
    const disposal = el('select', null, [el('option', { value: '' }, 'No, the case continues'), ...remarks.map(r => el('option', { value: r }, r)), el('option', { value: 'Other' }, 'Other (type it)')]);
    const disposalOther = el('input', { type: 'text', placeholder: 'Type the remark' });
    const otherRow = ui.field('Other remark', disposalOther);
    const sync = () => { otherRow.hidden = disposal.value !== 'Other'; };
    disposal.addEventListener('change', sync); sync();
    return ui.modal(`Record Outcome · ${e.suitNumber}`, el('div', null, [
      el('p', { class: 'muted' }, `${e.parties || ''} · ${e.business}, ${longDay(e.date)}`),
      ui.field('What happened *', what),
      el('h3', null, 'Adjourned to'),
      el('div', { class: 'form-grid' }, [ui.field('Next date', nextDate, 'Leave empty if no date was fixed.'), ui.field('Time', nextTime)]),
      ui.field('Coming up for', biz.pick), biz.otherRow,
      e.caseId ? el('div', null, [ui.field('Disposed of?', disposal, 'Choosing a remark records it in the Case Register.'), otherRow]) : null
    ]), {
      confirmText: 'Save Outcome',
      onConfirm: async () => {
        const r = await sendWithLimit((force) => api.post(`/diary/${e.id}/outcome`, { outcome: what.value, nextDate: nextDate.value, nextTime: nextTime.value,
          nextBusiness: biz.pick.value, nextOther: biz.other.value, disposal: disposal.value, disposalOther: disposalOther.value, force }));
        if (!r) return undefined;
        ui.toast(r.next ? `Recorded. Next date: ${longDay(r.next.date)}.` : 'Outcome recorded.', 'success', 6000);
        return r;
      }
    });
  }

  // The day's cases, in order, with others added, into the Cause List form.
  async function drawCauseList(ctx, unit, day, entries) {
    const { ui, api, workflow: wf, user } = ctx;
    const el = ui.el;
    const cases = await registerCases(api, unit.key);
    const rows = entries.map(e => ({ include: true, suitNumber: e.suitNumber, parties: e.parties, nature: e.nature, stage: e.business, counsel: e.counsel, time: e.time }));
    const list = el('div', { class: 'pick-list cl-list' });
    function render() {
      list.replaceChildren(...rows.map((r, i) => {
        const box = el('input', { type: 'checkbox' }); box.checked = r.include;
        box.addEventListener('change', () => { r.include = box.checked; });
        const move = (d) => () => { const j = i + d; if (j < 0 || j >= rows.length) return; [rows[i], rows[j]] = [rows[j], rows[i]]; render(); };
        return el('div', { class: 'pick-row cl-row' }, [box, el('span', { class: 'cl-n' }, String(i + 1)),
          el('span', { class: 'cl-text' }, [el('strong', null, r.suitNumber), ` ${r.parties || ''} · ${r.stage}${r.added ? ' (added)' : ''}`]),
          el('button', { class: 'btn btn--small btn--ghost', type: 'button', title: 'Move up', onclick: move(-1) }, '↑'),
          el('button', { class: 'btn btn--small btn--ghost', type: 'button', title: 'Move down', onclick: move(1) }, '↓')]);
      }));
      if (!rows.length) list.appendChild(el('p', { class: 'muted' }, 'No case in the diary for this day. Add the cases below.'));
    }
    render();
    // Add a case not in the diary that day.
    const scheduled = new Set(entries.map(e => e.suitNumber));
    const picker = casePicker(ui, cases.filter(c => !scheduled.has(c.suitNumber)));
    const stage = el('input', { type: 'text', placeholder: 'Coming up for, e.g. Mention' });
    const alsoDiary = el('input', { type: 'checkbox' }); alsoDiary.checked = true;
    const addBtn = el('button', { class: 'btn btn--small btn--primary', type: 'button', onclick: async () => {
      const c = picker.value();
      if (!c) { ui.toast('Choose the case to add.', 'error'); return; }
      const business = stage.value.trim() || 'Mention';
      if (alsoDiary.checked) {
        try { await sendWithLimit((force) => api.post('/diary', { unitKey: unit.key, caseId: c.id, date: day, business: 'Others', other: business, force })); }
        catch (e) { ui.toast(e.message, 'error'); return; }
      }
      rows.push({ include: true, added: true, suitNumber: c.suitNumber, parties: partiesOf(c), nature: c.nature || '', stage: business, counsel: c.counsel || '' });
      scheduled.add(c.suitNumber);
      stage.value = '';
      render();
    } }, '+ Add to the list');
    // The judge of the court, when there is one.
    let judgeName = '';
    try {
      const j = (await api.get(`/catalogue/signers?role=judge&unitKey=${encodeURIComponent(unit.key)}`)).signers.filter(s => s.unitKeys.includes(unit.key));
      if (j.length === 1) judgeName = [j[0].title, j[0].fullName].filter(Boolean).join(' ');
    } catch (e) { /* the registry types it */ }
    const go = await ui.modal(`Draw Cause List · ${longDay(day)}`, el('div', null, [
      el('p', { class: 'muted' }, 'The cases in the diary for this day, in order. Untick any to leave out, move them up or down, and add others. The Cause List form then opens filled in, to check, save and send for signing as usual.'),
      list,
      el('h3', null, 'Add a case not in the diary for this day'),
      picker.node, ui.field('Coming up for', stage),
      el('label', { class: 'check check--plain' }, [alsoDiary, ' Also put it in the diary for this day']),
      el('div', { class: 'card__actions' }, [addBtn])
    ]), { confirmText: 'Open Cause List', wide: true, onConfirm: () => {
      const chosen = rows.filter(r => r.include);
      if (!chosen.length) throw new Error('Choose at least one case.');
      return chosen;
    } });
    if (!go) return;
    const firstTime = entries.map(e => e.time).filter(Boolean).sort()[0] || '9:00';
    wf.openForm({ unitKey: unit.key, formType: 'cause-list', values: {
      judgeType: 'single', judgeName, sittingDate: day, sittingTime: firstTime.replace(/^0/, ''),
      entries: go.map((r, i) => ({ sn: String(i + 1), suitNumber: r.suitNumber, parties: r.parties, nature: r.nature, stage: r.stage, counselFirst: r.counsel, counselSecond: '', remarks: '' })),
      preparedBy: user.fullName
    } });
  }

  // Someone in several courts chooses the court first.
  async function chooseCourt(container, ctx) {
    const { ui, router } = ctx;
    const el = ui.el;
    const courts = (await router.units()).filter(u => u.type === 'registry');
    container.append(
      el('div', { class: 'page-head' }, [el('h1', null, '📅 Court Diary'), el('p', { class: 'muted' }, 'Choose the court whose diary to open.')]),
      el('div', { class: 'dash-stats' }, courts.map(u => el('button', { class: 'dash-card', type: 'button', onclick: () => router.loadModule('diary', { unit: u }) }, [
        el('div', { class: 'dash-card__label' }, u.name), el('div', { class: 'muted' }, 'Open')])))
    );
  }

  window.App.diaryUi = { fix, outcome, longDay };

  window.App.modules.diary = {
    async render(container, ctx) {
      const { ui, api, unit } = ctx;
      const el = ui.el;
      if (!unit) return chooseCourt(container, ctx);
      const P = window.App.processUi;
      let view = ctx.view || 'day', day = ctx.date || iso(new Date());
      let meta = { businessTypes: [], canWrite: false };
      let remarks = [];
      try { remarks = (await api.get('/process/settings')).remarks; } catch (e) { /* offline */ }

      const title = el('h2', { class: 'diary-title' });
      const picker = el('input', { type: 'date', value: day, 'aria-label': 'Go to date' });
      const viewBar = el('div', { class: 'tabs', role: 'tablist' });
      const actions = el('div', { class: 'diary-actions' });
      const out = el('div');
      container.append(
        el('div', { class: 'page-head' }, [el('h1', null, `📅 Court Diary · ${unit.name}`),
          el('p', { class: 'muted' }, 'Dates fixed for the cases of this court. The registry and the judges share it: what one enters, the other sees.')]),
        el('div', { class: 'toolbar diary-nav' }, [
          el('button', { class: 'btn btn--ghost', onclick: () => step(-1), title: 'Earlier' }, '◀'),
          el('button', { class: 'btn btn--ghost', onclick: () => { day = iso(new Date()); load(); } }, 'Today'),
          el('button', { class: 'btn btn--ghost', onclick: () => step(1), title: 'Later' }, '▶'),
          picker, actions
        ]),
        viewBar, title, out
      );
      picker.addEventListener('change', () => { if (picker.value) { day = picker.value; load(); } });
      [['day', 'Day'], ['week', 'Week'], ['month', 'Month']].forEach(([k, label]) => {
        const b = el('button', { class: 'tab' + (k === view ? ' is-active' : ''), role: 'tab', onclick: () => {
          viewBar.querySelectorAll('.tab').forEach(t => t.classList.remove('is-active')); b.classList.add('is-active'); view = k; load();
        } }, label);
        viewBar.appendChild(b);
      });
      function step(d) {
        if (view === 'day') day = addDays(day, d);
        else if (view === 'week') day = addDays(day, 7 * d);
        else { const x = parse(day); x.setDate(1); x.setMonth(x.getMonth() + d); day = iso(x); }
        load();
      }
      function range() {
        if (view === 'day') return [day, day];
        if (view === 'week') { const m = monday(day); return [m, addDays(m, 6)]; }
        const x = parse(day); const first = iso(new Date(x.getFullYear(), x.getMonth(), 1));
        return [monday(first), addDays(monday(iso(new Date(x.getFullYear(), x.getMonth() + 1, 0))), 6)];
      }

      async function load() {
        picker.value = day;
        const [from, to] = range();
        let r;
        try { r = await api.get(`/diary?unitKey=${encodeURIComponent(unit.key)}&from=${from}&to=${to}`); }
        catch (e) { out.replaceChildren(ui.empty(e.offline ? 'The diary needs the internet.' : e.message)); return; }
        meta = r;
        actions.replaceChildren(...[
          r.canWrite ? el('button', { class: 'btn btn--primary', onclick: async () => { const e = await fix(ctx, unit, { date: view === 'day' ? day : undefined }); if (e) { day = e.date; load(); } } }, '+ Fix a Date') : null,
          view === 'day' && r.canWrite ? el('button', { class: 'btn btn--ghost', onclick: () => drawCauseList(ctx, unit, day, r.entries.filter(e => e.status === 'fixed')) }, '📋 Draw Cause List') : null,
          view !== 'month' ? el('button', { class: 'btn btn--ghost', onclick: () => print(r.entries) }, '🖨 Print') : null
        ].filter(Boolean));
        if (view === 'month') return month(r.entries);
        title.textContent = view === 'day' ? longDay(day) : `Week of ${longDay(from)}`;
        const days = view === 'day' ? [day] : Array.from({ length: 7 }, (_, i) => addDays(from, i));
        out.replaceChildren(...days.map(d => {
          const list = r.entries.filter(e => e.date === d);
          if (view === 'week' && !list.length) return el('div', { class: 'diary-day diary-day--empty' }, [el('h3', null, longDay(d)), el('p', { class: 'muted' }, 'Nothing fixed.')]);
          return el('div', { class: 'diary-day' }, [
            view === 'week' ? el('h3', null, `${longDay(d)} · ${list.length} case${list.length > 1 ? 's' : ''}`) : el('p', { class: 'muted' }, list.length ? `${list.length} case${list.length > 1 ? 's' : ''}` : ''),
            list.length ? table(list) : ui.empty(r.canWrite ? 'Nothing fixed for this day. Use + Fix a Date.' : 'Nothing fixed for this day.')
          ]);
        }));
      }

      function table(list) {
        return ui.table([
          { label: 'Time', value: e => e.time || '' },
          { label: 'Suit number', node: e => P.caseNo(ui, e.suitNumber) },
          { label: 'Name of case', value: e => e.parties || '' },
          { label: 'Coming up for', value: e => e.business },
          { label: 'Notes / outcome', node: e => e.status === 'done'
            ? el('span', null, [el('span', { class: 'badge badge--final' }, 'Sat'), ' ', e.outcome.text, e.outcome.nextDate ? ` Adjourned to ${longDay(e.outcome.nextDate)}.` : ''])
            : el('span', null, e.notes || '') }
        ], list, meta.canWrite ? [
          { label: 'Record Outcome', class: 'btn--ok', show: e => e.status === 'fixed' && e.date <= iso(new Date()), onClick: async e => { if (await outcome(ctx, e, meta.businessTypes, remarks)) load(); } },
          { label: '📝 Form', onClick: e => ctx.workflow.fillFromCase({ diaryId: e.id, unitKey: unit.key }) },
          { label: 'Change', show: e => e.status === 'fixed', onClick: async e => { if (await edit(ctx, e, meta.businessTypes)) load(); } },
          { label: 'Remove', class: 'btn--danger', onClick: async e => {
            if (!confirm(`Remove ${e.suitNumber} (${e.business}, ${longDay(e.date)}) from the diary?`)) return;
            try { await api.del(`/diary/${e.id}`); ui.toast('Removed from the diary.', 'success'); load(); } catch (err) { ui.toast(err.message, 'error'); }
          } }
        ] : null);
      }

      function month(entries) {
        const x = parse(day);
        title.textContent = x.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
        const [from] = range();
        const cells = Array.from({ length: 42 }, (_, i) => addDays(from, i)).filter((d, i, a) => i < 35 || parse(a[35]).getMonth() === x.getMonth());
        const today = iso(new Date());
        out.replaceChildren(el('div', { class: 'diary-month' }, [
          ...['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(n => el('div', { class: 'diary-month__head' }, n)),
          ...cells.map(d => {
            const n = entries.filter(e => e.date === d).length;
            const cls = 'diary-month__day' + (parse(d).getMonth() !== x.getMonth() ? ' is-other' : '') + (d === today ? ' is-today' : '') + (n ? ' has-cases' : '');
            return el('button', { class: cls, type: 'button', onclick: () => { day = d; view = 'day'; viewBar.querySelectorAll('.tab').forEach((t, i) => t.classList.toggle('is-active', i === 0)); load(); } }, [
              el('span', { class: 'diary-month__num' }, String(parse(d).getDate())),
              n ? el('span', { class: 'diary-month__count' }, `${n} case${n > 1 ? 's' : ''}`) : null
            ]);
          })
        ]));
      }

      function print(entries) {
        const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        const [from, to] = range();
        const byDay = [...new Set(entries.map(e => e.date))].sort();
        const body = byDay.map(d => `<h3>${esc(longDay(d))}</h3><table class="doc-table"><thead><tr><th>Time</th><th>Suit number</th><th>Name of case</th><th>Coming up for</th><th>Notes / outcome</th></tr></thead><tbody>${
          entries.filter(e => e.date === d).map(e => `<tr><td>${esc(e.time)}</td><td>${P.caseNoHtml(e.suitNumber)}</td><td>${esc(e.parties)}</td><td>${esc(e.business)}</td><td>${esc(e.status === 'done' ? e.outcome.text : e.notes)}</td></tr>`).join('')}</tbody></table>`).join('') || '<p>Nothing fixed.</p>';
        P.printPage(`<article class="court-doc report-print">
          <header class="doc-masthead"><img class="doc-emblem" src="/assets/highcourt.png" alt="">
            <div class="doc-titleblock"><div class="doc-line1">THE JUDICIARY</div><div class="doc-line2">GOMBE STATE HIGH COURT OF JUSTICE</div><div class="doc-line3">${esc(unit.name)} · COURT DIARY</div></div>
            <img class="doc-emblem" src="/assets/coat.png" alt=""></header><div class="doc-rule"></div>
          <p>${esc(from === to ? longDay(from) : `${longDay(from)} to ${longDay(to)}`)}</p>${body}
          <footer class="doc-footer"><span>Printed ${esc(P.day(new Date()))}</span><span>Powered by the Directorate of ICT, Gombe State High Court of Justice</span></footer>
        </article>`, '@page { size: A4; margin: 12mm; }');
      }
      load();
    }
  };
})();
