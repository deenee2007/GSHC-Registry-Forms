/*
 * core/notices.js — the notifications bell in the header.
 *
 * The bell shows how many notifications are unread. Clicking it opens a
 * panel that scrolls, newest first, unread ones marked: clicking one marks
 * it read and opens what it is about (the document, the case screen or
 * leave). "Mark all as read" and "Clear all" act on the whole list; ✕ clears
 * one. The number is refreshed with the menu badges (every minute and after
 * each action).
 */
(function () {
  window.App = window.App || {};
  const ui = () => window.App.ui;
  const api = () => window.App.api;

  const KIND = { submitted: 'For signature', approved: 'Approved', signed: 'Signed', returned: 'Returned', revoked: 'Revoked', case: 'Case', leave: 'Leave' };
  let bell = null, badge = null, panel = null, open = false;

  // What a notification is about: its document, or the screen of its case or leave.
  async function follow(n) {
    const router = window.App.router;
    if (n.record) return window.App.workflow.openDocument(n.record);
    if (n.kind === 'leave') return router.loadModule('leave');
    if (n.kind === 'case' && n.link) {
      const units = await router.units();
      if (n.link === 'assign' || n.link.startsWith('assign:')) return router.loadModule('assign', n.link === 'assign' ? {} : { tab: n.link.slice(7) });
      if (n.link.startsWith('register:')) { const u = units.find(x => x.key === n.link.slice(9)); if (u) router.loadModule('caseRegister', { unit: u }); return; }
      const u = units.find(x => x.type === 'process'); if (u) router.loadUnit(u);
    }
  }

  function setCount(n) {
    if (!badge) return;
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.hidden = !n;
    bell.setAttribute('aria-label', n ? `Notifications, ${n} unread` : 'Notifications');
  }

  function close() {
    open = false;
    if (panel) panel.hidden = true;
    if (bell) bell.setAttribute('aria-expanded', 'false');
  }

  async function render() {
    const el = ui().el;
    let data;
    try { data = await api().get('/notifications'); }
    catch (e) { panel.replaceChildren(el('div', { class: 'notice-panel__empty' }, e.offline ? 'Notifications are not available offline.' : e.message)); return; }
    setCount(data.unread);
    const list = el('div', { class: 'notice-panel__list' });
    if (!data.notifications.length) list.appendChild(el('div', { class: 'notice-panel__empty' }, 'No notifications.'));
    data.notifications.forEach(n => {
      const clear = el('button', { class: 'notice-item__clear', type: 'button', title: 'Clear this notification', 'aria-label': 'Clear this notification', onclick: async (e) => {
        e.stopPropagation();
        try { await api().post('/notifications/clear', { ids: [n.id] }); } catch (err) { ui().toast(err.message, 'error'); return; }
        render(); window.App.router.refreshBadges();
      } }, '✕');
      list.appendChild(el('div', { class: 'notice-item' + (n.read ? '' : ' notice-item--unread'), role: 'button', tabindex: '0', onclick: go, onkeydown: (e) => { if (e.key === 'Enter') go(); } }, [
        el('div', { class: 'notice-item__head' }, [el('span', { class: 'notice-item__kind notice-item__kind--' + n.kind }, KIND[n.kind] || n.kind), clear]),
        el('div', { class: 'notice-item__msg' }, n.message),
        el('div', { class: 'notice-item__time' }, ui().fmtDate(n.createdAt))
      ]));
      async function go() {
        close();
        if (!n.read) { await api().post('/notifications/read', { ids: [n.id] }).catch(() => {}); window.App.router.refreshBadges(); }
        follow(n);
      }
    });
    const any = data.notifications.length > 0;
    panel.replaceChildren(
      el('div', { class: 'notice-panel__head' }, [el('strong', null, 'Notifications'), data.unread ? el('span', { class: 'notice-panel__new' }, `${data.unread} New`) : null]),
      list,
      any ? el('div', { class: 'notice-panel__foot' }, [
        data.unread ? el('button', { class: 'btn btn--ghost btn--small', type: 'button', onclick: async () => {
          await api().post('/notifications/read', { all: true }).catch(e => ui().toast(e.message, 'error'));
          render(); window.App.router.refreshBadges();
        } }, 'Mark all as read') : el('span'),
        el('button', { class: 'btn btn--ghost btn--small', type: 'button', onclick: async () => {
          if (!confirm(`Clear all ${data.notifications.length} notification(s)? They are removed from this list for good.`)) return;
          await api().post('/notifications/clear', { all: true }).catch(e => ui().toast(e.message, 'error'));
          render(); window.App.router.refreshBadges();
        } }, 'Clear all')
      ]) : null
    );
  }

  function toggle() {
    open = !open;
    panel.hidden = !open;
    bell.setAttribute('aria-expanded', String(open));
    if (open) { panel.replaceChildren(ui().el('div', { class: 'notice-panel__empty' }, 'Loading…')); render(); }
  }

  // The bell button and its panel, for the header.
  function mount() {
    const el = ui().el;
    badge = el('span', { class: 'appbar__count', hidden: 'hidden' }, '');
    bell = el('button', { class: 'appbar__icon', type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-label': 'Notifications', title: 'Notifications', onclick: (e) => { e.stopPropagation(); window.App.notices.closeMenus(); toggle(); } }, ['🔔', badge]);
    panel = el('div', { class: 'notice-panel', hidden: 'hidden', onclick: (e) => e.stopPropagation() });
    document.addEventListener('click', () => { if (open) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) close(); });
    return el('div', { class: 'appbar__bell' }, [bell, panel]);
  }

  window.App.notices = { mount, setCount, close, follow, closeMenus: () => {} };
})();
