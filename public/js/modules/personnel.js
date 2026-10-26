/*
 * modules/personnel.js — the Nominal Roll of the Directorate of Personnel.
 * The roll (search and filters, print as on paper, Excel), officers due to
 * retire, a summary by station, cadre and grade level, and each officer's
 * record: details, retirement (60 years of age or 35 years of service,
 * whichever comes first), the record of service (promotions, postings,
 * confirmation, status), the documents folder and the photo. Staff matters
 * will start from the record. Editing needs the personnel_edit privilege;
 * personnel_view sees the roll only.
 */
(function () {
  window.App = window.App || {};
  window.App.modules = window.App.modules || {};
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  // 12/03/1990, as on the roll.
  const dmy = (d) => d ? `${+d.slice(8, 10)}/${+d.slice(5, 7)}/${d.slice(0, 4)}` : '';
  const long = (d) => d ? new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const BY = { age: '60 years of age', service: '35 years of service', contract: 'end of contract' };
  const monthsTo = (d) => { if (!d) return null; const a = new Date(), b = new Date(d + 'T12:00:00'); return (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth() - (b.getDate() < a.getDate() ? 1 : 0); };
  const when = (d) => { const m = monthsTo(d); if (m === null) return ''; if (d < new Date().toISOString().slice(0, 10)) return 'past due'; return m < 1 ? 'this month' : m < 12 ? `in ${m} month${m === 1 ? '' : 's'}` : `in ${Math.floor(m / 12)} yr${m >= 24 ? 's' : ''}${m % 12 ? ` ${m % 12} mth` : ''}`; };
  function download(name, rows) {
    const blob = new Blob(['﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  window.App.modules.personnel = {
    async render(container, ctx) {
      const { ui, api } = ctx;
      const el = ui.el;
      const P = window.App.processUi;
      let S;
      try { S = await api.get('/personnel/settings'); } catch (e) { container.appendChild(ui.empty(e.offline ? 'The Nominal Roll needs the internet.' : e.message)); return; }
      const canEdit = S.me.canEdit;
      const statusLabel = Object.fromEntries(S.statuses.map(s => [s.key, s.label]));

      container.appendChild(el('div', { class: 'page-head' }, [el('h1', null, '👥 Nominal Roll'),
        el('p', { class: 'muted' }, 'Every member of staff, with the record of service and the documents folder. Retirement is worked out: 60 years of age or 35 years of service, whichever comes first.')]));
      const tabsBar = el('div', { class: 'tabs', role: 'tablist' });
      const toolbar = el('div', { class: 'toolbar' }, [
        canEdit ? el('button', { class: 'btn btn--primary', onclick: () => editForm(null) }, '+ Add Staff') : null,
        canEdit ? el('button', { class: 'btn btn--ghost', onclick: importRoll }, '⬆ Import Roll') : null,
        el('button', { class: 'btn btn--ghost', onclick: () => printRoll() }, '🖨 Print Roll'),
        el('button', { class: 'btn btn--ghost', onclick: () => csv() }, '⬇ Excel (CSV)')
      ]);
      const panel = el('div', { class: 'tab-panel' });
      container.append(toolbar, tabsBar, panel);

      // ── Filters ──
      const opt = (v, t) => el('option', { value: v }, t || v);
      const search = el('input', { type: 'search', class: 'search-input', placeholder: '🔍  Search name, PSN, rank or station' });
      const fStation = el('select', { 'aria-label': 'Station' }, [opt('', 'All stations'), ...S.stations.map(x => opt(x))]);
      const fCadre = el('select', { 'aria-label': 'Cadre' }, [opt('', 'All cadres'), ...S.cadres.map(x => opt(x))]);
      const fGl = el('select', { 'aria-label': 'GL' }, [opt('', 'All GL'), ...S.gls.map(x => opt(x, x === 'Cons.' ? 'Cons.' : `GL ${x}`))]);
      const fStatus = el('select', { 'aria-label': 'Status' }, [opt('serving', 'In service (with leave and suspended)'), opt('', 'All'), ...S.statuses.map(s => opt(s.key, s.label))]);
      const fLga = el('select', { 'aria-label': 'LGA' }, [opt('', 'All LGAs'), ...S.lgas.map(x => opt(x))]);
      const fCheck = el('input', { type: 'checkbox' });
      const filters = el('div', { class: 'report-filters' }, [
        el('label', { class: 'report-filter report-filter--wide' }, [el('span', null, 'Search'), search]),
        ...[['Station', fStation], ['Cadre', fCadre], ['Grade level', fGl], ['Status', fStatus], ['LGA', fLga]].map(([t, n]) => el('label', { class: 'report-filter' }, [el('span', null, t), n])),
        el('label', { class: 'check check--plain' }, [fCheck, ' Dates to check'])
      ]);
      let timer = null;
      search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(loadRoll, 300); });
      [fStation, fCadre, fGl, fStatus, fLga, fCheck].forEach(x => x.addEventListener('change', loadRoll));
      let roll = [], total = 0;
      const rollBox = el('div');

      async function loadRoll() {
        const q = new URLSearchParams();
        if (search.value.trim()) q.set('q', search.value.trim());
        [['station', fStation], ['cadre', fCadre], ['gl', fGl], ['status', fStatus], ['lga', fLga]].forEach(([k, n]) => n.value && q.set(k, n.value));
        if (fCheck.checked) q.set('checkDates', '1');
        try { const r = await api.get(`/personnel/staff?${q}`); roll = r.staff.map((x, i) => ({ ...x, sn: i + 1 })); total = r.total; }
        catch (e) { rollBox.replaceChildren(ui.empty(e.offline ? 'The Nominal Roll needs the internet.' : e.message)); return; }
        if (!total) { rollBox.replaceChildren(ui.empty(canEdit ? 'No staff on the roll yet. Use ⬆ Import Roll to bring in the nominal roll from Excel, or + Add Staff.' : 'No staff on the roll yet.')); return; }
        const checks = roll.filter(s => s.checkDates).length;
        rollBox.replaceChildren(
          el('p', { class: 'muted' }, `${roll.length} of ${total} staff${checks ? `; ${checks} with dates to check` : ''}.`),
          roll.length ? ui.table([
            { label: 'S/No', value: s => String(s.sn) },
            { label: 'Name', node: s => el('span', null, [s.name, s.checkDates ? el('span', { class: 'badge badge--returned staff-flag', title: 'The import could not be sure of a date' }, 'check dates') : null]) },
            { label: 'Sex', value: s => s.sex },
            { label: 'Rank', value: s => s.rank },
            { label: 'GL', value: s => s.gl },
            { label: 'PSN', value: s => s.psn },
            { label: 'Station', value: s => s.station },
            { label: 'DOB', value: s => dmy(s.dob) },
            { label: 'DOFA', value: s => dmy(s.dofa) },
            { label: 'LGA', value: s => s.lga },
            { label: 'Retires', value: s => s.retiresOn ? `${dmy(s.retiresOn)} (${s.retiresBy === 'age' ? 'age' : s.retiresBy === 'service' ? 'service' : 'contract'})` : '' },
            { label: 'Status', value: s => s.status === 'in_service' ? '' : s.statusLabel }
          ], roll, [{ label: 'Open', class: 'btn--primary', onClick: s => openRecord(s.id) }]) : ui.empty('No staff match.')
        );
      }

      // ── Due to retire ──
      async function due(box) {
        const months = el('select', { 'aria-label': 'Within' }, [3, 6, 12, 24, 36].map(m => el('option', { value: m }, `${m} months`)));
        months.value = '12';
        const out = el('div');
        box.replaceChildren(el('div', { class: 'report-filters' }, [el('label', { class: 'report-filter' }, [el('span', null, 'Retiring within'), months]),
          el('div', { class: 'report-actions' }, [el('button', { class: 'btn btn--ghost', onclick: () => list && printDue() }, '🖨 Print')])]), out);
        let list = null;
        async function show() {
          try { list = (await api.get(`/personnel/due-to-retire?months=${months.value}`)).staff; } catch (e) { out.replaceChildren(ui.empty(e.message)); return; }
          const past = list.filter(s => when(s.retiresOn) === 'past due').length;
          out.replaceChildren(
            el('p', { class: 'muted' }, `${list.length} officer${list.length === 1 ? '' : 's'} in service retire${list.length === 1 ? 's' : ''} within ${months.value} months${past ? `; ${past} past the date and still shown in service: change their status` : ''}. Start the retirement papers early.`),
            list.length ? ui.table([
              { label: 'Name', value: s => s.name }, { label: 'PSN', value: s => s.psn }, { label: 'Rank', value: s => s.rank }, { label: 'GL', value: s => s.gl },
              { label: 'Station', value: s => s.station }, { label: 'Retires on', value: s => long(s.retiresOn) },
              { label: 'By', value: s => BY[s.retiresBy] || '' },
              { label: 'When', node: s => el('span', { class: 'badge badge--' + (when(s.retiresOn) === 'past due' ? 'returned' : 'pending') }, when(s.retiresOn)) }
            ], list, [{ label: 'Open', class: 'btn--primary', onClick: s => openRecord(s.id) }]) : ui.empty('No one retires in this period.')
          );
        }
        function printDue() {
          P.printPage(`<article class="court-doc report-print">${masthead(`DUE TO RETIRE WITHIN ${months.value} MONTHS`)}
            <table class="doc-table"><thead><tr><th>S/No</th><th>Name</th><th>PSN</th><th>Rank</th><th>GL</th><th>Station</th><th>Date of birth</th><th>Date of first appointment</th><th>Retires on</th><th>By</th></tr></thead><tbody>
            ${list.map((s, i) => `<tr><td>${i + 1}</td><td>${esc(s.name)}</td><td>${esc(s.psn)}</td><td>${esc(s.rank)}</td><td>${esc(s.gl)}</td><td>${esc(s.station)}</td><td>${esc(dmy(s.dob))}</td><td>${esc(dmy(s.dofa))}</td><td>${esc(dmy(s.retiresOn))}</td><td>${esc(BY[s.retiresBy] || '')}</td></tr>`).join('')}
            </tbody></table>${footer()}</article>`, '@page { size: A4 landscape; margin: 10mm; }');
        }
        months.addEventListener('change', show);
        show();
      }

      // ── Summary: staff in service by station, cadre, grade level and sex ──
      async function summary(box) {
        let list;
        try { list = (await api.get('/personnel/staff?status=serving')).staff; } catch (e) { box.replaceChildren(ui.empty(e.message)); return; }
        const count = (key) => { const m = {}; list.forEach(s => { const k = s[key] || 'Not given'; m[k] = (m[k] || 0) + 1; }); return Object.entries(m).sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })); };
        const card = (n, label) => el('div', { class: 'dash-card' }, [el('div', { class: 'dash-card__num' }, String(n)), el('div', { class: 'dash-card__label' }, label)]);
        const part = (title, key) => el('div', { class: 'staff-sum' }, [el('h3', null, title), ui.table([{ label: title, value: r => r[0] }, { label: 'Staff', value: r => String(r[1]) }], count(key))]);
        box.replaceChildren(
          el('div', { class: 'dash-stats' }, [card(list.length, 'Staff in service'), card(list.filter(s => s.sex === 'M').length, 'Male'), card(list.filter(s => s.sex === 'F').length, 'Female'), card(list.filter(s => s.contract).length, 'On contract')]),
          el('div', { class: 'staff-sums' }, [part('Station', 'station'), part('Cadre', 'cadre'), part('Grade level', 'gl'), part('LGA', 'lga')])
        );
      }

      // ── An officer's record ──
      async function openRecord(id) {
        let s;
        try { s = (await api.get(`/personnel/staff/${id}`)).staff; } catch (e) { ui.toast(e.message, 'error'); return; }
        let dialog;
        const reopen = () => { dialog.close(); openRecord(id); loadRoll(); };
        const kv = (k, v) => v ? el('div', { class: 'doc-kv' }, [el('strong', null, k + ': '), v]) : null;
        const photo = s.hasPhoto ? el('img', { class: 'staff-photo', src: `/api/personnel/staff/${s.id}/photo?t=${Date.now()}`, alt: 'Photo' }) : el('div', { class: 'staff-photo staff-photo--none' }, '👤');
        const action = (label, fn, cls = 'btn--ghost') => el('button', { class: 'btn ' + cls, onclick: fn }, label);
        const ret = s.retiresOn ? el('div', { class: 'notice' + (when(s.retiresOn) === 'past due' && ['in_service', 'on_leave', 'suspended'].includes(s.status) ? ' notice--warn' : '') },
          `Retires on ${long(s.retiresOn)} (${BY[s.retiresBy]}), ${when(s.retiresOn)}.${s.age !== null ? ` Age ${s.age}.` : ''}${s.service !== null ? ` ${s.service} years in service.` : ''}`) : el('div', { class: 'notice notice--warn' }, 'The retirement date cannot be worked out: add the date of birth and the date of first appointment.');
        const body = el('div', null, [
          el('div', { class: 'doc-preview__actions' }, [
            el('button', { class: 'btn btn--ghost', onclick: () => dialog.close() }, '✕  Close'),
            canEdit ? action('✏ Edit', () => { dialog.close(); editForm(s); }) : null,
            canEdit ? action('⬆ Promotion', () => event(s, 'promotion', reopen)) : null,
            canEdit ? action('🏢 Posting', () => event(s, 'posting', reopen)) : null,
            canEdit && !s.confirmedOn ? action('✔ Confirmation', () => event(s, 'confirmation', reopen)) : null,
            canEdit ? action('⚑ Status', () => event(s, 'status', reopen)) : null,
            canEdit ? action('📝 Note', () => event(s, 'note', reopen)) : null,
            canEdit ? action('📷 Photo', () => uploadPhoto(s, reopen)) : null,
            S.me.admin ? action('🗑 Remove', async () => {
              if (!confirm(`Remove ${s.name} (PSN ${s.psn}) and all their documents from the roll? Use this only for a record entered by mistake; for an officer who left, change the status instead.`)) return;
              try { await api.del(`/personnel/staff/${s.id}`); ui.toast('Record removed.', 'success'); dialog.close(); loadRoll(); } catch (e) { ui.toast(e.message, 'error'); }
            }, 'btn--danger') : null
          ]),
          el('div', { class: 'staff-head' }, [photo, el('div', null, [
            el('h2', null, [s.title, s.name].filter(Boolean).join(' ')),
            el('div', null, `${s.rank || 'Rank not given'}${s.gl ? `, GL ${s.gl}${s.step ? ` step ${s.step}` : ''}` : ''}`),
            el('div', { class: 'muted' }, `PSN ${s.psn}${s.station ? ` · ${s.station}` : ''}`),
            el('span', { class: 'badge badge--' + (s.status === 'in_service' ? 'final' : 'pending') }, s.statusLabel + (s.statusDate && s.status !== 'in_service' ? ` since ${long(s.statusDate)}` : ''))
          ])]),
          ret,
          s.checkDates ? el('div', { class: 'notice notice--warn' }, [
            'The import could not be sure of a date on this record (see the record of service). Check the dates against the documents. ',
            canEdit ? el('button', { class: 'btn btn--small btn--ghost', onclick: async () => { try { await api.post(`/personnel/staff/${s.id}/dates-checked`); reopen(); } catch (e) { ui.toast(e.message, 'error'); } } }, 'Dates are right') : null
          ]) : null,
          el('div', { class: 'case-details staff-details' }, [
            kv('Sex', s.sex === 'M' ? 'Male' : s.sex === 'F' ? 'Female' : ''), kv('Cadre', s.cadre), kv('Highest qualification', s.qualification),
            kv('Date of birth', long(s.dob)), kv('Date of first appointment', long(s.dofa)), kv('Date of present appointment', long(s.dopa)),
            kv('Date of confirmation', long(s.confirmedOn)), kv('LGA', s.lga), kv('Contract', s.contract ? `Yes${s.contractEnds ? `, ends ${long(s.contractEnds)}` : ', end date not given'}` : ''),
            kv('Phone', s.phone), kv('Email', s.email), kv('Address', s.address),
            kv('Next of kin', [s.nextOfKin.name, s.nextOfKin.relationship, s.nextOfKin.phone].filter(Boolean).join(', ')),
            kv('Qualifications', s.qualifications.map(q => [q.name, q.institution, q.year].filter(Boolean).join(', ')).join('; '))
          ]),
          el('div', { class: 'case-docs' }, [el('h3', null, `Record of service (${s.history.length})`), s.history.length ? ui.table([
            { label: 'Date', value: h => long(h.date) }, { label: 'Entry', value: h => h.text }, { label: 'By', value: h => h.byName }
          ], s.history) : el('p', { class: 'muted' }, 'Nothing recorded yet.')]),
          docsPanel(s)
        ]);
        ui.modal(`${s.name} · PSN ${s.psn}`, body, { noFooter: true, wide: true, onOpen: (o) => { dialog = o; } });
      }

      function docsPanel(s) {
        const box = el('div', { class: 'case-docs' }, el('p', { class: 'muted' }, 'Loading documents…'));
        const size = (n) => n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`;
        async function load() {
          let r;
          try { r = await api.get(`/personnel/staff/${s.id}/documents`); } catch (e) { box.replaceChildren(el('p', { class: 'muted' }, e.message)); return; }
          box.replaceChildren(
            el('div', { class: 'case-docs__head' }, [el('h3', null, `Documents (${r.documents.length})`),
              r.canUpload ? el('button', { class: 'btn btn--small btn--primary', onclick: () => add(r.docTypes) }, '+ Add Document') : null]),
            r.documents.length ? ui.table([
              { label: 'Date', value: d => long(d.date) },
              { label: 'Title', node: d => el('span', null, [d.title, d.confidential ? el('span', { class: 'badge badge--returned staff-flag' }, '🔒 Confidential') : null]) },
              { label: 'Type', value: d => d.docType && d.docType !== d.title ? d.docType : '' },
              { label: 'Size', value: d => size(d.bytes) },
              { label: 'Added by', value: d => `${d.uploadedByName}, ${P.day(d.uploadedAt)}` }
            ], r.documents, [
              { label: 'Open', show: d => !!d.url, onClick: d => window.open(d.url, '_blank', 'noopener') },
              { label: 'Delete', class: 'btn--danger', show: d => d.canDelete, onClick: async d => {
                if (!confirm(`Delete "${d.title}" from the folder?`)) return;
                try { await api.del(`/personnel/documents/${d.id}`); ui.toast('Document deleted.', 'success'); load(); } catch (e) { ui.toast(e.message, 'error'); }
              } }
            ]) : el('p', { class: 'muted' }, r.canUpload ? 'No documents yet. Add the appointment letter, certificates, promotion letters and so on.' : 'No documents yet.')
          );
        }
        function add(types) {
          const type = el('select', null, types.map(t => el('option', { value: t }, t === 'Others' ? 'Others (type it)' : t)));
          const other = el('input', { type: 'text', placeholder: 'Type of document' });
          const title = el('input', { type: 'text', placeholder: 'Optional, e.g. Promotion to GL 08' });
          const date = el('input', { type: 'date' });
          const conf = el('input', { type: 'checkbox' });
          const files = el('input', { type: 'file', accept: 'application/pdf,image/png,image/jpeg', multiple: 'multiple' });
          const otherRow = ui.field('Type of document', other);
          const sync = () => { otherRow.hidden = type.value !== 'Others'; if (/query|disciplin/i.test(type.value)) conf.checked = true; };
          type.addEventListener('change', sync); sync();
          ui.modal('Add Document', el('div', null, [
            ui.field('Document', type), otherRow, ui.field('Title', title, 'Leave empty to use the type of document.'), ui.field('Date of the document', date),
            el('label', { class: 'check check--plain' }, [conf, ' 🔒 Confidential: only those who edit the roll can open it (queries, disciplinary papers)']),
            ui.field('Scanned file(s)', files, 'PDF or photo, up to 10 MB each. Choose several files for a long document: each is kept as a part.')
          ]), {
            confirmText: 'Upload',
            onConfirm: async () => {
              const list = [...files.files];
              if (!list.length) throw new Error('Choose the scanned file.');
              for (let i = 0; i < list.length; i++) {
                const f = new FormData();
                f.append('docType', type.value); f.append('other', other.value); f.append('date', date.value); f.append('confidential', conf.checked ? '1' : '0');
                f.append('title', list.length > 1 ? `${title.value.trim() || (type.value === 'Others' ? other.value : type.value)} (part ${i + 1} of ${list.length})` : title.value);
                f.append('file', list[i]);
                await api.post(`/personnel/staff/${s.id}/documents`, f);
              }
              ui.toast('Added to the folder.', 'success'); load(); return true;
            }
          });
        }
        load();
        return box;
      }

      // Promotion, posting, confirmation, status or a note, into the record of service.
      function event(s, kind, done) {
        const date = el('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
        const note = el('textarea', { rows: '2', maxlength: '500', placeholder: kind === 'note' ? 'The note' : 'Optional: the letter reference, or anything to add' });
        const rank = el('input', { type: 'text', list: 'rank-list', value: s.rank, placeholder: 'New rank' });
        const gl = el('select', null, S.gls.map(x => opt(x)));
        gl.value = s.gl && S.gls.indexOf(s.gl) + 1 < S.gls.length ? S.gls[S.gls.indexOf(s.gl) + 1] : s.gl || '01';
        const step = el('input', { type: 'number', min: '1', max: '15', value: '1' });
        const station = stationSelect('');
        const status = el('select', null, S.statuses.filter(x => x.key !== s.status).map(x => opt(x.key, x.label)));
        const parts = {
          promotion: ['Record Promotion', [ui.field('New rank', rank), ui.field('Grade level', gl), ui.field('Step', step), ui.field('Date of the promotion (date of present appointment)', date)]],
          posting: ['Record Posting', [ui.field('Posted to', station), ui.field('Date of the posting', date)]],
          confirmation: ['Record Confirmation', [ui.field('Date of confirmation', date)]],
          status: ['Change Status', [ui.field('Status', status), ui.field('From', date)]],
          note: ['Add a Note', [ui.field('Date', date)]]
        };
        const [title, fields] = parts[kind];
        ui.modal(`${title} · ${s.name}`, el('div', null, [...fields, ui.field(kind === 'note' ? 'Note' : 'Note (optional)', note), rankList()]), {
          confirmText: 'Save',
          onConfirm: async () => {
            await api.post(`/personnel/staff/${s.id}/events`, { kind, date: date.value, note: note.value, rank: rank.value, gl: gl.value, step: step.value, station: station.value, status: status.value });
            ui.toast('Recorded in the record of service.', 'success'); done(); return true;
          }
        });
      }
      const rankList = () => el('datalist', { id: 'rank-list' }, S.ranks.map(r => el('option', { value: r.name })));
      function stationSelect(value) {
        const list = [...S.stations];
        if (value && !list.includes(value)) list.push(value);
        const s = el('select', null, [opt('', S.stations.length ? 'Choose the station' : 'No stations yet (Settings, Personnel)'), ...list.map(x => opt(x))]);
        s.value = value || '';
        return s;
      }

      function uploadPhoto(s, done) {
        const file = el('input', { type: 'file', accept: 'image/png,image/jpeg' });
        ui.modal(`Photo · ${s.name}`, el('div', null, [ui.field('Passport photo', file, 'PNG or JPEG, under 2 MB. Optional.'),
          s.hasPhoto ? el('button', { class: 'btn btn--small btn--danger', type: 'button', onclick: async () => { try { await api.del(`/personnel/staff/${s.id}/photo`); ui.toast('Photo removed.', 'success'); done(); } catch (e) { ui.toast(e.message, 'error'); } } }, 'Remove the photo') : el('span')]), {
          confirmText: 'Upload',
          onConfirm: async () => {
            if (!file.files[0]) throw new Error('Choose the photo.');
            const f = new FormData(); f.append('file', file.files[0]);
            await api.post(`/personnel/staff/${s.id}/photo`, f);
            ui.toast('Photo saved.', 'success'); done(); return true;
          }
        });
      }

      // Add or correct a record. A promotion or posting is better recorded as such (it keeps the history).
      async function editForm(s) {
        const v = s || { sex: '', gl: '', lga: '', station: '', contract: false, nextOfKin: {}, qualifications: [] };
        const f = (label, node, full) => el('label', { class: 'form-field' + (full ? ' form-field--full' : '') }, [el('span', { class: 'form-field__label' }, label), node]);
        const input = (val, type = 'text', extra = {}) => el('input', { type, value: val || '', ...extra });
        const x = {
          psn: input(v.psn), name: input(v.name), title: input(v.title, 'text', { placeholder: 'e.g. Barr., Mal., Mrs' }),
          sex: el('select', null, [opt('', 'Choose'), opt('M', 'Male'), opt('F', 'Female')]),
          rank: input(v.rank, 'text', { list: 'rank-list' }), gl: el('select', null, [opt('', 'Choose'), ...S.gls.map(g => opt(g))]),
          step: input(v.step == null ? '' : v.step, 'number', { min: '1', max: '15' }), qualification: input(v.qualification),
          dob: input(v.dob, 'date'), dofa: input(v.dofa, 'date'), dopa: input(v.dopa, 'date'), confirmedOn: input(v.confirmedOn, 'date'),
          lga: el('select', null, [opt('', 'Choose'), ...S.lgas.map(l => opt(l))]), station: stationSelect(v.station),
          contract: el('input', { type: 'checkbox' }), contractEnds: input(v.contractEnds, 'date'),
          phone: input(v.phone, 'tel'), email: input(v.email, 'email'), address: input(v.address),
          kinName: input(v.nextOfKin.name), kinRel: input(v.nextOfKin.relationship, 'text', { placeholder: 'e.g. Wife, Son' }), kinPhone: input(v.nextOfKin.phone, 'tel')
        };
        x.sex.value = v.sex || ''; x.gl.value = v.gl || ''; x.lga.value = v.lga || ''; x.contract.checked = !!v.contract;
        const endRow = f('Contract end date', x.contractEnds);
        const syncC = () => { endRow.hidden = !x.contract.checked; };
        x.contract.addEventListener('change', syncC); syncC();
        const quals = el('div', { class: 'settings-list' });
        const qRow = (q) => el('div', { class: 'settings-row' }, [
          el('input', { type: 'text', value: q.name || '', placeholder: 'Qualification', 'data-k': 'name' }),
          el('input', { type: 'text', value: q.institution || '', placeholder: 'Institution', 'data-k': 'institution' }),
          el('input', { type: 'text', value: q.year || '', placeholder: 'Year', 'data-k': 'year', class: 'input--short' }),
          el('button', { class: 'btn btn--small btn--ghost', type: 'button', onclick: (e) => e.target.closest('.settings-row').remove() }, '✕')]);
        (v.qualifications || []).forEach(q => quals.appendChild(qRow(q)));
        let account = null;
        if (S.me.admin && s) {
          account = el('select', null, [opt('', 'None')]);
          api.get('/admin/users').then(r => { account.append(...r.users.map(u => opt(u.id, `${u.fullName} (${u.username})`))); account.value = v.user || ''; }).catch(() => {});
        }
        const body = el('div', { class: 'form-grid' }, [
          s ? el('p', { class: 'muted form-field--full' }, 'For a promotion, posting, confirmation or change of status, use those buttons on the record instead, so the record of service keeps the history. Corrections made here are written into the record of service too.') : null,
          f('PSN *', x.psn), f('Name *', x.name), f('Title', x.title), f('Sex', x.sex), f('Rank', x.rank), f('Grade level', x.gl), f('Step', x.step),
          f('Highest qualification', x.qualification), f('Date of birth', x.dob), f('Date of first appointment', x.dofa), f('Date of present appointment', x.dopa),
          f('Date of confirmation', x.confirmedOn), f('LGA', x.lga), f('Station', x.station),
          el('label', { class: 'check check--plain form-field--full' }, [x.contract, ' On contract (retires at the end of the contract)']), endRow,
          f('Phone', x.phone), f('Email', x.email), f('Address', x.address, true),
          f('Next of kin', x.kinName), f('Relationship', x.kinRel), f('Next of kin phone', x.kinPhone),
          el('div', { class: 'form-field form-field--full' }, [el('span', { class: 'form-field__label' }, 'Qualifications'), quals,
            el('button', { class: 'btn btn--small btn--ghost', type: 'button', onclick: () => quals.appendChild(qRow({})) }, '+ Add qualification')]),
          account ? f('Sign in account (links the officer to their login)', account, true) : null,
          rankList()
        ]);
        ui.modal(s ? `Edit · ${s.name}` : 'Add Staff', body, {
          wide: true, confirmText: s ? 'Save' : 'Add to the Roll',
          onConfirm: async () => {
            const payload = {
              psn: x.psn.value, name: x.name.value, title: x.title.value, sex: x.sex.value, rank: x.rank.value, gl: x.gl.value, step: x.step.value,
              qualification: x.qualification.value, dob: x.dob.value, dofa: x.dofa.value, dopa: x.dopa.value, confirmedOn: x.confirmedOn.value,
              lga: x.lga.value, station: x.station.value, contract: x.contract.checked, contractEnds: x.contract.checked ? x.contractEnds.value : '',
              phone: x.phone.value, email: x.email.value, address: x.address.value,
              nextOfKin: { name: x.kinName.value, relationship: x.kinRel.value, phone: x.kinPhone.value },
              qualifications: [...quals.children].map(r => Object.fromEntries([...r.querySelectorAll('input')].map(i => [i.dataset.k, i.value])))
            };
            if (account) payload.user = account.value;
            const r = s ? await api.put(`/personnel/staff/${s.id}`, payload) : await api.post('/personnel/staff', payload);
            ui.toast(s ? 'Saved.' : 'Added to the Nominal Roll.', 'success');
            loadRoll(); openRecord(r.staff.id); return true;
          }
        });
      }

      // ── Import ──
      const TEMPLATE = ['S/NO', 'NAME', 'SEX', 'RANK', 'HIG. QUALIFICATION', 'GL', 'STEP', 'PSN', 'DOB', 'DOFA', 'DOPA', 'DATE OF CONFIRMATION', 'LGA', 'STATION', 'CONTRACT', 'CONTRACT END DATE', 'PHONE', 'EMAIL', 'EXP.DATE OF RET. BY AGE', 'EXP.DATE OF RET. BY SERVICE'];
      function importRoll() {
        let dialog;
        const file = el('input', { type: 'file', accept: '.xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv' });
        const result = el('div');
        const send = async (commit) => {
          if (!file.files[0]) { ui.toast('Choose the Excel or CSV file first.', 'error'); return null; }
          const f = new FormData(); f.append('commit', commit ? '1' : '0'); f.append('file', file.files[0]);
          return api.post('/personnel/import', f);
        };
        const check = el('button', { class: 'btn btn--primary', onclick: async () => {
          check.disabled = true; check.textContent = 'Checking…';
          try { const r = await send(false); if (r) show(r); } catch (e) { ui.toast(e.message, 'error', 9000); }
          check.disabled = false; check.textContent = '🔎 Check the File';
        } }, '🔎 Check the File');
        file.addEventListener('change', () => result.replaceChildren());
        function show(r) {
          const flagged = r.rows.filter(x => x.ok && x.check).length;
          const go = el('button', { class: 'btn btn--ok', disabled: r.toAdd ? null : true, onclick: async () => {
            if (!confirm(`Add ${r.toAdd} officer${r.toAdd === 1 ? '' : 's'} to the Nominal Roll?`)) return;
            go.disabled = true; go.textContent = 'Importing…';
            try {
              const d = await send(true);
              ui.toast(`${d.added} added to the Nominal Roll${d.checkDates ? `; ${d.checkDates} marked "check dates"` : ''}.${d.failed.length ? ` ${d.failed.length} could not be added.` : ''}`, 'success', 9000);
              dialog.close(); loadRoll();
            } catch (e) { ui.toast(e.message, 'error', 9000); go.disabled = false; go.textContent = `⬆ Import ${r.toAdd}`; }
          } }, `⬆ Import ${r.toAdd} Officer${r.toAdd === 1 ? '' : 's'}`);
          const ordered = [...r.rows.filter(x => !x.ok), ...r.rows.filter(x => x.ok && (x.check || x.notes.length)), ...r.rows.filter(x => x.ok && !x.check && !x.notes.length)];
          result.replaceChildren(
            el('div', { class: 'notice' + (r.skipped || flagged ? ' notice--warn' : '') }, `${r.toAdd} officer${r.toAdd === 1 ? '' : 's'} can be added.` +
              (r.skipped ? ` ${r.skipped} row${r.skipped === 1 ? ' has a problem' : 's have problems'} and will be left out (listed first).` : '') +
              (flagged ? ` ${flagged} will be marked "check dates": a date could not be read for certain, or the sheet's own retirement date does not agree. They are added; check them on their records afterwards.` : '')),
            ui.table([
              { label: 'Row', value: x => String(x.line) }, { label: 'PSN', value: x => x.psn }, { label: 'Name', value: x => x.name },
              { label: 'Rank', value: x => x.rank }, { label: 'Retires', value: x => x.retiresOn ? `${dmy(x.retiresOn)} (${x.retiresBy})` : '' },
              { label: 'Check', node: x => el('div', null, [
                ...x.problems.map(p => el('div', { class: 'import-problem' }, '✕ ' + p)),
                ...x.notes.map(n => el('div', { class: 'muted' }, n)),
                x.ok && !x.notes.length ? el('span', { class: 'badge badge--final' }, 'OK') : null
              ]) }
            ], ordered.slice(0, 500)),
            ordered.length > 500 ? el('p', { class: 'muted' }, `Showing the first 500 of ${ordered.length} rows.`) : el('span'),
            el('div', { class: 'card__actions' }, [go])
          );
        }
        ui.modal('Import the Nominal Roll', el('div', null, [
          el('div', { class: 'doc-preview__actions' }, [el('button', { class: 'btn btn--ghost', onclick: () => dialog.close() }, '✕  Close')]),
          el('ol', { class: 'import-steps' }, [
            el('li', null, ['Use the nominal roll as it is kept in Excel, or download the template. ', el('button', { class: 'btn btn--small btn--ghost', type: 'button', onclick: () => download('nominal-roll-template.csv', [TEMPLATE]) }, '⬇ Download the template')]),
            el('li', null, 'One officer per row. The columns are found by their headings: NAME and PSN are needed; the others (SEX, RANK, HIG. QUALIFICATION, GL, STEP, DOB, DOFA, DOPA, LGA, STATION, CONTRACT, and the expected dates of retirement) as available. Write dates day first (12/03/1990). Where the sheet gives the expected date of retirement, it is used to check the dates.'),
            el('li', null, 'Choose the file and click Check the File: nothing is saved yet. Rows with a problem (no PSN, a PSN given twice or already on the roll) are left out; click Import to add the rest.')
          ]),
          ui.field('The roll file', file), el('div', { class: 'card__actions' }, [check]),
          result
        ]), { noFooter: true, wide: true, onOpen: (o) => { dialog = o; } });
      }

      // ── Print and Excel, in the columns of the roll ──
      const masthead = (line3) => `<header class="doc-masthead"><img class="doc-emblem" src="/assets/highcourt.png" alt="">
        <div class="doc-titleblock"><div class="doc-line1">THE JUDICIARY</div><div class="doc-line2">GOMBE STATE HIGH COURT OF JUSTICE</div><div class="doc-line3">${esc(line3)}</div></div>
        <img class="doc-emblem" src="/assets/coat.png" alt=""></header><div class="doc-rule"></div>`;
      const footer = () => `<footer class="doc-footer"><span>Printed ${esc(P.day(new Date()))}</span><span>Powered by the Directorate of ICT, Gombe State High Court of Justice</span></footer>`;
      const HEAD = ['S/NO', 'NAME', 'SEX', 'RANK', 'HIG. QUALIFICATION', 'GL', 'PSN', 'DOB', 'DOFA', 'LGA', 'CONTRACT', 'DOPA', 'EXP. DATE OF RET. BY AGE', 'EXP. DATE OF RET. BY SERVICE', 'STATION'];
      const line = (s, i) => [i + 1, s.name, s.sex, s.rank, s.qualification, s.gl, s.psn, dmy(s.dob), dmy(s.dofa), s.lga, s.contract ? 'Contract' : '', dmy(s.dopa),
        s.retiresBy === 'age' ? dmy(s.retiresOn) : '', s.retiresBy === 'service' ? dmy(s.retiresOn) : s.retiresBy === 'contract' ? `${dmy(s.retiresOn)} (contract)` : '', s.station];
      const asAt = () => new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase();
      function printRoll() {
        if (!roll.length) { ui.toast('Nothing to print.', 'info'); return; }
        P.printPage(`<article class="court-doc report-print">${masthead(`STAFF NOMINAL ROLL AS AT ${asAt()}`)}
          <table class="doc-table roll-print"><thead><tr>${HEAD.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>
          ${roll.map((s, i) => `<tr>${line(s, i).map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>${footer()}</article>`, '@page { size: A4 landscape; margin: 8mm; }');
      }
      function csv() {
        if (!roll.length) { ui.toast('Nothing to download.', 'info'); return; }
        download(`nominal-roll-${new Date().toISOString().slice(0, 10)}.csv`, [[`HIGH COURT OF JUSTICE STAFF NOMINAL ROLL AS AT ${asAt()}`], HEAD, ...roll.map(line)]);
      }

      const TABS = [['roll', 'Nominal Roll'], ['due', 'Due to Retire'], ['summary', 'Summary']];
      function select(key) {
        tabsBar.querySelectorAll('.tab').forEach(t => t.classList.toggle('is-active', t.dataset.tab === key));
        toolbar.hidden = key !== 'roll';
        if (key === 'roll') { panel.replaceChildren(filters, rollBox); loadRoll(); }
        else { const box = el('div'); panel.replaceChildren(box); (key === 'due' ? due : summary)(box); }
      }
      TABS.forEach(([key, name]) => tabsBar.appendChild(el('button', { class: 'tab', role: 'tab', 'data-tab': key, onclick: () => select(key) }, name)));
      select(ctx.tab || 'roll');
    }
  };
})();
