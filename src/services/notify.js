/*
 * src/services/notify.js — in app notifications (the dashboard badge).
 */
const { Notification } = require('../models');

async function notify(userIds, kind, record, message) {
  const ids = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean).map(String))];
  if (!ids.length) return;
  await Notification.insertMany(ids.map(user => ({ user, kind, record: record._id, message })));
}

module.exports = { notify };
