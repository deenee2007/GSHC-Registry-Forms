/*
 * modules/signature.js — "My Signature": a signer registers the signature
 * image placed on documents they approve (drawn on screen or uploaded
 * from a scan) and the PIN they type each time they sign.
 */
(function () {
  window.App = window.App || {};
  window.App.modules = window.App.modules || {};

  // Crop a canvas to the ink, with a small margin, so the printed
  // signature is not mostly empty space.
  function trimmed(canvas) {
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    const px = ctx.getImageData(0, 0, width, height).data;
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (px[(y * width + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) return null;
    const m = 8;
    x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(width - 1, x1 + m); y1 = Math.min(height - 1, y1 + m);
    const out = document.createElement('canvas');
    out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
    out.getContext('2d').drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  }

  function pad(ui) {
    const canvas = ui.el('canvas', { class: 'sig-pad', width: 600, height: 200, 'aria-label': 'Draw your signature' });
    const ctx = canvas.getContext('2d');
    ctx.lineWidth = 2.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#0a1f6b';
    let drawing = false, drawn = false;
    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      return [(e.clientX - r.left) * canvas.width / r.width, (e.clientY - r.top) * canvas.height / r.height];
    };
    canvas.addEventListener('pointerdown', (e) => { drawing = true; drawn = true; canvas.setPointerCapture(e.pointerId); const [x, y] = pos(e); ctx.beginPath(); ctx.moveTo(x, y); });
    canvas.addEventListener('pointermove', (e) => { if (!drawing) return; const [x, y] = pos(e); ctx.lineTo(x, y); ctx.stroke(); });
    ['pointerup', 'pointercancel'].forEach(t => canvas.addEventListener(t, () => { drawing = false; }));
    return {
      node: canvas,
      clear() { ctx.clearRect(0, 0, canvas.width, canvas.height); drawn = false; },
      value() { return drawn ? trimmed(canvas) : null; }
    };
  }

  window.App.modules.signature = {
    async render(container, ctx) {
      const { ui, api, auth } = ctx;
      let user = await auth.refresh().catch(() => auth.current());
      const el = ui.el;

      container.appendChild(el('div', { class: 'page-head' }, [
        el('h1', null, 'My Signature'),
        el('p', { class: 'muted' }, 'Set up your signature and signing PIN once. When you approve or finalise a form, your signature is placed on it automatically.')
      ]));

      const statusBox = el('div', { class: 'sig-status' });
      container.appendChild(statusBox);
      function paintStatus() {
        ui.clear(statusBox);
        const ok = user.hasSignature && user.hasSigningPin;
        statusBox.className = 'sig-status ' + (ok ? 'sig-status--ok' : 'sig-status--warn');
        statusBox.append(
          el('strong', null, ok ? '✔ Ready to sign' : 'Not ready to sign yet'),
          el('span', null, `  ·  Signature: ${user.hasSignature ? 'registered' : 'not set'}  ·  Signing PIN: ${user.hasSigningPin ? 'set' : 'not set'}`)
        );
      }
      paintStatus();

      // ── Current signature ──
      const current = el('div', { class: 'sig-current' });
      function paintCurrent() {
        ui.clear(current);
        if (!user.hasSignature) { current.appendChild(ui.empty('No signature registered yet.')); return; }
        current.append(el('span', { class: 'form-field__label' }, 'Current signature'),
          el('img', { class: 'sig-current__img', src: '/api/me/signature?t=' + Date.now(), alt: 'Your current signature' }));
      }
      paintCurrent();

      // ── Draw or upload ──
      const drawPad = pad(ui);
      const file = el('input', { type: 'file', accept: 'image/png,image/jpeg' });
      const pw1 = el('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Your account password' });
      let mode = 'draw';
      const drawPane = el('div', { class: 'sig-pane' }, [
        el('p', { class: 'muted' }, 'Sign inside the box with a mouse, stylus or finger.'),
        drawPad.node,
        el('div', null, [el('button', { class: 'btn btn--ghost btn--small', type: 'button', onclick: () => drawPad.clear() }, 'Clear')])
      ]);
      const uploadPane = el('div', { class: 'sig-pane', hidden: 'hidden' }, [
        el('p', { class: 'muted' }, 'Upload a clear scan or photo of your signature on white paper (PNG or JPEG, under 1 MB). A transparent PNG prints best.'),
        file
      ]);
      const modeBtns = el('div', { class: 'filter-btns' });
      [['draw', 'Draw'], ['upload', 'Upload a scan']].forEach(([m, label]) => {
        const b = el('button', { class: 'btn btn--small filter-btn' + (m === mode ? ' filter-btn--active' : ''), type: 'button', onclick: () => {
          mode = m;
          modeBtns.querySelectorAll('button').forEach(x => x.classList.remove('filter-btn--active'));
          b.classList.add('filter-btn--active');
          drawPane.hidden = m !== 'draw'; uploadPane.hidden = m !== 'upload';
        } }, label);
        modeBtns.appendChild(b);
      });

      async function saveSignature() {
        if (!pw1.value) return ui.toast('Enter your account password to confirm.', 'error');
        try {
          let res;
          if (mode === 'draw') {
            const dataUrl = drawPad.value();
            if (!dataUrl) return ui.toast('Draw your signature first.', 'error');
            res = await api.post('/me/signature', { password: pw1.value, dataUrl });
          } else {
            if (!file.files[0]) return ui.toast('Choose an image file first.', 'error');
            const fd = new FormData();
            fd.append('password', pw1.value);
            fd.append('file', file.files[0]);
            res = await api.post('/me/signature', fd);
          }
          user = res.user; auth.set(user);
          pw1.value = ''; drawPad.clear(); file.value = '';
          paintStatus(); paintCurrent();
          ui.toast('Signature saved. Documents you signed before keep the signature they were signed with.', 'success', 5000);
        } catch (e) { ui.toast(e.offline ? 'Saving a signature needs an internet connection.' : e.message, 'error'); }
      }

      container.appendChild(el('section', { class: 'card' }, [
        el('h2', { class: 'card__title' }, 'Signature'),
        current, modeBtns, drawPane, uploadPane,
        ui.field('Confirm with your password', pw1),
        el('div', { class: 'card__actions' }, [el('button', { class: 'btn btn--primary', onclick: saveSignature }, 'Save Signature')])
      ]));

      // ── Signing PIN ──
      const pw2 = el('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Your account password' });
      const pinA = el('input', { type: 'password', inputmode: 'numeric', maxlength: '8', autocomplete: 'new-password', placeholder: '4 to 8 digits' });
      const pinB = el('input', { type: 'password', inputmode: 'numeric', maxlength: '8', autocomplete: 'new-password', placeholder: 'Repeat the PIN' });
      async function savePin() {
        if (pinA.value !== pinB.value) return ui.toast('The PINs do not match.', 'error');
        try {
          const res = await api.post('/me/signing-pin', { password: pw2.value, pin: pinA.value });
          user = res.user; auth.set(user);
          pw2.value = pinA.value = pinB.value = '';
          paintStatus();
          ui.toast('Signing PIN saved.', 'success');
        } catch (e) { ui.toast(e.offline ? 'Setting a PIN needs an internet connection.' : e.message, 'error'); }
      }
      container.appendChild(el('section', { class: 'card' }, [
        el('h2', { class: 'card__title' }, 'Signing PIN'),
        el('p', { class: 'muted' }, 'You type this PIN every time you sign, so nobody can sign in your name on a computer you left signed in. Keep it private. After 5 wrong attempts, signing locks for 15 minutes.'),
        el('div', { class: 'form-grid' }, [ui.field('Account password', pw2), ui.field('New PIN', pinA), ui.field('Repeat PIN', pinB)]),
        el('div', { class: 'card__actions' }, [el('button', { class: 'btn btn--primary', onclick: savePin }, user.hasSigningPin ? 'Change PIN' : 'Set PIN')])
      ]));
    }
  };
})();
