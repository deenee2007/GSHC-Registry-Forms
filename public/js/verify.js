/*
 * public/js/verify.js — the public page a QR code opens.
 * Reads the code from the address (/verify/GSHC-...) or the form, asks the
 * server, and shows whether the document is genuine.
 */
(function () {
  const form = document.getElementById('v-form');
  const input = document.getElementById('v-code');
  const out = document.getElementById('v-result');

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  const fmt = (d) => d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

  const VERDICT = {
    valid:     ['v-ok',   'Genuine document', 'This document was issued and signed through the GSHC Registry system and has not been altered.'],
    revoked:   ['v-bad',  'Revoked',          'This document was issued by the court but has since been revoked. It must not be relied on.'],
    tampered:  ['v-bad',  'Record altered',   'The stored record no longer matches what was signed. Contact the court registry.'],
    not_found: ['v-bad',  'Not found',        'No signed document has this code. Check the code, or treat the document as not genuine.'],
    error:     ['v-warn', 'Could not check',  'The check could not be completed. Please try again shortly.']
  };

  function row(dl, label, value) {
    if (!value) return;
    dl.appendChild(el('dt', null, label));
    dl.appendChild(el('dd', null, value));
  }

  function show(r) {
    const [cls, title, text] = VERDICT[r.status] || VERDICT.error;
    out.hidden = false;
    out.className = 'v-result ' + cls;
    out.replaceChildren();
    out.appendChild(el('h2', null, title));
    out.appendChild(el('p', null, r.error || text));
    if (r.document) {
      const dl = el('dl');
      row(dl, 'Code', r.code);
      row(dl, 'Document', r.document);
      row(dl, 'Reference', r.reference);
      row(dl, 'Issued by', r.court);
      row(dl, 'Issued on', fmt(r.issuedAt));
      (r.signedBy || []).forEach(s => row(dl, 'Signed (' + s.capacity + ')', [s.title, s.name].filter(Boolean).join(' ') + ', ' + fmt(s.signedAt)));
      if (r.status === 'revoked') {
        row(dl, 'Revoked on', fmt(r.revokedAt));
        row(dl, 'Reason', r.revokeReason);
      }
      out.appendChild(dl);
      out.appendChild(el('p', 'v-note', 'Compare these details with the paper document. They must match exactly.'));
    }
  }

  async function check(code) {
    out.hidden = false;
    out.className = 'v-result';
    out.textContent = 'Checking…';
    try {
      const res = await fetch('/api/verify/' + encodeURIComponent(code));
      show(await res.json());
    } catch (e) { show({ status: 'error' }); }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = input.value.trim();
    if (!code) return;
    history.replaceState(null, '', '/verify/' + encodeURIComponent(code));
    check(code);
  });

  const m = location.pathname.match(/^\/verify\/(.+)$/);
  if (m) { input.value = decodeURIComponent(m[1]); check(input.value); }
})();
