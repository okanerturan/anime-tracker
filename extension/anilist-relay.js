// AniList relay. AniList blocks some hosting networks (Cloudflare included), so the hosted tracker
// queues the AniList requests it couldn't make; this runs them from your own browser and posts the
// answers back. Spaced 2.1 s apart to stay inside AniList's rate limit. Also served to the web app.
/* exported runAniListRelay */
async function runAniListRelay(trackerUrl, headers = {}, client = 'extension') {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const res = await fetch(`${trackerUrl}/api/anilist/relay`, { headers });
  if (!res.ok) return { ran: 0, total: 0 };
  const { jobs = [] } = await res.json();
  let ran = 0; let last = 0;
  for (const job of jobs) {
    const wait = last + 2100 - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    let r;
    try {
      r = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query: job.query, variables: job.variables })
      });
    } catch { break; }
    if (r.status === 429) break; // rate limited: the rest waits for the next run
    const json = await r.json().catch(() => null);
    if (!r.ok || !json || !json.data) continue;
    await fetch(`${trackerUrl}/api/anilist/relay`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'X-Tracker-Client': client },
      body: JSON.stringify({ answers: [{ id: job.id, data: json.data }] })
    });
    ran += 1;
  }
  return { ran, total: jobs.length };
}
