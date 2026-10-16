/*
 * src/routes/notifications.js — the signed in user's notifications.
 */
const express = require('express');
const mongoose = require('mongoose');
const { Notification } = require('../models');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use(requireLogin);

router.get('/', wrap(async (req, res) => {
  const q = { user: req.user._id };
  if (req.query.unread === '1') q.read = false;
  const [items, unread] = await Promise.all([
    Notification.find(q).sort({ createdAt: -1 }).limit(100),
    Notification.countDocuments({ user: req.user._id, read: false })
  ]);
  res.json({
    unread,
    notifications: items.map(n => ({ id: String(n._id), kind: n.kind, record: n.record ? String(n.record) : null, message: n.message, read: n.read, createdAt: n.createdAt }))
  });
}));

// body: { ids: [...] } or { all: true }
router.post('/read', wrap(async (req, res) => {
  const q = { user: req.user._id, read: false };
  if (!req.body.all) q._id = { $in: (req.body.ids || []).filter(id => mongoose.isValidObjectId(id)) };
  const r = await Notification.updateMany(q, { read: true });
  res.json({ updated: r.modifiedCount });
}));

module.exports = router;
