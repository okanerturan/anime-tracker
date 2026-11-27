# Operating the tracker (Tsuzuku)

## Where it runs (since 2026-10-23)

- **App:** container `anime-tracker-web` on hub (178.104.118.172), Kamal 2, `AUTH_MODE=passphrase`, data in
  `/srv/anime-tracker` (`anime-tracker.db`, image cache, `backups/`). Address since 2026-10-28:
  `https://tsuzuku.okanerturan.com`, a DNS-only A record in the okanerturan.com zone on Cloudflare (proxy
  off, like BoxitApp's hosts); kamal-proxy routes by hostname and gets the Let's Encrypt certificate. The app
  checks the passphrase itself (`server/passgate.js`, `APP_PASSPHRASE`); there is no front Worker and no
  origin lock (both removed from the code on 2026-11-25).
- **Old address:** the Worker `anime-tracker` (anime-tracker.okan.workers.dev) only answers 308 to the same path
  on the new address (`wrangler.redirect.jsonc`, `worker/redirect.mjs`, `npm run deploy:redirect`).
  Extension 1.15.0 rewrites a saved
  workers.dev address to the new one. Delete the Worker once nothing uses the old address. The self-hosted
  Cloudflare build (Durable Object, R2, `npm run deploy`) was retired and removed on 2026-11-25; git history
  has it (last commit with it: `d6178a8`), and the extension has no `*.workers.dev` access since 1.16.5.
  `scripts/backup.js restore <file> --local <db>` still reads that build's archived JSON backups. Nothing else is
  on Cloudflare: the Durable Object (migration v2, 2026-10-27) and the R2 images bucket are deleted; the
  images are in the hub's image cache. The Durable Object's daily backups (2026-10-13 to -22, everything in
  them is also on the hub) are in `/srv/anime-tracker/backups/archive/` (see its README.txt).
- **Recovery:** if the hub is lost, restore from restic (Storage Box) onto a new box and point the DNS record
  at it; checked 2026-10-27 by restoring the nightly file into a scratch folder.
- **Deploy the app:** `bin/kamal deploy` from this Mac (builds amd64 locally, needs Docker: `colima start`;
  the image goes to the hub through Kamal's local registry, no registry account). Secrets:
  `~/.config/anime-tracker/hub.env` (`APP_PASSPHRASE`, `TMDB_API_READ_ACCESS_TOKEN`), read by `.kamal/secrets`.
- **Backups:** `server/localbackup.js` writes `/srv/anime-tracker/backups/<day>/anime-tracker.db.gz` nightly
  (~03:00 Europe/Tirane, 14 days kept); hub-backup's restic run ships it and `images/` to the Storage Box. Restore:
  stop the container (`bin/kamal app stop`), gunzip a copy over `/srv/anime-tracker/anime-tracker.db`
  (delete its `-wal`/`-shm`), `bin/kamal app boot`.
- **Wrong-passphrase limit** (`server/guesses.js`, since 2026-11-25): ten different wrong passphrases, keys
  or session cookies from one address within 15 minutes, and that address's passphrase and key attempts get
  429 until its oldest guess is 15 minutes old (the right one included; a valid session cookie always gets
  through). Addresses that have never signed in share 60 between them. The same wrong value repeated counts
  once. The caller's address is kamal-proxy's `X-Forwarded-For` (it replaces whatever the caller sent). All
  of it is in memory: any deploy, or `bin/kamal app boot`, clears every count and lock.
- **Watching:** hub-check alerts if `anime-tracker-web` is down or `backups/last-backup.json` is older than 26 h.
- AniList answers the hub directly (Cloudflare's addresses are blocked), so the browser relay stays idle.
- Episode data: the weekly ID map (Fribb's anime-lists, `catalog_idmap`, state key `idmap`) loads from
  the refresh cycle. `UPSTREAM_DNS` (comma-separated resolvers, e.g. `1.1.1.1,1.0.0.1`) makes the
  episode sources and the ID map look hosts up there instead of the system resolver; needed on this Mac
  without the VPN (the ISP answers `api.themoviedb.org` itself), not on the hub.

The sections below describe the accounts mode (`AUTH_MODE=accounts`), built but not switched on yet.

# Operating the hosted tracker

Notes for whoever runs the hosted build (`AUTH_MODE=accounts`) on the hub. The single-user tracker
(`node server.js` at home, or the hub in passphrase mode) needs none of this.

## Kill switches

Runtime settings in `accounts.db`, read on every request with a 10-second cache, so a flip takes effect
within about 10 seconds and needs no deploy. Run them inside the container:

| Switch | Values | What it does |
| --- | --- | --- |
| `SYNC_PAUSED` | a message, or `""` to resume | Refuses the extension's sync routes (503). Popups show the message. |
| `READ_ONLY` | `on` / `off` | Pages load; every write (sync, ratings, account changes) gets a maintenance message. Signing in and out still work. |
| `THUMBNAILS` | `off` / `on` | No episode stills in any response; pages show the show's poster instead. |
| `SIGNUP` | `closed` / `invite` / `open` | Who can create an account. |

```sh
bin/kamal app exec 'node scripts/switch.js'                         # show all
bin/kamal app exec 'node scripts/switch.js SYNC_PAUSED "Crunchyroll changed something; fix coming"'
bin/kamal app exec 'node scripts/switch.js SYNC_PAUSED ""'          # resume
bin/kamal app exec 'node scripts/switch.js READ_ONLY on'
```

Environment variables with the same names only give the first value while the table has none.

## Images and backups (accounts mode)

Accounts mode runs at the same direct address as today (no Worker in front, no R2; removed 2026-11-25).

- Images: the hub's image cache, shared by every account (`/srv/anime-tracker/images`, in restic).
- Backups: `server/localbackup.js` copies `accounts.db`, `catalog.db` and every `accounts/<id>.db` into
  `BACKUP_DIR` nightly (one gzipped file each per day, 14 days); hub-backup's restic ships them offsite.
- Restore one account: `READ_ONLY on` (or stop the app), gunzip that day's `accounts__<id>.db.gz` over
  `/data/accounts/<id>.db` and delete its `-wal`/`-shm`, then `READ_ONLY off`. No other account is
  touched. Whole box: restore the folder from restic onto a new box, gunzip each file into `/data`, boot.
- Sign-in limits key on the caller's address from kamal-proxy's `X-Forwarded-For` (`server/guesses.js`).

## Deploy (Kamal)

`Dockerfile` (Node 26, better-sqlite3 built in the image, runs as `node` on port 3000) and
`config/deploy.yml` (hub 178.104.118.172, `tsuzuku.okanerturan.com`, 1 GB / 1 CPU,
`/srv/anime-tracker:/data`, health check `GET /up`). Secrets come from the environment through
`.kamal/secrets`, which holds only variable names.

- Once on the box: `mkdir -p /srv/anime-tracker && chown 1000:1000 /srv/anime-tracker`.
- `AUTH_MODE=passphrase` with `APP_PASSPHRASE` gives the same passphrase gate and session cookie as the
  Cloudflare build (`server/passgate.js`), so signed-in browsers and the extension keep working when
  a deploy. Switch to `AUTH_MODE=accounts` at migration step 5.
- Kamal isn't installed on this Mac yet: `gem install kamal` (or the official Docker image) before the
  first `kamal setup`.
- Local check of the image: `docker build -t anime-tracker:local .` then
  `docker run -p 8195:3000 -v at-data:/data -e APP_PASSPHRASE=test -e NO_SYNC=1 anime-tracker:local`.
