// Checks the test server end to end without a browser: the allowed bucket answers the preflight for the page's origin
// and the denied one refuses it, a presigned POST sent in the plugin's order (fields sorted by name, then the file)
// stores the bytes unchanged, and a presigned GET reads them back. Run with the emulator and server.mjs up.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const SERVER = `http://localhost:${process.env.PORT ?? 4580}`;
const ORIGIN = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173').split(',')[0].trim();

async function post(path, body) {
  return (await fetch(SERVER + path, { method: 'POST', body: JSON.stringify(body) })).json();
}

async function preflight(url) {
  const res = await fetch(url, {
    method: 'OPTIONS',
    headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' },
  });
  return { status: res.status, allowOrigin: res.headers.get('access-control-allow-origin') };
}

const key = `check/${Date.now()}.bin`;
const bytes = crypto.randomBytes(256 * 1024);
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

const allowed = await post('/presign', { key });
const allowedPreflight = await preflight(allowed.url);
assert.equal(allowedPreflight.status, 200, 'preflight to the allowed bucket');
assert.equal(allowedPreflight.allowOrigin, ORIGIN);
console.log('ok  preflight allowed', allowedPreflight);

const denied = await post('/presign', { key, bucket: 'denied' });
const deniedPreflight = await preflight(denied.url);
assert.equal(deniedPreflight.status, 403, 'preflight to the denied bucket');
assert.equal(deniedPreflight.allowOrigin, null);
console.log('ok  preflight denied', deniedPreflight);

const form = new FormData();
for (const [name, value] of Object.entries(allowed.fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
  form.append(name, value);
}
form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), 'check.bin');
const upload = await fetch(allowed.url, { method: 'POST', body: form, headers: { Origin: ORIGIN } });
assert.equal(upload.status, 204, `presigned POST: ${await upload.text()}`);
assert.equal(upload.headers.get('access-control-allow-origin'), ORIGIN);
console.log('ok  presigned POST', upload.status);

const stored = await (await fetch(`${SERVER}/object?key=${encodeURIComponent(key)}`)).json();
assert.equal(stored.sha256, sha256, 'stored bytes');
console.log('ok  object in bucket', stored.size, 'bytes, sha256 matches');

const { url } = await post('/presign-get', { key });
const download = await fetch(url, { headers: { Origin: ORIGIN } });
assert.equal(download.status, 200);
assert.equal(download.headers.get('access-control-allow-origin'), ORIGIN);
const back = Buffer.from(await download.arrayBuffer());
assert.equal(crypto.createHash('sha256').update(back).digest('hex'), sha256, 'downloaded bytes');
console.log('ok  presigned GET, sha256 matches');

const tampered = url.replace(/X-Amz-Signature=([0-9a-f])/, (_, c) => `X-Amz-Signature=${c === '0' ? '1' : '0'}`);
assert.equal((await fetch(tampered)).status, 403, 'a GET with a wrong signature is refused');
console.log('ok  signatures are checked');
