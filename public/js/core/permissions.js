/*
 * core/permissions.js — decides which buttons to show. The server makes
 * the real decision on every request; these mirror its rules.
 */
(function () {
  window.App = window.App || {};
  const auth = () => window.App.auth;

  const ACTIONS = ['view', 'create', 'edit', 'finalize', 'delete', 'print', 'reports'];

  function isAdmin(user) {
    user = user || auth().current();
    return !!user && user.role === 'admin';
  }

  function canAccessUnit(unitKey, user) {
    user = user || auth().current();
    if (!user) return false;
    if (isAdmin(user)) return true;
    if (!user.unitKeys.length) return user.signerRoles.length > 0;
    return user.unitKeys.includes(unitKey);
  }

  function can(action, user) {
    user = user || auth().current();
    if (!user) return false;
    if (isAdmin(user)) return true;
    return (user.privileges || []).includes(action);
  }

  function isSigner(user) {
    user = user || auth().current();
    return !!user && (user.signerRoles || []).length > 0;
  }

  window.App.permissions = { ACTIONS, isAdmin, canAccessUnit, can, isSigner };
})();
