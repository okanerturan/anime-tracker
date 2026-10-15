'use strict';
// The front Worker (worker/front.js) against a fake R2 binding and a fake hub origin.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const KEY = 'test-signing-key';
const hash = crypto.createHash('sha1').update('https://s4.anilist.co/file/poster.jpg').digest('hex');

async function load() {
  const mod = await import('../worker/front.js');
  mod._test.reset();
  return mod;
}
function env(objects = {}) {
  return {
    ORIGIN_URL: 'https://origin.test', ORIGIN_SECRET: 'origin-secret', IMAGE_SIGNING_KEY: KEY,
    IMAGES: { get: async (k) => (objects[k] ? { body: objects[k], httpMetadata: { contentType: 'image/jpeg' }, httpEtag: '"e"' } : null) }
  };
}

test('signatures made by the app are accepted for this period and the last, and nothing older', async () => {
  const { validSignature } = await load();
  process.env.IMAGE_SIGNING_KEY = KEY;
  const imgsig = require('../server/imgsig');
  const now = Date.now();
  assert.equal(await validSignature(hash, imgsig.sign(hash, imgsig.period(now)), KEY, now), true, 'Node and Web Crypto agree');
  assert.equal(await validSignature(hash, imgsig.sign(hash, imgsig.period(now) - 1), KEY, now), true, 'last period still works');
  assert.equal(await validSignature(hash, imgsig.sign(hash, imgsig.period(now) - 2), KEY, now), false, 'two periods back is expired');
  assert.equal(await validSignature(hash, 'made-up', KEY, now), false);
  assert.match(require('../server/images').localUrl('https://s4.anilist.co/file/poster.jpg'), new RegExp(`^/img/${hash}\\?u=.+&s=[\\w-]{22}$`), 'the app signs its links');
  delete process.env.IMAGE_SIGNING_KEY;
});

test('front Worker: signed image from R2, unsigned refused, missing image and pages go to the origin with the secret', async () => {
  const front = (await load()).default;
  process.env.IMAGE_SIGNING_KEY = KEY;
  const s = require('../server/imgsig').sign(hash);
  delete process.env.IMAGE_SIGNING_KEY;
  const seen = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => { seen.push({ url: String(url), auth: init.headers.get('X-Origin-Auth'), ip: init.headers.get('X-Client-IP') }); return new Response('from origin', { status: 200 }); };
  try {
    const hit = await front.fetch(new Request(`https://w.test/img/${hash}?u=x&s=${s}`), env({ [`img/${hash}`]: 'jpeg-bytes' }));
    assert.equal(hit.status, 200); assert.equal(await hit.text(), 'jpeg-bytes'); assert.equal(seen.length, 0, 'served from R2 without the hub');
    assert.equal((await front.fetch(new Request(`https://w.test/img/${hash}?u=x`), env())).status, 403, 'unsigned');
    assert.equal((await front.fetch(new Request(`https://w.test/img/${hash}?u=x&s=AAAAAAAAAAAAAAAAAAAAAA`), env())).status, 403, 'forged');
    const miss = await front.fetch(new Request(`https://w.test/img/${hash}?u=x&s=${s}`), env());
    assert.equal(await miss.text(), 'from origin', 'not in R2 yet: the hub fetches it');
    await front.fetch(new Request('https://w.test/api/up-next', { headers: { 'CF-Connecting-IP': '203.0.113.9' } }), env());
    assert.deepEqual(seen.at(-1), { url: 'https://origin.test/api/up-next', auth: 'origin-secret', ip: '203.0.113.9' });
  } finally { global.fetch = realFetch; }
});

test('front Worker: a failing hub gives 502 at first and the maintenance page after a minute', async () => {
  const front = (await load()).default;
  const realFetch = global.fetch; const realNow = Date.now;
  global.fetch = async () => { throw new Error('connection refused'); };
  let t = 1_000_000; Date.now = () => t;
  try {
    const page = () => front.fetch(new Request('https://w.test/', { headers: { Accept: 'text/html' } }), env());
    assert.equal((await page()).status, 502, 'first failure: no maintenance page yet');
    t += 61e3;
    const later = await page();
    assert.equal(later.status, 503); assert.match(await later.text(), /Back in a few minutes/);
    global.fetch = async () => new Response('ok');
    assert.equal((await page()).status, 200, 'recovers as soon as the hub answers');
  } finally { global.fetch = realFetch; Date.now = realNow; }
});
