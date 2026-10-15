// The Cloudflare build is single-user: hosted-mode kill switches never apply (swapped in by build.mjs).
module.exports = { thumbnailsOff: () => false, refuse: () => null, get: () => undefined };
