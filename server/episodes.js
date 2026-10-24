'use strict';
// Episode facts shared by everyone (catalog_episodes): one row per show and episode, merged per field
// from several sources. Every writer goes through merge(), so precedence lives in one place: a value
// replaces the stored one when the stored one is empty (or an "Episode N" placeholder), or when the new
// source ranks at least as high for that field (equal rank: the newer value wins).
const { catalog } = require('./db');

// Highest first. 'crunchyroll' links are the exact episode in the audio version you watch;
// 'crunchyroll-other' may be another language's version (migrated, or sent without an audio match).
// 'legacy' is migrated data of unknown origin, below every real source.
const RANKS = {
  title: ['crunchyroll', 'crunchyroll-other', 'tmdb', 'anilist', 'kitsu', 'jikan', 'legacy'],
  image: ['crunchyroll', 'crunchyroll-other', 'tmdb', 'anilist', 'kitsu', 'jikan', 'legacy'],
  aired: ['anilist', 'crunchyroll', 'crunchyroll-other', 'tmdb', 'kitsu', 'jikan', 'legacy'],
  url: ['crunchyroll', 'crunchyroll-other', 'anilist', 'jikan', 'legacy']
};
const rank = (field, src) => { const i = RANKS[field].indexOf(src); return i < 0 ? 0 : RANKS[field].length - i; };
const isPlaceholder = (title) => !title || /^Episode \d+(\.0)?( \(from history\))?$/i.test(String(title).trim());
const empty = (v) => v == null || v === '';

const getStmt = catalog.prepare('SELECT * FROM catalog_episodes WHERE mal_id = ? AND episode_number = ?');
const putStmt = catalog.prepare(`INSERT INTO catalog_episodes (mal_id, episode_number, title, title_src, title_at, url, url_src,
    aired, aired_src, image_url, image_blob, image_mime, image_src, image_at, updated_at)
  VALUES (@mal_id, @episode_number, @title, @title_src, @title_at, @url, @url_src, @aired, @aired_src,
    @image_url, @image_blob, @image_mime, @image_src, @image_at, @updated_at)
  ON CONFLICT(mal_id, episode_number) DO UPDATE SET title = excluded.title, title_src = excluded.title_src, title_at = excluded.title_at,
    url = excluded.url, url_src = excluded.url_src, aired = excluded.aired, aired_src = excluded.aired_src,
    image_url = excluded.image_url, image_blob = excluded.image_blob, image_mime = excluded.image_mime,
    image_src = excluded.image_src, image_at = excluded.image_at, updated_at = excluded.updated_at`);

/** Would `src` replace the stored value of `field`? */
function wins(field, value, src, curValue, curSrc, placeholderCheck = false) {
  if (empty(value) || (placeholderCheck && isPlaceholder(value))) return false;
  if (empty(curValue) || (placeholderCheck && isPlaceholder(curValue))) return true;
  // A Crunchyroll link of unknown audio never replaces another one: the stored link may be the
  // version you watch, the new one a dub (only an audio-matched link replaces it).
  if (field === 'url' && src === 'crunchyroll-other') return rank(field, src) > rank(field, curSrc);
  return rank(field, src) >= rank(field, curSrc);
}

/**
 * Merge what `source` says about one episode. `facts`: { title, url, aired, imageUrl }, any subset;
 * `sources` overrides the source per field (e.g. { url: 'crunchyroll-other' }). Returns the fields that
 * changed. Creates the row when it doesn't exist (an episode can be known before anyone watches it).
 */
function merge(malId, episodeNumber, facts, source, { sources = {}, now = new Date().toISOString() } = {}) {
  const cur = getStmt.get(malId, episodeNumber) || {};
  const row = {
    mal_id: malId, episode_number: episodeNumber,
    title: cur.title ?? null, title_src: cur.title_src ?? null, title_at: cur.title_at ?? null,
    url: cur.url ?? null, url_src: cur.url_src ?? null,
    aired: cur.aired ?? null, aired_src: cur.aired_src ?? null,
    image_url: cur.image_url ?? null, image_blob: cur.image_blob ?? null, image_mime: cur.image_mime ?? null,
    image_src: cur.image_src ?? null, image_at: cur.image_at ?? null, updated_at: cur.updated_at ?? now
  };
  const changed = [];
  const src = (f) => sources[f] || source;
  if (wins('title', facts.title, src('title'), cur.title, cur.title_src, true) && facts.title.trim() !== cur.title) {
    Object.assign(row, { title: facts.title.trim(), title_src: src('title'), title_at: now }); changed.push('title');
  }
  if (wins('url', facts.url, src('url'), cur.url, cur.url_src) && (facts.url !== cur.url || src('url') !== cur.url_src)) {
    Object.assign(row, { url: facts.url, url_src: src('url') }); changed.push('url');
  }
  if (wins('aired', facts.aired, src('aired'), cur.aired, cur.aired_src) && facts.aired !== cur.aired) {
    Object.assign(row, { aired: facts.aired, aired_src: src('aired') }); changed.push('aired');
  }
  const curImage = cur.image_url || (cur.image_blob != null ? 'blob' : null);
  if (wins('image', facts.imageUrl, src('image'), curImage, cur.image_src) && facts.imageUrl !== cur.image_url) {
    // A still from a ranked source replaces an old stored blob: the image cache serves it from now on.
    Object.assign(row, { image_url: facts.imageUrl, image_blob: null, image_mime: null, image_src: src('image'), image_at: now }); changed.push('image');
  }
  if (changed.length || !cur.mal_id) { row.updated_at = now; putStmt.run(row); }
  return changed;
}

/** Merge many episodes of one show in one transaction: [{ episodeNumber, title, url, aired, imageUrl }]. */
const mergeMany = catalog.transaction((malId, episodes, source, opts = {}) => {
  let changed = 0;
  for (const e of episodes || []) {
    const n = Number(e.episodeNumber);
    if (!Number.isInteger(n) || n < 1) continue;
    if (merge(malId, n, e, source, { ...opts, sources: { ...(opts.sources || {}), ...(e.sources || {}) } }).length) changed += 1;
  }
  return changed;
});

module.exports = { merge, mergeMany, rank, isPlaceholder, RANKS };
