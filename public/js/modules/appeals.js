/*
 * modules/appeals.js — Directorate of Appeal
 * Two forms: Criminal Appeal Notice and Civil Appeal Notice (Form 97, Order 43 Rule 2).
 * Also registers all forms globally so other units can be granted access via Settings.
 */
(function () {
  window.App = window.App || {};
  window.App.modules = window.App.modules || {};

  const forms = {

    'summons-settle-record': {
      label: 'Summons to Settle Record of Appeal',
      schema: [
        { section: 'Parties' },
        { name: 'appellant',  label: 'Appellant',  required: true, full: true },
        { name: 'respondent', label: 'Respondent', required: true },
        { section: 'Attendance Details' },
        { name: 'attendanceDate', label: 'Date of Attendance', type: 'date', required: true },
        { name: 'attendanceTime', label: "Time (O'Clock)", required: true, defaultValue: '9:00',
          help: "e.g. 9:00" },
        { section: 'Date' },
        { name: 'datedAt',   label: 'Dated At', defaultValue: 'Gombe', required: true },
        { name: 'issueDate', label: 'Date Issued', type: 'date', required: true }
      ]
    },

    'notice-appeal-fixed': {
      label: 'Notice of Appeal Fixed (to Lower Court)',
      schema: [
        { section: 'Letter Reference' },
        { name: 'refNo',             label: 'Ref. No.',            required: true },
        { name: 'letterDate',        label: 'Date',                type: 'date', required: true },
        { name: 'highCourtAppealNo', label: 'High Court Appeal No.', required: true },
        { section: 'Recipient (Lower Court)' },
        { name: 'lowerCourtName',    label: 'Lower Court Name',    required: true,
          help: 'e.g. Upper Area Court Kaltungo, Chief Magistrate Court Gombe' },
        { section: 'Parties' },
        { name: 'applicant',         label: 'Applicant',           required: true, full: true },
        { name: 'respondent',        label: 'Respondent',          required: true },
        { section: 'Appeal Details' },
        { name: 'hearingDay',        label: 'Day of Hearing (ordinal)', required: true,
          help: 'e.g. 15th' },
        { name: 'hearingMonth',      label: 'Month of Hearing',    required: true },
        { name: 'hearingYear',       label: 'Year of Hearing',     required: true },
        { name: 'originalDecisionDate', label: 'Date of Original Court Decision',
          type: 'date', required: true },
        { name: 'lowerCourtSuitNo',  label: 'Case/Suit No. at Lower Court', required: true },
        { name: 'lowerApplicant',    label: 'Applicant Name at Lower Court', required: true },
        { name: 'lowerRespondent',   label: 'Respondent Name at Lower Court', required: true },
        { section: 'Financial' },
        { name: 'depositAmount',     label: 'Deposit Amount for Certified Copies (₦)',
          required: true, defaultValue: '100',
          help: 'Amount appellant must deposit for certified copies of records' },
        { section: 'Copy & Signature' },
        { name: 'copyTo',         label: 'Copy To', type: 'textarea',
          help: 'Names/parties to receive a copy' },
        { name: 'registrarName', label: "Registrar's Name", required: true },
        { name: 'refNoBottom',   label: 'Ref. No. (bottom of letter)' },
        { name: 'issueYear',     label: 'Year (bottom of letter)',
          help: 'e.g. 2026' }
      ]
    },

    'criminal-appeal-notice': {
      label: 'Criminal Appeal Notice',
      schema: [
        { section: 'Registrar Address' },
        { name: 'registrarAddress', label: 'Registrar / Court Address', type: 'textarea',
          defaultValue: 'The High Court of Justice, Gombe State', required: true },
        { section: 'Case Reference' },
        { name: 'caseNumber', label: 'Case / File Number', required: true },
        { name: 'decisionCourt', label: 'Decision of (Court / Tribunal)', required: true,
          help: 'e.g. Upper Area Court Gombe' },
        { section: 'Parties' },
        { name: 'appellant', label: 'Appellant', required: true, full: true },
        { name: 'respondent', label: 'Respondent', required: true },
        { section: 'Decision Details' },
        { name: 'dateOfDecision', label: 'Date of Decision', type: 'date', required: true },
        { name: 'offenceOrClaim', label: '3. Offence (in Criminal case) or Claim (in Civil matters)',
          type: 'textarea', required: true },
        { name: 'sentenceOrOrders', label: '4. Sentence (in Criminal cases) or Orders (in Civil matters)',
          type: 'textarea', required: true },
        { section: 'Grounds of Appeal' },
        { name: 'groundsDecisionBody', label: 'That the Decision of (court / body)', required: true,
          help: 'Name the court/tribunal whose decision is being appealed in this ground' },
        { name: 'additionalGrounds', label: 'Additional Grounds of Appeal', type: 'textarea',
          help: 'List any further grounds. More grounds may be filed on receipt of record of proceedings.' },
        { section: 'Signature & Date' },
        { name: 'issueDate', label: 'Date', type: 'date', required: true },
        { name: 'respondentAddress', label: 'Respondent Address', type: 'textarea' },
        { name: 'appellantPractitioner', label: 'Appellant / Legal Practitioner Name', required: true }
      ]
    },

    'civil-appeal-notice': {
      label: 'Civil Appeal Notice',
      schema: [
        { section: 'Registrar Address' },
        { name: 'registrarAddress', label: 'Registrar / Court Address', type: 'textarea',
          defaultValue: 'The High Court of Justice, Gombe State', required: true },
        { section: 'Case Reference' },
        { name: 'caseNumber', label: 'Case / File Number', required: true },
        { name: 'decisionCourt', label: 'Decision of (Court / Tribunal)', required: true,
          help: 'e.g. Upper Area Court Gombe' },
        { section: 'Parties' },
        { name: 'appellant', label: 'Appellant', required: true, full: true },
        { name: 'respondent', label: 'Respondent', required: true },
        { section: 'Decision Details' },
        { name: 'dateOfDecision', label: 'Date of Decision', type: 'date', required: true },
        { name: 'offenceOrClaim', label: '3. Offence (in Criminal case) or Claim (in Civil matters)',
          type: 'textarea', required: true },
        { name: 'sentenceOrOrders', label: '4. Sentence (in Criminal cases) or Orders (in Civil matters)',
          type: 'textarea', required: true },
        { section: 'Grounds of Appeal' },
        { name: 'groundsDecisionBody', label: 'That the Decision of (court / body)', required: true,
          help: 'Name the court/tribunal whose decision is being appealed in this ground' },
        { name: 'additionalGrounds', label: 'Additional Grounds of Appeal', type: 'textarea',
          help: 'List any further grounds. More grounds may be filed on receipt of record of proceedings.' },
        { section: 'Signature & Date' },
        { name: 'issueDate', label: 'Date', type: 'date', required: true },
        { name: 'respondentAddress', label: 'Respondent Address', type: 'textarea' },
        { name: 'appellantPractitioner', label: 'Appellant / Legal Practitioner Name', required: true }
      ]
    }

  };

  // ── Register forms globally so other units can be granted access ──
  window.App.allForms = window.App.allForms || {};
  window.App.allFormsByModule = window.App.allFormsByModule || {};
  Object.assign(window.App.allForms, forms);
  window.App.allFormsByModule['Appeals'] = forms;

  window.App.modules.appeals = {
    id: 'appeals',
    forms,
    render(container, ctx) {
      window.App.recordEngine.render(container, ctx, {
        store: 'appeals_records',
        subtitle: 'Directorate of Appeal — notice of appeal & related forms',
        forms
      });
    }
  };
})();
