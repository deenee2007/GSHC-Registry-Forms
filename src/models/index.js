/*
 * src/models/index.js — MongoDB collections.
 */
const mongoose = require('mongoose');
const { Schema } = mongoose;
const { SIGNER_ROLES } = require('../forms/signers');

const PRIVILEGES = ['view', 'create', 'edit', 'finalize', 'delete', 'print', 'reports'];

// Where a signature image lives: Cloudinary (production) or inline in
// MongoDB (local development without Cloudinary).
const ImageRef = new Schema({
  provider: { type: String, enum: ['cloudinary', 'inline'], required: true },
  publicId: String,
  format: String,
  dataUrl: String
}, { _id: false });

const UserSchema = new Schema({
  username:     { type: String, required: true, unique: true, lowercase: true, trim: true },
  fullName:     { type: String, required: true, trim: true },
  title:        { type: String, trim: true, default: '' },     // e.g. "Hon. Justice", printed under a signature
  email:        { type: String, trim: true, lowercase: true },  // for invitations and password reset links
  emailAlerts:  { type: Boolean, default: true },   // the user's own choice (My Account)
  emailAlertsBlocked: { type: Boolean, default: false }, // switched off by an administrator
  passwordHash: { type: String, required: true },
  role:         { type: String, enum: ['admin', 'user'], default: 'user' },
  unitKeys:     { type: [String], default: [] },               // empty = every unit (admins, Chief Registrar)
  privileges:   { type: [String], enum: PRIVILEGES, default: [] },
  signerRoles:  { type: [String], enum: Object.keys(SIGNER_ROLES), default: [] },
  signature:    { type: ImageRef, default: null },
  signatureUpdatedAt: Date,
  signingPinHash: { type: String, default: null },
  pinFailures:  { type: Number, default: 0 },
  pinLockedUntil: Date,
  mustChangePassword: { type: Boolean, default: true },
  active:       { type: Boolean, default: true },
  failedLogins: { type: Number, default: 0 },
  lockedUntil:  Date,
  lastLoginAt:  Date
}, { timestamps: true });

// An email address belongs to one account, so a reset link always reaches the right person.
UserSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });

UserSchema.methods.toSafeJSON = function () {
  return {
    id: String(this._id), username: this.username, fullName: this.fullName, title: this.title, email: this.email || '',
    role: this.role, unitKeys: this.unitKeys, privileges: this.privileges, signerRoles: this.signerRoles,
    emailAlerts: this.emailAlerts !== false, emailAlertsBlocked: !!this.emailAlertsBlocked,
    hasSignature: !!this.signature, hasSigningPin: !!this.signingPinHash,
    mustChangePassword: this.mustChangePassword, active: this.active,
    lastLoginAt: this.lastLoginAt, createdAt: this.createdAt
  };
};

const UnitSchema = new Schema({
  key:          { type: String, required: true, unique: true, lowercase: true, trim: true },
  type:         { type: String, enum: ['registry', 'appeals', 'execution', 'general'], required: true },
  name:         { type: String, required: true, trim: true },
  courtNo:      Number,
  allowedForms: { type: [String], default: null },
  active:       { type: Boolean, default: true }
}, { timestamps: true });

const FormConfigSchema = new Schema({
  formType: { type: String, required: true, unique: true },
  signers:  [{ _id: false, role: { type: String, enum: Object.keys(SIGNER_ROLES), required: true }, label: { type: String, required: true } }]
}, { timestamps: true });

// A signature placed on a record. The image reference is copied at signing
// time so a later change of signature never alters documents already signed.
const SignatureSchema = new Schema({
  user:     { type: Schema.Types.ObjectId, ref: 'User', required: true },
  name:     String,
  title:    String,
  image:    ImageRef,
  signedAt: { type: Date, required: true }
}, { _id: false });

// One signature line on a form (e.g. "Judge"), the people asked to sign it,
// and whether any one of them or all of them must sign (panels).
const SlotSchema = new Schema({
  role:       { type: String, required: true },
  label:      { type: String, required: true },
  rule:       { type: String, enum: ['any', 'all'], default: 'any' },
  approvers:  [{ type: Schema.Types.ObjectId, ref: 'User' }],
  signatures: { type: [SignatureSchema], default: [] }
}, { _id: false });

const STATUSES = ['draft', 'pending', 'returned', 'final', 'revoked'];

const RecordSchema = new Schema({
  unitKey:   { type: String, required: true, index: true },
  formType:  { type: String, required: true },
  status:    { type: String, enum: STATUSES, default: 'draft', index: true },
  ref:       { type: String, default: '' },
  summary:   { type: String, default: '' },
  caseNos:   { type: [String], default: undefined, index: true }, // suit / case / appeal numbers, for the case file
  data:      { type: Schema.Types.Mixed, default: {} },
  slots:     { type: [SlotSchema], default: [] },

  createdBy:     { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: String,
  updatedBy:     { type: Schema.Types.ObjectId, ref: 'User' },
  submittedBy:   { type: Schema.Types.ObjectId, ref: 'User', index: true },
  submittedByName: String,
  submittedAt:   Date,
  returnComment: String,
  returnedBy:    String,
  returnedAt:    Date,

  finalizedAt:   Date,
  verifyCode:    { type: String, unique: true, sparse: true },
  verifyUrl:     String,
  contentHash:   String,
  revokedAt:     Date,
  revokedBy:     String,
  revokeReason:  String,
  firstPrintedAt: Date,
  printCount:    { type: Number, default: 0 }
}, { timestamps: true, minimize: false, optimisticConcurrency: true });

RecordSchema.index({ 'slots.approvers': 1, status: 1 });
RecordSchema.index({ ref: 1 });

const AuditLogSchema = new Schema({
  at:       { type: Date, default: Date.now, index: true },
  user:     { type: Schema.Types.ObjectId, ref: 'User' },
  username: String,
  action:   { type: String, required: true },
  record:   { type: Schema.Types.ObjectId, ref: 'Record', index: true },
  unitKey:  String,
  details:  Schema.Types.Mixed,
  ip:       String
});

const NotificationSchema = new Schema({
  user:    { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  kind:    { type: String, enum: ['submitted', 'approved', 'returned', 'revoked', 'signed'], required: true },
  record:  { type: Schema.Types.ObjectId, ref: 'Record' },
  message: String,
  read:    { type: Boolean, default: false }
}, { timestamps: true });

// One time links for setting a password: an invitation for a new account,
// or a reset. Only a hash of the token is stored; MongoDB deletes expired
// ones by itself.
const PasswordTokenSchema = new Schema({
  user:      { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  kind:      { type: String, enum: ['invite', 'reset'], required: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
  usedAt:    Date
}, { timestamps: true });
PasswordTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// The exact document as it was signed: a standalone HTML file with its
// styles, signature images and QR code inside, kept for download.
const DocumentCopySchema = new Schema({
  record:      { type: Schema.Types.ObjectId, ref: 'Record', required: true, unique: true },
  html:        { type: String, required: true },
  generatedAt: { type: Date, default: Date.now },
  late:        { type: Boolean, default: false }, // made after signing (record signed before copies existed)
  backedUpAt:  Date                                 // copied to the backup store (src/services/backup.js)
});

// One run of the backup: the data file it wrote, or why it failed.
const BackupSchema = new Schema({
  at:          { type: Date, default: Date.now, index: true },
  ok:          { type: Boolean, required: true },
  reason:      { type: String, enum: ['scheduled', 'manual'], default: 'scheduled' },
  by:          String,                 // username, for a manual run
  file:        String,                 // name in the backup store
  bytes:       Number,
  counts:      Schema.Types.Mixed,     // documents per collection
  copiesAdded: { type: Number, default: 0 },
  error:       String,
  deleted:     { type: Boolean, default: false } // removed from the store by retention
});

module.exports = {
  PRIVILEGES, STATUSES,
  User:         mongoose.model('User', UserSchema),
  Unit:         mongoose.model('Unit', UnitSchema),
  FormConfig:   mongoose.model('FormConfig', FormConfigSchema),
  Record:       mongoose.model('Record', RecordSchema),
  AuditLog:     mongoose.model('AuditLog', AuditLogSchema),
  Notification: mongoose.model('Notification', NotificationSchema),
  PasswordToken: mongoose.model('PasswordToken', PasswordTokenSchema),
  DocumentCopy: mongoose.model('DocumentCopy', DocumentCopySchema),
  Backup:       mongoose.model('Backup', BackupSchema)
};
