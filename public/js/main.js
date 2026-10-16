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

    root.appendChild(ui.el('div', { class: 'login' }, [
      ui.el('div', { class: 'login__card' }, [
        ui.el('img', { class: 'login__emblem', src: '/assets/highcourt.png', alt: '' }),
        ui.el('h1', { class: 'login__title' }, 'Gombe State High Court of Justice'),
        ui.el('p', { class: 'login__sub' }, 'Registry & Units Forms Automation System'),
        username, password, msg, btn,
        ui.el('p', { class: 'login__foot' }, 'Directorate of ICT')
      ])
    ]));
    username.focus();
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
    root.appendChild(ui.el('div', { class: 'login' }, [
      ui.el('div', { class: 'login__card' }, [
        ui.el('h1', { class: 'login__title' }, 'Set Your Password'),
        ui.el('p', { class: 'login__sub' }, 'Choose a new password of at least 8 characters, with letters and numbers.'),
        p1, p2, msg,
        ui.el('button', { class: 'btn btn--primary btn--block', onclick: submit }, 'Save Password')
      ])
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
    const { user, offline } = await App.auth.restore();
    if (!user) return loginScreen(offline ? 'You are offline. Connect to the internet to sign in.' : '');
    if (user.mustChangePassword && !offline) return loginScreen('Please sign in again to set your new password.', false);
    startApp(offline);
  }

  boot();
})();
