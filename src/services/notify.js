/*
 * src/services/notify.js — tells people when something needs them: an in
 * app notification (the badges) and, where allowed, an email.
 *
 * An email goes only when all of these hold: email is set up on the server,
 * the administrator has not switched alerts off for everyone or for that
 * user, the user has not switched them off, and the user has an address.
 */
const { Notification, User } = require('../models');
const mail = require('./mail');
const settings = require('./settings');
const verification = require('./verification');

const SUBJECTS = {
  submitted: 'For your signature',
  approved: 'Approved and ready to print',
  signed: 'Signed, waiting for other signatures',
  returned: 'Returned with comments',
  revoked: 'Revoked'
};

async function emailUsers(ids, kind, record, message, req) {
  if (!mail.enabled() || !(await settings.get()).emailAlerts) return;
  const users = await User.find({ _id: { $in: ids }, active: true, emailAlerts: { $ne: false }, emailAlertsBlocked: { $ne: true }, email: { $type: 'string' } });
  const link = req ? verification.baseUrl(req) + '/' : '';
  const label = record.ref ? ` · ${record.ref}` : '';
  await Promise.allSettled(users.map(u => mail.send({
    to: u.email, name: u.fullName,
    ...mail.alertMessage(u, `${SUBJECTS[kind] || 'Update'}${label}`, message, link)
  }).catch(e => console.error(`Alert email to ${u.username} failed: ${e.message}`))));
}

async function notify(userIds, kind, record, message, req) {
  const ids = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean).map(String))];
  if (!ids.length) return;
  await Notification.insertMany(ids.map(user => ({ user, kind, record: record._id, message })));
  try { await emailUsers(ids, kind, record, message, req); }
  catch (e) { console.error('Alert emails failed:', e.message); } // never block the workflow
}

module.exports = { notify };
