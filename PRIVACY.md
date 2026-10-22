# Tsuzuku extension: privacy policy

Last updated: 2026-10-23

The Tsuzuku browser extension ("the extension") connects your Crunchyroll watch history to a Tsuzuku
tracker that **you** choose: one you run yourself, or one you sign in to. It has no servers of its own
and sends nothing to its developer.

## What the extension reads

- **Your Crunchyroll watch history** (show, season and episode identifiers and titles, when you
  watched, how far you got) and the episode lists of seasons you watched. It reads these from
  crunchyroll.com in your own browser, using your existing Crunchyroll sign-in.
- **The Crunchyroll page you are on**, only to show your progress card for that show.

It never reads or stores your Crunchyroll password. The short-lived access token it obtains from your
own session stays in memory and is never stored or sent anywhere except back to Crunchyroll.

## Where it sends data

- **Only to the tracker address you enter** in the extension's settings. That tracker stores your
  history to build your watch list. Who operates that tracker, and its own privacy policy, decide what
  happens to the data there.
- **AniList** (graphql.anilist.co) receives public catalog questions (show identifiers, titles) when
  your tracker asks the browser to look shows up for it. Nothing personal is included.

No analytics, advertising, tracking or data sales. Nothing is sent to the extension's developer.

## What it stores in your browser

Your tracker address, an optional tracker key, the time and result of the last sync, and your
settings (notifications, the progress card), in Chrome's extension storage on your device.
Uninstalling the extension removes them.

## Contact

Questions: open an issue at https://github.com/okanerturan/anime-tracker/issues
