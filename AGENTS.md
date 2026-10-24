# Operating the tracker (Tsuzuku)

## Where it runs (since 2026-10-23)

- **App:** container `anime-tracker-web` on hub (178.104.118.172), Kamal 2, `AUTH_MODE=passphrase`, data in
  `/srv/anime-tracker` (`anime-tracker.db`, image cache, `backups/`). Origin:
  `https://anime-tracker.178-104-118-172.sslip.io`, which refuses anything without `X-Origin-Auth`.
- **Front:** the Cloudflare Worker `anime-tracker` (anime-tracker.okan.workers.dev) still checks the passphrase
  (its `APP_PASSPHRASE` secret) and, because its `ORIGIN_URL` secret is set, forwards everything to the hub
  with `ORIGIN_SECRET`. Images it cached in R2 before the move are served from its R2 binding.
- **Rollback:** `npx wrangler secret delete ORIGIN_URL` (with `CLOUDFLARE_API_TOKEN` unset): the Worker serves
  from its Durable Object again at once. That copy stopped receiving changes at the move (2026-10-23).
- **Deploy the app:** `bin/kamal deploy` from this Mac (builds amd64 locally, needs Docker: `colima start`;
  the image goes to the hub through Kamal's local registry, no registry account). Deploy the Worker:
  `npm run deploy`. Secrets: `~/.config/anime-tracker/hub.env` (ORIGIN_SECRET, same value as the Worker's).
- **Backups:** `server/localbackup.js` writes `/srv/anime-tracker/backups/<day>/anime-tracker.db.gz` nightly
  (~03:00 Europe/Tirane, 14 days kept); hub-backup's restic run ships the folder to the Storage Box. Restore:
  stop the container (`bin/kamal app stop`), gunzip a copy over `/srv/anime-tracker/anime-tracker.db`
  (delete its `-wal`/`-shm`), `bin/kamal app boot`.
- **Watching:** hub-check alerts if `anime-tracker-web` is down or `backups/last-backup.json` is older than 26 h.
- AniList answers the hub directly (Cloudflare's addresses are blocked), so the browser relay stays idle.
- Episode data: the weekly ID map (Fribb's anime-lists, `catalog_idmap`, state key `idmap`) loads from
  the refresh cycle. `UPSTREAM_DNS` (comma-separated resolvers, e.g. `1.1.1.1,1.0.0.1`) makes the
  episode sources and the ID map look hosts up there instead of the system resolver; needed on this Mac
  without the VPN (the ISP answers `api.themoviedb.org` itself), not on the hub.

The sections below describe the accounts mode (`AUTH_MODE=accounts`), built but not switched on yet.

# Operating the hosted tracker

Notes for whoever runs the hosted build (`AUTH_MODE=accounts`) on the hub. The single-user tracker
(Cloudflare Durable Object or `node server.js` at home) needs none of this.

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

## Front Worker and origin lock

`worker/front.js` (config `wrangler.front.jsonc`) keeps the workers.dev address: signed `/img/<sha1>`
links come straight from R2, everything else goes to the hub with `X-Origin-Auth`. The hub refuses any
request without that secret, except kamal-proxy's `GET /up`.

- Secrets on the Worker: `ORIGIN_URL`, `ORIGIN_SECRET`, `IMAGE_SIGNING_KEY`. On the hub: `ORIGIN_SECRET`
  (plus `ORIGIN_SECRET_PREVIOUS` while rotating) and the same `IMAGE_SIGNING_KEY`.
- Rotating the origin secret: set the new value as `ORIGIN_SECRET` and the old one as
  `ORIGIN_SECRET_PREVIOUS` on the hub and deploy; update the Worker's `ORIGIN_SECRET`; then remove
  `ORIGIN_SECRET_PREVIOUS` and deploy again.
- Image links are valid for 7 to 14 days (the current 7-day period and the previous one). Changing
  `IMAGE_SIGNING_KEY` breaks links in pages already open until they reload.
- When the hub fails for a minute, page loads get a maintenance page. A deliberate 503 from the hub
  (`X-Tracker-Maintenance: 1`, from the switches above) is passed through with its message.
- Local run: `npx wrangler dev -c wrangler.front.jsonc --var ORIGIN_URL:http://127.0.0.1:8080 --var ORIGIN_SECRET:<test> --var IMAGE_SIGNING_KEY:<test>`
  in front of `AUTH_MODE=accounts ORIGIN_SECRET=<test> IMAGE_SIGNING_KEY=<test> node server.js`.

## Images in R2

With `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET` set, the hub puts each
image into R2 once under `img/<sha1(url)>` (the key the front Worker serves) and remembers it in the
catalog's `image_cache` as `r2:<key>`. The key needs write access to that one bucket only.

## Backups and restore

Nightly at about 03:00 (`TIMEZONE`), the app snapshots `accounts.db`, `catalog.db` and every account
file that changed since its last upload (`VACUUM INTO`, gzip) to the `hub-backups` bucket under
`anime-tracker/YYYY-MM-DD/`. Each day has a `manifest.json` naming the newest copy of every file, so one
day's manifest restores everything. Days older than 30 are deleted; a copy still needed is copied
forward first, so an account unchanged for months keeps a backup. Hetzner's daily server backups stay
on as the second layer.

- Settings: `R2_ACCOUNT_ID`, `R2_BACKUP_ACCESS_KEY_ID`, `R2_BACKUP_SECRET_ACCESS_KEY` (a key that can
  only reach `hub-backups`), optional `R2_BACKUP_BUCKET`.
- Last good run: `/data/last-snapshot.json` (`lastSuccessAt`); `hub-check` alerts past 26 hours.
- A run in progress holds `/data/snapshot.lock`; a lock older than 2 hours is taken over.

Restore (and the quarterly drill), always into a scratch directory first:

```sh
bin/kamal app exec 'node scripts/restore.js --to /data/restore-drill --day 2026-10-14 --account 12'
# prints row counts for accounts.db, catalog.db and account 12: compare with the live files
```

To put one account back: `READ_ONLY on` (or stop the app), copy
`/data/restore-drill/accounts/<id>.db` over `/data/accounts/<id>.db` and delete its `-wal`/`-shm`,
then `READ_ONLY off`. No other account is touched. `--all` restores every account (whole-box rebuild:
`kamal setup` on the new box, restore with `--all` into `/data`, start).

## Deploy (Kamal)

`Dockerfile` (Node 26, better-sqlite3 built in the image, runs as `node` on port 3000) and
`config/deploy.yml` (hub 178.104.118.172, `anime-tracker.178-104-118-172.sslip.io`, 1 GB / 1 CPU,
`/srv/anime-tracker:/data`, health check `GET /up`). Secrets come from the environment through
`.kamal/secrets`, which holds only variable names.

- Once on the box: `mkdir -p /srv/anime-tracker && chown 1000:1000 /srv/anime-tracker`.
- `AUTH_MODE=passphrase` with `APP_PASSPHRASE` gives the same passphrase gate and session cookie as the
  Cloudflare build (`server/passgate.js`), so signed-in browsers and the extension keep working when
  the front Worker starts proxying. Switch to `AUTH_MODE=accounts` at migration step 5.
- Kamal isn't installed on this Mac yet: `gem install kamal` (or the official Docker image) before the
  first `kamal setup`.
- Local check of the image: `docker build -t anime-tracker:local .` then
  `docker run -p 8195:3000 -v at-data:/data -e APP_PASSPHRASE=test -e NO_SYNC=1 anime-tracker:local`.
