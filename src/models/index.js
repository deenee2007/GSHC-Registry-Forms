/*
 * src/models/index.js — MongoDB collections.
 */
const mongoose = require('mongoose');
const { Schema } = mongoose;
const { SIGNER_ROLES } = require('../forms/signers');

// personnel_view / personnel_edit: the Nominal Roll of the Directorate of
// Personnel (staff records), apart from the unit forms.
const PRIVILEGES = ['view', 'create', 'edit', 'finalize', 'delete', 'print', 'reports', 'personnel_view', 'personnel_edit'];

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
  type:         { type: String, enum: ['registry', 'appeals', 'execution', 'general', 'process'], required: true },
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
  events:    { type: [{ _id: false, date: String, time: String, what: String }], default: undefined }, // court dates, for reminders
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
RecordSchema.index({ 'events.date': 1, status: 1 });

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
  kind:    { type: String, enum: ['submitted', 'approved', 'returned', 'revoked', 'signed', 'case', 'leave'], required: true },
  link:    String, // for a case notice: the screen it opens ("assign", "process" or "register:<unit key>")
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

// ── Process Registry ──
// A file kept privately (the payment receipt of a filing).
const FileRef = new Schema({
  provider:    { type: String, enum: ['cloudinary', 'inline'], required: true },
  publicId:    String,
  dataUrl:     String,
  contentType: String,
  name:        String,
  bytes:       Number,
  uploadedAt:  Date
}, { _id: false });

// draft → submitted (to the Process Registrar) → awaiting_assignment (number
// given) → assigned (by the Chief Judge) → received (by the court) → disposed.
// "returned" goes back to the filer with the Process Registrar's comment.
const CASE_STATUSES = ['draft', 'submitted', 'returned', 'awaiting_assignment', 'assigned', 'dispatched', 'received', 'disposed'];

// A case filed at the Process Registry: registered with the next suit
// number of its type, assigned to a court by the Hon. Chief Judge, then
// kept in that court's Case Register until disposed of. A case filed
// before the system ("earlier case") is entered straight into a register.
const CaseSchema = new Schema({
  caseType:      { type: String, required: true },   // key from the Process Registry settings (civil, criminal, ...)
  suitNumber:    { type: String, trim: true },       // GM/1/2026, GM/45c/2026; set at registration
  seq:           Number,
  year:          Number,
  earlier:       { type: Boolean, default: false },  // entered by a court registry for a case filed before the system
  firstParty:    { type: String, trim: true, default: '' },
  secondParty:   { type: String, trim: true, default: '' },
  nature:        { type: String, trim: true, default: '' },
  process:       { type: String, trim: true, default: '' },   // originating process
  counsel:       { type: String, trim: true, default: '' },
  counselAddress:{ type: String, trim: true, default: '' },
  firstPartyAddress:  { type: String, trim: true, default: '' },
  secondPartyAddress: { type: String, trim: true, default: '' },
  filedOn:       String,                              // YYYY-MM-DD
  efcc:          { type: Boolean, default: false },
  official:      { type: Boolean, default: false },  // no filing fee (criminal cases filed by the State, EFCC matters)
  fees:          { type: [{ _id: false, item: String, amount: Number, qty: Number }], default: [] },
  feeTotal:      { type: Number, default: 0 },
  receiptNumber: { type: String, trim: true, default: '' },
  receiptKey:    { type: String, index: true },        // the receipt number written one way, to find it used twice
  receipt:       { type: FileRef, default: null },
  // Email updates on the stage of the case, to the addresses given at filing.
  emails:        { type: { _id: false, firstParty: [String], secondParty: [String], counsel: [String] }, default: () => ({ firstParty: [], secondParty: [], counsel: [] }) },
  emailLog:      { type: [{ _id: false, stage: String, to: String, at: Date, ok: Boolean }], default: [] },
  // The invoice given to the filer to go and pay: its reference and what it listed.
  invoice:       { type: { _id: false, reference: String, issuedAt: Date, issuedByName: String,
                   fees: [{ _id: false, item: String, amount: Number, qty: Number }], total: Number }, default: null },

  status:        { type: String, enum: CASE_STATUSES, default: 'draft', index: true },
  returnComment: String,
  returnedByName: String,
  createdBy:     { type: Schema.Types.ObjectId, ref: 'User' },
  createdByName: String,
  registeredBy:  { type: Schema.Types.ObjectId, ref: 'User' },
  registeredByName: String,
  registeredAt:  Date,

  proposedUnit:  String,                              // court the rotation proposed
  assignedUnit:  { type: String, index: true },       // court the Chief Judge assigned
  assignedAt:    Date,
  assignment:    { type: SignatureSchema, default: null },  // the Chief Judge's signature on the assignment
  verifyCode:    { type: String, unique: true, sparse: true },
  verifyUrl:     String,
  contentHash:   String,

  // Reassignment: the court's request (until the Chief Judge acts on it), the
  // courts the case was in before (their registers keep it, marked
  // reassigned), and the court the present assignment came from.
  reassignRequest: { type: { _id: false, reason: String, note: String, by: Schema.Types.ObjectId, byName: String, at: Date }, default: null },
  formerUnits:   { type: [{ _id: false, unitKey: String, assignedAt: Date, dispatchedAt: Date, receivedAt: Date, leftAt: Date,
                   toUnit: String, reason: String, byName: String, verifyCode: String, signedByName: String }], default: [] },
  reassignedFrom: String,
  dispatchedAt:  Date,                                // the Process Registry sent the file to the court
  dispatchedByName: String,
  receivedAt:    Date,
  receivedByName: String,
  disposal:      { type: { _id: false, remark: String, date: String, byName: String, at: Date }, default: null },
  caseNos:       { type: [String], index: true }      // for the case file
}, { timestamps: true });
CaseSchema.index({ suitNumber: 1 }, { unique: true, partialFilterExpression: { suitNumber: { $type: 'string' } } });
CaseSchema.index({ 'formerUnits.unitKey': 1 });
CaseSchema.index({ 'formerUnits.verifyCode': 1 });
// "RC 1001", "rc1001" and "RC-1001" are the same receipt.
const receiptKey = (n) => String(n || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
CaseSchema.pre('save', function () { this.receiptKey = receiptKey(this.receiptNumber) || undefined; });

// A process filed later in a case (a motion, ...), at the court's registry:
// its fees, the invoice the filer takes to pay at revenue, and the receipt.
// It is recorded against the suit number; it has no number of its own.
const CaseProcessSchema = new Schema({
  case:          { type: Schema.Types.ObjectId, ref: 'Case', required: true, index: true },
  unitKey:       { type: String, required: true, index: true },   // the court's registry
  processType:   { type: String, trim: true, required: true },    // Motion on notice, Motion ex parte, ...
  filedOn:       { type: String, index: true },                   // YYYY-MM-DD
  fees:          { type: [{ _id: false, item: String, amount: Number, qty: Number }], default: [] },
  feeTotal:      { type: Number, default: 0 },
  invoice:       { type: { _id: false, reference: String, issuedAt: Date, issuedByName: String,
                   fees: [{ _id: false, item: String, amount: Number, qty: Number }], total: Number }, default: null },
  receiptNumber: { type: String, trim: true, default: '' },
  receiptKey:    { type: String, index: true },
  receipt:       { type: FileRef, default: null },
  createdBy:     { type: Schema.Types.ObjectId, ref: 'User' },
  createdByName: String,
  updatedByName: String
}, { timestamps: true });
CaseProcessSchema.pre('save', function () { this.receiptKey = receiptKey(this.receiptNumber) || undefined; });

// A scanned document attached to a case (writ, motion, affidavit, exhibit, ...).
const DOC_TYPES = ['Writ of summons', 'Statement of claim', 'Statement of defence', 'Originating summons', 'Petition', 'Motion',
  'Affidavit', 'Counter affidavit', 'Written address', 'Exhibit', 'Charge', 'Proof of evidence', 'Order', 'Judgment', 'Ruling'];
const CaseDocumentSchema = new Schema({
  case:          { type: Schema.Types.ObjectId, ref: 'Case', required: true, index: true },
  title:         { type: String, trim: true, required: true },
  docType:       { type: String, trim: true, default: '' },  // one of DOC_TYPES, or typed under Others
  filedOn:       String,                                     // YYYY-MM-DD: when the document was filed in court
  file:          { type: FileRef, required: true },
  unitKey:       String,                                     // where it was uploaded: 'process' or the court
  process:       { type: Schema.Types.ObjectId, ref: 'CaseProcess' }, // filed with a later process, if so
  uploadedBy:    { type: Schema.Types.ObjectId, ref: 'User' },
  uploadedByName: String
}, { timestamps: true });

// A date in a court's diary: one case, the day and time, and the business
// (Mention, Hearing, ...). The registry and the judges of the court share
// it. After the sitting, the outcome is recorded; an adjournment makes the
// next entry. Cases not in the register can be entered by number.
const DiaryEntrySchema = new Schema({
  unitKey:       { type: String, required: true, index: true },   // the court
  date:          { type: String, required: true, index: true },   // YYYY-MM-DD
  time:          { type: String, default: '' },                   // HH:MM
  case:          { type: Schema.Types.ObjectId, ref: 'Case', index: true },
  suitNumber:    { type: String, trim: true, required: true },
  parties:       { type: String, trim: true, default: '' },
  nature:        { type: String, trim: true, default: '' },
  counsel:       { type: String, trim: true, default: '' },
  business:      { type: String, trim: true, required: true },
  notes:         { type: String, trim: true, default: '' },
  status:        { type: String, enum: ['fixed', 'done'], default: 'fixed', index: true },
  outcome:       { type: { _id: false, text: String, nextDate: String, at: Date, byName: String }, default: null },
  previous:      { type: Schema.Types.ObjectId, ref: 'DiaryEntry' },  // the sitting this was adjourned from
  createdBy:     { type: Schema.Types.ObjectId, ref: 'User' },
  createdByName: String,
  updatedByName: String
}, { timestamps: true });

// A member of staff on the Nominal Roll of the Directorate of Personnel,
// whether or not they sign in. The PSN is unique to each officer. Dates are
// YYYY-MM-DD. The retirement date is worked out (60 years of age or 35
// years of service, whichever comes first; a contract officer, the end of
// the contract). Changes of rank, station and status are kept as the
// record of service.
const STAFF_STATUSES = ['in_service', 'on_leave', 'suspended', 'retired', 'resigned', 'deceased', 'transferred_out', 'dismissed'];
const StaffSchema = new Schema({
  psn:           { type: String, required: true, trim: true, unique: true },
  name:          { type: String, required: true, trim: true },
  title:         { type: String, trim: true, default: '' },
  sex:           { type: String, enum: ['M', 'F', ''], default: '' },
  rank:          { type: String, trim: true, default: '' },
  cadre:         { type: String, trim: true, default: '' },
  gl:            { type: String, trim: true, default: '' },    // 01 to 17, or Cons. (consolidated)
  step:          { type: Number, default: null },
  qualification: { type: String, trim: true, default: '' },    // the highest
  qualifications: { type: [{ _id: false, name: String, institution: String, year: String }], default: [] },
  dob:           { type: String, default: '' },
  dofa:          { type: String, default: '' },                 // date of first appointment
  dopa:          { type: String, default: '' },                 // date of present appointment
  confirmedOn:   { type: String, default: '' },
  lga:           { type: String, trim: true, default: '' },
  station:       { type: String, trim: true, default: '', index: true },
  contract:      { type: Boolean, default: false },
  contractEnds:  { type: String, default: '' },
  phone:         { type: String, trim: true, default: '' },
  email:         { type: String, trim: true, lowercase: true, default: '' },
  address:       { type: String, trim: true, default: '' },
  nextOfKin:     { type: { _id: false, name: String, relationship: String, phone: String }, default: () => ({ name: '', relationship: '', phone: '' }) },
  status:        { type: String, enum: STAFF_STATUSES, default: 'in_service', index: true },
  statusDate:    { type: String, default: '' },
  photo:         { type: FileRef, default: null },
  user:          { type: Schema.Types.ObjectId, ref: 'User', default: null },  // their sign in account, if any
  retiresOn:     { type: String, default: '', index: true },    // worked out on save
  retiresBy:     { type: String, default: '' },                 // age, service or contract
  checkDates:    { type: Boolean, default: false },             // the import could not be sure of a date
  history:       { type: [{ _id: false, kind: String, date: String, text: String, byName: String, at: Date }], default: [] },
  createdByName: String,
  updatedByName: String
}, { timestamps: true });
StaffSchema.index({ name: 1 });
StaffSchema.pre('save', function () {
  const r = retirement(this);
  this.retiresOn = r.date; this.retiresBy = r.by;
});
// The day an officer reaches a number of years from a date (29 February: 28 February).
function addYears(isoDate, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || '');
  if (!m) return '';
  const y = +m[1] + n, mo = +m[2], d = Math.min(+m[3], new Date(Date.UTC(y, mo, 0)).getUTCDate());
  return `${y}-${m[2]}-${String(d).padStart(2, '0')}`;
}
// 60 years of age or 35 years of service, whichever comes first; a contract, its end.
function retirement(s) {
  if (s.contract && s.contractEnds) return { date: s.contractEnds, by: 'contract' };
  const age = addYears(s.dob, 60), service = addYears(s.dofa, 35);
  if (age && (!service || age <= service)) return { date: age, by: 'age' };
  if (service) return { date: service, by: 'service' };
  return { date: '', by: '' };
}

// A scanned document in an officer's folder. A confidential one (a query,
// a disciplinary paper) opens only for those who edit the roll.
const StaffDocumentSchema = new Schema({
  staff:         { type: Schema.Types.ObjectId, ref: 'Staff', required: true, index: true },
  title:         { type: String, trim: true, required: true },
  docType:       { type: String, trim: true, default: '' },
  date:          String,
  confidential:  { type: Boolean, default: false },
  file:          { type: FileRef, required: true },
  uploadedBy:    { type: Schema.Types.ObjectId, ref: 'User' },
  uploadedByName: String
}, { timestamps: true });

// An application for leave, made from the officer's record (by the officer
// if their account is linked to it, or by the registry for them). It goes
// through the steps of the route in Settings (Staff Officer, then Director
// Personnel, or the Chief Registrar for senior officers), each signed with
// the PIN. Approval gives the letter and the record of service entry.
const LeaveStepSchema = new Schema({
  role:     { type: String, required: true },  // signer role that acts on this step
  label:    String,                            // e.g. "Staff Officer"
  action:   String,                            // "Forward" or "Approve"
  status:   { type: String, enum: ['waiting', 'done', 'declined'], default: 'waiting' },
  by:       { type: Schema.Types.ObjectId, ref: 'User' },
  byName:   String,
  title:    String,
  image:    { type: ImageRef, default: null },  // the signature, on the final step
  at:       Date,
  comment:  String
}, { _id: false });
const LeaveSchema = new Schema({
  staff:         { type: Schema.Types.ObjectId, ref: 'Staff', required: true, index: true },
  psn:           String,
  name:          String,
  rank:          String,
  gl:            String,
  station:       String,
  type:          { type: String, required: true },   // key of the kind of leave in Settings
  typeName:      String,
  year:          { type: Number, index: true },      // the leave year it counts against
  from:          { type: String, required: true },   // YYYY-MM-DD, first day of leave
  to:            { type: String, required: true },   // last day of leave
  resume:        String,                             // the day to resume duty
  days:          { type: Number, required: true },
  working:       { type: Boolean, default: true },   // days counted are working days
  reason:        { type: String, default: '' },
  address:       { type: String, default: '' },      // address while on leave
  phone:         { type: String, default: '' },
  relief:        { type: String, default: '' },      // the officer who covers the duties
  status:        { type: String, enum: ['pending', 'approved', 'declined', 'withdrawn'], default: 'pending', index: true },
  steps:         { type: [LeaveStepSchema], default: [] },
  waitingRole:   { type: String, index: true },      // the role of the step now waiting
  reference:     String,                             // of the approval letter
  appliedBy:     { type: Schema.Types.ObjectId, ref: 'User' },
  appliedByName: String,
  forSelf:       { type: Boolean, default: false }
}, { timestamps: true });

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
  PRIVILEGES, STATUSES, STAFF_STATUSES, retirement, addYears,
  User:         mongoose.model('User', UserSchema),
  Unit:         mongoose.model('Unit', UnitSchema),
  FormConfig:   mongoose.model('FormConfig', FormConfigSchema),
  Record:       mongoose.model('Record', RecordSchema),
  AuditLog:     mongoose.model('AuditLog', AuditLogSchema),
  Notification: mongoose.model('Notification', NotificationSchema),
  PasswordToken: mongoose.model('PasswordToken', PasswordTokenSchema),
  DocumentCopy: mongoose.model('DocumentCopy', DocumentCopySchema),
  Backup:       mongoose.model('Backup', BackupSchema),
  Case:         mongoose.model('Case', CaseSchema),
  CaseDocument: mongoose.model('CaseDocument', CaseDocumentSchema),
  CaseProcess:  mongoose.model('CaseProcess', CaseProcessSchema),
  Staff:        mongoose.model('Staff', StaffSchema),
  StaffDocument: mongoose.model('StaffDocument', StaffDocumentSchema),
  Leave:        mongoose.model('Leave', LeaveSchema),
  receiptKey,
  DiaryEntry:   mongoose.model('DiaryEntry', DiaryEntrySchema),
  CASE_STATUSES, DOC_TYPES
};
