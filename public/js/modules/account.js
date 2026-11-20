/*
 * modules/account.js — "My Account": the signed in user's details and
 * changing their own password.
 */
(function () {
  window.App = window.App || {};
  window.App.modules = window.App.modules || {};

  window.App.modules.account = {
    async render(container, ctx) {
      const { ui, api, auth, workflow } = ctx;
      const el = ui.el;
      const user = await auth.refresh().catch(() => auth.current());

      container.appendChild(el('div', { class: 'page-head' }, [
        el('h1', null, 'My Account'),
        el('p', { class: 'muted' }, 'Your account details and password.')
      ]));

      const row = (k, v) => el('div', { class: 'kv' }, [el('div', { class: 'kv__k' }, k), el('div', { class: 'kv__v' }, v || '—')]);
      container.appendChild(el('section', { class: 'card' }, [
        el('h2', { class: 'card__title' }, 'Details'),
        el('div', { class: 'kv-list' }, [
          row('Name', [user.title, user.fullName].filter(Boolean).join(' ')),
          row(user.kind === 'personal' ? 'Sign in (PSN)' : 'Username', user.username),
          row('Email', user.email || (user.kind === 'personal' ? 'Not set. Add one below to receive notifications and reset a forgotten password by email.' : 'Not set. Ask the administrator to add one so you can reset a forgotten password by email.')),
          row('Role', user.kind === 'personal' ? 'Personal staff account' : user.role === 'admin' ? 'Administrator' : 'Unit User'),
          row('Signs as', (user.signerRoles || []).map(r => workflow.roleLabel(r)).join(', ')),
          row('Last sign in', ui.fmtDate(user.lastLoginAt))
        ])
      ]));

      // A personal staff account adds or changes its own email.
      if (user.kind === 'personal') {
        const email = el('input', { type: 'email', value: user.email || '', placeholder: 'you@example.com', autocomplete: 'email' });
        const pass = el('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Your password' });
        container.appendChild(el('section', { class: 'card' }, [
          el('h2', { class: 'card__title' }, 'My Email'),
          el('p', { class: 'muted' }, 'With an email you receive notifications (such as a leave approval) and can reset a forgotten password yourself. Leave it empty to remove it.'),
          el('div', { class: 'form-grid' }, [ui.field('Email', email), ui.field('Your password (to confirm)', pass)]),
          el('div', { class: 'dash-links' }, [el('button', { class: 'btn btn--primary', onclick: async () => {
            try {
              const r = await api.patch('/me/email', { email: email.value.trim(), password: pass.value });
              ctx.auth.set(r.user); ui.toast(r.user.email ? 'Email saved.' : 'Email removed.', 'success'); window.App.router.loadModule('account');
            } catch (e) { ui.toast(e.message, 'error'); }
          } }, 'Save Email')])
        ]));
      }

      // Email alerts
      const alerts = el('input', { type: 'checkbox' });
      alerts.checked = user.emailAlerts;
      let why = '';
      if (!user.email) why = user.kind === 'personal' ? 'Add your email above to receive alerts.' : 'Add an email address (ask the administrator) to receive alerts.';
      else if (user.emailAlertsBlocked) why = 'The administrator has switched email alerts off for your account.';
      alerts.disabled = !!why;
      alerts.addEventListener('change', async () => {
        try {
          await api.patch('/me/preferences', { emailAlerts: alerts.checked });
          ui.toast(alerts.checked ? 'Email alerts on.' : 'Email alerts off. You will still see notifications in the app.', 'success');
        } catch (e) { alerts.checked = !alerts.checked; ui.toast(e.offline ? 'This needs an internet connection.' : e.message, 'error'); }
      });
      container.appendChild(el('section', { class: 'card' }, [
        el('h2', { class: 'card__title' }, 'Email Alerts'),
        el('label', { class: 'check check--plain' }, [alerts, ' Email me when a form is waiting for my signature, and when forms I submitted are approved, returned or revoked']),
        why ? el('p', { class: 'muted' }, why) : null
      ]));

      const current = el('input', { type: 'password', autocomplete: 'current-password' });
      const p1 = el('input', { type: 'password', autocomplete: 'new-password' });
      const p2 = el('input', { type: 'password', autocomplete: 'new-password' });
      async function save() {
        if (!current.value) return ui.toast('Enter your current password.', 'error');
        if (p1.value !== p2.value) return ui.toast('The new passwords do not match.', 'error');
        try {
          await auth.changePassword(current.value, p1.value);
          current.value = p1.value = p2.value = '';
          ui.toast('Password changed. You have been signed out on your other computers.', 'success', 5000);
        } catch (e) { ui.toast(e.offline ? 'Changing your password needs an internet connection.' : e.message, 'error'); }
      }
      container.appendChild(el('section', { class: 'card' }, [
        el('h2', { class: 'card__title' }, 'Change Password'),
        el('p', { class: 'muted' }, 'At least 8 characters, with letters and numbers. Changing it signs you out on every other computer.'),
        el('div', { class: 'form-grid' }, [
          ui.field('Current password', current),
          el('div'),
          ui.field('New password', p1),
          ui.field('Confirm new password', p2)
        ]),
        el('div', { class: 'card__actions' }, [el('button', { class: 'btn btn--primary', onclick: save }, 'Change Password')])
      ]));
    }
  };
})();
