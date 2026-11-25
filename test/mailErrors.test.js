/*
 * When Brevo refuses an email, the reason is given in plain words, with
 * where to put it right (not only "check the email settings").
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { explain } = require('../src/services/mail');

test('Brevo refusals are explained', () => {
  assert.match(explain(401, JSON.stringify({ code: 'unauthorized', message: 'We have detected you are using an unrecognised IP address 74.220.51.210.' })), /blocked the server's IP address.*Authorised IPs.*Outbound/);
  assert.match(explain(401, JSON.stringify({ code: 'unauthorized', message: 'Key not found' })), /did not accept the API key.*BREVO_API_KEY/);
  assert.match(explain(400, JSON.stringify({ code: 'invalid_parameter', message: 'sender is invalid / inactive' })), /MAIL_FROM.*not a verified sender/);
  assert.match(explain(402, JSON.stringify({ message: 'Not enough credits' })), /no email credits/);
  assert.match(explain(429, ''), /too many emails/);
  assert.match(explain(503, 'Service Unavailable'), /problem on its side/);
  assert.match(explain(0, ''), /could not reach Brevo/);
  assert.match(explain(400, JSON.stringify({ message: 'email is not valid' })), /refused the email \(email is not valid\)/);
});
