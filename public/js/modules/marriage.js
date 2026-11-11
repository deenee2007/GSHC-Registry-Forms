/*
 * modules/marriage.js — Marriage Registry, High Court of Justice Gombe.
 * The forms in use at the registry: the notice of marriage (its expiry
 * worked out, three months from its date), the particulars of the husband and the
 * wife, the particulars of their witnesses, the oath taking (vows), the oath
 * affirmation with the ring oath, and the declaration on the prohibited
 * degrees of relationship. They are signed by hand by the parties and
 * witnesses; Finalise locks each and gives it its QR code.
 */
(function () {
  window.App = window.App || {};
  window.App.modules = window.App.modules || {};

  // One person's particulars, as on the registry's form.
  const person = (p, title, condition) => [
    { section: title },
    { name: `${p}Name`, label: 'Name', required: true, full: true },
    { name: `${p}Age`, label: 'Age' },
    { name: `${p}Occupation`, label: 'Occupation' },
    { name: `${p}Address`, label: 'Address', type: 'textarea', full: true },
    { name: `${p}Phone`, label: 'Phone No.' },
    condition
      ? { name: `${p}Condition`, label: 'Condition', type: 'select', options: condition.map(c => ({ value: c, label: c })) }
      : { name: `${p}Condition`, label: 'Condition', help: 'e.g. Married, Single' },
    { name: `${p}FatherName`, label: 'Father Name & Surname' },
    { name: `${p}FatherOccupation`, label: 'Father Occupation' },
    { name: `${p}Date`, label: 'Date', type: 'date' }
  ];

  const WITH = [{ value: 'RING/BIBLE/QUR\'AN', label: 'Ring / Bible / Qur\'an (as on the form)' }, { value: 'RING', label: 'Ring' }, { value: 'BIBLE', label: 'Bible' }, { value: 'QUR\'AN', label: 'Qur\'an' }];

  // The same number on all the forms of a couple puts them together in the Case File.
  const fileNo = [{ section: 'Marriage File' },
    { name: 'marriageNo', label: 'Marriage File No.', help: 'The same number on all the forms of this couple, so the Case File shows them together' }];

  // One party on the notice of marriage; the boxes share their names with the
  // particulars, so a couple's notice fills from (or into) their other forms.
  const noticeParty = (p, title, condition) => [
    { section: title },
    { name: `${p}Name`, label: 'Name', required: true, full: true },
    { name: `${p}Condition`, label: 'Condition', type: 'select', options: ['', ...condition].map(c => ({ value: c, label: c || 'Choose' })) },
    { name: `${p}Occupation`, label: 'Occupation, Rank or Profession' },
    { name: `${p}Age`, label: 'Age' },
    { name: `${p}Address`, label: 'Dwelling or Place of Abode', type: 'textarea', full: true },
    { name: `${p}Consent`, label: 'Consent, if any, and by whom given', full: true, help: 'Where a party is under 21: whose consent, e.g. Father, Bello Usman' }
  ];

  const forms = {
    'notice-of-marriage': {
      label: 'Notice of Marriage (Form A, Schedule 1)',
      schema: [
        ...fileNo,
        { section: 'The Notice' },
        { name: 'registrarDistrict', label: 'To the Registrar of Marriage for the', defaultValue: 'Gombe', required: true, help: '… District of Nigeria' },
        { name: 'marriagePlace', label: 'The marriage to be had at', required: true, full: true, help: 'e.g. the Marriage Registry, High Court of Justice, Gombe' },
        { name: 'noticeNo', label: 'Notice No.' },
        { name: 'noticeDate', label: 'Date of the notice', type: 'date', required: true },
        { name: 'expiryDate', label: 'Expires on', type: 'computed', compute: { from: 'noticeDate', addMonths: 3 },
          help: 'Worked out: the marriage must be had within three months from the date of the notice' },
        ...noticeParty('husband', 'The Intended Husband', ['Bachelor', 'Widower', 'Divorced']),
        ...noticeParty('wife', 'The Intended Wife', ['Spinster', 'Widow', 'Divorced'])
      ]
    },

    'marriage-particulars': {
      label: 'Particulars of Husband and Wife',
      schema: [
        ...fileNo,
        ...person('husband', 'Husband', ['Bachelor', 'Widower', 'Divorced']),
        ...person('wife', 'Wife', ['Spinster', 'Widow', 'Divorced'])
      ]
    },

    'marriage-witnesses': {
      label: 'Particulars of Witnesses',
      schema: [
        ...fileNo,
        { section: 'The Marriage' },
        { name: 'husbandName', label: 'Husband', full: true },
        { name: 'wifeName', label: 'Wife' },
        ...person('husbandWitness', 'Husband Witness'),
        ...person('wifeWitness', 'Wife Witness')
      ]
    },

    'marriage-oath-taking': {
      label: 'Oath Taking (Vows)',
      schema: [
        ...fileNo,
        { section: 'The Parties' },
        { name: 'groomName', label: 'Groom', required: true, full: true },
        { name: 'brideName', label: 'Bride', required: true },
        { section: 'Dates' },
        { name: 'groomDate', label: 'Groom: Date', type: 'date' },
        { name: 'brideDate', label: 'Bride: Date', type: 'date' }
      ]
    },

    'marriage-oath-affirmation': {
      label: 'Oath Affirmation and Ring Oaths',
      schema: [
        ...fileNo,
        { section: 'The Parties' },
        { name: 'groomName', label: 'Groom (Husband)', required: true, full: true },
        { name: 'brideName', label: 'Bride (Wife)', required: true },
        { section: 'Oath Affirmation' },
        { name: 'groomDate', label: 'Groom: Date', type: 'date' },
        { name: 'brideDate', label: 'Bride: Date', type: 'date' },
        { section: 'Ring Oaths' },
        { name: 'ringOathWith', label: 'Groom: with this', type: 'select', defaultValue: 'RING/BIBLE/QUR\'AN', options: WITH,
          help: 'What the groom weds with, as printed in his ring oath' },
        { name: 'brideRingWith', label: 'Bride: with this', type: 'select', defaultValue: 'RING/BIBLE/QUR\'AN', options: WITH,
          help: 'What the bride weds with, as printed in her ring oath' }
      ]
    },

    'prohibited-degrees': {
      label: 'Prohibited Degrees of Relationship (Declaration)',
      schema: [
        ...fileNo,
        { section: 'The Proposed Husband and Wife' },
        { name: 'husbandName', label: 'Proposed Husband', required: true, full: true },
        { name: 'wifeName', label: 'Proposed Wife', required: true },
        { section: 'Date' },
        { name: 'declarationDate', label: 'Dated', type: 'date' }
      ]
    }
  };

  window.App.allForms = window.App.allForms || {};
  window.App.allFormsByModule = window.App.allFormsByModule || {};
  Object.assign(window.App.allForms, forms);
  window.App.allFormsByModule['Marriage'] = forms;

  window.App.modules.marriage = {
    id: 'marriage',
    forms,
    render(container, ctx) {
      window.App.recordEngine.render(container, ctx, {
        store: 'marriage_records',
        subtitle: 'Marriage Registry: particulars, witnesses, oaths and the declaration on prohibited degrees',
        forms
      });
    }
  };
})();
