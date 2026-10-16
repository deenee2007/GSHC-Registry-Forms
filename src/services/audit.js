/*
 * src/services/audit.js — append only history of who did what.
 */
const { AuditLog } = require('../models');

async function log(req, action, { record, unitKey, details } = {}) {
  const user = req && req.user;
  await AuditLog.create({
    user: user ? user._id : undefined,
    username: user ? user.username : undefined,
    action,
    record: record ? record._id : undefined,
    unitKey: unitKey || (record && record.unitKey) || undefined,
    details,
    ip: req ? req.ip : undefined
  });
}

module.exports = { log };
