/*
 * core/permissions.js — access control
 * A user is either an 'admin' (full access incl. Settings) or a 'user'
 * assigned to ONE unit, with a set of action privileges within it.
 */
(function () {
  window.App = window.App || {};
  const auth = () => window.App.auth;

  // The actions a unit user can be granted. Settings adds/removes these.
  const ACTIONS = ['view', 'create', 'edit', 'finalize', 'delete', 'print'];

  function isAdmin(user) {
    user = user || auth().current();
    return !!user && user.role === 'admin';
  }

  // Can this user open a given unit module at all?
  function canAccessUnit(unitKey, user) {
    user = user || auth().current();
    if (!user) return false;
    if (isAdmin(user)) return true;          // admins can open any unit
    return user.unitKey === unitKey;          // users only their assigned unit
  }

  // Can this user perform a specific action within their unit?
  function can(action, user) {
    user = user || auth().current();
    if (!user) return false;
    if (isAdmin(user)) return true;
    return (user.privileges || []).includes(action);
  }

  window.App.permissions = { ACTIONS, isAdmin, canAccessUnit, can };
})();
