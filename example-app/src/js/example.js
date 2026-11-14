import { CapacitorHttp } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { BackgroundUpload } from 'capacitor-background-upload';

// The app takes its commands from a computer so that a run needs no touch on the phone, through either of two channels:
//
// - HTTP: it polls GET <control>/control on the test server (test-server.mjs) and reports to POST <control>/log;
// - a file: it reads Documents/control.json (put there with `xcrun devicectl device copy to --domain-type
//   appDataContainer`) and appends everything to Documents/log.txt, which is how an iPhone is driven when it cannot
//   reach the computer over the network.
const controlUrl = import.meta.env.VITE_CONTROL_URL || 'http://127.0.0.1:8099';
const output = document.getElementById('log');
const madeFiles = new Map();

function show(text) {
  output.textContent = `${new Date().toISOString().slice(11, 19)} ${text}\n` + output.textContent;
}

async function report(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  show(text);
  try {
    await Filesystem.appendFile({
      path: 'log.txt',
      directory: Directory.Documents,
      data: `${new Date().toISOString()} ${text}\n`,
      encoding: 'utf8',
    });
  } catch (e) {
    show(`file log failed: ${e}`);
  }
  try {
    await CapacitorHttp.post({ url: `${controlUrl}/log`, headers: { 'Content-Type': 'text/plain' }, data: text, connectTimeout: 3000 });
  } catch (e) {
    show(`log failed: ${e}`);
  }
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** For an echo service (postman-echo, httpbin): the SHA-256 of the file the server says it received. */
async function echoedSha256(serverResponse) {
  try {
    const files = JSON.parse(serverResponse).files ?? {};
    const value = Object.values(files)[0];
    if (typeof value !== 'string' || !value.startsWith('data:')) return null;
    const binary = atob(value.slice(value.indexOf(',') + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { size: bytes.length, sha256: await sha256Hex(bytes) };
  } catch {
    return null;
  }
}

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** A file of random bytes in the app's data directory; returns its URI and SHA-256. */
async function makeFile(name, megabytes) {
  const all = new Uint8Array(megabytes * 1024 * 1024);
  for (let i = 0; i < all.length; i += 65536) crypto.getRandomValues(all.subarray(i, i + 65536));
  const path = `uploads/${name}`;
  await Filesystem.writeFile({ path, directory: Directory.Data, data: '', recursive: true });
  for (let i = 0; i < all.length; i += 1024 * 1024) {
    await Filesystem.appendFile({ path, directory: Directory.Data, data: toBase64(all.subarray(i, i + 1024 * 1024)) });
  }
  const sha256 = await sha256Hex(all);
  const { uri } = await Filesystem.getUri({ path, directory: Directory.Data });
  return { uri, sha256 };
}

async function run(command) {
  if (command.action === 'upload') {
    const id = command.id || `file-${Date.now()}.bin`;
    const { uri, sha256 } = await makeFile(id, command.megabytes || 4);
    madeFiles.set(id, sha256);
    await report({ made: id, uri, sha256 });
    try {
      await BackgroundUpload.startUpload({
        id,
        filePath: uri,
        serverUrl: command.serverUrl || `${controlUrl}/upload`,
        parameters: { key: `uploads/${id}`, acl: 'private' },
        headers: { 'X-Example': '1' },
        notificationTitle: 'Example uploads',
      });
      await report({ started: id });
    } catch (e) {
      await report({ startFailed: id, error: String(e), code: e.code });
    }
  } else if (command.action === 'start') {
    try {
      await BackgroundUpload.startUpload(command.options);
      await report({ started: command.options.id });
    } catch (e) {
      await report({ startFailed: command.options.id, error: String(e), code: e.code });
    }
  } else if (command.action === 'probe') {
    try {
      const r = await CapacitorHttp.get({ url: command.url, connectTimeout: 5000, readTimeout: 5000 });
      await report({ probe: command.url, status: r.status });
    } catch (e) {
      await report({ probe: command.url, error: String(e) });
    }
  } else if (command.action === 'remove') {
    await BackgroundUpload.removeUpload({ id: command.id });
    await report({ removed: command.id });
  }
}

async function poll() {
  try {
    const { data } = await Filesystem.readFile({ path: 'control.json', directory: Directory.Documents, encoding: 'utf8' });
    await Filesystem.deleteFile({ path: 'control.json', directory: Directory.Documents });
    const command = JSON.parse(data);
    await report({ command });
    await run(command);
  } catch {
    // no file command
  }
  try {
    const { data } = await CapacitorHttp.get({ url: `${controlUrl}/control`, connectTimeout: 3000 });
    if (data && data.action) await run(data);
  } catch (e) {
    show(`poll failed: ${e}`);
  }
  setTimeout(poll, 2000);
}

BackgroundUpload.addListener('event', async (event) => {
  const { serverResponse, ...rest } = event;
  const shown = { ...rest, serverResponse: serverResponse && serverResponse.length > 300 ? `${serverResponse.slice(0, 300)}...` : serverResponse };
  await report({ event: shown });
  if (event.state === 'UPLOADED' && serverResponse && madeFiles.has(event.id)) {
    const echoed = await echoedSha256(serverResponse);
    if (echoed) await report({ echoCheck: event.id, ...echoed, matches: echoed.sha256 === madeFiles.get(event.id) });
  }
  if (event.eventId && document.getElementById('ack').checked) {
    await BackgroundUpload.acknowledgeEvent({ eventId: event.eventId });
  }
});

window.uploadNow = () => run({ action: 'upload', megabytes: 4 });
report(`example app loaded, control ${controlUrl}`);
poll();
