'use strict';
// Outgoing requests to episode sources and the ID map. With UPSTREAM_DNS (comma-separated resolver
// addresses, e.g. "1.1.1.1,1.0.0.1") hostnames are looked up through those servers instead of the
// system resolver: some networks answer for upstream hosts themselves (seen with an ISP that sends
// api.themoviedb.org to its own page). Unset, this is plain fetch.
const dns = require('dns');
const http = require('http');
const https = require('https');

/** A `lookup` for http(s).request that asks `servers` (or `resolve`, for tests) first. */
function makeLookup(servers, resolve = null) {
  const resolver = new dns.promises.Resolver({ timeout: 5000, tries: 2 });
  if (!resolve) resolver.setServers(servers);
  const ask = resolve || (async (host) => {
    try { return (await resolver.resolve4(host)).map((address) => ({ address, family: 4 })); }
    catch { return (await resolver.resolve6(host)).map((address) => ({ address, family: 6 })); }
  });
  return (host, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    ask(host).then((list) => {
      if (!list.length) throw Object.assign(new Error(`no address for ${host}`), { code: 'ENOTFOUND' });
      return list;
    }).then((list) => (opts.all ? cb(null, list) : cb(null, list[0].address, list[0].family)), (err) => cb(err));
  };
}

/** fetch() through `lookup`: method, headers, body, signal and up to 5 redirects; returns a Response. */
function fetchWith(lookup) {
  const one = (url, opts) => new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: opts.method || 'GET', headers: opts.headers || {}, lookup, signal: opts.signal }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) for (const x of [].concat(v)) headers.append(k, x);
        const body = [101, 204, 205, 304].includes(res.statusCode) ? null : Buffer.concat(chunks);
        resolve(Object.assign(new Response(body, { status: res.statusCode, headers }), { location: res.headers.location }));
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
  return async function upstreamFetch(url, opts = {}) {
    let current = String(url);
    for (let hops = 0; hops <= 5; hops += 1) {
      const res = await one(current, opts);
      if (![301, 302, 303, 307, 308].includes(res.status) || !res.location) return res;
      current = new URL(res.location, current).href;
    }
    throw new Error('too many redirects');
  };
}

const servers = String(process.env.UPSTREAM_DNS || '').split(',').map((s) => s.trim()).filter(Boolean);
/** The fetch the episode sources and the ID map use. */
const upstreamFetch = servers.length ? fetchWith(makeLookup(servers)) : (...args) => fetch(...args);

module.exports = { fetch: upstreamFetch, makeLookup, fetchWith, servers };
