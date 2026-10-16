/*
 * modules/execution.js — Execution / Bailiffs Unit
 * 14 forms extracted from physical forms (Execution_forms.pdf).
 */
(function () {
  window.App = window.App || {};
  window.App.modules = window.App.modules || {};

  const forms = {

  'ex-affidavit-of-service': {
    label: 'Affidavit of Service',
    schema: [
      { section: 'Case Information' },
      { name: 'suitNumber', label: 'Suit Number', required: true, help: 'e.g. GM/12/2026' },
      { name: 'plaintiff',  label: 'Plaintiff',   required: true, full: true, type: 'textarea' },
      { name: 'defendant',  label: 'Defendant',   required: true, full: true, type: 'textarea' },
      { section: 'Deponent (Bailiff)' },
      { name: 'bailiffName', label: 'Bailiff Name', required: true },
      { section: 'Service Details' },
      { name: 'serviceDate', label: 'Date of Service', type: 'date', required: true },
      { name: 'serviceTime', label: 'Time of Service', required: true, help: 'e.g. 9:00' },
      { name: 'servedUpon', label: 'Served Upon (name)', required: true },
      { name: 'processDescription', label: 'Process / Document Served', required: true },
      { name: 'processSuitNo', label: 'Suit No. on Process' },
      { name: 'processDate', label: 'Date on Process', type: 'date' },
      { name: 'issuedAt', label: 'Issued Out of Court At', defaultValue: 'Gombe' },
      { name: 'complaintOf', label: 'Upon the Complaint / Application of' },
      { name: 'deliveredTo', label: 'Delivered Personally To', required: true },
      { name: 'recipientAddress', label: 'Recipient Address', type: 'textarea' },
      { name: 'placeOfService', label: 'Place of Service' },
      { section: 'Identification' },
      { name: 'unknownPerson', label: 'Person Initially Unknown (Before the day I served the…)' },
      { name: 'pointedOutBy', label: 'Pointed Out By' },
      { name: 'askedIdentity', label: 'I Asked Him/Her If He/She Were' },
      { name: 'identityResponse', label: 'And He/She Said That He/She Was' },
      { section: 'Oath' },
      { name: 'swornAt', label: 'Sworn At', defaultValue: 'High Court Registry, Gombe' },
      { name: 'swornDate', label: 'Date Sworn', type: 'date', required: true }
    ]
  },

  'writ-attachment-immovable': {
    label: 'Writ of Attachment and Sale (Movable/Immovable Property)',
    schema: [
      { section: 'Form Reference' },
      { name: 'writNo', label: 'Writ No.', required: true },
      { name: 'propertyCategory', label: 'Property Category', type: 'select', required: true,
        options: [{value:'immovable', label:'Immovable Property'}, {value:'movable', label:'Movable Property'}],
        defaultValue: 'immovable' },
      { name: 'courtName', label: 'Court Name / Description', defaultValue: 'High Court of Justice, Gombe State', required: true },
      { name: 'courtNo', label: 'Court No.' },
      { section: 'Parties' },
      { name: 'plaintiff', label: 'Plaintiff', required: true, full: true, type: 'textarea' },
      { name: 'defendant', label: 'Defendant', required: true, type: 'textarea' },
      { section: 'Judgment Details' },
      { name: 'judgmentCreditorsName', label: 'Judgment Creditor (obtained judgment)', required: true },
      { name: 'judgmentDebtorName', label: 'Judgment Debtor (judgment against)', required: true },
      { name: 'courtSittingAt', label: 'Court Sitting At', defaultValue: 'Gombe' },
      { name: 'judgmentDate', label: 'Date of Judgment', type: 'date', required: true },
      { name: 'installmentAmount', label: 'Instalment Amount (₦)', help: 'N___ for every ___' },
      { name: 'installmentPeriod', label: 'Instalment Period' },
      { name: 'subsequentCosts', label: 'Subsequent Costs Allowed (₦)' },
      { name: 'defaultSum', label: 'Amount in Default (₦)', required: true },
      { name: 'debtorPayableBy', label: 'Default Payable By (debtor name)' },
      { section: 'Attachment' },
      { name: 'movablePropertyDebtor', label: 'Debtor whose movable property was attached' },
      { name: 'failureReason', label: 'Reason Movable Attachment Failed' },
      { name: 'levyAmount', label: 'Amount to be Levied (₦)', required: true },
      { name: 'remainingDueTo', label: 'Remaining Due to (creditor name)' },
      { name: 'propertyOwner', label: 'Property Owner Name (whose property may be found)' },
      { name: 'issueDate', label: 'Date Issued', type: 'date', required: true }
    ]
  },

  'writ-possession-property': {
    label: 'Writ of Possession of Property (Ejectment)',
    schema: [
      { section: 'Parties' },
      { name: 'appellant',  label: 'Appellant',  required: true, full: true, type: 'textarea' },
      { name: 'respondent', label: 'Respondent', required: true, type: 'textarea' },
      { section: 'Judgment' },
      { name: 'courtDate', label: 'Court Date', type: 'date', required: true },
      { name: 'propertyAddress', label: 'Property Address / Location', required: true },
      { name: 'houseScheme', label: 'House Scheme Name' },
      { section: 'Non-Compliance' },
      { name: 'appellantTenant', label: 'Appellant / Tenant Name (who has not obeyed)', required: true },
      { name: 'issueDate', label: 'Date Issued', type: 'date', required: true }
    ]
  },

  'writ-possession-children': {
    label: 'Writ of Possession of Child/Children',
    schema: [
      { section: 'Parties' },
      { name: 'plaintiff',  label: 'Plaintiff',  required: true, full: true, type: 'textarea' },
      { name: 'defendant',  label: 'Defendant',  required: true, type: 'textarea' },
      { section: 'Judgment' },
      { name: 'courtDate', label: 'Court Date', type: 'date', required: true },
      { name: 'childrenResidence', label: 'Location where Child/Children are Living', required: true },
      { section: 'Non-Compliance' },
      { name: 'defendantPerson', label: 'Defendant / Person in Custody (who has not obeyed)', required: true },
      { name: 'custodyReceiver', label: 'Person to Receive Custody of Child/Children', required: true },
      { name: 'issueDate', label: 'Date Issued', type: 'date', required: true }
    ]
  },

  'writ-possession-premises': {
    label: 'Writ of Possession of Premises',
    schema: [
      { section: 'Parties' },
      { name: 'plaintiff',  label: 'Plaintiff',  required: true, full: true, type: 'textarea' },
      { name: 'defendant',  label: 'Defendant',  required: true, type: 'textarea' },
      { section: 'Property' },
      { name: 'courtHoldingAt', label: 'Court Holding At', defaultValue: 'Gombe' },
      { name: 'judgmentDate', label: 'Date of Judgment', type: 'date', required: true },
      { name: 'propertyType', label: 'Property Type', type: 'select', required: true,
        options: ['House', 'Plot', 'Farmland', 'Shop', 'Premises', 'Building'] },
      { name: 'propertyAddress', label: 'Property Address / Location', required: true, type: 'textarea' },
      { name: 'partyEntitled', label: 'Party Entitled to Possession', required: true,
        help: 'The judgment creditor / plaintiff who is entitled to possession' },
      { section: 'Non-Compliance' },
      { name: 'defaultingParty', label: 'Defaulting Party Name (who has not obeyed)', required: true },
      { name: 'beneficiary', label: 'Person to Give Possession To', required: true },
      { name: 'issueDate', label: 'Date Issued', type: 'date', required: true }
    ]
  },

  'judgment-summons': {
    label: 'Judgment Summons',
    schema: [
      { section: 'Case References' },
      { name: 'suitNo', label: 'No. of Plaint / Suit', required: true },
      { name: 'noJudgmentSummons', label: 'No. of Judgment Summons' },
      { name: 'noOrderCommitment', label: 'No. of Order of Commitment' },
      { section: 'Plaintiff' },
      { name: 'plaintiffName', label: "Plaintiff's Name in Full", required: true, full: true },
      { name: 'plaintiffResidence', label: 'Residence, Occupation or Description', type: 'textarea' },
      { section: 'Defendant(s)' },
      { name: 'defendantDetails', label: 'Full Names, Addresses and Occupations of All Defendants',
        type: 'textarea', required: true,
        help: 'Include all defendants. A separate order of warrant must be issued against every defendant required to be arrested.' },
      { name: 'commitmentDefendant', label: 'Defendant Against Whom Order of Commitment Was Made' },
      { name: 'commitmentDefendantAddress', label: 'Address and Occupation / Description', type: 'textarea' },
      { section: 'Application' },
      { name: 'applicationFor', label: 'I Apply for the Issue of', type: 'textarea', required: true },
      { name: 'solicitorName', label: 'Judgment Creditor / Solicitor for Judgment Creditor', required: true },
      { name: 'solicitorAddress', label: "Solicitor's Address", type: 'textarea' },
      { section: "Registrar's Completion (Preaciple)" },
      { name: 'ledgerFolio', label: 'Ledger Folio' },
      { name: 'judgmentOrderDate', label: 'Date of Judgment / Order', type: 'date' },
      { name: 'committedOn', label: 'Committed On', type: 'date' },
      { name: 'committedFor', label: 'Committed For' },
      { name: 'orderSuspendedFor', label: 'Order Suspended For' },
      { name: 'suspendedOnPayment', label: 'On Payment of (₦)' },
      { name: 'subsistenceAllowance', label: 'Subsistence Allowance per Diem (₦)' },
      { name: 'paidBeforeWarrant', label: 'Amount to be Paid Before Issue of Warrant (₦)' },
      { name: 'applicationDate', label: 'Date of Application', type: 'date' },
      { name: 'applicationTime', label: 'Time of Application', help: 'e.g. 9:00 a.m.' }
    ]
  },

  'notice-of-attachment': {
    label: 'Notice of Attachment (Form 41)',
    schema: [
      { section: 'Case Information' },
      { name: 'suitNumber', label: 'Suit No.', required: true },
      { name: 'plaintiff', label: 'Plaintiff', required: true, full: true, type: 'textarea' },
      { name: 'defendant', label: 'Defendant', required: true, type: 'textarea' },
      { section: 'Attachment Details' },
      { name: 'attachedProperty', label: 'Property / Item Attached', required: true, type: 'textarea',
        help: 'Describe the property or goods being attached' },
      { name: 'propertyDaysCount', label: 'Days Before Sale', defaultValue: '5',
        help: 'Number of days after attachment before property may be sold' },
      { section: 'Financial Summary' },
      { name: 'writAmount', label: 'Amount for Which Writ Was Issued (₦)', required: true },
      { name: 'writCostFee', label: 'Fees on Issue of Writ Cost (₦)' },
      { name: 'totalAmountLevied', label: 'Total Amount to be Levied Exclusive of Fees (₦)', required: true },
      { name: 'expensesAfterAttachment', label: 'Expenses Incurred After Attachment (₦)' },
      { name: 'issueDate', label: 'Date Issued', type: 'date', required: true }
    ]
  },

  'statutory-notice-auction': {
    label: 'Statutory Notice for Public Auction',
    schema: [
      { section: 'Letter Reference' },
      { name: 'ourRef', label: 'Our Reference No.', defaultValue: 'HCJ/GM/PLD/VOL.I/' },
      { name: 'letterDate', label: 'Date of Letter', type: 'date', required: true },
      { section: 'Recipient' },
      { name: 'recipientName', label: 'Recipient Name', required: true, full: true },
      { name: 'recipientAddress', label: 'Recipient Address', type: 'textarea', required: true },
      { section: 'Case Details' },
      { name: 'suitTitle', label: 'Suit Title (e.g. Mela vs Tadi)', required: true },
      { name: 'courtName', label: 'Court Whose Judgment is Being Enforced', required: true,
        help: 'e.g. Upper Area Court Filiya' },
      { name: 'propertyCategory', label: 'Property Category', type: 'select', required: true,
        options: [{value:'immovable', label:'Immovable Property'}, {value:'movable', label:'Movable Property'}],
        defaultValue: 'immovable' },
      { name: 'noticeDays', label: 'Days to Satisfy Judgment', defaultValue: '5' },
      { section: 'Signature' },
      { name: 'chiefBailiffName', label: "Chief Bailiff's Name", required: true },
      { name: 'issueDate', label: 'Date Issued', type: 'date', required: true }
    ]
  },

  'request-nscdc-personnel': {
    label: 'Request for NSCDC Personnel',
    schema: [
      { section: 'Letter Reference' },
      { name: 'ourRef', label: 'Our Reference No.', defaultValue: 'HCJ/GM/PLD/VOL.I/' },
      { name: 'letterDate', label: 'Date of Letter', type: 'date', required: true },
      { section: 'Recipient' },
      { name: 'recipientTitle', label: 'Recipient Title / Designation',
        defaultValue: 'The NSCDC Divisional Officer' },
      { name: 'recipientDivision', label: 'Division / Organisation' },
      { name: 'recipientAddress', label: 'Address', type: 'textarea',
        defaultValue: 'Gombe State' },
      { section: 'Case' },
      { name: 'personnelCount', label: 'Number of Personnel Required', required: true,
        help: 'e.g. Two, Three, Five' },
      { name: 'suitTitle', label: 'Case Title (Parties)', required: true, full: true },
      { name: 'suitNumber', label: 'Suit Number', required: true },
      { name: 'courtName', label: 'Court Whose Judgment is Being Enforced', required: true },
      { name: 'enforcementLocation', label: 'Enforcement Location', required: true },
      { section: 'Signature' },
      { name: 'chiefBailiffName', label: "Chief Bailiff's Name", required: true }
    ]
  },

  'public-auction-receipt': {
    label: 'Public Auction Receipt',
    schema: [
      { section: 'Receipt Details' },
      { name: 'receivedFrom', label: 'Received From', required: true, full: true, type: 'textarea' },
      { name: 'sumAmount', label: 'The Sum of (₦ in words and figures)', required: true, type: 'textarea' },
      { name: 'beingPaymentFor', label: 'Being Payment For', required: true, type: 'textarea' },
      { section: 'Date' },
      { name: 'receiptDate', label: 'Date of Receipt', type: 'date', required: true },
      { section: 'Signatories' },
      { name: 'deputySheriffName', label: 'Deputy Sheriff Name', required: true },
      { name: 'chiefBailiffName', label: 'Chief Bailiff Name', required: true }
    ]
  },

  'request-police-assistance': {
    label: 'Request for Police Assistance',
    schema: [
      { section: 'Letter Reference' },
      { name: 'ourRef', label: 'Our Reference No.', defaultValue: 'HCJ/CRO/S/VOL.I/' },
      { name: 'letterDate', label: 'Date of Letter', type: 'date', required: true },
      { section: 'Recipient' },
      { name: 'recipientTitle', label: 'Recipient Title / Designation',
        defaultValue: 'The Commissioner of Police' },
      { name: 'recipientDivision', label: 'Command / Division', defaultValue: 'Gombe State Police Command' },
      { name: 'recipientAddress', label: 'Address', type: 'textarea', defaultValue: 'Gombe State' },
      { section: 'Case' },
      { name: 'personnelCount', label: 'Number of Personnel Required', required: true,
        help: 'e.g. Two, Three, Five' },
      { name: 'suitTitle', label: 'Case Title (Parties)', required: true, full: true },
      { name: 'suitNumber', label: 'Suit Number', required: true },
      { name: 'courtName', label: 'Court Whose Judgment is Being Enforced', required: true },
      { name: 'enforcementLocation', label: 'Enforcement Location', required: true },
      { section: 'Signature' },
      { name: 'chiefBailiffName', label: "Chief Bailiff's Name", required: true }
    ]
  },

  'notice-to-vacate': {
    label: 'Notice to Vacate After Sale',
    schema: [
      { section: 'Letter Reference' },
      { name: 'ourRef', label: 'Our Reference No.', defaultValue: 'HCJ/GM/PLD/VOL.I/' },
      { name: 'letterDate', label: 'Date of Letter', type: 'date', required: true },
      { section: 'Recipient' },
      { name: 'recipientName', label: 'Recipient Name', required: true, full: true },
      { name: 'recipientAddress', label: 'Recipient Address', type: 'textarea', required: true },
      { section: 'Case & Property' },
      { name: 'caseTitle', label: 'Case Title (Re: Case of…)', required: true },
      { name: 'judgmentSum', label: 'Judgment Sum (₦)', required: true },
      { name: 'propertyType', label: 'Type of Property', type: 'select', required: true,
        options: ['house', 'shop', 'premises', 'farmland', 'building', 'property'] },
      { name: 'propertyAddress', label: 'Property Address / Location', required: true, type: 'textarea' },
      { name: 'noticeDays', label: 'Notice Period (days)', defaultValue: '7' },
      { section: 'Signature' },
      { name: 'chiefBailiffName', label: "Chief Bailiff's Name", required: true },
      { name: 'issueDate', label: 'Date Issued', type: 'date', required: true }
    ]
  },

  'writ-attachment-goods': {
    label: 'Writ of Attachment and Sale of Goods',
    schema: [
      { section: 'Case Details' },
      { name: 'judicialDivision', label: 'Judicial Division / Magisterial District', required: true,
        defaultValue: 'Gombe Judicial Division' },
      { name: 'plaintiff', label: 'Plaintiff', required: true, full: true, type: 'textarea' },
      { name: 'suitNo', label: 'Plaint / Suit No.', required: true },
      { name: 'defendant', label: 'Defendant', required: true, type: 'textarea' },
      { section: 'Judgment' },
      { name: 'judgmentDate', label: 'Date of Judgment / Order', type: 'date', required: true },
      { name: 'judgmentDetails', label: 'Summary of Judgment / What Was Ordered', type: 'textarea', required: true },
      { name: 'defaultDate', label: 'Date of Default in Payment', type: 'date' },
      { section: 'Execution Amounts' },
      { name: 'executionSumNaira', label: 'Execution Sum — Naira (₦)', required: true },
      { name: 'executionSumKobo', label: 'Execution Sum — Kobo (k)' },
      { name: 'totalSumNaira', label: 'Total Sum Remaining Unpaid — Naira (₦)', required: true },
      { name: 'totalSumKobo', label: 'Total Sum Remaining Unpaid — Kobo (k)' },
      { name: 'debtorName', label: 'Judgment Debtor Name (whose goods are to be seized)', required: true },
      { name: 'creditorName', label: 'Judgment Creditor Name (to whom amount is due)', required: true },
      { section: 'Sheriff Section' },
      { name: 'amountCostRemaining', label: 'Amount / Cost Remaining Due (₦ : k)' },
      { name: 'feesOnIssue', label: 'Fees on Issue of This Writ (₦ : k)' },
      { name: 'totalAmountLevied', label: 'Total Amount to be Levied (₦)' },
      { name: 'issueDate', label: 'Date Issued', type: 'date', required: true }
    ]
  },

  'writ-possession-occupancy': {
    label: 'Writ of Possession of Certificate of Occupancy',
    schema: [
      { section: 'Parties' },
      { name: 'plaintiff',  label: 'Plaintiff',  required: true, full: true, type: 'textarea' },
      { name: 'defendant',  label: 'Defendant',  required: true, type: 'textarea' },
      { section: 'Judgment' },
      { name: 'courtDate', label: 'Court Date', type: 'date', required: true },
      { name: 'coDescription', label: 'Certificate of Occupancy Details / Number', required: true, type: 'textarea' },
      { section: 'Non-Compliance' },
      { name: 'judgmentDebtorName', label: 'Judgment Debtor Name (who has not obeyed)', required: true },
      { name: 'beneficiary', label: 'Person to Receive the Certificate of Occupancy', required: true },
      { name: 'issueDate', label: 'Date Issued', type: 'date', required: true }
    ]
  }

  };

  // ── Register forms globally so other units can be granted access ──
  window.App.allForms = window.App.allForms || {};
  window.App.allFormsByModule = window.App.allFormsByModule || {};
  Object.assign(window.App.allForms, forms);
  window.App.allFormsByModule['Execution'] = forms;

  window.App.modules.execution = {
    id: 'execution',
    forms,
    render(container, ctx) {
      window.App.recordEngine.render(container, ctx, {
        store: 'execution_records',
        subtitle: 'Execution Unit — writs, attachments & enforcement',
        forms
      });
    }
  };
})();
