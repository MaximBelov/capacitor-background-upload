// A test server for the example app, run on the computer the phone talks to:
//
//   node test-server.mjs [port]
//
// POST /upload   receives the multipart upload and answers 201 with what arrived: each field, and the file part's name,
//                size and SHA-256. `?rate=<bytes per second>` reads the body that slowly, so that an upload is still
//                running when the app is sent to the background; `?status=<code>` answers with that status instead.
// GET  /control  the next command for the app (one at a time); POST /control queues one: {"action":"upload", ...}.
// POST /log      what the app reports; printed with a timestamp.
//
// Every received chunk of an upload is logged with its time, which is how "the upload went on while the app was in the
// background" is read: the chunks keep coming after the moment the app was sent away.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 8099);
const commands = [];
const stamp = () => new Date().toISOString().slice(11, 23);
const log = (...args) => console.log(stamp(), ...args);

function parseMultipart(body, contentType) {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
  if (!boundary) return null;
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = body.indexOf(delimiter);
  while (start !== -1) {
    const next = body.indexOf(delimiter, start + delimiter.length);
    if (next === -1) break;
    const content = body.subarray(start + delimiter.length + 2, next - 2);
    const split = content.indexOf('\r\n\r\n');
    const headers = content.subarray(0, split).toString();
    parts.push({ headers, data: content.subarray(split + 4) });
    start = next;
  }
  return parts;
}

createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(value));
  };
  if (url.pathname === '/control' && req.method === 'GET') return send(200, commands.shift() ?? {});
  const chunks = [];
  let received = 0;
  const rate = Number(url.searchParams.get('rate') ?? 0);
  const started = Date.now();
  let lastLogged = 0;
  req.on('data', (chunk) => {
    chunks.push(chunk);
    received += chunk.length;
    if (url.pathname === '/upload' && Date.now() - lastLogged >= 1000) {
      lastLogged = Date.now();
      log(`upload ${received} of ${req.headers['content-length']} bytes`);
    }
    if (rate > 0) {
      req.pause();
      setTimeout(() => req.resume(), (chunk.length / rate) * 1000);
    }
  });
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (url.pathname === '/control') {
      commands.push(JSON.parse(body.toString() || '{}'));
      return send(200, { queued: commands.length });
    }
    if (url.pathname === '/log') {
      log('app:', body.toString());
      return send(200, {});
    }
    if (url.pathname === '/upload') {
      const parts = parseMultipart(body, req.headers['content-type'] ?? '') ?? [];
      const fields = {};
      let file = null;
      for (const part of parts) {
        const name = /name="([^"]*)"/.exec(part.headers)?.[1];
        const filename = /filename="([^"]*)"/.exec(part.headers)?.[1];
        if (filename !== undefined) {
          file = {
            field: name,
            filename,
            type: /Content-Type: (.*)/i.exec(part.headers)?.[1],
            size: part.data.length,
            sha256: createHash('sha256').update(part.data).digest('hex'),
          };
        } else {
          fields[name] = part.data.toString();
        }
      }
      const answer = { method: req.method, fields, file, seconds: (Date.now() - started) / 1000 };
      log('upload done', JSON.stringify(answer));
      return send(Number(url.searchParams.get('status') ?? 201), answer);
    }
    send(404, {});
  });
}).listen(port, '::', () => log(`listening on ${port}`));
