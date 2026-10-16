/*
 * main.js — application bootstrap
 * Order of operations: open DB -> seed units & admin on first run ->
 * show login -> on success build the app shell and hand off to the router.
 */
(function () {
  // ── Permanently remove service worker and all caches ──
  // This app is served by a local Node server that is always running,
  // so a service worker adds no value and only causes stale-file problems.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(r => r.unregister()));
    caches.keys().then(keys => keys.forEach(k => caches.delete(k)));
  }
  const App = window.App;
  const ui = App.ui;

  // The units this deployment ships with. First run seeds them once.
  const SEED_UNITS = [
    ...Array.from({ length: 9 }, (_, i) => ({ key: 'hc' + (i + 1), type: 'registry', name: `High Court ${i + 1} Registry`, courtNo: i + 1 })),
    { key: 'appeals', type: 'appeals', name: 'Appeals Registry' },
    { key: 'execution', type: 'execution', name: 'Execution / Bailiffs Unit' }
  ];

  async function seedUnits() {
    const existing = await App.db.getAll('units');
    if (existing.length === 0) {
      for (const u of SEED_UNITS) await App.db.put('units', u);
    }
  }

  const root = document.getElementById('app');

  function loginScreen(message) {
    ui.clear(root);
    const username = ui.el('input', { type: 'text', placeholder: 'Username', autocomplete: 'username' });
    const password = ui.el('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
    const msg = ui.el('p', { class: 'login__msg' }, message || '');

    async function submit() {
      try {
        const session = await App.auth.login(username.value, password.value);
        if (session.mustChangePassword) return changePasswordScreen(session);
        appShell();
      } catch (e) { msg.textContent = e.message; }
    }
    password.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });

    root.appendChild(ui.el('div', { class: 'login' }, [
      ui.el('div', { class: 'login__card' }, [
        ui.el('div', { class: 'login__crest' }, '⚖'),
        ui.el('h1', { class: 'login__title' }, 'Gombe State High Court of Justice'),
        ui.el('p', { class: 'login__sub' }, 'Registry & Units Forms Automation System'),
        username, password, msg,
        ui.el('button', { class: 'btn btn--primary btn--block', onclick: submit }, 'Sign In'),
        ui.el('p', { class: 'login__foot' }, 'Directorate of ICT')
      ])
    ]));
  }

  function changePasswordScreen(session) {
    ui.clear(root);
    const p1 = ui.el('input', { type: 'password', placeholder: 'New password' });
    const p2 = ui.el('input', { type: 'password', placeholder: 'Confirm new password' });
    const msg = ui.el('p', { class: 'login__msg' }, '');
    async function submit() {
      if (p1.value.length < 4) return msg.textContent = 'Password too short.';
      if (p1.value !== p2.value) return msg.textContent = 'Passwords do not match.';
      await App.auth.changePassword(session.id, p1.value);
      appShell();
    }
    root.appendChild(ui.el('div', { class: 'login' }, [
      ui.el('div', { class: 'login__card' }, [
        ui.el('h1', { class: 'login__title' }, 'Set Your Password'),
        ui.el('p', { class: 'login__sub' }, 'You must change your password before continuing.'),
        p1, p2, msg,
        ui.el('button', { class: 'btn btn--primary btn--block', onclick: submit }, 'Save Password')
      ])
    ]));
  }

  function appShell() {
    ui.clear(root);
    const user = App.auth.current();
    const nav = ui.el('nav', { class: 'sidebar__nav' });
    const content = ui.el('main', { class: 'content' });
    const footer = ui.el('footer', { class: 'app-footer' },
      `© ${new Date().getFullYear()} Directorate of ICT · Gombe State High Court of Justice`);

    const shell = ui.el('div', { class: 'shell' }, [
      ui.el('aside', { class: 'sidebar' }, [
        ui.el('div', { class: 'sidebar__brand' }, [ui.el('span', { class: 'sidebar__crest' }, '⚖'), ui.el('span', null, 'GSHC Registry')]),
        nav,
        ui.el('div', { class: 'sidebar__user' }, [
          ui.el('div', { class: 'sidebar__name' }, user.fullName),
          ui.el('div', { class: 'sidebar__role muted' }, user.role === 'admin' ? 'Administrator' : 'Unit User'),
          ui.el('button', { class: 'btn btn--ghost btn--small', onclick: () => { App.auth.logout(); loginScreen('Signed out.'); } }, 'Sign Out')
        ])
      ]),
      content,
      footer
    ]);
    root.appendChild(shell);
    App.router.mount(nav, content);
  }

  async function boot() {
    await App.db.open();
    await seedUnits();
    await App.auth.ensureSeedAdmin();
    const session = App.auth.current();
    if (session) { session.mustChangePassword ? changePasswordScreen(session) : appShell(); }
    else loginScreen('Default first login — username: admin, password: admin');
  }

  boot();
})();
