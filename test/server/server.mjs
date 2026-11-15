// Test server for the web implementation, in front of the S3 emulator from docker-compose.yml.
//
// - Creates two buckets: `uploads-allowed`, whose CORS rules allow the page's origin, and `uploads-denied`, whose rules
//   allow only another origin (the negative control: the browser must refuse the upload and the plugin report FAILED).
// - POST /presign            { key, bucket?, slow? } -> { url, fields } : a presigned S3 POST, ready for startUpload
//                            ({ serverUrl: url, parameters: fields, fileKey: 'file' }).
// - POST /presign-get        { key, bucket? } -> { url } : a presigned GET for downloading the object back.
// - GET  /object?key=&bucket= -> { exists, size, sha256, contentType } : what landed in the bucket.
// - POST /echo               : a multipart sink that records the parts in the order received (GET /echo-log).
// - GET  /s3-log?since=<ms>  : every request the browser sent to S3, preflight OPTIONS included, with its CORS headers
//                              and the answer (browsers do not all show preflights in their own network logs).
//
// The browser reaches S3 through two logging proxies: PROXY_PORT at full speed and SLOW_PORT, which trickles the
// request body at SLOW_BPS so a test can reload or abort mid-upload in every engine.
import crypto from 'node:crypto';
import http from 'node:http';

import {
  CopyObjectCommand,
  CreateBucketCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import Busboy from 'busboy';

const S3_PORT = Number(process.env.S3_PORT ?? 4566);
const PORT = Number(process.env.PORT ?? 4580);
const PROXY_PORT = Number(process.env.PROXY_PORT ?? 4581);
const SLOW_PORT = Number(process.env.SLOW_PORT ?? 4582);
const SLOW_BPS = Number(process.env.SLOW_BPS ?? 200_000);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173').split(',').map((o) => o.trim());

/** The CORS rules a bucket needs for a page that uploads with this plugin and downloads with fetch. */
export const ALLOWED_CORS = {
  CORSRules: [
    {
      AllowedOrigins: ALLOWED_ORIGINS,
      AllowedMethods: ['POST', 'GET', 'HEAD'],
      AllowedHeaders: ['*'],
      ExposeHeaders: ['ETag'],
      MaxAgeSeconds: 3000,
    },
  ],
};
const DENIED_CORS = {
  CORSRules: [
    { AllowedOrigins: ['https://other.example.com'], AllowedMethods: ['POST', 'GET'], AllowedHeaders: ['*'] },
  ],
};
const BUCKETS = { allowed: 'uploads-allowed', denied: 'uploads-denied' };

const s3 = new S3Client({
  region: 'eu-west-1',
  endpoint: `http://localhost:${S3_PORT}`,
  forcePathStyle: true,
  // Emulator credentials. The session token makes the presigned POST carry X-Amz-Security-Token, as one signed with
  // temporary credentials does.
  credentials: { accessKeyId: 'test', secretAccessKey: 'test', sessionToken: 'emulator-session' },
});

async function setUpBuckets() {
  for (const [kind, Bucket] of Object.entries(BUCKETS)) {
    try {
      await s3.send(
        new CreateBucketCommand({ Bucket, CreateBucketConfiguration: { LocationConstraint: 'eu-west-1' } }),
      );
    } catch (e) {
      if (!/BucketAlready/.test(e.name)) throw e;
    }
    const CORSConfiguration = kind === 'allowed' ? ALLOWED_CORS : DENIED_CORS;
    await s3.send(new PutBucketCorsCommand({ Bucket, CORSConfiguration }));
    console.log(`[server] bucket ${Bucket}: ${JSON.stringify(CORSConfiguration.CORSRules)}`);
  }
}

const echoLog = [];
const s3Log = [];
const bucketOf = (name) => BUCKETS[name ?? 'allowed'] ?? BUCKETS.allowed;
const viaProxy = (url, slow) => url.replace(`:${S3_PORT}`, `:${slow ? SLOW_PORT : PROXY_PORT}`);

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const api = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  try {
    if (req.method === 'POST' && url.pathname === '/presign') {
      const { key, bucket, slow } = await readJson(req);
      const { url: action, fields } = await createPresignedPost(s3, {
        Bucket: bucketOf(bucket),
        Key: key,
        Conditions: [['content-length-range', 0, 100 * 1024 * 1024]],
        Expires: 600,
      });
      return send(res, 200, { url: viaProxy(action, slow), fields });
    }
    if (req.method === 'POST' && url.pathname === '/presign-get') {
      const { key, bucket } = await readJson(req);
      const signed = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucketOf(bucket), Key: key }), {
        expiresIn: 600,
      });
      return send(res, 200, { url: viaProxy(signed, false) });
    }
    if (req.method === 'GET' && url.pathname === '/object') {
      const Bucket = bucketOf(url.searchParams.get('bucket'));
      const Key = url.searchParams.get('key');
      try {
        const head = await s3.send(new HeadObjectCommand({ Bucket, Key }));
        const body = Buffer.from(
          await (await s3.send(new GetObjectCommand({ Bucket, Key }))).Body.transformToByteArray(),
        );
        const sha256 = crypto.createHash('sha256').update(body).digest('hex');
        return send(res, 200, { exists: true, size: body.length, sha256, contentType: head.ContentType });
      } catch (e) {
        return send(res, 200, { exists: false, error: e.name });
      }
    }
    if (req.method === 'POST' && url.pathname === '/copy-to-denied') {
      // Puts an object in the denied bucket, so that a refused download is a CORS refusal and not a 404.
      const Key = url.searchParams.get('key');
      await s3.send(new CopyObjectCommand({ Bucket: BUCKETS.denied, Key, CopySource: `${BUCKETS.allowed}/${Key}` }));
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/echo') {
      const parts = [];
      const busboy = Busboy({ headers: req.headers });
      busboy.on('field', (name, value) => parts.push({ kind: 'field', name, length: value.length }));
      busboy.on('file', (name, stream, info) => {
        const hash = crypto.createHash('sha256');
        let size = 0;
        stream.on('data', (d) => {
          size += d.length;
          hash.update(d);
        });
        stream.on('end', () =>
          parts.push({
            kind: 'file',
            name,
            filename: info.filename,
            mimeType: info.mimeType,
            size,
            sha256: hash.digest('hex'),
          }),
        );
      });
      busboy.on('close', () => {
        echoLog.push({ at: Date.now(), parts });
        res.writeHead(204);
        res.end();
      });
      req.pipe(busboy);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/echo-log') return send(res, 200, echoLog);
    if (req.method === 'GET' && url.pathname === '/s3-log') {
      const since = Number(url.searchParams.get('since') ?? 0);
      return send(
        res,
        200,
        s3Log.filter((e) => e.at >= since),
      );
    }
    if (req.method === 'GET' && url.pathname === '/cors')
      return send(res, 200, { allowed: ALLOWED_CORS, denied: DENIED_CORS });
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: String(e) });
  }
});

/** A logging proxy to the emulator. Host is rewritten to the emulator's, so presigned GET signatures stay valid. */
function proxy(port, throttle) {
  return http.createServer((req, res) => {
    const entry = {
      at: Date.now(),
      port,
      method: req.method,
      path: req.url.split('?')[0],
      origin: req.headers.origin ?? null,
      requestMethod: req.headers['access-control-request-method'] ?? null,
      requestHeaders: req.headers['access-control-request-headers'] ?? null,
      bytesIn: 0,
      status: null,
      allowOrigin: null,
      exposeHeaders: null,
      aborted: false,
    };
    s3Log.push(entry);
    const headers = { ...req.headers, host: `localhost:${S3_PORT}` };
    const upstream = http.request(
      { host: '127.0.0.1', port: S3_PORT, method: req.method, path: req.url, headers },
      (up) => {
        entry.status = up.statusCode;
        entry.allowOrigin = up.headers['access-control-allow-origin'] ?? null;
        entry.exposeHeaders = up.headers['access-control-expose-headers'] ?? null;
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
        up.on('end', () => (entry.endedAt = Date.now()));
      },
    );
    upstream.on('error', (e) => {
      entry.error = String(e);
      res.destroy();
    });
    res.on('close', () => {
      if (!entry.endedAt) entry.aborted = true;
    });
    req.on('aborted', () => upstream.destroy());
    req.on('data', (chunk) => {
      entry.bytesIn += chunk.length;
      upstream.write(chunk);
      if (throttle) {
        req.pause();
        setTimeout(() => req.resume(), Math.ceil((chunk.length / SLOW_BPS) * 1000));
      }
    });
    req.on('end', () => upstream.end());
  });
}

await setUpBuckets();
api.listen(PORT, () =>
  console.log(`[server] http://localhost:${PORT}, origins allowed: ${ALLOWED_ORIGINS.join(', ')}`),
);
proxy(PROXY_PORT, false).listen(PROXY_PORT, () => console.log(`[server] S3 via :${PROXY_PORT}`));
proxy(SLOW_PORT, true).listen(SLOW_PORT, () => console.log(`[server] S3 via :${SLOW_PORT} at ${SLOW_BPS} bytes/s`));
