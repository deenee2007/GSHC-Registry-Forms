/*
 * The user guide: served at /guide, one section per role, and the button
 * and menu names it tells people to click still exist in the app.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';
const DB = (process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/gshc_registry_test') + '_guide';
const mongoose = require('mongoose');
const { createApp } = require('../src/app');

let server, base;
before(async () => {
  await mongoose.connect(DB);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

const PUB = path.join(__dirname, '..', 'public');
const guide = fs.readFileSync(path.join(PUB, 'guide.html'), 'utf8');
const appCode = ['js/main.js', 'js/core/workflow.js', 'js/core/recordEngine.js', 'js/core/router.js', 'js/core/ui.js', 'js/modules/inbox.js',
  'js/modules/submissions.js', 'js/modules/signature.js', 'js/modules/settings.js', 'js/modules/dashboard.js', 'js/modules/reports.js',
  'js/modules/cases.js', 'js/modules/account.js', 'js/verify.js'].map(f => fs.readFileSync(path.join(PUB, f), 'utf8')).join('\n');

test('the guide is served without signing in and has a page for each role', async () => {
  const r = await fetch(base + '/guide');
  assert.equal(r.status, 200);
  const html = await r.text();
  for (const id of ['everyone', 'staff', 'signers', 'execution', 'admins', 'verify']) assert.match(html, new RegExp(`<section class="g-page" id="${id}"`));
  assert.equal((await fetch(base + '/js/guide.js')).status, 200);
  assert.equal((await fetch(base + '/css/guide.css')).status, 200);
});

test('every button and menu name the guide quotes exists in the app', () => {
  const names = ['Sign In', 'Forgot password?', '+ New Entry', 'Save Draft', 'Fill them in', 'Submit for Signature', 'Finalise',
    'Any one may approve', 'All must approve', 'Print Draft Copy', 'Download Copy', 'Withdraw', 'Edit', 'History', 'Case File',
    'Awaiting My Signature', 'Review', 'Approve & Sign', 'Return with Comments', 'Revoke', 'My Signature', 'Save Signature',
    'Upload a scan', 'Draw', 'Account password', 'New PIN', 'Repeat PIN', 'Set PIN', 'Reset PIN', 'My Submissions', 'Approved',
    'Awaiting Signature', 'Returned', 'Revoked', 'My Account', 'Help', 'Sign Out', 'Not Synced', '+ Add User', 'Email Reset Link',
    'One Time Password', 'Reset Password', 'Deactivate', '+ Add Unit', 'Form Access', 'Signing Rules', 'Audit Log', 'Back up now',
    'Download for Excel', 'Upcoming Court Dates', 'Genuine document', 'Record altered', 'Not found'];
  for (const n of names) {
    assert.ok(guide.includes(n.replace('&', '&amp;')) || guide.includes(n), `the guide mentions "${n}"`);
    assert.ok(appCode.includes(n), `"${n}" is in the app`);
  }
});
