/*
 * src/forms/signers.js — who signs what.
 *
 * SIGNER_ROLES are the signing capacities a user can hold (an admin assigns
 * them in Settings). DEFAULT_SIGNERS is the starting rule for each form; it
 * is copied into the database on first run, after which the admin controls
 * it from Settings, so nothing here is final.
 *
 * A form with no signers is signed by hand by people outside the system
 * (deponent, surety, counsel). Finalising it still locks it and issues a
 * verification code.
 */
const SIGNER_ROLES = {
  judge:                 'Judge',
  chief_registrar:       'Chief Registrar',
  registrar:             'Registrar',
  chief_bailiff:         'Chief Bailiff',
  deputy_sheriff:        'Deputy Sheriff',
  commissioner_for_oaths: 'Commissioner for Oaths'
};

const judge = [{ role: 'judge', label: 'Judge' }];
const registrar = [{ role: 'registrar', label: 'Registrar' }];
const chiefBailiff = [{ role: 'chief_bailiff', label: 'Chief Bailiff' }];

const DEFAULT_SIGNERS = {
  // Court Registry
  'civil-summons': judge,
  'witness-summons': judge,
  'order-to-produce-prisoner': judge,
  'criminal-summons': judge,
  'warrant-of-arrest': judge,
  'bail-bond': [],                       // signed by the surety
  'affidavit-of-service': [],            // deponent and Commissioner for Oaths
  'affidavit-of-means': [],              // declarant and Commissioner for Oaths
  'subpoena-ad-testificandum': judge,
  'subpoena-duces-tecum': judge,
  'hearing-notice': registrar,
  'remand-warrant': judge,
  'committal-warrant': judge,
  'court-order': judge,
  'cause-list': registrar,

  // Appeals
  'summons-settle-record': [{ role: 'registrar', label: 'Appeal Registrar' }],
  'notice-appeal-fixed': registrar,
  'criminal-appeal-notice': [],          // appellant or legal practitioner
  'civil-appeal-notice': [],

  // Execution / Bailiffs
  'ex-affidavit-of-service': [],
  'writ-attachment-immovable': judge,
  'writ-possession-property': judge,
  'writ-possession-children': judge,
  'writ-possession-premises': judge,
  'judgment-summons': [],                // judgment creditor or solicitor
  'notice-of-attachment': [{ role: 'chief_registrar', label: 'Chief Registrar' }],
  'statutory-notice-auction': chiefBailiff,
  'request-nscdc-personnel': chiefBailiff,
  'public-auction-receipt': [{ role: 'deputy_sheriff', label: 'Deputy Sheriff' }, { role: 'chief_bailiff', label: 'Chief Bailiff' }],
  'request-police-assistance': chiefBailiff,
  'notice-to-vacate': chiefBailiff,
  'writ-attachment-goods': judge,
  'writ-possession-occupancy': judge
};

module.exports = { SIGNER_ROLES, DEFAULT_SIGNERS };
