'use strict';
// R2 through its S3 API (hosted mode, 5.9): the hub writes posters and episode stills under the
// same keys the Cloudflare build uses (img/<sha1(url)>), so the front Worker serves them straight
// from its R2 binding. Configured by R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
// R2_BUCKET (R2_ENDPOINT overrides the endpoint, e.g. a fake S3 in tests).
const { AwsClient } = require('aws4fetch');

let client = null;
function configured() {
  return Boolean(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET && (process.env.R2_ACCOUNT_ID || process.env.R2_ENDPOINT));
}
function aws() {
  if (!client) client = new AwsClient({ accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY, service: 's3', region: 'auto' });
  return client;
}
const objectUrl = (key) => `${process.env.R2_ENDPOINT || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`}/${process.env.R2_BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`;

async function put(key, body, contentType) {
  const res = await aws().fetch(objectUrl(key), { method: 'PUT', body, headers: { 'Content-Type': contentType || 'application/octet-stream' } });
  if (!res.ok) throw new Error(`R2 put ${key}: ${res.status}`);
}
async function exists(key) {
  const res = await aws().fetch(objectUrl(key), { method: 'HEAD' });
  return res.ok;
}
async function get(key) {
  const res = await aws().fetch(objectUrl(key));
  return res.ok ? { body: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') } : null;
}

module.exports = { configured, put, exists, get, objectUrl, reset: () => { client = null; } };
