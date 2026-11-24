/*
 * src/middleware/auth.js — every permission is checked here, on the server.
 * The session holds only the user id; the user is reloaded on each request
 * so a changed privilege or a deactivated account takes effect at once.
 */
const { User } = require('../models');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function loadUser(req, res, next) {
  try {
    req.user = null;
    if (req.session && req.session.userId) {
      const user = await User.findById(req.session.userId);
      if (user && user.active) req.user = user;
      else req.session.userId = null;
    }
    next();
  } catch (e) { next(e); }
}

function requireLogin(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'Please sign in.'));
  // Until the first password change, only the password and session routes work.
  if (req.user.mustChangePassword && !req.allowWithTempPassword) {
    return next(new HttpError(403, 'You must change your password before continuing.'));
  }
  next();
}

function allowTempPassword(req, res, next) { req.allowWithTempPassword = true; next(); }

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return next(new HttpError(403, 'Administrator access required.'));
  next();
}

const isAdmin = (user) => !!user && user.role === 'admin';

// Unit access: admins and users with no unit restriction reach every unit,
// except the Directorate of Personnel (staff records), which only those
// given it in Settings, Users, can open.
// Roles held only for the cash flow (the CJ's aide, the DCR Admin and
// Finance, the Accountant) give no unit: such a person reaches a unit only
// when it is given to them in Settings, Users.
const CLOSED_UNITS = ['personnel'];
const OFFICE_ROLES = ['cj_aide', 'dcr_admin_finance', 'accountant'];
const unitRoles = (user) => (user.signerRoles || []).filter(r => !OFFICE_ROLES.includes(r));
function canAccessUnit(user, unitKey) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  if (CLOSED_UNITS.includes(unitKey)) return user.unitKeys.includes(unitKey);
  return !user.unitKeys.length ? unitRoles(user).length > 0 : user.unitKeys.includes(unitKey);
}

function can(user, action) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  return user.privileges.includes(action);
}

// Browsers will not send a custom header on a cross site request without a
// CORS preflight, which this server never approves. Requiring it on every
// state changing call blocks cross site request forgery.
function requireAppHeader(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'GSHC') return next(new HttpError(403, 'Request rejected.'));
  next();
}

module.exports = { OFFICE_ROLES, unitRoles, HttpError, loadUser, requireLogin, allowTempPassword, requireAdmin, isAdmin, canAccessUnit, can, requireAppHeader };
