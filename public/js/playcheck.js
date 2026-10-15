// "Finished E4?" after Play: watching in the Crunchyroll app on a phone isn't synced until the
// extension runs on a computer, so when you come back to the tracker it offers a one-tap tick.
import { api } from './api.js';
import { toast } from './ui.js';
import { bus } from './bus.js';

const KEY = 'play:pending';
const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } };
const clear = () => { try { localStorage.removeItem(KEY); } catch {} };

/** Called when a Play button opens an exact episode. */
export function rememberPlay(item, episode) {
  if (!item?.malId || !episode) return;
  try { localStorage.setItem(KEY, JSON.stringify({ malId: item.malId, title: item.title, episode, at: Date.now() })); } catch {}
}

/** On load and whenever the tracker comes back into view: ask once, 15 min to 12 h after Play. */
export async function checkPlay() {
  const p = read();
  if (!p) return;
  const age = Date.now() - p.at;
  if (age > 12 * 3600e3) { clear(); return; }
  if (age < 15 * 60e3) return;
  clear();
  // The extension synced since then: Crunchyroll's own history already says whether you finished.
  try {
    const st = await api.crStatus();
    if (st.lastSync?.at && new Date(st.lastSync.at).getTime() > p.at) return;
  } catch {}
  // No doubled punctuation after titles that end in "!" or "?".
  const q = /[!?]$/.test(p.title || '') ? '' : '?';
  // Up for 20 s: you've just come back to the app and may not be looking at the corner yet.
  toast(`Finished E${p.episode} of ${p.title}${q}`, { label: 'Mark watched', ms: 20000, onClick: async () => {
    // Just that episode: you may have played one out of order, and the ones before it stay as they are.
    try {
      await api.toggleWatched(p.malId, p.episode, true);
      bus.emit('library-changed');
      toast(`E${p.episode} of ${p.title} marked watched`, { label: 'Undo', onClick: async () => {
        try { await api.toggleWatched(p.malId, p.episode, false); bus.emit('library-changed'); } catch (err) { toast(err.message); }
      } });
    } catch (err) { toast(err.message); }
  } });
}
