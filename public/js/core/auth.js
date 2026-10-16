/*
 * core/auth.js — the signed in user.
 * The server keeps the session (an httpOnly cookie); the browser only keeps
 * a copy of the user's profile so screens can decide which buttons to show.
 * The server checks every action again, so editing this copy grants nothing.
 * The copy is kept in localStorage so the app can still open offline.
 */
(function () {
  window.App = window.App || {};
  const api = () => window.App.api;
  const KEY = 'gshc_user';
  let _user = null;

  function remember(user) {
    _user = user;
    try { if (user) localStorage.setItem(KEY, JSON.stringify(user)); else localStorage.removeItem(KEY); } catch (e) { /* storage blocked */ }
  }

  function cached() {
    try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; }
  }

  // Returns { user, offline }. user is null when not signed in.
  async function restore() {
    try {
      const { user } = await api().get('/auth/me');
      remember(user);
      return { user, offline: false };
    } catch (e) {
      if (e.offline) { _user = cached(); return { user: _user, offline: true }; }
      remember(null);
      return { user: null, offline: false };
    }
  }

  async function login(username, password) {
    const previous = cached();
    const { user } = await api().post('/auth/login', { username, password });
    if (previous && previous.id !== user.id) await clearCaches();
    remember(user);
    return user;
  }

  async function logout() {
    try { await api().post('/auth/logout'); } catch (e) { /* offline: the session expires on its own */ }
    remember(null);
    await clearCaches();
  }

  async function changePassword(currentPassword, newPassword) {
    const { user } = await api().post('/auth/change-password', { currentPassword, newPassword });
    remember(user);
    return user;
  }

  async function refresh() {
    const { user } = await api().get('/auth/me');
    remember(user);
    return user;
  }

  // Cached API answers belong to whoever was signed in; drop them.
  async function clearCaches() {
    if (!('caches' in window)) return;
    try { await caches.delete('gshc-api'); } catch (e) { /* ignore */ }
  }

  window.App.auth = { restore, login, logout, changePassword, refresh, current: () => _user, set: remember };
})();
