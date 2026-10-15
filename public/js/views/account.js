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

export async function render(view) {
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
