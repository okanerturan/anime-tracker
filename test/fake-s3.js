'use strict';
// An in-memory S3 for tests: PUT (and server-side copy), GET, HEAD, DELETE and ListObjectsV2,
// checking every request is SigV4-signed. Install with fakeS3.install(); restore with .uninstall().
function fakeS3(endpoint = 'https://fake-s3.test') {
  const objects = new Map(); // `${bucket}/${key}` -> { body, type }
  const calls = { put: 0, copy: 0, get: 0, del: 0, list: 0, unsigned: 0 };
  let real = null;
  async function handle(input, init) {
    const req = input instanceof Request ? input : new Request(input, init);
    if (!req.url.startsWith(endpoint)) return real(input, init);
    if (!/^AWS4-HMAC-SHA256 Credential=/.test(req.headers.get('authorization') || '')) calls.unsigned += 1;
    const u = new URL(req.url);
    const [bucket, ...rest] = u.pathname.slice(1).split('/');
    const key = rest.map(decodeURIComponent).join('/');
    if (req.method === 'GET' && !key && u.searchParams.get('list-type') === '2') {
      calls.list += 1;
      const prefix = `${bucket}/${u.searchParams.get('prefix') || ''}`;
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort().map((k) => k.slice(bucket.length + 1));
      return new Response(`<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`);
    }
    const id = `${bucket}/${key}`;
    if (req.method === 'PUT') {
      const src = req.headers.get('x-amz-copy-source');
      if (src) {
        calls.copy += 1;
        const from = objects.get(src.slice(1).split('/').map(decodeURIComponent).join('/'));
        if (!from) return new Response(null, { status: 404 });
        objects.set(id, from);
      } else { calls.put += 1; objects.set(id, { body: Buffer.from(await req.arrayBuffer()), type: req.headers.get('content-type') }); }
      return new Response(null, { status: 200 });
    }
    if (req.method === 'DELETE') { calls.del += 1; objects.delete(id); return new Response(null, { status: 204 }); }
    const hit = objects.get(id);
    if (req.method === 'GET') calls.get += 1;
    if (!hit) return new Response(null, { status: 404 });
    return new Response(req.method === 'HEAD' ? null : hit.body, { status: 200, headers: { 'content-type': hit.type || 'application/octet-stream' } });
  }
  return {
    objects, calls,
    keys: (bucket) => [...objects.keys()].filter((k) => k.startsWith(`${bucket}/`)).map((k) => k.slice(bucket.length + 1)).sort(),
    install() { real = global.fetch; global.fetch = handle; return this; },
    uninstall() { if (real) global.fetch = real; }
  };
}
module.exports = { fakeS3 };
