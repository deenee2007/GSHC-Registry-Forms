/*
 * src/routes/leave.js — applications for leave.
 *
 *   applied ──Staff Officer forwards──▶ Director Personnel approves ──▶ approved
 *                                       (senior officers: recommends ──▶ Chief Registrar approves)
 *   any step may decline it; the officer may withdraw it while it is pending.
 *
 * An application is made from the officer's record on the Nominal Roll: by
 * the officer, when their sign in account is linked to the record, or by
 * the registry (Nominal Roll: edit) for them. The days are checked against
 * what is left for the year. Each step is signed with the PIN; the final
 * approval gives the approval letter, with its reference, and an entry in
 * the record of service. The leave roster shows who is away on a day.
 */
const express = require('express');
const mongoose = require('mongoose');
const { Leave, Staff, User, Notification } = require('../models');
const leaveSvc = require('../services/leave');
const personnel = require('../services/personnel');
const store = require('../services/signatureStore');
const audit = require('../services/audit');
const mail = require('../services/mail');
const settings = require('../services/settings');
const { verifyPin } = require('./me');
const { HttpError, requireLogin, isAdmin } = require('../middleware/auth');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use(requireLogin);

const ROLES = ['staff_officer', 'director_personnel', 'chief_registrar', 'chief_judge'];
const canEditRoll = (u) => isAdmin(u) || u.privileges.includes('personnel_edit');
const canViewRoll = (u) => canEditRoll(u) || u.privileges.includes('personnel_view');
const myRoles = (u) => u.signerRoles.filter(r => ROLES.includes(r));
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);
const long = (d) => d ? new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
const meta = () => mongoose.connection.collection('appmeta');
const isOwn = (u, staff) => !!staff && !!staff.user && String(staff.user) === String(u._id);
const ownStaff = (u) => Staff.findOne({ user: u._id });

function canSee(u, l, own) {
  return canViewRoll(u) || own || l.steps.some(s => u.signerRoles.includes(s.role));
}
function serialize(l, u, own) {
  const step = l.steps.find(s => s.status === 'waiting');
  return {
    id: String(l._id), staffId: String(l.staff), psn: l.psn, name: l.name, rank: l.rank, gl: l.gl, station: l.station,
    type: l.type, typeName: l.typeName, year: l.year, from: l.from, to: l.to, resume: l.resume, days: l.days, working: l.working,
    reason: l.reason, address: l.address, phone: l.phone, relief: l.relief, status: l.status, reference: l.reference || '',
    steps: l.steps.map(s => ({ role: s.role, label: s.label, action: s.action, status: s.status, byName: s.byName || '', title: s.title || '', at: s.at, comment: s.comment || '' })),
    waiting: step ? { role: step.role, label: step.label, action: step.action } : null,
    canAct: !!step && u.signerRoles.includes(step.role) && !own,
    canWithdraw: l.status === 'pending' && (own || canEditRoll(u)),
    appliedByName: l.appliedByName, forSelf: !!l.forSelf, createdAt: l.createdAt,
    signatureUrl: l.status === 'approved' ? `/api/leave/${l._id}/signature` : null
  };
}
async function load(id, u) {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'Application not found.');
  const l = await Leave.findById(id);
  if (!l) throw new HttpError(404, 'Application not found.');
  const staff = await Staff.findById(l.staff, 'user');
  const own = isOwn(u, staff);
  if (!canSee(u, l, own)) throw new HttpError(403, 'You do not have access to this application.');
  return { l, own };
}

// In app notices, and an email where the person allows alerts.
async function tell(users, message, link, subject) {
  const list = users.filter(Boolean);
  if (!list.length) return;
  await Notification.insertMany(list.map(x => ({ user: x._id, kind: 'leave', link, message })));
  try {
    if (!mail.enabled() || !(await settings.get()).emailAlerts) return;
    await Promise.allSettled(list.filter(x => x.email && x.emailAlerts !== false && !x.emailAlertsBlocked)
      .map(x => mail.send({ to: x.email, name: x.fullName, ...mail.alertMessage(x, subject, message, '') })));
  } catch (e) { console.error('Leave alert emails failed:', e.message); }
}
const holders = (role, not) => User.find({ active: true, signerRoles: role, ...(not ? { _id: { $nin: not } } : {}) });

// Days used (approved) and asked for (pending) of each kind in a year.
async function balances(staff, year, s, except) {
  const list = await Leave.find({ staff: staff._id, year, status: { $in: ['approved', 'pending'] }, ...(except ? { _id: { $ne: except } } : {}) }, 'type days status').lean();
  return s.types.filter(t => leaveSvc.offered(t, staff)).map(t => {
    const allowed = leaveSvc.allowed(t, staff, s);
    const used = list.filter(x => x.type === t.key && x.status === 'approved').reduce((n, x) => n + x.days, 0);
    const pending = list.filter(x => x.type === t.key && x.status === 'pending').reduce((n, x) => n + x.days, 0);
    return { key: t.key, name: t.name, working: t.working, allowed, used, pending, left: allowed ? Math.max(0, allowed - used - pending) : null };
  });
}

router.get('/settings', wrap(async (req, res) => {
  const s = await leaveSvc.getSettings();
  res.json({ ...s, me: { roles: myRoles(req.user), viewRoll: canViewRoll(req.user), editRoll: canEditRoll(req.user), admin: isAdmin(req.user), hasRecord: !!(await Staff.exists({ user: req.user._id })) } });
}));
router.put('/settings', wrap(async (req, res) => {
  if (!isAdmin(req.user)) throw new HttpError(403, 'Only an administrator changes the leave settings.');
  const s = await leaveSvc.setSettings(req.body || {});
  await audit.log(req, 'leave_settings_changed', { details: { types: s.types.length } });
  res.json(s);
}));

// Applications waiting for this person's step: for the menu badge.
router.get('/counts', wrap(async (req, res) => {
  const roles = myRoles(req.user);
  if (!roles.length) return res.json({ waiting: 0 });
  const own = await ownStaff(req.user);
  res.json({ waiting: await Leave.countDocuments({ status: 'pending', waitingRole: { $in: roles }, ...(own ? { staff: { $ne: own._id } } : {}) }) });
}));

// The officer's own record (when linked), balances and applications.
router.get('/me', wrap(async (req, res) => {
  const staff = await ownStaff(req.user);
  if (!staff) return res.json({ staff: null });
  const s = await leaveSvc.getSettings();
  const year = Number(req.query.year) || new Date().getFullYear();
  const list = await Leave.find({ staff: staff._id }).sort({ from: -1 }).limit(200);
  res.json({ staff: { id: String(staff._id), name: staff.name, psn: staff.psn, rank: staff.rank, gl: staff.gl, station: staff.station, retiresOn: staff.retiresOn, retiresBy: staff.retiresBy },
    year, balances: await balances(staff, year, s), leaves: list.map(l => serialize(l, req.user, true)) });
}));

router.get('/balance/:staffId', wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.staffId)) throw new HttpError(404, 'Staff record not found.');
  const staff = await Staff.findById(req.params.staffId);
  if (!staff) throw new HttpError(404, 'Staff record not found.');
  if (!canViewRoll(req.user) && !isOwn(req.user, staff)) throw new HttpError(403, 'You do not have access to this record.');
  const year = Number(req.query.year) || new Date().getFullYear();
  res.json({ year, balances: await balances(staff, year, await leaveSvc.getSettings()) });
}));

// Lists: waiting for my step, all (the Directorate), or one officer's.
router.get('/', wrap(async (req, res) => {
  const scope = String(req.query.scope || 'waiting');
  const q = {};
  if (scope === 'waiting') {
    const roles = myRoles(req.user);
    if (!roles.length) return res.json({ leaves: [] });
    Object.assign(q, { status: 'pending', waitingRole: { $in: roles } });
    const own = await ownStaff(req.user);
    if (own) q.staff = { $ne: own._id };
  } else if (scope === 'acted') {
    q['steps.by'] = req.user._id;
  } else {
    if (!canViewRoll(req.user) && !myRoles(req.user).length) throw new HttpError(403, 'The list of applications is for the Directorate of Personnel.');
    if (req.query.status) q.status = String(req.query.status);
    if (req.query.year) q.year = Number(req.query.year);
    if (req.query.type) q.type = String(req.query.type);
    if (req.query.staffId && mongoose.isValidObjectId(req.query.staffId)) q.staff = req.query.staffId;
    if (!canViewRoll(req.user)) q['steps.role'] = { $in: myRoles(req.user) };
  }
  const list = await Leave.find(q).sort(scope === 'waiting' ? { createdAt: 1 } : { from: -1 }).limit(1000);
  res.json({ leaves: list.map(l => serialize(l, req.user, false)) });
}));

// Who is away on a day (approved leave covering it).
router.get('/roster', wrap(async (req, res) => {
  if (!canViewRoll(req.user) && !myRoles(req.user).length) throw new HttpError(403, 'The leave roster is for the Directorate of Personnel.');
  const from = DAY.test(req.query.from || '') ? req.query.from : today();
  const to = DAY.test(req.query.to || '') && req.query.to >= from ? req.query.to : from;
  const q = { status: 'approved', from: { $lte: to }, to: { $gte: from } };
  if (req.query.station) q.station = String(req.query.station);
  const list = await Leave.find(q).sort({ station: 1, from: 1 });
  res.json({ from, to, leaves: list.map(l => serialize(l, req.user, false)) });
}));

router.get('/:id', wrap(async (req, res) => {
  const { l, own } = await load(req.params.id, req.user);
  res.json({ leave: serialize(l, req.user, own) });
}));

// Apply: for oneself (linked record) or, by the registry, for an officer.
router.post('/', wrap(async (req, res) => {
  const b = req.body || {};
  if (!mongoose.isValidObjectId(b.staffId || '')) throw new HttpError(400, 'Choose the officer.');
  const staff = await Staff.findById(b.staffId);
  if (!staff) throw new HttpError(404, 'Staff record not found.');
  const own = isOwn(req.user, staff);
  if (!own && !canEditRoll(req.user)) throw new HttpError(403, 'You can apply for your own leave, or the registry applies for an officer.');
  if (!['in_service', 'on_leave'].includes(staff.status)) throw new HttpError(409, `${staff.name} is not in service (${personnel.STATUS_LABELS[staff.status]}).`);
  const s = await leaveSvc.getSettings();
  const type = s.types.find(t => t.key === b.type);
  if (!type) throw new HttpError(400, 'Choose the kind of leave.');
  if (!leaveSvc.offered(type, staff)) throw new HttpError(400, `${type.name} is not for this officer.`);
  if (!DAY.test(b.from || '')) throw new HttpError(400, 'Enter the first day of leave.');
  const days = Number(b.days);
  if (!(Number.isInteger(days) && days >= 1 && days <= 400)) throw new HttpError(400, 'Enter the number of days.');
  const relief = String(b.relief || '').trim().slice(0, 200);
  if (s.reliefRequired && !relief) throw new HttpError(400, 'Name the officer who will relieve you (relief officer).');
  const sp = leaveSvc.span(b.from, days, type.working, s.holidays);
  const year = Number(sp.from.slice(0, 4));
  const bal = (await balances(staff, year, s)).find(x => x.key === type.key);
  if (bal.allowed && days > bal.left) throw new HttpError(400, `Only ${bal.left} day${bal.left === 1 ? '' : 's'} of ${type.name.toLowerCase()} left for ${year} (${bal.allowed} allowed, ${bal.used} taken${bal.pending ? `, ${bal.pending} applied for` : ''}).`);
  const clash = await Leave.findOne({ staff: staff._id, status: { $in: ['pending', 'approved'] }, from: { $lte: sp.to }, to: { $gte: sp.from } });
  if (clash) throw new HttpError(409, `This overlaps ${clash.typeName.toLowerCase()} from ${long(clash.from)} to ${long(clash.to)} (${clash.status}).`);
  const steps = leaveSvc.route(staff, s);
  const l = await Leave.create({
    staff: staff._id, psn: staff.psn, name: staff.name, rank: staff.rank, gl: staff.gl, station: staff.station,
    type: type.key, typeName: type.name, year, ...sp, days, working: type.working,
    reason: String(b.reason || '').trim().slice(0, 500), address: String(b.address || '').trim().slice(0, 300), phone: String(b.phone || '').trim().slice(0, 40), relief,
    steps, waitingRole: steps[0].role, appliedBy: req.user._id, appliedByName: req.user.fullName, forSelf: own
  });
  await audit.log(req, 'leave_applied', { details: { leaveId: String(l._id), psn: staff.psn, type: type.key, days, from: sp.from } });
  await tell(await holders(steps[0].role, [req.user._id, staff.user].filter(Boolean)),
    `${staff.name} (PSN ${staff.psn}) applies for ${days} ${type.working ? 'working ' : ''}days of ${type.name.toLowerCase()} from ${long(sp.from)}.`, 'leave', 'Leave application');
  res.status(201).json({ leave: serialize(l, req.user, own) });
}));

// A step: forward, recommend or approve (or decline), signed with the PIN.
router.post('/:id/act', wrap(async (req, res) => {
  const { l, own } = await load(req.params.id, req.user);
  if (l.status !== 'pending') throw new HttpError(409, 'This application is no longer pending.');
  const i = l.steps.findIndex(s => s.status === 'waiting');
  const step = l.steps[i];
  if (!req.user.signerRoles.includes(step.role)) throw new HttpError(403, `This application is waiting for the ${step.label}.`);
  if (own) throw new HttpError(403, 'You cannot act on your own application.');
  const decline = req.body.decision === 'decline';
  const comment = String(req.body.comment || '').trim().slice(0, 500);
  if (decline && !comment) throw new HttpError(400, 'Give the reason for declining.');
  const me = await User.findById(req.user._id);
  const last = i === l.steps.length - 1;
  if (last && !decline && !me.signature) throw new HttpError(400, 'Register your signature first (My Signature): it goes on the approval letter.');
  await verifyPin(me, String(req.body.pin || ''));
  Object.assign(step, { status: decline ? 'declined' : 'done', by: me._id, byName: me.fullName, title: me.title, at: new Date(), comment, image: last && !decline ? me.signature : null });
  const staff = await Staff.findById(l.staff);
  const applicant = [staff && staff.user, l.appliedBy].filter(Boolean);
  if (decline) {
    l.status = 'declined'; l.waitingRole = undefined;
  } else if (last) {
    l.status = 'approved'; l.waitingRole = undefined;
    const r = await meta().findOneAndUpdate({ _id: `leaveSeq:${l.year}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
    l.reference = `GSHC/PER/LV/${l.year}/${String((r && r.value ? r.value : r).seq).padStart(4, '0')}`;
  } else {
    l.waitingRole = l.steps[i + 1].role;
  }
  l.markModified('steps');
  await l.save();
  await audit.log(req, decline ? 'leave_declined' : last ? 'leave_approved' : 'leave_forwarded', { details: { leaveId: String(l._id), psn: l.psn, step: step.label } });
  const what = `${l.days} ${l.working ? 'working ' : ''}days of ${l.typeName.toLowerCase()} from ${long(l.from)}`;
  if (decline) {
    await tell(await User.find({ _id: { $in: applicant, $ne: me._id } }), `The ${step.label} declined the application of ${l.name} for ${what}: ${comment}`, 'leave', 'Leave declined');
  } else if (last) {
    if (staff) {
      staff.history.push({ kind: 'leave', date: l.from, byName: me.fullName, at: new Date(),
        text: `${l.typeName} approved: ${l.days} ${l.working ? 'working ' : ''}days, ${long(l.from)} to ${long(l.to)}; resumes ${long(l.resume)} (${l.reference})` });
      await staff.save();
    }
    await tell(await User.find({ _id: { $in: applicant, $ne: me._id } }), `Approved: ${l.name}, ${what}, to resume on ${long(l.resume)}. Ref. ${l.reference}. Print the approval letter from Leave.`, 'leave', 'Leave approved');
    await tell(await User.find({ active: true, privileges: 'personnel_edit', _id: { $nin: [me._id, ...applicant] } }), `Leave approved for ${l.name} (PSN ${l.psn}): ${what}. Ref. ${l.reference}.`, 'leave', 'Leave approved');
  } else {
    const next = l.steps[i + 1];
    await tell(await holders(next.role, [me._id, staff && staff.user].filter(Boolean)), `${l.name} (PSN ${l.psn}): ${what}, ${step.action === 'Recommend' ? 'recommended' : 'forwarded'} by the ${step.label}, waits for the ${next.label}.`, 'leave', 'Leave application');
  }
  res.json({ leave: serialize(l, req.user, own) });
}));

router.post('/:id/withdraw', wrap(async (req, res) => {
  const { l, own } = await load(req.params.id, req.user);
  if (l.status !== 'pending') throw new HttpError(409, 'Only a pending application can be withdrawn.');
  if (!own && !canEditRoll(req.user)) throw new HttpError(403, 'Only the officer or the registry withdraws an application.');
  l.status = 'withdrawn'; l.waitingRole = undefined;
  await l.save();
  await audit.log(req, 'leave_withdrawn', { details: { leaveId: String(l._id), psn: l.psn } });
  res.json({ leave: serialize(l, req.user, own) });
}));

// The approver's signature, for the approval letter.
router.get('/:id/signature', wrap(async (req, res) => {
  const { l } = await load(req.params.id, req.user);
  const step = l.status === 'approved' && l.steps[l.steps.length - 1];
  if (!step || !step.image) throw new HttpError(404, 'Not approved.');
  const img = await store.read(step.image);
  if (!img) throw new HttpError(404, 'Signature image missing.');
  res.set('Content-Type', img.contentType).set('Cache-Control', 'private, max-age=86400').send(img.buffer);
}));

module.exports = router;
