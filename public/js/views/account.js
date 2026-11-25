// Account page (hosted mode): passkeys, recovery codes, sign out, export and delete.
import { h, fill, section, toast, relTime } from '../ui.js';
import { authPost, makePasskey, usePasskey, cancelled, codesFile } from '../passkey.js';

const when = (iso) => (iso ? relTime(Date.parse(iso)) : 'never');

function codesBlock(codes) {
  const copy = h('button', { type: 'button', class: 'btn small' }, 'Copy');
  copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(codes.join('\n')); copy.textContent = 'Copied'; } catch { copy.textContent = 'Select and copy them'; } });
  return h('div', { class: 'account-codes' },
    h('p', {}, 'Your new recovery codes. The old ones stopped working. Each works once, and you won\'t see these again.'),
    h('ol', { class: 'codes num' }, codes.map((c) => h('li', {}, c))),
    h('div', { class: 'hero-actions' }, copy, h('a', { class: 'btn small', href: codesFile(codes), download: 'anime-tracker-recovery-codes.txt' }, 'Download')));
}

/** The single-passphrase tracker (no accounts yet): the passphrase, the extension, the Crunchyroll account. */
async function renderPassphrase(view, me) {
  const post = (path) => fetch(path, { method: 'POST', headers: { 'X-Tracker-Client': 'app' } }).then(async (r) => { if (!r.ok) throw new Error(`tracker ${r.status}`); return r.json(); });
  const getPassphrase = async () => (await post('/api/me/passphrase')).passphrase;

  // Passphrase: hidden until asked for, then copy.
  const shown = h('code', { class: 'account-secret' }, '••••••');
  const show = h('button', { type: 'button', class: 'btn small' }, 'Show');
  const copy = h('button', { type: 'button', class: 'btn small ghost' }, 'Copy');
  show.addEventListener('click', async () => {
    if (show.dataset.on) { shown.textContent = '••••••'; show.textContent = 'Show'; delete show.dataset.on; return; }
    try { shown.textContent = await getPassphrase(); show.textContent = 'Hide'; show.dataset.on = '1'; } catch (err) { toast(err.message); }
  });
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(await getPassphrase()); toast('Passphrase copied'); } catch (err) { toast(`Couldn't copy: ${err.message}`); }
  });

  // Extension: hand it this address and the passphrase through its bridge on this page (1.16.0+).
  const version = document.documentElement.dataset.trackerExtension || null;
  const ext = me.extension || {};
  const out = h('div', { role: 'status' });
  const setUp = h('button', { type: 'button', class: 'btn primary' }, 'Set up the extension in this browser');
  setUp.addEventListener('click', async () => {
    setUp.disabled = true;
    try {
      const token = await getPassphrase();
      const answer = new Promise((resolve) => {
        const on = (e) => { if (e.source === window && e.data?.source === 'anime-tracker-extension') { window.removeEventListener('message', on); resolve(e.data); } };
        window.addEventListener('message', on);
        setTimeout(() => resolve({ connected: false, error: 'the extension didn\'t answer' }), 4000);
      });
      window.postMessage({ source: 'anime-tracker-connect', token }, location.origin);
      const r = await answer;
      fill(out, r.connected
        ? h('p', { class: 'signin-note' }, 'Done. The extension now syncs to this address with your passphrase, and a sync has started.')
        : h('p', { class: 'signin-note bad' }, `Couldn't hand it over (${r.error}). Reload the extension in chrome://extensions, refresh this page and try again, or paste the passphrase into its Tracker key.`));
    } catch (err) { toast(err.message); }
    setUp.disabled = false;
  });
  const extLine = [
    version ? `Installed here: ${version}` : 'Not found in this browser',
    ext.seen ? `last seen ${ext.seen}` : '',
    ext.lastSyncAt ? `last sync ${when(ext.lastSyncAt)}` : 'no sync yet',
    ext.latest && version && version !== ext.latest ? `newest is ${ext.latest}, reload it in chrome://extensions` : ''
  ].filter(Boolean).join(' · ');

  // Crunchyroll: the account the sync follows, and forgetting it.
  const crOut = h('div');
  const drawCr = (cr) => {
    const forget = h('button', { type: 'button', class: 'btn small ghost btn-danger-quiet' }, 'Forget it');
    forget.addEventListener('click', async () => {
      try { await post('/api/crunchyroll/forget-account'); toast('Forgotten. The next sync follows whoever is signed in to Crunchyroll then.'); drawCr(null); } catch (err) { toast(err.message); }
    });
    fill(crOut, cr
      ? h('div', { class: 'account-row' }, h('span', {}, `Account ending …${cr.ending}${cr.profile ? ' (one profile)' : ''}`),
        h('span', { class: 'muted' }, `followed since ${when(cr.since)}. History from any other Crunchyroll account is skipped.`), forget)
      : h('p', { class: 'muted' }, 'Not tied to an account yet. The next sync ties it to whoever is signed in to Crunchyroll in that browser.'));
  };
  drawCr(me.crunchyroll);

  fill(view,
    me.mode === 'passphrase' ? section('Account', 'One passphrase, no accounts yet',
      h('div', { class: 'panel' }, h('div', { class: 'hero-actions' }, h('a', { class: 'btn small', href: '/logout' }, 'Sign out of this browser')))) : null,
    me.mode === 'passphrase' ? section('Passphrase', 'Signs you in here and is the extension\'s Tracker key', h('div', { class: 'panel' },
      h('div', { class: 'account-row' }, shown, h('span', { class: 'muted' }, 'Keep it in your password manager.'), h('span', { class: 'hero-actions' }, show, copy)))) : null,
    section('Extension', extLine, h('div', { class: 'panel' },
      h('p', { class: 'muted' }, 'One click gives the extension in this browser this address and the passphrase, so you don\'t have to type either.'),
      h('div', { class: 'hero-actions' }, setUp), out)),
    section('Crunchyroll account', 'Whose watch history comes in', h('div', { class: 'panel account-list' }, crOut)));
}

export async function render(view) {
  const me = await fetch('/api/me').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (me) return renderPassphrase(view, me);
  const state = await fetch('/auth/state').then((r) => r.json()).catch(() => ({}));
  if (!state.signedIn) { location.href = `/signin.html?next=${encodeURIComponent('#/account')}`; return; }
  const draw = async () => {
    const pk = await fetch('/auth/passkeys').then((r) => r.json());
    const dv = await fetch('/auth/devices').then((r) => r.json()).catch(() => ({ devices: [] }));
    // Connected browsers (extension tokens): last sync, and disconnect at once.
    const deviceRows = dv.devices.map((d) => {
      const off = h('button', { type: 'button', class: 'btn small ghost btn-danger-quiet' }, 'Disconnect');
      off.addEventListener('click', async () => { try { await authPost('/auth/devices/revoke', { id: d.id }); toast(`${d.name} disconnected`); draw(); } catch (err) { toast(err.message); } });
      return h('div', { class: 'account-row' }, h('span', {}, d.name), h('span', { class: 'muted' }, `connected ${when(d.connectedAt)} · last sync ${when(d.lastSyncAt)}`), off);
    });
    // Passkeys: one row per device, rename in place, remove (the last one needs fresh codes first).
    const rows = pk.passkeys.map((p) => {
      const name = h('input', { class: 'account-name', value: p.name || '', 'aria-label': 'Passkey name', maxlength: '60', placeholder: 'Unnamed passkey' });
      name.addEventListener('change', async () => { try { await authPost('/auth/passkeys/rename', { id: p.id, name: name.value }); toast('Renamed'); } catch (err) { toast(err.message); } });
      const remove = h('button', { type: 'button', class: 'btn small ghost btn-danger-quiet' }, 'Remove');
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        try { await authPost('/auth/passkeys/remove', { id: p.id }); toast('Passkey removed'); draw(); }
        catch (err) { remove.disabled = false; toast(err.message); }
      });
      return h('div', { class: 'account-row' }, name, h('span', { class: 'muted' }, `added ${when(p.createdAt)} · last used ${when(p.lastUsedAt)}`), remove);
    });
    const add = h('button', { type: 'button', class: 'btn small' }, 'Add a passkey on this device');
    add.addEventListener('click', async () => {
      add.disabled = true;
      try { const { flow, options } = await authPost('/auth/passkey/options'); await authPost('/auth/passkey/verify', { flow, response: await makePasskey(options) }); toast('Passkey added'); draw(); }
      catch (err) { add.disabled = false; if (!cancelled(err)) toast(err.message); }
    });
    const codesOut = h('div');
    const regen = h('button', { type: 'button', class: 'btn small' }, 'Make new recovery codes');
    regen.addEventListener('click', async () => {
      try { const r = await authPost('/auth/recovery/regenerate'); fill(codesOut, codesBlock(r.recoveryCodes)); } catch (err) { toast(err.message); }
    });
    const signOut = h('button', { type: 'button', class: 'btn small' }, 'Sign out');
    signOut.addEventListener('click', async () => { await authPost('/auth/signout').catch(() => {}); location.href = '/signin.html?signedOut=1'; });
    const everywhere = h('button', { type: 'button', class: 'btn small ghost' }, 'Sign out everywhere');
    everywhere.addEventListener('click', async () => { await authPost('/auth/signout-everywhere').catch(() => {}); location.href = '/signin.html?signedOut=1'; });

    // Delete: a passkey (or a recovery code) confirms it.
    const delOut = h('div');
    const del = h('button', { type: 'button', class: 'btn small ghost btn-danger-quiet' }, 'Delete my account…');
    del.addEventListener('click', () => {
      const confirmPk = h('button', { type: 'button', class: 'btn small btn-danger' }, 'Delete everything (confirm with a passkey)');
      const code = h('input', { class: 'account-name', placeholder: 'or a recovery code', 'aria-label': 'Recovery code' });
      const confirmCode = h('button', { type: 'button', class: 'btn small ghost' }, 'Delete with this code');
      const done = () => { location.href = '/signin.html?signedOut=1'; };
      confirmPk.addEventListener('click', async () => {
        try { const { flow, options } = await authPost('/auth/account/delete/options'); await authPost('/auth/account/delete', { flow, response: await usePasskey(options) }); done(); }
        catch (err) { if (!cancelled(err)) toast(err.message); }
      });
      confirmCode.addEventListener('click', async () => { try { await authPost('/auth/account/delete', { code: code.value }); done(); } catch (err) { toast(err.message); } });
      fill(delOut, h('div', { class: 'account-danger' },
        h('p', {}, 'This deletes your library, history, ratings and settings, and every way to sign in. It can\'t be undone (export first if you want a copy). Backups that still hold it expire within 30 days.'),
        h('div', { class: 'hero-actions' }, confirmPk), h('div', { class: 'account-row account-row--code' }, code, confirmCode)));
    });

    fill(view,
      section('Account', state.account?.name ? `Signed in as ${state.account.name}` : 'Signed in',
        h('div', { class: 'panel' }, h('div', { class: 'hero-actions' }, signOut, everywhere))),
      section('Passkeys', 'The devices you sign in with', h('div', { class: 'panel account-list' }, ...rows, h('div', { class: 'hero-actions' }, add))),
      section('Connected browsers', `${dv.devices.length} of ${dv.max || 10}`, h('div', { class: 'panel account-list' },
        ...(deviceRows.length ? deviceRows : [h('p', { class: 'muted' }, 'No extension connected yet.')]),
        h('div', { class: 'hero-actions' }, h('a', { class: 'btn small', href: '#/connect' }, 'Connect an extension')))),
      section('Recovery codes', `${pk.recoveryCodesLeft} of 10 left`, h('div', { class: 'panel' },
        h('p', { class: 'muted' }, 'If you lose every passkey, a recovery code gets you back in. Making new ones cancels the old set.'),
        h('div', { class: 'hero-actions' }, regen), codesOut)),
      section('Your data', 'Take it with you, or remove it', h('div', { class: 'panel' },
        h('div', { class: 'hero-actions' },
          h('a', { class: 'btn small', href: '/auth/account/export', download: '' }, 'Export everything (JSON)'),
          h('a', { class: 'btn small ghost', href: '/privacy.html' }, 'Privacy'), del),
        delOut)));
  };
  await draw();
}
