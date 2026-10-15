'use strict';
// R2 through its S3 API (hosted mode). Two buckets with separate keys, each scoped to one bucket:
//   images  (5.9): R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, writes img/<sha1(url)>, the key
//                  the front Worker serves from its R2 binding;
//   backups (8.2): R2_BACKUP_ACCESS_KEY_ID, R2_BACKUP_SECRET_ACCESS_KEY, R2_BACKUP_BUCKET (hub-backups).
// Both use R2_ACCOUNT_ID; R2_ENDPOINT overrides the endpoint (a fake S3 in tests).
const { AwsClient } = require('aws4fetch');

function bucket(prefix, defaultBucket = '') {
  let client = null;
  const env = (k) => process.env[`${prefix}${k}`];
  const name = () => env('BUCKET') || defaultBucket;
  const configured = () => Boolean(env('ACCESS_KEY_ID') && env('SECRET_ACCESS_KEY') && name() && (process.env.R2_ACCOUNT_ID || process.env.R2_ENDPOINT));
  const aws = () => (client ||= new AwsClient({ accessKeyId: env('ACCESS_KEY_ID'), secretAccessKey: env('SECRET_ACCESS_KEY'), service: 's3', region: 'auto' }));
  const base = () => `${process.env.R2_ENDPOINT || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`}/${name()}`;
  const objectUrl = (key) => `${base()}/${key.split('/').map(encodeURIComponent).join('/')}`;

  async function put(key, body, contentType) {
    const res = await aws().fetch(objectUrl(key), { method: 'PUT', body, headers: { 'Content-Type': contentType || 'application/octet-stream' } });
    if (!res.ok) throw new Error(`R2 put ${key}: ${res.status}`);
  }
  async function get(key) {
    const res = await aws().fetch(objectUrl(key));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`R2 get ${key}: ${res.status}`);
    return { body: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') };
  }
  async function exists(key) { return (await aws().fetch(objectUrl(key), { method: 'HEAD' })).ok; }
  async function del(key) {
    const res = await aws().fetch(objectUrl(key), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error(`R2 delete ${key}: ${res.status}`);
  }
  /** Server-side copy within the bucket (no download). */
  async function copy(from, to) {
    const res = await aws().fetch(objectUrl(to), { method: 'PUT', headers: { 'x-amz-copy-source': `/${name()}/${from.split('/').map(encodeURIComponent).join('/')}` } });
    if (!res.ok) throw new Error(`R2 copy ${from} -> ${to}: ${res.status}`);
  }
  /** Every key under a prefix (ListObjectsV2, following continuation tokens). */
  async function list(prefix) {
    const keys = []; let token = null;
    do {
      const q = new URLSearchParams({ 'list-type': '2', prefix, ...(token ? { 'continuation-token': token } : {}) });
      const res = await aws().fetch(`${base()}?${q}`);
      if (!res.ok) throw new Error(`R2 list ${prefix}: ${res.status}`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1].replace(/&amp;/g, '&'));
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? (xml.match(/<NextContinuationToken>([^<]+)</) || [])[1] : null;
    } while (token);
    return keys;
  }
  return { configured, put, get, exists, del, copy, list, objectUrl, reset: () => { client = null; } };
}

const images = bucket('R2_');
const backups = bucket('R2_BACKUP_', 'hub-backups');

// The image functions stay at the top level (images.js uses them as before).
module.exports = { ...images, images, backups, bucket };
