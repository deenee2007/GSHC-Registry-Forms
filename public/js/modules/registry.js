/*
 * modules/registry.js — Court Registry module (drives High Court 1–9).
 * One module instance serves any of the nine courts; the router passes the
 * specific court via ctx.unit, and the standard masthead shows that unit.
 * The 13 form schemas below are the real registry forms (English only).
 */
(function () {
  window.App = window.App || {};
  window.App.modules = window.App.modules || {};

  const forms = {
  "civil-summons": {
    "label": "Civil Summons",
    "description": "Generates a civil summons for service on a defendant.",
    "schema": [
      {
        "section": "Case Information"
      },
      {
        "name": "division",
        "label": "Judicial Division",
        "type": "text",
        "required": true,
        "defaultValue": "Gombe Judicial Division"
      },
      {
        "name": "suitNumber",
        "label": "Suit Number",
        "type": "text",
        "required": true,
        "help": "Example: GM/12/2026. No separate year is required because the year is contained in the suit number."
      },
      {
        "name": "plaintiff",
        "label": "Plaintiff",
        "type": "textarea",
        "required": true
      },
      {
        "name": "plaintiffAddress",
        "label": "Plaintiff Address",
        "type": "textarea",
        "required": true
      },
      {
        "name": "defendant",
        "label": "Defendant",
        "type": "textarea",
        "required": true
      },
      {
        "name": "recipientName",
        "label": "Recipient Name",
        "type": "text",
        "required": true
      },
      {
        "name": "recipientAddress",
        "label": "Recipient Address",
        "type": "textarea",
        "required": true
      },
      {
        "section": "Summons Details"
      },
      {
        "name": "courtPlace",
        "label": "Court Place / Court Room",
        "type": "text",
        "required": true,
        "help": "The court and its number, e.g. High Court No. 1. On a court registry's forms it is filled in for you."
      },
      {
        "name": "appearanceDate",
        "label": "Date of Appearance",
        "type": "date",
        "required": true
      },
      {
        "name": "appearanceTime",
        "label": "Time of Appearance",
        "type": "text",
        "defaultValue": "9:00",
        "required": true,
        "help": "Example: 9:00"
      },
      {
        "name": "timePeriod",
        "label": "Time Period",
        "type": "select",
        "required": true,
        "defaultValue": "forenoon",
        "options": [
          "forenoon",
          "afternoon"
        ]
      },
      {
        "section": "Issuance and Fees"
      },
      {
        "name": "issuePlace",
        "label": "Issued At",
        "type": "text",
        "required": true,
        "defaultValue": "Gombe"
      },
      {
        "name": "issueDate",
        "label": "Date of Issue",
        "type": "date",
        "required": true
      },
      {
        "name": "summonsFee",
        "label": "Summons Fee (₦)",
        "type": "text",
        "required": false
      },
      {
        "name": "serviceFee",
        "label": "Service Fee (₦)",
        "type": "text",
        "required": false
      },
      {
        "name": "mileage",
        "label": "Mileage (₦)",
        "type": "text",
        "required": false
      }
    ]
  },
  "witness-summons": {
    "label": "Witness Summons",
    "description": "Summons a witness to attend court and give evidence.",
    "schema": [
      {
        "section": "Case Information"
      },
      {
        "name": "courtName",
        "label": "Court Name",
        "type": "text",
        "required": true,
        "defaultValue": "High Court of Justice, Gombe"
      },
      {
        "name": "caseNumber",
        "label": "Case Number",
        "type": "text",
        "required": true,
        "help": "Example: GM/CR/12/2026"
      },
      {
        "name": "complainant",
        "label": "Complainant",
        "type": "textarea",
        "required": true
      },
      {
        "name": "defendant",
        "label": "Defendant",
        "type": "textarea",
        "required": true
      },
      {
        "section": "Witness Information"
      },
      {
        "name": "witnessName",
        "label": "Witness Name",
        "type": "text",
        "required": true
      },
      {
        "name": "witnessAddress",
        "label": "Witness Address",
        "type": "textarea",
        "required": true
      },
      {
        "section": "Complaint / Offence Details"
      },
      {
        "name": "accusedName",
        "label": "Person Accused / Suspected",
        "type": "text",
        "required": true
      },
      {
        "name": "accusedAddress",
        "label": "Address of Person Accused / Suspected",
        "type": "textarea",
        "required": true
      },
      {
        "name": "offenceDescription",
        "label": "Offence Description",
        "type": "textarea",
        "required": true,
        "help": "State the offence clearly. Guidance text will not appear on the print output."
      },
      {
        "section": "Summons Details"
      },
      {
        "name": "appearBefore",
        "label": "To Appear Before",
        "type": "text",
        "required": true,
        "defaultValue": "the High Court of Justice, Gombe"
      },
      {
        "name": "appearanceDate",
        "label": "Date of Appearance",
        "type": "date",
        "required": true
      },
      {
        "name": "appearanceTime",
        "label": "Time of Appearance",
        "type": "text",
        "defaultValue": "9:00",
        "required": true,
        "help": "Example: 9:00"
      },
      {
        "section": "Issuance"
      },
      {
        "name": "issueDate",
        "label": "Date Issued",
        "type": "date",
        "required": true
      }
    ]
  },
  "order-to-produce-prisoner": {
    "label": "Order to Produce a Prisoner",
    "description": "Orders prison authority to produce a prisoner before court.",
    "schema": [
      {
        "section": "Case Information"
      },
      {
        "name": "courtName",
        "label": "Court Name",
        "type": "text",
        "required": true,
        "defaultValue": "High Court of Justice, Gombe"
      },
      {
        "name": "caseNumber",
        "label": "Case Number",
        "type": "text",
        "required": true
      },
      {
        "name": "complainant",
        "label": "Complainant",
        "type": "textarea",
        "required": true
      },
      {
        "name": "defendant",
        "label": "Defendant",
        "type": "textarea",
        "required": true
      },
      {
        "section": "Custody Information"
      },
      {
        "name": "prisonLocation",
        "label": "Prison Location",
        "type": "text",
        "required": true,
        "help": "This fills: To the keeper of the prison at..."
      },
      {
        "name": "prisonerName",
        "label": "Prisoner Name",
        "type": "text",
        "required": true
      },
      {
        "section": "Production Details"
      },
      {
        "name": "courtToProduceBefore",
        "label": "Court to Produce Before",
        "type": "text",
        "required": true,
        "defaultValue": "High Court of Justice, Gombe"
      },
      {
        "name": "courtLocation",
        "label": "Court Location",
        "type": "text",
        "required": true,
        "defaultValue": "Gombe"
      },
      {
        "name": "productionDate",
        "label": "Production Date",
        "type": "date",
        "required": true
      },
      {
        "name": "productionTime",
        "label": "Production Time",
        "type": "text",
        "defaultValue": "9:00",
        "required": true,
        "help": "Example: 9:00"
      },
      {
        "section": "Issuance"
      },
      {
        "name": "issuedAt",
        "label": "Issued At",
        "type": "text",
        "required": true,
        "defaultValue": "Gombe"
      },
      {
        "name": "issueDate",
        "label": "Date Issued",
        "type": "date",
        "required": true
      }
    ]
  },
  "criminal-summons": {
    "label": "Criminal Summons",
    "description": "Summons an accused person to answer a criminal charge.",
    "schema": [
      {
        "section": "Case Information"
      },
      {
        "name": "courtLocation",
        "label": "Court Location (Holden at)",
        "type": "text",
        "required": true,
        "defaultValue": "Gombe"
      },
      {
        "name": "caseNumber",
        "label": "Case Number",
        "type": "text",
        "required": true
      },
      {
        "name": "complainant",
        "label": "Complainant",
        "type": "textarea",
        "required": true,
        "defaultValue": "The People of Gombe State"
      },
      {
        "name": "defendant",
        "label": "Defendant / Accused",
        "type": "textarea",
        "required": true
      },
      {
        "section": "Accused Details"
      },
      {
        "name": "accusedName",
        "label": "Accused Name",
        "type": "text",
        "required": true
      },
      {
        "name": "accusedAddress",
        "label": "Accused Address",
        "type": "textarea",
        "required": true
      },
      {
        "section": "Offence"
      },
      {
        "name": "offence",
        "label": "Offence Description",
        "type": "textarea",
        "required": true
      },
      {
        "name": "offencePlace",
        "label": "Place of Offence",
        "type": "text",
        "required": true
      },
      {
        "name": "offenceDate",
        "label": "Date of Offence",
        "type": "date",
        "required": true
      },
      {
        "section": "Appearance"
      },
      {
        "name": "appearanceCourt",
        "label": "Court to Appear Before",
        "type": "text",
        "required": true,
        "help": "The court and its number, e.g. High Court No. 1. On a court registry's forms it is filled in for you."
      },
      {
        "name": "appearanceDate",
        "label": "Appearance Date",
        "type": "date",
        "required": true
      },
      {
        "name": "appearanceTime",
        "label": "Appearance Time",
        "type": "text",
        "defaultValue": "9:00",
        "required": true
      },
      {
        "section": "Issuance"
      },
      {
        "name": "issueDate",
        "label": "Date Issued",
        "type": "date",
        "required": true
      }
    ]
  },
  "warrant-of-arrest": {
    "label": "Warrant of Arrest",
    "description": "Commands the arrest and production of an accused person.",
    "schema": [
      {
        "section": "Case Information"
      },
      {
        "name": "courtName",
        "label": "Court Name",
        "type": "text",
        "required": true,
        "defaultValue": "High Court of Justice, Gombe"
      },
      {
        "name": "caseNumber",
        "label": "Case Number",
        "type": "text",
        "required": true
      },
      {
        "name": "complainant",
        "label": "Complainant",
        "type": "textarea",
        "required": true,
        "defaultValue": "The People of Gombe State"
      },
      {
        "name": "defendant",
        "label": "Defendant / Accused",
        "type": "textarea",
        "required": true
      },
      {
        "section": "Person to be Arrested"
      },
      {
        "name": "accusedName",
        "label": "Name of Person to be Arrested",
        "type": "text",
        "required": true
      },
      {
        "name": "accusedAddress",
        "label": "Address / Description",
        "type": "textarea",
        "required": false
      },
      {
        "section": "Offence Details"
      },
      {
        "name": "offenceDescription",
        "label": "Offence Description",
        "type": "textarea",
        "required": true
      },
      {
        "name": "offencePlace",
        "label": "Place of Offence",
        "type": "text",
        "required": false
      },
      {
        "name": "offenceDate",
        "label": "Date of Offence",
        "type": "date",
        "required": false
      },
      {
        "section": "Execution / Production"
      },
      {
        "name": "officerAddressed",
        "label": "Officer Addressed",
        "type": "text",
        "required": true,
        "defaultValue": "All Police Officers"
      },
      {
        "name": "courtToBringBefore",
        "label": "Court to Bring Accused Before",
        "type": "text",
        "required": true,
        "defaultValue": "High Court of Justice, Gombe"
      },
      {
        "section": "Issuance"
      },
      {
        "name": "issuedAt",
        "label": "Issued At",
        "type": "text",
        "required": true,
        "defaultValue": "Gombe"
      },
      {
        "name": "issueDate",
        "label": "Date Issued",
        "type": "date",
        "required": true
      }
    ]
  },
  "bail-bond": {
    "label": "Bail Bond",
    "description": "Prepares bail bond for an accused person and surety.",
    "schema": [
      {
        "section": "Case Information"
      },
      {
        "name": "courtName",
        "label": "Court Name",
        "type": "text",
        "required": true,
        "defaultValue": "High Court of Justice, Gombe"
      },
      {
        "name": "caseNumber",
        "label": "Case Number",
        "type": "text",
        "required": true
      },
      {
        "name": "complainant",
        "label": "Complainant",
        "type": "textarea",
        "required": true
      },
      {
        "name": "defendant",
        "label": "Defendant",
        "type": "textarea",
        "required": true
      },
      {
        "section": "Accused Bond"
      },
      {
        "name": "accusedName",
        "label": "Accused Name",
        "type": "text",
        "required": true
      },
      {
        "name": "accusedAddress",
        "label": "Accused Address",
        "type": "textarea",
        "required": true
      },
      {
        "name": "policeStation",
        "label": "Police Station / Place of Arrest",
        "type": "text",
        "required": false
      },
      {
        "name": "appearanceCourt",
        "label": "Court to Attend",
        "type": "text",
        "required": true,
        "help": "The court and its number, e.g. High Court No. 1. On a court registry's forms it is filled in for you."
      },
      {
        "name": "offenceDescription",
        "label": "Offence Description",
        "type": "textarea",
        "required": true
      },
      {
        "name": "appearanceDate",
        "label": "Date of Appearance",
        "type": "date",
        "required": true
      },
      {
        "name": "appearanceTime",
        "label": "Time of Appearance",
        "type": "text",
        "defaultValue": "9:00",
        "required": true
      },
      {
        "name": "accusedBondAmount",
        "label": "Accused Bond Amount (₦)",
        "type": "text",
        "required": true
      },
      {
        "section": "Surety Bond"
      },
      {
        "name": "suretyName",
        "label": "Surety Name",
        "type": "text",
        "required": true
      },
      {
        "name": "suretyAddress",
        "label": "Surety Address",
        "type": "textarea",
        "required": true
      },
      {
        "name": "suretyBondAmount",
        "label": "Surety Bond Amount (₦)",
        "type": "text",
        "required": true
      },
      {
        "section": "Issuance"
      },
      {
        "name": "issueDate",
        "label": "Date Issued",
        "type": "date",
        "required": true
      }
    ]
  },
  "affidavit-of-service": {
    "label": "Affidavit of Service",
    "description": "Records proof of service of court process.",
    "schema": [
      {
        "section": "Case Information"
      },
      {
        "name": "division",
        "label": "Judicial Division",
        "type": "text",
        "required": true,
        "defaultValue": "Gombe Judicial Division"
      },
      {
        "name": "suitNumber",
        "label": "Suit Number",
        "type": "text",
        "required": true
      },
      {
        "name": "plaintiff",
        "label": "Plaintiff",
        "type": "textarea",
        "required": true
      },
      {
        "name": "defendant",
        "label": "Defendant",
        "type": "textarea",
        "required": true
      },
      {
        "section": "Bailiff / Deponent"
      },
      {
        "name": "bailiffName",
        "label": "Bailiff / Deponent Name",
        "type": "text",
        "required": true
      },
      {
        "section": "Service Details"
      },
      {
        "name": "serviceDate",
        "label": "Date of Service",
        "type": "date",
        "required": true
      },
      {
        "name": "serviceTime",
        "label": "Time of Service",
        "type": "text",
        "required": true
      },
      {
        "name": "servedUpon",
        "label": "Person Served Upon",
        "type": "text",
        "required": true
      },
      {
        "name": "personServedGender",
        "label": "Gender of Person Served",
        "type": "select",
        "required": true,
        "options": [
          "Male",
          "Female"
        ]
      },
      {
        "name": "processServed",
        "label": "Process / Document Served",
        "type": "text",
        "required": true
      },
      {
        "name": "processSuitNumber",
        "label": "Suit Number on Process",
        "type": "text",
        "required": false
      },
      {
        "name": "processDate",
        "label": "Date on Process",
        "type": "date",
        "required": false
      },
      {
        "name": "issuedAt",
        "label": "Issued Out of Court At",
        "type": "text",
        "required": true,
        "defaultValue": "Gombe"
      },
      {
        "name": "complaintOf",
        "label": "Upon the Complaint/Application of",
        "type": "text",
        "required": false
      },
      {
        "name": "deliveredTo",
        "label": "Delivered Personally To",
        "type": "text",
        "required": true
      },
      {
        "name": "recipientAddress",
        "label": "Recipient Address",
        "type": "textarea",
        "required": true
      },
      {
        "name": "placeOfService",
        "label": "Place of Service",
        "type": "text",
        "required": true
      },
      {
        "section": "Identification Details"
      },
      {
        "name": "unknownPerson",
        "label": "Person Initially Unknown To Bailiff",
        "type": "text",
        "required": false
      },
      {
        "name": "pointedOutBy",
        "label": "Pointed Out By",
        "type": "text",
        "required": false
      },
      {
        "name": "askedIdentity",
        "label": "Person Asked If He/She Was",
        "type": "text",
        "required": false
      },
      {
        "name": "identityResponse",
        "label": "Identity Response",
        "type": "text",
        "required": false
      },
      {
        "section": "Oath"
      },
      {
        "name": "swornAt",
        "label": "Sworn At",
        "type": "text",
        "required": true,
        "defaultValue": "High Court Registry, Gombe"
      },
      {
        "name": "swornDate",
        "label": "Date Sworn",
        "type": "date",
        "required": true
      }
    ]
  },
  "affidavit-of-means": {
    "label": "Affidavit of Means",
    "description": "Captures a surety’s financial means and declaration.",
    "schema": [
      {
        "section": "Case / Declarant Information"
      },
      {
        "name": "courtName",
        "label": "Court Name",
        "type": "text",
        "required": true,
        "defaultValue": "High Court of Justice, Gombe"
      },
      {
        "name": "caseNumber",
        "label": "Case Number",
        "type": "text",
        "required": false
      },
      {
        "name": "declarantName",
        "label": "Declarant / Surety Name",
        "type": "text",
        "required": true
      },
      {
        "name": "declarantAddress",
        "label": "Declarant Address",
        "type": "textarea",
        "required": true
      },
      {
        "name": "stateOfOrigin",
        "label": "State of Origin",
        "type": "text",
        "required": false
      },
      {
        "section": "Surety Declaration"
      },
      {
        "name": "accusedName",
        "label": "Accused Person",
        "type": "text",
        "required": true
      },
      {
        "name": "occupation",
        "label": "Occupation / Status",
        "type": "text",
        "required": true
      },
      {
        "name": "propertyAddress",
        "label": "House / Property Address",
        "type": "textarea",
        "required": false
      },
      {
        "name": "estimatedWorth",
        "label": "Estimated Worth / Value",
        "type": "text",
        "required": false
      },
      {
        "name": "relationship",
        "label": "Relationship / Standing",
        "type": "textarea",
        "required": false
      },
      {
        "section": "Oath / Interpretation"
      },
      {
        "name": "swornAt",
        "label": "Sworn At",
        "type": "text",
        "required": true,
        "defaultValue": "High Court Registry, Gombe"
      },
      {
        "name": "swornDate",
        "label": "Date Sworn",
        "type": "date",
        "required": true
      },
      {
        "name": "interpreterName",
        "label": "Interpreter Name",
        "type": "text",
        "required": false
      },
      {
        "section": "Payment / Receipt"
      },
      {
        "name": "feeWords",
        "label": "Fee Paid in Words",
        "type": "text",
        "required": false
      },
      {
        "name": "feeAmount",
        "label": "Fee Amount (₦)",
        "type": "text",
        "required": false
      },
      {
        "name": "receiptNumber",
        "label": "Receipt Number",
        "type": "text",
        "required": false
      },
      {
        "name": "receiptDate",
        "label": "Receipt Date",
        "type": "date",
        "required": false
      }
    ]
  },
  "subpoena-ad-testificandum": {
    "label": "Subpoena ad Testificandum",
    "description": "Commands a witness to attend and testify.",
    "schema": [
      {
        "section": "Case Information"
      },
      {
        "name": "courtName",
        "label": "Court Name",
        "type": "text",
        "required": true,
        "defaultValue": "High Court of Justice of Gombe State of Nigeria, Holden at Gombe"
      },
      {
        "name": "division",
        "label": "Judicial Division",
        "type": "text",
        "required": true,
        "defaultValue": "Gombe Judicial Division"
      },
      {
        "name": "suitNumber",
        "label": "Suit Number",
        "type": "text",
        "required": true
      },
      {
        "name": "plaintiff",
        "label": "Plaintiff / Applicant",
        "type": "textarea",
        "required": true
      },
      {
        "name": "defendant",
        "label": "Defendant / Respondent",
        "type": "textarea",
        "required": true
      },
      {
        "section": "Witness Information"
      },
      {
        "name": "witnessName",
        "label": "Witness Name",
        "type": "text",
        "required": true
      },
      {
        "name": "witnessAddress",
        "label": "Witness Address",
        "type": "textarea",
        "required": true
      },
      {
        "section": "Attendance Details"
      },
      {
        "name": "courtLocation",
        "label": "Court Location",
        "type": "text",
        "required": true,
        "defaultValue": "High Court of Justice, Gombe"
      },
      {
        "name": "attendanceDate",
        "label": "Attendance Date",
        "type": "date",
        "required": true
      },
      {
        "name": "attendanceTime",
        "label": "Attendance Time",
        "type": "text",
        "defaultValue": "9:00",
        "required": true
      },
      {
        "name": "causeDescription",
        "label": "Cause Description / Purpose",
        "type": "textarea",
        "required": false
      },
      {
        "section": "Issuance"
      },
      {
        "name": "issueDate",
        "label": "Date Issued",
        "type": "date",
        "required": true
      }
    ]
  },
  "subpoena-duces-tecum": {
    "label": "Subpoena Duces Tecum",
    "description": "Commands production of specified documents in court.",
    "schema": [
      {
        "section": "Case Information"
      },
      {
        "name": "courtName",
        "label": "Court Name",
        "type": "text",
        "required": true,
        "defaultValue": "High Court of Justice of Gombe State of Nigeria"
      },
      {
        "name": "division",
        "label": "Judicial Division",
        "type": "text",
        "required": true,
        "defaultValue": "Gombe Judicial Division"
      },
      {
        "name": "suitNumber",
        "label": "Suit Number",
        "type": "text",
        "required": true
      },
      {
        "name": "plaintiff",
        "label": "Plaintiff",
        "type": "textarea",
        "required": true
      },
      {
        "name": "defendant",
        "label": "Defendant",
        "type": "textarea",
        "required": true
      },
      {
        "section": "Addressee"
      },
      {
        "name": "recipientName",
        "label": "Recipient Name",
        "type": "text",
        "required": true
      },
      {
        "name": "recipientAddress",
        "label": "Recipient Address",
        "type": "textarea",
        "required": true
      },
      {
        "section": "Attendance"
      },
      {
        "name": "courtLocation",
        "label": "Court Location",
        "type": "text",
        "required": true,
        "defaultValue": "High Court No. 3, Gombe"
      },
      {
        "name": "attendanceDate",
        "label": "Attendance Date",
        "type": "date",
        "required": true
      },
      {
        "name": "attendanceTime",
        "label": "Attendance Time",
        "type": "text",
        "defaultValue": "9:00",
        "required": true
      },
      {
        "section": "Documents"
      },
      {
        "name": "documents",
        "label": "Documents to be Produced",
        "type": "textarea",
        "required": true
      },
      {
        "section": "Issuance"
      },
      {
        "name": "issueDate",
        "label": "Date Issued",
        "type": "date",
        "required": true
      }
    ]
  },
  "hearing-notice": {
    "label": "Hearing Notice",
    "description": "Notifies parties of the date and stage of hearing.",
    "schema": [
      {
        "section": "Case Information"
      },
      {
        "name": "courtName",
        "label": "Court Name",
        "type": "text",
        "required": true,
        "defaultValue": "High Court of Justice, Gombe"
      },
      {
        "name": "suitNumber",
        "label": "Suit Number",
        "type": "text",
        "required": true
      },
      {
        "name": "plaintiff",
        "label": "Plaintiff",
        "type": "textarea",
        "required": true
      },
      {
        "name": "defendant",
        "label": "Defendant",
        "type": "textarea",
        "required": true
      },
      {
        "section": "Recipient"
      },
      {
        "name": "recipientName",
        "label": "Recipient Name",
        "type": "text",
        "required": true
      },
      {
        "name": "recipientAddress",
        "label": "Recipient Address",
        "type": "textarea",
        "required": true
      },
      {
        "section": "Hearing Details"
      },
      {
        "name": "stage",
        "label": "Stage (Mention/Hearing/Judgment etc.)",
        "type": "text",
        "required": true
      },
      {
        "name": "hearingDate",
        "label": "Hearing Date",
        "type": "date",
        "required": true
      },
      {
        "name": "hearingTime",
        "label": "Hearing Time",
        "type": "text",
        "defaultValue": "9:00",
        "required": true
      },
      {
        "section": "Issuance"
      },
      {
        "name": "issuePlace",
        "label": "Issued At",
        "type": "text",
        "required": true,
        "defaultValue": "Gombe"
      },
      {
        "name": "issueDate",
        "label": "Date Issued",
        "type": "date",
        "required": true
      }
    ]
  },
  "remand-warrant": {
    "label": "Remand Warrant",
    "description": "Commits an accused person to custody on remand.",
    "schema": [
      {
        "section": "Case Information"
      },
      {
        "name": "courtName",
        "label": "Court Name",
        "type": "text",
        "required": true,
        "defaultValue": "High Court of Justice, Gombe"
      },
      {
        "name": "caseNumber",
        "label": "Case Number",
        "type": "text",
        "required": true
      },
      {
        "name": "complainant",
        "label": "Complainant",
        "type": "textarea",
        "required": true
      },
      {
        "name": "defendant",
        "label": "Defendant",
        "type": "textarea",
        "required": true
      },
      {
        "section": "Accused Details"
      },
      {
        "name": "accusedName",
        "label": "Name of Accused",
        "type": "text",
        "required": true
      },
      {
        "name": "raceOrTribe",
        "label": "Race or Tribe",
        "type": "text",
        "required": false
      },
      {
        "name": "residence",
        "label": "Residence",
        "type": "textarea",
        "required": true
      },
      {
        "name": "occupation",
        "label": "Occupation",
        "type": "text",
        "required": false
      },
      {
        "section": "Custody and Offence Details"
      },
      {
        "name": "prisonLocation",
        "label": "Prison Location",
        "type": "text",
        "required": true
      },
      {
        "name": "offenceDescription",
        "label": "Offence Description",
        "type": "textarea",
        "required": true,
        "help": "State the offence concisely with time and place. This guidance will not appear on print output."
      },
      {
        "section": "Return and Issuance"
      },
      {
        "name": "returnDate",
        "label": "Return Date / Disposal Date",
        "type": "date",
        "required": true
      },
      {
        "name": "issueDate",
        "label": "Date Issued",
        "type": "date",
        "required": true
      }
    ]
  },
  "committal-warrant": {
    "label": "Committal Warrant",
    "description": "Commits a convicted person to prison after sentence.",
    "schema": [
      {
        "section": "Case Information"
      },
      {
        "name": "courtName",
        "label": "Court Name",
        "type": "text",
        "required": true,
        "defaultValue": "High Court of Justice, Gombe"
      },
      {
        "name": "caseNumber",
        "label": "Case Number",
        "type": "text",
        "required": true
      },
      {
        "name": "complainant",
        "label": "Complainant",
        "type": "textarea",
        "required": true
      },
      {
        "name": "defendant",
        "label": "Defendant",
        "type": "textarea",
        "required": true
      },
      {
        "section": "Prisoner Details"
      },
      {
        "name": "prisonerName",
        "label": "Name of Prisoner",
        "type": "text",
        "required": true
      },
      {
        "name": "race",
        "label": "Race or Tribe",
        "type": "text"
      },
      {
        "name": "residence",
        "label": "Residence",
        "type": "textarea"
      },
      {
        "name": "offence",
        "label": "Offence",
        "type": "textarea"
      },
      {
        "name": "sentencingCourt",
        "label": "Court Awarding Sentence",
        "type": "text"
      },
      {
        "section": "Sentence"
      },
      {
        "name": "convictionDate",
        "label": "Conviction Date",
        "type": "date",
        "required": true
      },
      {
        "name": "fineAmount",
        "label": "Fine Amount",
        "type": "text"
      },
      {
        "name": "imprisonmentTerm",
        "label": "Imprisonment Term",
        "type": "text"
      },
      {
        "name": "reducedTerm",
        "label": "Reduced Term (if any)",
        "type": "text"
      },
      {
        "section": "Custody"
      },
      {
        "name": "prisonLocation",
        "label": "Prison Location",
        "type": "text",
        "required": true
      },
      {
        "section": "Issuance"
      },
      {
        "name": "issueDate",
        "label": "Date Issued",
        "type": "date",
        "required": true
      }
    ]
  },

  "court-order": {
    "label": "Court Order",
    "description": "Generates a formal court order with two-column judge/order layout.",
    "schema": [
      { "section": "Court & Sitting" },
      { "name": "sittingDate", "label": "Date of Sitting", "type": "date", "required": true },
      { "name": "judgeType", "label": "Judge Type", "type": "select", "required": true,
        "options": [{"value":"single","label":"Single Judge"},{"value":"panel","label":"Panel of Judges"}],
        "defaultValue": "single" },
      { "name": "judgeName", "label": "Judge's Name & Title (Single Judge)", "type": "text",
        "help": "e.g. Hon. Justice M.A Haruna — fill if Single Judge selected" },
      { "name": "judgeDesignation", "label": "Judge Designation (Single Judge)",
        "defaultValue": "JUDGE", "help": "e.g. JUDGE, P/JUDGE, J.C.A" },
      { "name": "judges", "label": "Panel Judges (fill if Panel selected)", "type": "table",
        "full": true,
        "columns": [
          { "name": "name", "label": "Judge's Name & Title" },
          { "name": "designation", "label": "Designation (e.g. P/JUDGE, J.C.A)" }
        ]
      },
      { "section": "Case" },
      { "name": "suitNumber", "label": "Suit / Appeal Number", "required": true },
      { "name": "additionalSuits", "label": "Additional Suit Numbers (consolidated appeals)",
        "type": "textarea", "help": "One per line — leave blank if not applicable" },
      { "name": "partyType", "label": "Party Designation", "type": "select", "required": true,
        "options": [
          {"value":"applicant-respondent","label":"Applicant / Respondent"},
          {"value":"plaintiff-defendant","label":"Plaintiff / Defendant"},
          {"value":"appellant-respondent","label":"Appellant / Respondent"}
        ]
      },
      { "name": "leftParties", "label": "Left Side Parties (Plaintiff / Applicant / Appellant)",
        "type": "textarea", "required": true, "full": true, "help": "One party per line" },
      { "name": "rightParties", "label": "Right Side Parties (Defendant / Respondent)",
        "type": "textarea", "required": true, "full": true, "help": "One party per line" },
      { "section": "Originating Process" },
      { "name": "processType", "label": "Type of Process", "type": "select", "required": true,
        "options": [
          {"value":"motion-on-notice","label":"Motion on Notice"},
          {"value":"ex-parte","label":"Ex-Parte Motion"},
          {"value":"writ-of-summons","label":"Writ of Summons"},
          {"value":"originating-summons","label":"Originating Summons"},
          {"value":"chamber-summons","label":"Chamber Summons"},
          {"value":"petition","label":"Petition"},
          {"value":"other","label":"Other"}
        ]
      },
      { "name": "processDate", "label": "Date of Process", "type": "date", "required": true },
      { "name": "filingDate", "label": "Date of Filing", "type": "date", "required": true },
      { "name": "counselName", "label": "Counsel Name", "required": true, "help": "e.g. S.S Gana Esq" },
      { "name": "onBehalfOf", "label": "Moving on Behalf of", "type": "select", "required": true,
        "options": ["Applicant","Plaintiff","Appellant","Defendant","Respondent"] },
      { "name": "prayer", "label": "Prayer / Relief Sought", "type": "textarea", "required": true },
      { "name": "applicableRules", "label": "Applicable Rules / Laws (optional)", "type": "textarea",
        "help": "e.g. Order 42 Rules 1(i)(A), 2 and 3(i)..." },
      { "section": "Further Narrative (optional)" },
      { "name": "furtherNarrative", "label": "Hearing Summary / Additional Narrative", "type": "textarea",
        "help": "e.g. AFTER HEARING the Applicant application, there being no objection/response, same is hereby granted." },
      { "section": "Order Items" },
      { "name": "orderItems", "label": "Order Items", "type": "table", "required": true, "full": true,
        "columns": [{ "name": "item", "label": "Order Item (e.g. That the defendant shall pay...)" }]
      },
      { "section": "Closing" },
      { "name": "orderHeading", "label": "Order Heading", "defaultValue": "COURT ORDER",
        "help": "e.g. COURT ORDER, COURT'S ORDER" },
      { "name": "issueDate", "label": "Date of Order", "type": "date", "required": true },
      { "name": "registrarName", "label": "Registrar's Name", "required": true },
      { "name": "registrarDesignation", "label": "Registrar's Designation", "required": true,
        "help": "e.g. Senior Registrar, Principal Registrar, ACR (Appeals)" }
    ]
  },

  "cause-list": {
    "label": "Cause List",
    "description": "Generates the daily cause list for the court sitting.",
    "schema": [
      { "section": "Court & Sitting Details" },
      {
        "name": "judgeType",
        "label": "Judge / Sitting Type",
        "type": "select",
        "required": true,
        "options": [
          { "value": "single", "label": "Single Judge" },
          { "value": "panel",  "label": "Panel of Judges" }
        ],
        "defaultValue": "single"
      },
      {
        "name": "judgeName",
        "label": "Judge's Name & Title (Single Judge)",
        "type": "text",
        "help": "e.g. Hon. Justice Abubakar Sadiq Gital — fill if Single Judge selected"
      },
      {
        "name": "judges",
        "label": "Panel Judges (fill if Panel selected above)",
        "type": "table",
        "full": true,
        "columns": [
          { "name": "name", "label": "Judge's Name & Title" }
        ]
      },
      {
        "name": "sittingDate",
        "label": "Date of Sitting",
        "type": "date",
        "required": true
      },
      {
        "name": "sittingTime",
        "label": "Time of Sitting",
        "type": "text",
        "required": true,
        "defaultValue": "9:00"
      },
      {
        "name": "division",
        "label": "Judicial Division",
        "type": "text",
        "required": true,
        "defaultValue": "Gombe Judicial Division"
      },
      { "section": "Cases" },
      {
        "name": "entries",
        "label": "Case Entries",
        "type": "table",
        "required": true,
        "full": true,
        "columns": [
          { "name": "suitNumber", "label": "Suit No." },
          { "name": "parties",    "label": "Parties (Plaintiff v. Defendant)" },
          { "name": "nature",     "label": "Nature of Case" },
          { "name": "stage",      "label": "Stage / Purpose" },
          { "name": "counsel",    "label": "Counsel" },
          { "name": "remarks",    "label": "Remarks" }
        ]
      },
      { "section": "Certification" },
      {
        "name": "preparedBy",
        "label": "Prepared By (Registrar's Name)",
        "type": "text",
        "required": true
      }
    ]
  }
};

  // ── Register forms globally so other units can be granted access ──
  window.App.allForms = window.App.allForms || {};
  window.App.allFormsByModule = window.App.allFormsByModule || {};
  Object.assign(window.App.allForms, forms);
  window.App.allFormsByModule['Registry'] = forms;

  window.App.modules.registry = {
    id: "registry",
    forms: forms,
    render(container, ctx) {
      window.App.recordEngine.render(container, ctx, {
        store: "registry_records",
        subtitle: "Court Registry — file processing & official form generation",
        forms: forms
      });
    }
  };
})();
