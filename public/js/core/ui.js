/*
 * core/ui.js — shared UI helpers used by every module.
 * Keeps modules small: they describe data, ui.js renders it.
 */
(function () {
  window.App = window.App || {};

  // Tiny DOM builder: el('div', {class:'x'}, [child, 'text'])
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) Object.entries(attrs).forEach(([k, v]) => {
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) node.setAttribute(k, v);
    });
    (Array.isArray(children) ? children : [children]).forEach(c => {
      if (c === null || c === undefined) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

  function toast(message, type, ms) {
    const t = el('div', { class: 'toast toast--' + (type || 'info'), role: 'status' }, message);
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('toast--show'), 10);
    setTimeout(() => { t.classList.remove('toast--show'); setTimeout(() => t.remove(), 300); }, ms || 3500);
  }

  // Modal returning a Promise (resolves with form data on save, null on cancel)
  function modal(title, bodyNode, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const overlay = el('div', { class: 'modal-overlay' });
      const close = (val) => { overlay.remove(); resolve(val); };
      const confirmBtn = el('button', { class: 'btn ' + (opts.confirmClass || 'btn--primary'), onclick: async () => {
        confirmBtn.disabled = true;
        try {
          const result = opts.onConfirm ? await opts.onConfirm() : true;
          if (result !== undefined && result !== null && result !== false) close(result);
        } catch (e) {
          toast(e.message || 'Something went wrong.', 'error');
        } finally { confirmBtn.disabled = false; }
      } }, opts.confirmText || 'Save');
      const footer = el('div', { class: 'modal__footer' }, [
        el('button', { class: 'btn btn--ghost', onclick: () => close(null) }, opts.cancelText || 'Cancel'),
        confirmBtn
      ]);
      const box = el('div', { class: 'modal' + (opts.wide ? ' modal--wide' : '') }, [
        el('div', { class: 'modal__header' }, title),
        el('div', { class: 'modal__body' }, bodyNode),
        opts.noFooter ? null : footer
      ]);
      overlay.appendChild(box);
      overlay.addEventListener('click', (e) => { if (e.target === overlay && !opts.noBackdropClose) close(null); });
      overlay.close = () => close(null);
      document.body.appendChild(overlay);
      if (opts.onOpen) opts.onOpen(overlay, close);
    });
  }

  // Build a form from a schema: [{name,label,type,options?,required?}]
  // Returns { node, getValues(), setValues(obj), validate() }
  function form(schema, initial) {
    const fields = {};
    const tableCtrls = {};   // holds table controllers for type:'table' fields
    const wrap = el('div', { class: 'form-grid' });

    schema.forEach(f => {
      if (!f.name && f.section) {
        wrap.appendChild(el('div', { class: 'form-section' }, f.section));
        return;
      }

      // ── Dynamic repeating table (e.g. cause list entries) ──
      if (f.type === 'table') {
        const cols = f.columns || [];
        const tbody = el('tbody');

        function addRow(vals) {
          const cells = cols.map(c => {
            const inp = el('input', { type: 'text', placeholder: c.label, class: 'ft-inp' });
            if (vals && vals[c.name] !== undefined) inp.value = vals[c.name];
            else if (vals && c.legacy && vals[c.legacy] !== undefined) inp.value = vals[c.legacy]; // saved before the column was renamed
            return el('td', null, [inp]);
          });
          const snCell = el('td', { class: 'ft-sn' }, String(tbody.children.length + 1));
          const delBtn = el('button', { class: 'btn btn--ghost btn--small ft-del', type: 'button', title: 'Remove this row',
            onclick: () => { row.remove(); reNumber(); }
          }, '✕');
          // Move a row up or down: the order printed (e.g. of a cause list).
          const move = (up) => () => {
            const other = up ? row.previousElementSibling : row.nextElementSibling;
            if (!other) return;
            if (up) tbody.insertBefore(row, other); else tbody.insertBefore(other, row);
            reNumber();
          };
          const upBtn = el('button', { class: 'btn btn--ghost btn--small ft-move', type: 'button', title: 'Move up', 'aria-label': 'Move up', onclick: move(true) }, '↑');
          const downBtn = el('button', { class: 'btn btn--ghost btn--small ft-move', type: 'button', title: 'Move down', 'aria-label': 'Move down', onclick: move(false) }, '↓');
          const row = el('tr', null, [snCell, ...cells, el('td', { class: 'ft-actions' }, [upBtn, downBtn, delBtn])]);
          tbody.appendChild(row);
        }

        function reNumber() {
          Array.from(tbody.rows).forEach((r, i) => { r.cells[0].textContent = String(i + 1); });
        }

        // seed with initial values or one blank row
        let initRows = [];
        if (initial && initial[f.name]) {
          try { initRows = Array.isArray(initial[f.name]) ? initial[f.name] : JSON.parse(initial[f.name]); } catch(e) { initRows = []; }
        }
        if (initRows.length) initRows.forEach(r => addRow(r));
        else addRow();

        const thead = el('thead', null, [
          el('tr', null, [
            el('th', { class: 'ft-sn' }, 'S/N'),
            ...cols.map(c => el('th', null, c.label)),
            el('th', { class: 'ft-sn' }, '')
          ])
        ]);

        const tbl = el('table', { class: 'ft-table' }, [thead, tbody]);
        const addBtn = el('button', { class: 'btn btn--ghost btn--small', type: 'button',
          onclick: () => addRow()
        }, '+ Add Row');

        const container = el('div', { class: 'form-field form-field--full' }, [
          el('span', { class: 'form-field__label' }, f.label + (f.required ? ' *' : '')),
          el('div', { class: 'ft-scroll' }, [tbl]), // a wide table scrolls on its own, not the whole form
          el('div', { class: 'ft-add' }, [addBtn])
        ]);
        wrap.appendChild(container);

        tableCtrls[f.name] = {
          getValues() {
            return Array.from(tbody.rows).map((row, i) => {
              const obj = { sn: String(i + 1) };
              cols.forEach((c, ci) => { obj[c.name] = row.cells[ci + 1].querySelector('input').value.trim(); });
              return obj;
            });
          },
          validate() {
            if (f.required && tbody.rows.length === 0) { toast('Please add at least one entry to ' + f.label, 'error'); return false; }
            return true;
          }
        };
        return;
      }

      // ── Standard fields ──
      let input;
      if (f.type === 'textarea') input = el('textarea', { rows: f.rows || 3 });
      else if (f.type === 'select') {
        input = el('select');
        (f.options || []).forEach(o => input.appendChild(el('option', { value: o.value !== undefined ? o.value : o }, o.label || o)));
      } else input = el('input', { type: f.type || 'text' });
      input.name = f.name;
      // A saved draft made before this field existed takes legacyValue, so
      // editing it keeps the meaning it printed with.
      const init = (initial && initial[f.name] !== undefined) ? initial[f.name]
                 : (initial && f.legacyValue !== undefined) ? f.legacyValue
                 : (f.defaultValue !== undefined ? f.defaultValue : '');
      if (init !== '') input.value = init;
      fields[f.name] = input;
      const isFull = f.full || f.type === 'textarea';
      const cell = el('label', { class: 'form-field' + (isFull ? ' form-field--full' : '') }, [
        el('span', { class: 'form-field__label' }, f.label + (f.required ? ' *' : '')),
        input,
        f.help ? el('span', { class: 'form-field__help' }, f.help) : null
      ]);
      wrap.appendChild(cell);
    });

    return {
      node: wrap,
      getValues() {
        const o = {};
        Object.entries(fields).forEach(([k, i]) => o[k] = i.value.trim ? i.value.trim() : i.value);
        Object.entries(tableCtrls).forEach(([k, ctrl]) => o[k] = ctrl.getValues());
        return o;
      },
      validate() {
        for (const f of schema) {
          if (!f.name) continue;
          if (f.type === 'table') { if (!tableCtrls[f.name].validate()) return false; continue; }
          if (f.required && !fields[f.name].value.trim()) { toast('Please fill: ' + f.label, 'error'); fields[f.name].focus(); return false; }
        }
        return true;
      }
    };
  }

  // Render a records table with optional row actions
  function table(columns, rows, actions) {
    const head = el('tr', null, columns.map(c => el('th', null, c.label)));
    if (actions) head.appendChild(el('th', null, 'Actions'));
    const body = rows.map(r => {
      const tr = el('tr', null, columns.map(c => el('td', c.label ? { 'data-label': c.label } : null,
        c.node ? c.node(r) : String(c.value ? c.value(r) : (r[c.key] ?? '')))));
      if (actions) {
        const cell = el('td', { class: 'row-actions' });
        actions.forEach(a => { if (!a.show || a.show(r)) cell.appendChild(el('button', { class: 'btn btn--small ' + (a.class || ''), onclick: () => a.onClick(r) }, typeof a.label === 'function' ? a.label(r) : a.label)); });
        tr.appendChild(cell);
      }
      return tr;
    });
    return el('div', { class: 'table-scroll' }, [el('table', { class: 'data-table' }, [el('thead', null, head), el('tbody', null, body)])]);
  }

  const STATUS_LABELS = {
    draft: 'Draft', pending: 'Awaiting Signature', returned: 'Returned',
    final: 'Signed', revoked: 'Revoked', offline: 'Not Synced'
  };
  function statusBadge(status) {
    status = status || 'draft';
    return el('span', { class: 'badge badge--' + status }, STATUS_LABELS[status] || status);
  }

  // Labelled input for small dialogs.
  function field(label, input, help) {
    return el('label', { class: 'form-field form-field--full' }, [
      el('span', { class: 'form-field__label' }, label), input,
      help ? el('span', { class: 'form-field__help' }, help) : null
    ]);
  }

  function fmtDate(v) {
    if (!v) return '';
    return new Date(v).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function empty(text) { return el('p', { class: 'muted empty' }, text); }

  // ── Show / hide for every password and PIN field ──
  // Any <input type="password"> added anywhere gets an eye button, so each
  // screen does not have to remember to add one.
  function addReveal(input) {
    if (input.dataset.reveal) return;
    input.dataset.reveal = '1';
    const btn = el('button', { type: 'button', class: 'pw-toggle', 'aria-label': 'Show password', title: 'Show' }, '👁');
    btn.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? '🙈' : '👁';
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      btn.title = show ? 'Hide' : 'Show';
      input.focus();
    });
    const wrap = el('span', { class: 'pw-wrap' });
    input.parentNode.insertBefore(wrap, input);
    wrap.append(input, btn);
  }
  function revealAll(root) {
    if (root.matches && root.matches('input[type=password]')) addReveal(root);
    if (root.querySelectorAll) root.querySelectorAll('input[type=password]').forEach(addReveal);
  }
  new MutationObserver(list => list.forEach(m => m.addedNodes.forEach(n => { if (n.nodeType === 1) revealAll(n); })))
    .observe(document.documentElement, { childList: true, subtree: true });

  // Copy text, with a fallback for browsers that block the clipboard API.
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (e) {
      const ta = el('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = text; document.body.appendChild(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      ta.remove();
      return ok;
    }
  }

  window.App.ui = { el, clear, toast, modal, form, table, statusBadge, STATUS_LABELS, field, fmtDate, empty, copyText };
})();
