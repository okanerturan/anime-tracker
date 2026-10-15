// Sign-in page (hosted mode): passkey sign-in, invite sign-up, recovery codes, recovery sign-in.
// After signing in it returns to the app at the page that asked (?next=#/library?anime=…).
import { h, fill } from './ui.js';
import { authPost as post, makePasskey, usePasskey, cancelled, codesFile } from './passkey.js';

const panel = document.getElementById('panel');
const params = new URLSearchParams(location.search);
const invite = params.get('invite');
const next = params.get('next') || '#/up-next';
const goApp = () => { location.href = `/${next.startsWith('#') ? next : '#/up-next'}`; };

const note = (text, kind = '') => h('p', { class: `signin-note ${kind}`, role: kind === 'bad' ? 'alert' : null }, text);
const busy = (btn, on, label) => { btn.disabled = on; if (label) btn.textContent = label; };

function signInView(message = null) {
  const go = h('button', { type: 'button', class: 'btn primary signin-main' }, 'Sign in with a passkey');
  const status = h('div');
  go.addEventListener('click', async () => {
    busy(go, true, 'Waiting for your passkey…');
    try {
      const { flow, options } = await post('/auth/signin/options');
      await post('/auth/signin/verify', { flow, response: await usePasskey(options) });
      goApp();
    } catch (err) {
      fill(status, note(cancelled(err) ? 'No passkey chosen. Try again when you\'re ready.' : err.message, cancelled(err) ? '' : 'bad'));
      busy(go, false, 'Sign in with a passkey');
    }
  });
  const recover = h('button', { type: 'button', class: 'link-btn' }, 'Lost your passkey? Use a recovery code');
  recover.addEventListener('click', () => fill(panel, recoverView()));
  fill(panel,
    h('h1', {}, 'Sign in'),
    message ? note(message) : null,
    h('p', { class: 'muted' }, 'Your passkey is the face, fingerprint or screen lock you set up for this site.'),
    go, status, recover);
}

function recoverView() {
  const input = h('input', { class: 'search', autocomplete: 'one-time-code', spellcheck: 'false', placeholder: 'xxxxx-xxxxx', 'aria-label': 'Recovery code' });
  const go = h('button', { type: 'submit', class: 'btn primary' }, 'Sign in');
  const status = h('div');
  const form = h('form', { class: 'signin-form' }, input, go);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    busy(go, true);
    try {
      const r = await post('/auth/recover', { code: input.value });
      fill(panel, addPasskeyView(r.recoveryCodesLeft));
    } catch (err) { fill(status, note(err.message, 'bad')); busy(go, false); }
  });
  const back = h('button', { type: 'button', class: 'link-btn' }, 'Back to passkey sign-in');
  back.addEventListener('click', () => signInView());
  return [h('h1', {}, 'Use a recovery code'), h('p', { class: 'muted' }, 'One of the ten codes you saved when you signed up. Each works once.'), form, status, back];
}

function addPasskeyView(left) {
  const go = h('button', { type: 'button', class: 'btn primary signin-main' }, 'Add a passkey on this device');
  const status = h('div');
  go.addEventListener('click', async () => {
    busy(go, true, 'Waiting for your passkey…');
    try {
      const { flow, options } = await post('/auth/passkey/options');
      await post('/auth/passkey/verify', { flow, response: await makePasskey(options) });
      goApp();
    } catch (err) {
      fill(status, note(cancelled(err) ? 'Not added yet. You can do it later from your account page.' : err.message, cancelled(err) ? '' : 'bad'));
      busy(go, false, 'Add a passkey on this device');
    }
  });
  const later = h('button', { type: 'button', class: 'link-btn' }, 'Skip for now');
  later.addEventListener('click', goApp);
  return [h('h1', {}, 'You\'re in'), h('p', {}, `Add a passkey so you won't need a code next time. You have ${left} recovery code${left === 1 ? '' : 's'} left.`), go, status, later];
}

function inviteView() {
  const name = h('input', { class: 'search', autocomplete: 'nickname', placeholder: 'What should we call you? (optional)', 'aria-label': 'Your name', maxlength: '40' });
  const go = h('button', { type: 'submit', class: 'btn primary signin-main' }, 'Create my passkey');
  const status = h('div');
  const form = h('form', { class: 'signin-form signin-form--stack' }, name, go);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    busy(go, true, 'Waiting for your passkey…');
    try {
      const { flow, options } = await post('/auth/signup/options', { invite, name: name.value });
      const r = await post('/auth/signup/verify', { flow, invite, response: await makePasskey(options) });
      fill(panel, codesView(r.recoveryCodes));
    } catch (err) {
      fill(status, note(cancelled(err) ? 'No passkey made yet. Your invite still works; try again.' : err.message, cancelled(err) ? '' : 'bad'));
      busy(go, false, 'Create my passkey');
    }
  });
  fill(panel,
    h('h1', {}, 'You\'re invited'),
    h('p', {}, 'A passkey lets you sign in with your face, fingerprint or screen lock instead of a password. It stays on your device and syncs with your other devices.'),
    form, status);
}

function codesView(codes) {
  const text = codes.join('\n');
  const list = h('ol', { class: 'codes num' }, codes.map((c) => h('li', {}, c)));
  const copy = h('button', { type: 'button', class: 'btn' }, 'Copy');
  copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(text); copy.textContent = 'Copied'; } catch { copy.textContent = 'Select and copy them'; } });
  const save = h('a', { class: 'btn', href: codesFile(codes), download: 'anime-tracker-recovery-codes.txt' }, 'Download');
  const ok = h('input', { type: 'checkbox', id: 'saved' });
  const go = h('button', { type: 'button', class: 'btn primary', disabled: true }, 'Continue');
  ok.addEventListener('change', () => { go.disabled = !ok.checked; });
  go.addEventListener('click', goApp);
  return [
    h('h1', {}, 'Save your recovery codes'),
    h('p', {}, 'If you ever lose your passkey, one of these gets you back in. Each works once. You won\'t see them again.'),
    list, h('div', { class: 'hero-actions' }, copy, save),
    h('label', { class: 'signin-check', for: 'saved' }, ok, ' I saved these somewhere safe'),
    go
  ];
}

(async () => {
  if (!window.PublicKeyCredential) {
    fill(panel, h('h1', {}, 'Passkeys aren\'t available here'), note('This browser can\'t use passkeys. Try a current Chrome, Safari or Edge, or use a recovery code.'));
    panel.append(...recoverView());
    return;
  }
  const state = await fetch('/auth/state').then((r) => r.json()).catch(() => ({}));
  if (state.signedIn && !invite) return goApp();
  if (invite) return inviteView();
  signInView(params.get('signedOut') ? 'You\'re signed out.' : null);
})();
