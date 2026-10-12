(async () => {
  const AUTH = prompt("Paste Authorization value (Bearer ...)").trim();
  if (!AUTH) throw new Error("Missing token");

  const headers = {
    accept: "application/json, text/plain, */*",
    authorization: AUTH
  };

  const fetchJSON = async (url) => {
    const r = await fetch(url, { headers, credentials: "include" });
    const t = await r.text();
    if (!r.ok) throw new Error(`${r.status}: ${t.slice(0, 300)}`);
    return JSON.parse(t);
  };

  const me = await fetchJSON("https://www.crunchyroll.com/accounts/v1/me");
  const accountId = me.account_id;

  const n = 500;
  let start = 0;
  const all = [];

  while (true) {
    const url = `https://www.crunchyroll.com/content/v2/discover/${accountId}/watchlist?order=desc&start=${start}&n=${n}`;
    const j = await fetchJSON(url);
    const rows = Array.isArray(j.data) ? j.data : [];
    all.push(...rows);
    if (rows.length < n) break;
    start += n;
    await new Promise((r) => setTimeout(r, 250));
  }

  const titles = [...new Set(
    all
      .map((x) => x?.panel?.title || x?.panel?.episode_metadata?.series_title || x?.title || "")
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));

  const dl = (name, data) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
    );
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  dl("crunchyroll-watchlist-live-raw.json", all);
  dl("crunchyroll-watchlist-live-titles.json", titles);

  console.log({ accountId, totalItems: all.length, uniqueTitles: titles.length });
})();
