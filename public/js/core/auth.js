/*
 * core/auth.js — authentication & session
 * SHA-256 password hashing via Web Crypto. Session held in memory +
 * sessionStorage so a refresh keeps the user logged in but closing the
 * browser logs them out.
 */
(function () {
  window.App = window.App || {};
  const db = () => window.App.db;

  const SESSION_KEY = 'gshc_session';

  async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // On very first run, create a default admin so setup can begin.
  async function ensureSeedAdmin() {
    const users = await db().getAll('users');
    if (users.length === 0) {
      await db().add('users', {
        username: 'admin',
        fullName: 'System Administrator',
        passwordHash: await sha256('admin'),   // CHANGE ON FIRST LOGIN
        role: 'admin',
        unitKey: null,
        privileges: [],
        mustChangePassword: true,
        createdAt: Date.now()
      });
      return true;
    }
    return false;
  }

  async function login(username, password) {
    const matches = await db().getByIndex('users', 'username', username.trim());
    const user = matches && matches[0];
    if (!user) throw new Error('Unknown username.');
    const hash = await sha256(password);
    if (hash !== user.passwordHash) throw new Error('Incorrect password.');
    const session = {
      id: user.id, username: user.username, fullName: user.fullName,
      role: user.role, unitKey: user.unitKey, privileges: user.privileges || [],
      mustChangePassword: !!user.mustChangePassword
    };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return session;
  }

  function current() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); }
    catch { return null; }
  }

  function logout() {
    sessionStorage.removeItem(SESSION_KEY);
  }

  async function changePassword(userId, newPassword) {
    const user = await db().get('users', userId);
    if (!user) throw new Error('User not found.');
    user.passwordHash = await sha256(newPassword);
    user.mustChangePassword = false;
    await db().put('users', user);
    const sess = current();
    if (sess && sess.id === userId) {
      sess.mustChangePassword = false;
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(sess));
    }
  }

  window.App.auth = { sha256, ensureSeedAdmin, login, current, logout, changePassword };
})();
