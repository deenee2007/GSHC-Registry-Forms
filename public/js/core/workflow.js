/*
 * core/workflow.js — everything that happens to one record, shared by the
 * unit pages, the signing inbox, My Submissions and the dashboard:
 * fill / edit a form, open the document, submit, approve, return,
 * withdraw, revoke, delete and print.
 */
(function () {
  window.App = window.App || {};
  const App = window.App;
  const ui = () => App.ui;
  const api = () => App.api;
  const perms = () => App.permissions;
  const me = () => App.auth.current();

  // ── Change notifications so open lists refresh themselves ──
  const listeners = new Set();
  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function changed() { listeners.forEach(fn => { try { fn(); } catch (e) { /* ignore */ } }); }

  // ── Signing rules and role names (cached for the session) ──
  let _meta = null;
  async function meta(force) {
    if (_meta && !force) return _meta;
    const { forms, signerRoles } = await api().get('/catalogue/forms');
    _meta = { roles: signerRoles, rules: Object.fromEntries(forms.map(f => [f.formType, f.signers])) };
    return _meta;
  }
  const ROLE_FALLBACK = { chief_judge: 'Hon. Chief Judge', process_registrar: 'Process Registrar', judge: 'Judge', chief_registrar: 'Chief Registrar', registrar: 'Registrar', chief_bailiff: 'Chief Bailiff', deputy_sheriff: 'Deputy Sheriff', director_of_litigation: 'Director of Litigation', commissioner_for_oaths: 'Commissioner for Oaths' };
  function roleLabel(role) { return (_meta && _meta.roles[role]) || ROLE_FALLBACK[role] || role; }

  const formDef = (formType) => (App.allForms || {})[formType];
  const same = (a, b) => String(a) === String(b);

  // ── What the signed in user may do with a record ──
  function abilities(rec) {
    const user = me();
    const p = perms();
    const status = rec.status;
    const inUnit = p.canAccessUnit(rec.unitKey);
    const mine = same(rec.createdBy, user.id);
    const submittedByMe = same(rec.submittedBy, user.id);
    const slots = rec.slots || [];
    const signedByMe = slots.some(s => s.signatures.some(g => same(g.user, user.id)));
    const awaitingMe = status === 'pending' && slots.some(s => !s.done &&
      s.approvers.some(a => same(a.id, user.id)) && !s.signatures.some(g => same(g.user, user.id)));
    const editable = status === 'draft' || status === 'returned' || status === 'offline';
    return {
      edit:     editable && inUnit && (p.can('edit') || (mine && p.can('create')) || status === 'offline'),
      submit:   (status === 'draft' || status === 'returned') && inUnit && p.can('finalize'),
      remove:   editable && inUnit && (p.can('delete') || status === 'offline'),
      withdraw: status === 'pending' && (submittedByMe || (inUnit && p.can('finalize'))),
      approve:  awaitingMe,
      giveBack: status === 'pending' && (awaitingMe || p.isAdmin()),
      print:    status === 'final' && (p.can('print') || submittedByMe || signedByMe),
      printDraft: editable && status !== 'offline' && p.can('print'),
      revoke:   status === 'final' && (p.isAdmin() || signedByMe),
      history:  status !== 'offline'
    };
  }

  // ── Fill or edit a form ──
  // record: a server record (with data), or an offline entry ({ localId, ... }).
  // values: boxes already filled for a new form (the cause list drawn from the diary).
  // fill: values from a registered case (Fill a Form), put into its empty boxes.
  async function openForm({ unitKey, formType, record, values, fill }) {
    const def = formDef(formType);
    if (!def) { ui().toast('This form is not available.', 'error'); return null; }
    const f = ui().form(def.schema, record ? record.data : values || null);
    const offlineEntry = record && record.localId ? record : null;
    // Every save stores every field, so a field missing from a saved draft
    // was added to the form after the draft was made.
    const added = record && record.data ? def.schema.filter(x => x.name && !(x.name in record.data)) : [];
    const body = ui().el('div', null, [
      added.length ? ui().el('div', { class: 'notice notice--warn' }, `This form has changed since this draft was saved. Please check these boxes before saving: ${added.map(x => x.label).join('; ')}.`) : null,
      f.node
    ]);
    if (!record && !values) offerPrefill(def, formType, f.node, body);
    // A new form in a court registry or the Execution Unit can be filled from a case.
    const unit = unitKey ? (await App.router.units()).find(u => u.key === unitKey) : null;
    // A court registry's new forms name the court (High Court No. 9) where
    // they ask for the court to appear before and where they were issued.
    if (!record && unit && unit.type === 'registry' && unit.courtNo) {
      def.schema.filter(x => UNIT_COURT.includes(x.name)).forEach(x => {
        const inp = f.node.querySelector(`[name="${x.name}"]`);
        if (inp && (!inp.value.trim() || inp.value === String(x.defaultValue === undefined ? '' : x.defaultValue))) inp.value = `High Court No. ${unit.courtNo}`;
      });
    }
    if (!record && !values && unit && ['registry', 'execution'].includes(unit.type)) offerCasePicker(def, formType, f.node, body, fill);

    return ui().modal(def.label, body, {
      confirmText: 'Save Draft',
      noBackdropClose: true,
      onConfirm: async () => {
        if (!f.validate()) return undefined;
        const data = f.getValues();
        try {
          let saved;
          if (offlineEntry) {
            saved = (await api().post('/records', { unitKey: offlineEntry.unitKey, formType, data })).record;
            await App.offline.remove(offlineEntry.localId);
          } else if (record) {
            saved = (await api().put('/records/' + record.id, { data, version: record.version })).record;
          } else {
            saved = (await api().post('/records', { unitKey, formType, data })).record;
          }
          ui().toast(record ? 'Draft updated.' : 'Saved as draft.', 'success');
          changed();
          return saved;
        } catch (e) {
          if (!e.offline) throw e;
          const entry = await App.offline.saveDraft({
            localId: offlineEntry && offlineEntry.localId,
            recordId: record && !offlineEntry ? record.id : null,
            version: record && record.version, unitKey: unitKey || record.unitKey, formType, data
          });
          ui().toast('You are offline. The draft is saved on this computer and will sync automatically.', 'info', 6000);
          changed();
          return entry;
        }
      }
    });
  }

  // On a new form: once a suit or case number is typed, offer to fill the
  // empty boxes from earlier documents for that case. Online only.
  const CASE_FIELDS = ['suitNumber', 'caseNumber', 'suitNo', 'processSuitNumber', 'processSuitNo', 'highCourtAppealNo', 'lowerCourtSuitNo', 'appealNumber'];
  function offerPrefill(def, formType, formNode, body) {
    const bar = ui().el('div', { class: 'notice notice--info prefill-bar', hidden: 'hidden' });
    body.insertBefore(bar, formNode);
    let asked = '';
    const check = async (e) => {
      const caseNo = e.target.value.trim();
      if (caseNo.replace(/\s+/g, '').length < 3 || caseNo === asked) return;
      asked = caseNo;
      let r;
      try { r = await api().get(`/cases/prefill?caseNo=${encodeURIComponent(caseNo)}&formType=${encodeURIComponent(formType)}`); }
      catch (err) { return; } // offline or not allowed: nothing to offer
      if (asked !== caseNo) return; // the number changed while asking
      const boxes = def.schema.filter(x => x.name && r.values[x.name] !== undefined && isEmpty(formNode, x));
      if (!boxes.length) { bar.hidden = true; return; }
      const from = [...new Set(r.sources.map(x => x.formLabel))].slice(0, 3).join(', ');
      const btn = ui().el('button', { class: 'btn btn--small btn--primary', type: 'button', onclick: () => {
        let n = 0;
        boxes.forEach(x => { const inp = formNode.querySelector(`[name="${x.name}"]`); if (inp && isEmpty(formNode, x)) { inp.value = r.values[x.name]; n++; } });
        bar.hidden = true;
        ui().toast(`Filled ${n} box(es) from earlier documents. Please check them.`, 'success');
      } }, 'Fill them in');
      bar.replaceChildren(ui().el('span', null, `Earlier documents for ${r.caseNo} (${from}) can fill ${boxes.length} empty box(es): ${boxes.map(x => x.label).join(', ')}. `), btn);
      bar.hidden = false;
    };
    CASE_FIELDS.forEach(name => {
      const inp = formNode.querySelector(`[name="${name}"]`);
      if (inp) inp.addEventListener('change', check);
    });
  }
  const UNIT_COURT = ['courtPlace', 'appearanceCourt', 'issuedAt', 'issuePlace'];

  // Put a case's values into the form: empty boxes, and court boxes still at
  // their starting value. The boxes filled are marked until edited.
  function applyFill(def, formNode, r) {
    const labels = [];
    def.schema.forEach(f => {
      if (!f.name || r.values[f.name] === undefined || r.values[f.name] === '') return;
      const inp = formNode.querySelector(`[name="${f.name}"]`);
      if (!inp) return;
      const atStart = (r.replace || []).includes(f.name) && (!inp.value.trim() || inp.value === String(f.defaultValue === undefined ? '' : f.defaultValue));
      if (!isEmpty(formNode, f) && !atStart) return;
      if (inp.tagName === 'SELECT' && ![...inp.options].some(o => o.value === r.values[f.name])) return;
      inp.value = r.values[f.name];
      inp.classList.add('is-prefilled');
      inp.addEventListener('input', () => inp.classList.remove('is-prefilled'), { once: true });
      labels.push(f.label);
    });
    return labels;
  }
  const filledNote = (r, labels) => `${labels.length} box(es) filled from ${r.caseNo}${r.fromDiary ? ' and its diary date' : ''}${r.fromDocuments ? ' and earlier documents' : ''}: ${labels.join(', ')}. They are marked; please check them before saving.`;

  // "Choose a case" at the top of a new form: search registered cases by
  // suit number or party, and fill the form from the one chosen.
  function offerCasePicker(def, formType, formNode, body, fill) {
    const el = ui().el;
    const note = el('div', { class: 'notice notice--info', hidden: 'hidden' });
    const search = el('input', { type: 'search', placeholder: '🔍  Choose a case: type part of the suit number or a party', 'aria-label': 'Choose a case' });
    const list = el('div', { class: 'case-results' });
    const bar = el('div', { class: 'case-chooser' }, [search, list]);
    body.insertBefore(note, formNode);
    body.insertBefore(bar, note);
    const use = (r) => {
      const labels = applyFill(def, formNode, r);
      note.textContent = labels.length ? filledNote(r, labels) : `Nothing to fill from ${r.caseNo}: the boxes it would fill already have something in them.`;
      note.hidden = false;
    };
    let t = null, asked = '';
    search.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const q = search.value.trim();
        if (q.length < 2) { list.replaceChildren(); return; }
        asked = q;
        let r;
        try { r = await api().get(`/cases/registered?q=${encodeURIComponent(q)}`); } catch (e) { return; }
        if (asked !== q) return;
        list.replaceChildren(...(r.cases.length ? r.cases.map(c => el('button', { class: 'case-result', type: 'button', onclick: async () => {
          list.replaceChildren(); search.value = `${c.suitNumber} · ${c.parties}`;
          try { use(await api().get(`/cases/fill?formType=${encodeURIComponent(formType)}&caseId=${c.id}`)); } catch (e) { ui().toast(e.message, 'error'); }
        } }, [el('strong', null, c.suitNumber), ` ${c.parties}${c.court ? ' · ' + c.court : ''}`])) : [el('p', { class: 'muted' }, 'No registered case matches.')]));
      }, 250);
    });
    if (fill) { bar.hidden = true; use(fill); }
  }

  // 📝 Fill a Form from a case (the Case Register, the Case File, the Court
  // Diary): choose the form, and it opens filled from the case.
  async function fillFromCase({ caseId, caseNo, diaryId, unitKey }) {
    const el = ui().el;
    const user = App.auth.current();
    const all = window.App.allForms || {};
    const units = (await App.router.units()).filter(u => ['registry', 'execution'].includes(u.type) && (u.forms || []).length &&
      (App.permissions.isAdmin(user) ? true : user.unitKeys.includes(u.key)) && App.permissions.can('create', user));
    if (!units.length) { ui().toast('You cannot make forms in any court registry or the Execution Unit.', 'error'); return; }
    units.sort((a, b) => (b.key === unitKey) - (a.key === unitKey));
    let dialog;
    const pick = el('select', { 'aria-label': 'Unit' }, units.map(u => el('option', { value: u.key }, u.name)));
    const grid = el('div', { class: 'dash-forms' });
    const show = () => {
      const u = units.find(x => x.key === pick.value);
      grid.replaceChildren(...u.forms.filter(k => all[k]).map(k => el('button', { class: 'dash-form-btn', type: 'button', onclick: async () => {
        let r;
        const q = diaryId ? `diaryId=${diaryId}` : caseId ? `caseId=${caseId}` : `caseNo=${encodeURIComponent(caseNo)}`;
        try { r = await api().get(`/cases/fill?formType=${encodeURIComponent(k)}&${q}`); } catch (e) { ui().toast(e.message, 'error'); return; }
        dialog.close();
        openForm({ unitKey: u.key, formType: k, fill: r });
      } }, all[k].label)));
    };
    pick.addEventListener('change', show);
    show();
    ui().modal('Fill a Form from this Case', el('div', null, [
      el('div', { class: 'doc-preview__actions' }, [el('button', { class: 'btn btn--ghost', onclick: () => dialog.close() }, '✕  Close')]),
      el('p', { class: 'muted' }, 'Choose the form. It opens with the suit number, the parties, the court and what else is known filled in; check and change anything before saving.'),
      units.length > 1 ? ui().field('Unit', pick) : null,
      grid
    ]), { noFooter: true, onOpen: (o) => { dialog = o; } });
  }

  // A box is free to fill when it is blank, or a list still at its starting choice.
  function isEmpty(formNode, field) {
    const inp = formNode.querySelector(`[name="${field.name}"]`);
    if (!inp) return false;
    if (field.type === 'select') return field.defaultValue === undefined || inp.value === String(field.defaultValue);
    return !inp.value.trim();
  }

  // ── Open the document with the actions this user can take ──
  async function openDocument(idOrEntry, opts) {
    opts = opts || {};
    let doc;
    if (idOrEntry && idOrEntry.localId) {
      const units = await App.router.units();
      const u = units.find(x => x.key === idOrEntry.unitKey);
      doc = { ...idOrEntry, status: 'offline', unitName: u ? u.name : idOrEntry.unitKey, createdByName: idOrEntry.userName, createdAt: idOrEntry.savedAt, slots: [] };
    } else {
      try { doc = (await api().get(`/records/${idOrEntry}/document`)).document; }
      catch (e) { ui().toast(e.offline ? 'This document is not available offline.' : e.message, 'error'); return; }
    }
    const def = formDef(doc.formType) || { label: doc.formLabel || doc.formType, schema: [] };
    const can = abilities(doc);

    let overlay;
    const done = (fn) => async () => {
      const result = await fn();
      if (result) { overlay && overlay.close(); changed(); if (opts.onDone) opts.onDone(result); }
    };
    const B = (label, cls, onclick, show) => (show ? ui().el('button', { class: 'btn ' + cls, onclick }, label) : null);

    const actions = ui().el('div', { class: 'doc-preview__actions' }, [
      B('✕  Close', 'btn--ghost', () => overlay.close(), true),
      B('History', 'btn--ghost', () => showHistory(doc), can.history),
      B('📁  Case File', 'btn--ghost', () => { overlay.close(); App.router.loadModule('cases', { q: doc.caseNos[0] }); }, doc.caseNos && doc.caseNos.length && doc.status !== 'offline'),
      B('Edit', 'btn--ghost', done(() => openForm({ unitKey: doc.unitKey, formType: doc.formType, record: doc })), can.edit),
      B('Delete', 'btn--danger', done(() => deleteRecord(doc)), can.remove),
      B('Withdraw', 'btn--ghost', done(() => withdraw(doc)), can.withdraw),
      B('Return with Comments', 'btn--danger', done(() => returnDialog(doc)), can.giveBack),
      B('Revoke', 'btn--danger', done(() => revokeDialog(doc)), can.revoke),
      B('🖨  Print Draft Copy', 'btn--ghost', () => print(doc, def), can.printDraft),
      B('⬇  Download Copy', 'btn--ghost', () => download(doc.id), doc.status === 'final' || doc.status === 'revoked'),
      B('🖨  Print', 'btn--primary', () => print(doc, def), can.print),
      B(submitLabel(doc), 'btn--primary', done(() => submitDialog(doc)), can.submit),
      B('✔  Approve & Sign', 'btn--ok', done(() => approveDialog(doc)), can.approve)
    ]);

    const preview = ui().el('div', { class: 'doc-preview', html: App.output.render(doc, doc.unitName, def) });
    const zoom = fitToScreen(preview);
    overlay = null;
    ui().modal(`${def.label}`, ui().el('div', null, [actions, statusPanel(doc), zoom.bar, preview]), {
      noFooter: true, wide: true,
      onOpen: (o) => { overlay = o; zoom.fit(); }
    });
  }

  // On a narrow screen (a phone) the A4 page is shrunk to the width of the
  // screen, like a PDF, and scrolls top to bottom; "Actual size" shows it
  // full size, to read closely, scrolling sideways too.
  function fitToScreen(box) {
    const page = box.querySelector('.court-doc');
    const holder = document.createElement('div');
    holder.className = 'doc-fit';
    if (page) { page.parentNode.insertBefore(holder, page); holder.appendChild(page); }
    let actual = false;
    const btn = ui().el('button', { class: 'btn btn--small btn--ghost', type: 'button', onclick: () => { actual = !actual; fit(); } }, '');
    const bar = ui().el('div', { class: 'doc-zoom', hidden: 'hidden' }, [ui().el('span', { class: 'muted' }, 'Shrunk to fit the screen.'), btn]);
    function fit() {
      if (!page) return;
      page.style.transform = ''; holder.style.width = ''; holder.style.height = ''; holder.style.overflow = ''; box.style.minHeight = '';
      page.classList.add('court-doc--a4');
      const style = getComputedStyle(box);
      const room = box.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const full = page.offsetWidth;
      if (!room || full <= room) { bar.hidden = true; return; } // it fits as it is
      bar.hidden = false;
      bar.firstChild.textContent = actual ? 'Actual size: scroll sideways to read across.' : 'Shrunk to fit the screen.';
      btn.textContent = actual ? '↙ Fit to screen' : '🔍 Actual size';
      if (actual) { holder.style.overflow = 'visible'; return; }
      const s = room / full;
      page.style.transform = `scale(${s})`;
      holder.style.width = `${room}px`;
      holder.style.height = `${page.offsetHeight * s}px`;
      box.style.minHeight = '0';
    }
    if (window.ResizeObserver && page) {
      let last = 0;
      new ResizeObserver(() => { const w = box.clientWidth; if (w !== last) { last = w; fit(); } }).observe(box);
      // images (crest, signatures, QR) change the page's height when they load
      page.querySelectorAll('img').forEach(img => img.addEventListener('load', fit));
    }
    return { bar, fit };
  }

  function submitLabel(doc) {
    const lines = (_meta && _meta.rules[doc.formType]) || [];
    const user = me();
    const selfOnly = lines.every(l => user.signerRoles.includes(l.role));
    return selfOnly ? '✔  Finalise' : '➤  Submit for Signature';
  }

  // Status, signing progress, comments and verification code above the preview.
  function statusPanel(doc) {
    const el = ui().el;
    const rows = [el('div', { class: 'doc-status__head' }, [ui().statusBadge(doc.status), doc.ref ? el('span', { class: 'muted' }, doc.ref) : null])];
    if (doc.status === 'offline') rows.push(el('p', null, 'Saved on this computer only. It will be sent to the server when the connection returns.' + (doc.error ? ' Last attempt failed: ' + doc.error : '')));
    if (doc.status === 'returned' && doc.returnComment) {
      rows.push(el('div', { class: 'doc-status__note doc-status__note--warn' }, [el('strong', null, `Returned by ${doc.returnedBy}: `), doc.returnComment]));
    }
    (doc.slots || []).forEach(s => {
      const who = s.approvers.map(a => {
        const sig = s.signatures.find(g => same(g.user, a.id));
        return (a.title ? a.title + ' ' : '') + (a.fullName || 'Signer') + (sig ? ` ✔ ${ui().fmtDate(sig.signedAt)}` : ' (waiting)');
      });
      const rule = s.approvers.length > 1 ? (s.rule === 'all' ? ' · all must sign' : ' · any one may sign') : '';
      rows.push(el('div', { class: 'doc-status__line' }, [el('strong', null, s.label + rule + ': '), who.join(', ')]));
    });
    if (doc.verifyCode) rows.push(el('div', { class: 'doc-status__line' }, [el('strong', null, 'Verification code: '), doc.verifyCode]));
    if (doc.status === 'final') rows.push(el('div', { class: 'doc-status__line muted' }, doc.printCount ? `Printed ${doc.printCount} time(s)` : 'Not printed yet'));
    if (doc.status === 'revoked') rows.push(el('div', { class: 'doc-status__note doc-status__note--bad' }, [el('strong', null, `Revoked by ${doc.revokedBy}: `), doc.revokeReason || '']));
    return el('div', { class: 'doc-status' }, rows);
  }

  async function showHistory(doc) {
    let entries = [];
    try { entries = (await api().get(`/records/${doc.id}/history`)).entries; }
    catch (e) { ui().toast(e.message, 'error'); return; }
    const NAMES = {
      record_created: 'Created', record_updated: 'Edited', record_submitted: 'Submitted for signature',
      record_signed: 'Signed', record_approved: 'Approved and signed', record_finalized: 'Finalised',
      record_returned: 'Returned', record_withdrawn: 'Withdrawn', record_revoked: 'Revoked', record_printed: 'Printed'
    };
    const list = ui().el('ol', { class: 'history' }, entries.map(e => ui().el('li', null, [
      ui().el('strong', null, NAMES[e.action] || e.action), ` by ${e.username || 'system'} · ${ui().fmtDate(e.at)}`,
      e.details && (e.details.comment || e.details.reason) ? ui().el('div', { class: 'muted' }, e.details.comment || e.details.reason) : null
    ])));
    ui().modal('Record History', entries.length ? list : ui().empty('No history recorded.'), { noFooter: false, confirmText: 'Close', cancelText: 'Back' });
  }

  // ── Submit: choose signers, or sign yourself ──
  async function submitDialog(rec) {
    if (rec.status === 'offline') { ui().toast('This draft must reach the server before it can be submitted.', 'error'); return null; }
    let m;
    try { m = await meta(); } catch (e) { ui().toast(e.offline ? 'Submitting needs an internet connection.' : e.message, 'error'); return null; }
    const lines = m.rules[rec.formType] || [];
    const user = me();
    const el = ui().el;
    const body = el('div', { class: 'submit-dialog' });
    const pickers = [];
    let needsPin = false;

    if (!lines.length) {
      body.appendChild(el('p', null, 'This form is signed by hand outside the system (for example by a deponent, surety or counsel). Finalising locks it and gives it a verification code and QR code.'));
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const box = el('div', { class: 'signer-box' }, [el('div', { class: 'signer-box__title' }, `Signature line: ${line.label}`)]);
      body.appendChild(box);
      if (user.signerRoles.includes(line.role)) {
        needsPin = true;
        box.appendChild(el('p', { class: 'signer-box__self' }, `✔ You will sign this line yourself as ${roleLabel(line.role)}.`));
        pickers.push(null);
        continue;
      }
      const picker = { checks: [], rule: 'any' };
      pickers.push(picker);
      const listWrap = el('div', { class: 'signer-list' }, 'Loading…');
      const ruleWrap = el('div', { class: 'signer-rule', style: 'display:none' });
      const anyR = el('input', { type: 'radio', name: 'rule' + i, value: 'any', checked: 'checked' });
      const allR = el('input', { type: 'radio', name: 'rule' + i, value: 'all' });
      anyR.addEventListener('change', () => { picker.rule = 'any'; });
      allR.addEventListener('change', () => { picker.rule = 'all'; });
      ruleWrap.append(el('span', { class: 'form-field__label' }, 'When more than one is chosen:'),
        el('label', { class: 'check' }, [anyR, ' Any one may approve']),
        el('label', { class: 'check' }, [allR, ' All must approve']));

      const syncRule = () => { ruleWrap.style.display = picker.checks.filter(c => c.cb.checked).length > 1 ? '' : 'none'; };
      async function load(all) {
        let signers = [];
        try { signers = (await api().get('/catalogue/signers' + api().qs({ role: line.role, unitKey: rec.unitKey, all: all ? '1' : '' }))).signers; }
        catch (e) { ui().clear(listWrap).append(e.message); return; }
        ui().clear(listWrap);
        picker.checks = [];
        if (!signers.length) listWrap.appendChild(el('p', { class: 'muted' }, `No active ${roleLabel(line.role)} is set up for this unit. Ask the administrator.`));
        signers.forEach(s => {
          const cb = el('input', { type: 'checkbox' });
          if (signers.length === 1) cb.checked = true;
          cb.addEventListener('change', syncRule);
          picker.checks.push({ cb, id: s.id });
          listWrap.appendChild(el('label', { class: 'check signer-option' }, [cb, ' ' + [s.title, s.fullName].filter(Boolean).join(' '),
            s.ready ? null : el('span', { class: 'muted' }, '  (signature not set up yet)')]));
        });
        if (!all) listWrap.appendChild(el('button', { class: 'btn btn--ghost btn--small', type: 'button', onclick: () => load(true) }, `Show every ${roleLabel(line.role)} (for a panel)`));
        syncRule();
      }
      box.append(el('p', { class: 'muted' }, `Choose who should sign as ${line.label}:`), listWrap, ruleWrap);
      load(false);
    }

    const pin = el('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: '8', placeholder: 'Signing PIN' });
    if (needsPin) body.appendChild(ui().field('Your signing PIN', pin, 'Your signature will be placed on the document.'));

    const selfOnly = pickers.every(p => p === null);
    return ui().modal(selfOnly ? 'Finalise Document' : 'Submit for Signature', body, {
      confirmText: selfOnly ? (needsPin ? 'Sign & Finalise' : 'Finalise') : 'Submit',
      onConfirm: async () => {
        const approvers = pickers.map(p => (p ? p.checks.filter(c => c.cb.checked).map(c => c.id) : []));
        const rules = pickers.map(p => (p ? p.rule : 'any'));
        for (let i = 0; i < lines.length; i++) {
          if (pickers[i] && !approvers[i].length) { ui().toast(`Choose who should sign as ${lines[i].label}.`, 'error'); return undefined; }
        }
        if (needsPin && !pin.value) { ui().toast('Enter your signing PIN.', 'error'); return undefined; }
        try {
          const { record } = await api().post(`/records/${rec.id}/submit`, { approvers, rules, pin: pin.value || undefined });
          ui().toast(record.status === 'final' ? 'Signed and finalised. It is ready to print.' : 'Submitted. The signer has been notified.', 'success', 5000);
          return record;
        } catch (e) {
          if (e.offline) throw new Error('Submitting needs an internet connection. Your draft is safe; try again when you are back online.');
          throw e;
        }
      }
    });
  }

  async function approveDialog(rec) {
    const lines = (rec.slots || []).filter(s => !s.done && s.approvers.some(a => same(a.id, me().id))).map(s => s.label);
    const pin = ui().el('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: '8', placeholder: 'Signing PIN' });
    const body = ui().el('div', null, [
      ui().el('p', null, `Your signature will be placed on this document${lines.length ? ' as ' + lines.join(', ') : ''}. Once every signature line is signed, the document is locked and returned to ${rec.submittedByName || 'the submitter'} to print.`),
      ui().field('Your signing PIN', pin)
    ]);
    setTimeout(() => pin.focus(), 50);
    return ui().modal('Approve & Sign', body, {
      confirmText: 'Approve & Sign', confirmClass: 'btn--ok',
      onConfirm: async () => {
        if (!pin.value) { ui().toast('Enter your signing PIN.', 'error'); return undefined; }
        try {
          const { record } = await api().post(`/records/${rec.id}/approve`, { pin: pin.value });
          ui().toast(record.status === 'final' ? 'Approved and signed. Sent back to the submitter.' : 'Signed. Waiting for the other signatures.', 'success', 5000);
          return record;
        } catch (e) { if (e.offline) throw new Error('Signing needs an internet connection.'); throw e; }
      }
    });
  }

  async function returnDialog(rec) {
    const ta = ui().el('textarea', { rows: 4, placeholder: 'What needs correcting?' });
    return ui().modal('Return with Comments', ui().el('div', null, [
      ui().el('p', null, `The form goes back to ${rec.submittedByName || 'the submitter'} with your comments. Any signatures already placed are removed.`),
      ui().field('Comments', ta)
    ]), {
      confirmText: 'Return', confirmClass: 'btn--danger',
      onConfirm: async () => {
        if (!ta.value.trim()) { ui().toast('Please say what needs correcting.', 'error'); return undefined; }
        const { record } = await api().post(`/records/${rec.id}/return`, { comment: ta.value.trim() });
        ui().toast('Returned to the submitter.', 'success');
        return record;
      }
    });
  }

  async function revokeDialog(rec) {
    const ta = ui().el('textarea', { rows: 3, placeholder: 'Reason for revoking' });
    return ui().modal('Revoke Signed Document', ui().el('div', null, [
      ui().el('p', null, 'Revoking cannot be undone. Anyone who scans this document\'s QR code will be told it has been revoked, with your reason.'),
      ui().field('Reason', ta)
    ]), {
      confirmText: 'Revoke', confirmClass: 'btn--danger',
      onConfirm: async () => {
        if (!ta.value.trim()) { ui().toast('Please give the reason.', 'error'); return undefined; }
        const { record } = await api().post(`/records/${rec.id}/revoke`, { reason: ta.value.trim() });
        ui().toast('Document revoked.', 'info');
        return record;
      }
    });
  }

  async function withdraw(rec) {
    if (!confirm('Withdraw this form from signing and return it to draft?')) return null;
    try {
      const { record } = await api().post(`/records/${rec.id}/withdraw`);
      ui().toast('Withdrawn to draft.', 'info');
      return record;
    } catch (e) { ui().toast(e.message, 'error'); return null; }
  }

  async function deleteRecord(rec) {
    if (!confirm('Delete this draft permanently?')) return null;
    if (rec.localId) { await App.offline.remove(rec.localId); ui().toast('Offline draft deleted.', 'info'); return true; }
    try { await api().del('/records/' + rec.id); ui().toast('Draft deleted.', 'info'); return true; }
    catch (e) { ui().toast(e.message, 'error'); return null; }
  }

  // Print the official copy (or a draft copy, marked as such).
  async function print(docOrId, def) {
    let doc = docOrId;
    try {
      if (typeof docOrId === 'string') doc = (await api().get(`/records/${docOrId}/document`)).document;
      def = def || formDef(doc.formType);
      await App.output.print(doc, doc.unitName, def, doc.status === 'final' ? await savedCopy(doc.id) : null);
      if (doc.status === 'final') { await api().post(`/records/${doc.id}/printed`); changed(); }
    } catch (e) { ui().toast(e.offline ? 'This document is not available offline.' : e.message, 'error'); }
  }

  // The document part of the saved copy, so a signed document prints exactly
  // as it was signed even after a form's wording changes. Null when the copy
  // cannot be fetched; the document is then drawn from its data as before.
  async function savedCopy(id) {
    try {
      const res = await fetch(`/api/records/${id}/copy?print=1`, { credentials: 'same-origin', headers: { 'X-Requested-With': 'GSHC' } });
      if (!res.ok) return null;
      const page = new DOMParser().parseFromString(await res.text(), 'text/html');
      const article = page.querySelector('article.court-doc');
      return article ? article.outerHTML : null;
    } catch (e) { return null; }
  }

  // The saved copy of a signed document, as a file the user keeps.
  function download(id) {
    const a = document.createElement('a');
    a.href = `/api/records/${id}/copy`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  App.workflow = {
    onChange, changed, meta, roleLabel, abilities, submitLabel,
    openForm, openDocument, fillFromCase, download, submitDialog, approveDialog, returnDialog, revokeDialog, withdraw, deleteRecord, print
  };
})();
