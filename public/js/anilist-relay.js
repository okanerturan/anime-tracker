// Web-app side of the AniList relay (see extension/anilist-relay.js): while the app is open it runs
// queued AniList requests from this browser, and search falls back to querying AniList directly.
let running = null;

async function ask(job) {
  const r = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: job.query, variables: job.variables })
  });
  const json = await r.json().catch(() => null);
  if (!r.ok || !json?.data) throw new Error(`AniList ${r.status}`);
  return json.data;
}

/** Answer one relay job right away (used when a request needs AniList now, like search). */
export async function answerNow(job) {
  const data = await ask(job);
  await fetch('/api/anilist/relay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Tracker-Client': 'app' },
    body: JSON.stringify({ answers: [{ id: job.id, data }] })
  });
}

/** Work through the queue in the background, 2.1 s between AniList requests. */
export function runRelay() {
  if (running) return running;
  running = (async () => {
    const res = await fetch('/api/anilist/relay');
    if (!res.ok) return 0;
    const { jobs = [] } = await res.json();
    let ran = 0;
    for (const job of jobs) {
      try { await answerNow(job); ran += 1; } catch { break; }
      await new Promise((r) => setTimeout(r, 2100));
    }
    return ran;
  })().catch(() => 0).finally(() => { running = null; });
  return running;
}
