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
