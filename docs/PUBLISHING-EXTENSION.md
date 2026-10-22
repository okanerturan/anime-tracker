# Publishing the extension to the Chrome Web Store

Releases are automatic once the one-time setup below is done: bump `version` in
`extension/manifest.json`, commit, then

```sh
git tag ext-v1.13.8 && git push origin ext-v1.13.8
```

`.github/workflows/publish-extension.yml` runs the tests, zips `extension/`
(`scripts/package-extension.mjs`, the tag must match the manifest), uploads the zip and submits it for
review (`scripts/cws.mjs`). Google reviews it, usually within 1–3 days, and installed copies update
themselves. Re-run a failed one from Actions → Publish extension → Run workflow with the tag.

Store images (two 1280×800 screenshots and the 440×280 promo tile, from the real popup and card): `npm run ext:assets` → `releases/store/`.

Locally, with the same variables set: `npm run ext:package`, `npm run cws:status`,
`CWS_SOURCE_PATH=releases/tsuzuku-extension-vX.Y.Z.zip npm run cws:publish`.

## Current setup (done 2026-10-23)

| | |
| --- | --- |
| Publisher | Okan Erturan (personal), ID `ef4f85d6-9b8c-4f46-b7c6-472c614da50b` |
| Item | `eeegieckllpapcmippbkkklmoeocoeil`, Unlisted, free |
| Service account | `tsuzuku-cws-publisher@chrome-plugin-uploader.iam.gserviceaccount.com`, registered in the publisher's settings |
| GitHub secrets | `CWS_SA_KEY`, `CWS_PUBLISHER_ID`, `CWS_EXTENSION_ID` |
| Store page | https://chromewebstore.google.com/detail/eeegieckllpapcmippbkkklmoeocoeil |

The listing and privacy answers were filled in by driving the dashboard over the DevTools protocol in a
separate Chrome profile (`~/.config/anime-tracker/cws-chrome`, signed in as okanert@gmail.com): Chrome
blocks extensions, including browser-automation ones, from scripting Web Store pages.

## One-time setup

The publisher is Okan's personal Chrome Web Store developer account (okanert@gmail.com), not the
Loqalit group publisher.

1. **Developer account.** Sign in to https://chrome.google.com/webstore/devconsole as okanert@gmail.com
   (one-time registration fee if this account never registered). Settings → Account shows the
   **publisher ID**.
2. **First upload, by hand.** The API can only update an item that exists. Run
   `npm run ext:package`, then in the dashboard: New item → upload the zip. Its **extension ID** is
   shown afterwards.
3. **Store listing** (dashboard only), see the text below: description, category, at least one
   1280×800 screenshot, a 440×280 promo tile, the 128×128 icon (`extension/icons/icon-128.png`).
4. **Privacy practices tab** (dashboard only; without it, submitting fails with
   `INVALID_ITEM_METADATA`): single purpose, a justification for each permission (below), data usage
   (it handles "web history" for Crunchyroll only; not sold, not used for anything else), and the
   privacy policy URL: https://github.com/okanerturan/anime-tracker/blob/main/PRIVACY.md
5. **Visibility.** Unlisted (only people with the link) until there is a hosted tracker people can
   sign up for; public after that.
6. **Service account.** In Google Cloud project `chrome-plugin-uploader` (owned by okanert@gmail.com),
   create a service account just for this publisher (the Loqalit one stays Loqalit's), make a key,
   and enter the service account's email in the dashboard: Settings → Service account.
7. **GitHub secrets** on this repository: `CWS_SA_KEY` (the key file's JSON), `CWS_PUBLISHER_ID`,
   `CWS_EXTENSION_ID`. Then delete the local key file.

## Listing text

**Name:** Tsuzuku: sync for Crunchyroll
**Summary (132 chars max):** Turns your Crunchyroll history into a watch list: what to watch next,
new episodes and seasons, and your progress on every show page.

**Description:**

> Tsuzuku keeps a watch list for you from what you actually watch on Crunchyroll.
>
> • Up next: the next episode of every show you're watching, one click to play it on Crunchyroll
> • Your progress on every Crunchyroll show page, with Play, Hold and Drop right there
> • New episodes and new seasons of the shows you follow
> • Works with a Tsuzuku tracker: your own (free, open source) or a hosted one
>
> The extension reads your watch history in your own browser and sends it only to the tracker you
> choose. No ads, no analytics. Tsuzuku is not affiliated with Crunchyroll.

## Permission justifications

| Permission | Justification |
| --- | --- |
| `alarms` | Syncs your Crunchyroll watch history to your tracker every 30 minutes. |
| `storage` | Remembers your tracker address, optional tracker key, settings and the last sync result. |
| `notifications` | Tells you when a show you are watching has a new episode (can be turned off). |
| `https://www.crunchyroll.com/*` | Reads your watch history and season episode lists, and shows your progress card on show pages. |
| `https://graphql.anilist.co/*` | Looks up public show information (titles, episode counts) for your tracker. |
| `https://*.workers.dev/*`, `http://localhost/*`, `http://127.0.0.1/*` | Sends your history to the tracker address you enter (a self-hosted tracker runs on one of these). |
