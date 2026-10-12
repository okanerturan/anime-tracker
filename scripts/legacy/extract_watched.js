const fs = require('fs');

const raw = fs.readFileSync('dump', 'utf8');
const lines = raw.split(/\r?\n/).map((line) => line.trim());

const events = [];

for (let i = 0; i < lines.length - 2; i++) {
  const title = lines[i];
  const episodeLine = lines[i + 1];
  const dateLine = lines[i + 2];

  if (!title || !episodeLine || !dateLine) continue;

  const looksLikeEpisode = /^(S\d+\s+)?E[\dA-Z-]+\s+-\s+/.test(episodeLine);
  const looksLikeDate = /^\d{2}\/\d{2}\/\d{4}$/.test(dateLine);

  if (!looksLikeEpisode || !looksLikeDate) continue;

  events.push({
    title,
    episode: episodeLine,
    watchedAt: dateLine
  });
}

const watched = [...new Set(events.map((entry) => entry.title))];

fs.writeFileSync('data/watch-events.json', JSON.stringify(events, null, 2) + '\n');
fs.writeFileSync('data/watched-anime.json', JSON.stringify(watched, null, 2) + '\n');

console.log(`Extracted ${events.length} watch events.`);
console.log(`Extracted ${watched.length} unique anime titles.`);
