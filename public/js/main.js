/*
 * main.js — application bootstrap.
 * Restore the session from the server (or the cached profile when offline),
 * show sign in or the app, and keep offline drafts syncing.
 */
(function () {
  const App = window.App;
  const ui = App.ui;
  const root = document.getElementById('app');

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }

  function loginScreen(message, isError) {
    ui.clear(root);
    const username = ui.el('input', { type: 'text', placeholder: 'Username', autocomplete: 'username', autocapitalize: 'none' });
    const password = ui.el('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
    const msg = ui.el('p', { class: 'login__msg' + (isError === false ? ' login__msg--info' : '') }, message || '');
    const btn = ui.el('button', { class: 'btn btn--primary btn--block', onclick: submit }, 'Sign In');

    async function submit() {
      msg.className = 'login__msg';
      msg.textContent = '';
      btn.disabled = true;
      try {
        const user = await App.auth.login(username.value, password.value);
        if (user.mustChangePassword) return changePasswordScreen(password.value);
        startApp(false);
      } catch (e) {
        msg.textContent = e.message;
      } finally { btn.disabled = false; }
    }
    [username, password].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); }));

    const forgot = ui.el('button', { class: 'login__link', type: 'button', hidden: 'hidden', onclick: () => forgotScreen(username.value) }, 'Forgot password?');
    App.api.get('/auth/options').then(o => { if (o.forgotPassword) forgot.hidden = false; }).catch(() => {});

    root.appendChild(card([
      ui.el('img', { class: 'login__emblem', src: '/assets/highcourt.png', alt: '' }),
      ui.el('h1', { class: 'login__title' }, 'Gombe State High Court of Justice'),
      ui.el('p', { class: 'login__sub' }, 'Registry & Units Forms Automation System'),
      username, password, msg, btn, forgot,
      ui.el('p', { class: 'login__foot' }, 'Directorate of ICT')
    ]));
    username.focus();
  }

  function card(children) {
    return ui.el('div', { class: 'login' }, [ui.el('div', { class: 'login__card' }, children)]);
  }

  // Ask for a reset link by email.
  function forgotScreen(prefill) {
    ui.clear(root);
    const who = ui.el('input', { type: 'text', placeholder: 'Username or email address', autocomplete: 'username', autocapitalize: 'none' });
    who.value = prefill || '';
    const msg = ui.el('p', { class: 'login__msg' }, '');
    const btn = ui.el('button', { class: 'btn btn--primary btn--block', onclick: submit }, 'Send Reset Link');
    async function submit() {
      msg.className = 'login__msg'; msg.textContent = '';
      btn.disabled = true;
      try {
        const r = await App.api.post('/auth/forgot', { username: who.value });
        msg.className = 'login__msg login__msg--info';
        msg.textContent = r.message;
        btn.hidden = true;
      } catch (e) { msg.textContent = e.message; }
      finally { btn.disabled = false; }
    }
    who.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    root.appendChild(card([
      ui.el('h1', { class: 'login__title' }, 'Forgot Your Password?'),
      ui.el('p', { class: 'login__sub' }, 'Enter your username or the email address on your account. We will email you a link to choose a new password.'),
      who, msg, btn,
      ui.el('button', { class: 'login__link', type: 'button', onclick: () => loginScreen() }, 'Back to sign in')
    ]));
    who.focus();
  }

  // Opened from an invitation or reset email: /reset-password?token=...
  async function resetScreen(token) {
    ui.clear(root);
    const back = () => { history.replaceState(null, '', '/'); loginScreen(); };
    let info = { valid: false };
    try { info = await App.api.get('/auth/reset/' + encodeURIComponent(token)); } catch (e) { /* treated as invalid */ }
    if (!info.valid) {
      root.appendChild(card([
        ui.el('h1', { class: 'login__title' }, 'Link Expired'),
        ui.el('p', { class: 'login__sub' }, 'This link has expired or has already been used. Ask for a new one, or ask the administrator to reset your password.'),
        ui.el('button', { class: 'btn btn--primary btn--block', onclick: () => { history.replaceState(null, '', '/'); forgotScreen(); } }, 'Request a New Link'),
        ui.el('button', { class: 'login__link', type: 'button', onclick: back }, 'Back to sign in')
      ]));
      return;
    }
    const p1 = ui.el('input', { type: 'password', placeholder: 'New password', autocomplete: 'new-password' });
    const p2 = ui.el('input', { type: 'password', placeholder: 'Confirm new password', autocomplete: 'new-password' });
    const msg = ui.el('p', { class: 'login__msg' }, '');
    async function submit() {
      if (p1.value !== p2.value) { msg.textContent = 'Passwords do not match.'; return; }
      try {
        const r = await App.api.post('/auth/reset', { token, newPassword: p1.value });
        history.replaceState(null, '', '/');
        loginScreen(`Password saved. Sign in as ${r.username} with your new password.`, false);
      } catch (e) { msg.textContent = e.message; }
    }
    p2.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    const invite = info.kind === 'invite';
    root.appendChild(card([
      ui.el('h1', { class: 'login__title' }, invite ? 'Welcome, ' + info.fullName : 'Choose a New Password'),
      ui.el('p', { class: 'login__sub' }, `${invite ? 'Choose a password for your account' : 'Choose a new password for'} "${info.username}". At least 8 characters, with letters and numbers.`),
      p1, p2, msg,
      ui.el('button', { class: 'btn btn--primary btn--block', onclick: submit }, 'Save Password'),
      ui.el('button', { class: 'login__link', type: 'button', onclick: back }, 'Back to sign in')
    ]));
    p1.focus();
  }

  function changePasswordScreen(currentPassword) {
    ui.clear(root);
    const p1 = ui.el('input', { type: 'password', placeholder: 'New password', autocomplete: 'new-password' });
    const p2 = ui.el('input', { type: 'password', placeholder: 'Confirm new password', autocomplete: 'new-password' });
    const msg = ui.el('p', { class: 'login__msg' }, '');
    async function submit() {
      if (p1.value !== p2.value) { msg.textContent = 'Passwords do not match.'; return; }
      try {
        await App.auth.changePassword(currentPassword, p1.value);
        startApp(false);
      } catch (e) { msg.textContent = e.message; }
    }
    p2.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    root.appendChild(card([
      ui.el('h1', { class: 'login__title' }, 'Set Your Password'),
      ui.el('p', { class: 'login__sub' }, 'Choose a new password of at least 8 characters, with letters and numbers.'),
      p1, p2, msg,
      ui.el('button', { class: 'btn btn--primary btn--block', onclick: submit }, 'Save Password')
    ]));
    p1.focus();
  }

  function appShell(offline) {
    ui.clear(root);
    const user = App.auth.current();
    const nav = ui.el('nav', { class: 'sidebar__nav' });
    const content = ui.el('main', { class: 'content' });
    const status = ui.el('div', { class: 'sync-status' });
    const footer = ui.el('footer', { class: 'app-footer' },
      `© ${new Date().getFullYear()} Directorate of ICT · Gombe State High Court of Justice`);

    const roleText = user.role === 'admin' ? 'Administrator'
      : (user.signerRoles || []).length ? user.signerRoles.map(r => App.workflow.roleLabel(r)).join(', ') : 'Unit User';

    root.appendChild(ui.el('div', { class: 'shell' }, [
      ui.el('aside', { class: 'sidebar' }, [
        ui.el('div', { class: 'sidebar__brand' }, [ui.el('img', { class: 'sidebar__emblem', src: '/assets/highcourt.png', alt: '' }), ui.el('span', null, 'GSHC Registry')]),
        nav,
        status,
        ui.el('div', { class: 'sidebar__user' }, [
          ui.el('div', { class: 'sidebar__name' }, [user.title, user.fullName].filter(Boolean).join(' ')),
          ui.el('div', { class: 'sidebar__role muted' }, roleText),
          ui.el('button', { class: 'btn btn--ghost btn--small', onclick: signOut }, 'Sign Out')
        ])
      ]),
      content,
      footer
    ]));
    App.router.mount(nav, content, { offline });
    watchConnection(status);
  }

  async function signOut() {
    const waiting = (await App.offline.all()).length;
    if (waiting && !confirm(`${waiting} draft(s) saved offline have not reached the server yet. They stay on this computer and will be sent the next time you sign in here. Sign out?`)) return;
    await App.auth.logout();
    loginScreen('Signed out.', false);
  }

  let syncTimer = null;
  function watchConnection(statusEl) {
    async function paint() {
      const waiting = (await App.offline.all()).length;
      const online = navigator.onLine !== false;
      statusEl.className = 'sync-status ' + (online ? 'sync-status--online' : 'sync-status--offline');
      statusEl.textContent = (online ? '● Online' : '● Offline') +
        (waiting ? ` · ${waiting} draft${waiting > 1 ? 's' : ''} waiting to sync` : '');
    }
    async function trySync() {
      if (navigator.onLine === false) return paint();
      const before = (await App.offline.all()).length;
      if (before) {
        const { sent, failed } = await App.offline.sync();
        if (sent) ui.toast(`${sent} offline draft${sent > 1 ? 's' : ''} sent to the server.`, 'success');
        if (failed) ui.toast(`${failed} offline draft${failed > 1 ? 's' : ''} could not be saved. Open the unit to review.`, 'error');
        if (sent) App.router.refresh();
      }
      paint();
    }
    App.offline.onChange(paint);
    window.addEventListener('online', trySync);
    window.addEventListener('offline', paint);
    clearInterval(syncTimer);
    syncTimer = setInterval(trySync, 60000);
    trySync();
  }

  function startApp(offline) {
    appShell(offline);
    if (offline) ui.toast('You are offline. You can open forms and save drafts; they will sync when the connection returns.', 'info', 6000);
  }

  App.api.onUnauthorized(() => {
    App.auth.set(null);
    loginScreen('Your session has ended. Please sign in again.');
  });

  async function boot() {
    if (location.pathname === '/reset-password') {
      const token = new URLSearchParams(location.search).get('token') || '';
      return resetScreen(token);
    }
    const { user, offline } = await App.auth.restore();
    if (!user) return loginScreen(offline ? 'You are offline. Connect to the internet to sign in.' : '');
    if (user.mustChangePassword && !offline) return loginScreen('Please sign in again to set your new password.', false);
    startApp(offline);
  }

  boot();
})();
