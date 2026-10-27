'use strict';
// Passkeys (WebAuthn) for sign-in (D5). The relying party is the address people use
// (tsuzuku.okanerturan.com); RP_ID and APP_ORIGIN override it for local runs and tests.
// Each ceremony gets a one-time "flow" id that carries its challenge for 5 minutes.
const { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } = require('@simplewebauthn/server');
const { adb, secret } = require('./store');

const rpID = () => process.env.RP_ID || 'tsuzuku.okanerturan.com';
const origin = () => process.env.APP_ORIGIN || `https://${rpID()}`;
const FLOW_MS = 5 * 60e3;
const flows = new Map(); // flow id -> { challenge, purpose, accountId, expires }

function startFlow(data) {
  for (const [k, f] of flows) if (f.expires < Date.now()) flows.delete(k);
  const id = secret(18);
  flows.set(id, { ...data, expires: Date.now() + FLOW_MS });
  return id;
}
function takeFlow(id, purpose) {
  const f = flows.get(id);
  flows.delete(id); // one try per challenge
  if (!f || f.purpose !== purpose || f.expires < Date.now()) throw Object.assign(new Error('This sign-in step expired. Please try again.'), { status: 400 });
  return f;
}

const listFor = (accountId) => adb().prepare('SELECT id, transports FROM passkeys WHERE account_id = ?').all(accountId);

/** Options for adding a passkey to an account (new or existing). */
async function registrationOptions(accountId, userName) {
  const options = await generateRegistrationOptions({
    rpName: 'Anime Tracker', rpID: rpID(), userName: userName || `account-${accountId}`,
    userID: new TextEncoder().encode(`acct:${accountId}`),
    attestationType: 'none',
    excludeCredentials: listFor(accountId).map((p) => ({ id: p.id, transports: p.transports ? JSON.parse(p.transports) : undefined })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' }
  });
  return { flow: startFlow({ purpose: 'register', accountId, challenge: options.challenge }), options };
}

/** Check the browser's answer and store the passkey. Returns its id. */
async function finishRegistration(flowId, response, name = null) {
  const f = takeFlow(flowId, 'register');
  const v = await verifyRegistrationResponse({ response, expectedChallenge: f.challenge, expectedOrigin: origin(), expectedRPID: rpID() });
  if (!v.verified || !v.registrationInfo) throw Object.assign(new Error('That passkey could not be verified.'), { status: 400 });
  const { credential } = v.registrationInfo;
  adb().prepare('INSERT INTO passkeys (id, account_id, public_key, counter, transports, name) VALUES (?, ?, ?, ?, ?, ?)')
    .run(credential.id, f.accountId, Buffer.from(credential.publicKey), credential.counter || 0,
      credential.transports ? JSON.stringify(credential.transports) : null, name ? String(name).slice(0, 60) : null);
  return credential.id;
}

/** Options for signing in: any passkey stored for this site (discoverable credentials). */
async function authenticationOptions() {
  const options = await generateAuthenticationOptions({ rpID: rpID(), userVerification: 'preferred' });
  return { flow: startFlow({ purpose: 'signin', challenge: options.challenge }), options };
}

/** Check a sign-in answer; returns the account id. */
async function finishAuthentication(flowId, response) {
  const f = takeFlow(flowId, 'signin');
  const pk = response?.id ? adb().prepare('SELECT * FROM passkeys WHERE id = ?').get(response.id) : null;
  if (!pk) throw Object.assign(new Error('That passkey isn\'t registered here.'), { status: 401 });
  const v = await verifyAuthenticationResponse({
    response, expectedChallenge: f.challenge, expectedOrigin: origin(), expectedRPID: rpID(),
    credential: { id: pk.id, publicKey: new Uint8Array(pk.public_key), counter: pk.counter, transports: pk.transports ? JSON.parse(pk.transports) : undefined }
  });
  if (!v.verified) throw Object.assign(new Error('That passkey could not be verified.'), { status: 401 });
  adb().prepare("UPDATE passkeys SET counter = ?, last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(v.authenticationInfo.newCounter, pk.id);
  return pk.account_id;
}

module.exports = { registrationOptions, finishRegistration, authenticationOptions, finishAuthentication, rpID, origin };
