// Every method of the TypeScript API has its native method on both platforms, its web method and its section in the
// README, and no platform has a method the API does not declare. A miss on either side compiles fine and fails only on a phone. Plain
// Node, no install.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const swift = read('ios/Sources/BackgroundUploadPlugin/BackgroundUploadPlugin.swift');
const kotlin = read('android/src/main/kotlin/io/github/maximbelov/backgroundupload/BackgroundUploadPlugin.kt');

// addListener and removeAllListeners are Capacitor's own, on both platforms.
const own = new Set(['addListener', 'removeAllListeners']);
const api = [...read('src/definitions.ts').matchAll(/^\s+(\w+)\([^)]*\):\s*Promise</gm)]
  .map((m) => m[1])
  .filter((name) => !own.has(name))
  .sort();
const ios = [...swift.matchAll(/CAPPluginMethod\(name:\s*"(\w+)"/g)].map((m) => m[1]).sort();
const iosFunctions = [...swift.matchAll(/@objc func (\w+)\(_ call: CAPPluginCall\)/g)].map((m) => m[1]).sort();
const android = [...kotlin.matchAll(/@PluginMethod\s+fun (\w+)\(/g)].map((m) => m[1]).sort();
const web = read('src/web.ts');
const webMethods = [...web.matchAll(/^  async (\w+)\(/gm)].map((m) => m[1]).sort();

test('the API declares the methods', () => {
  assert.deepEqual(api, ['acknowledgeEvent', 'removeUpload', 'startUpload']);
});

test('iOS registers exactly the methods of the API', () => {
  assert.deepEqual(ios, api);
  assert.deepEqual(iosFunctions, api);
});

test('Android annotates exactly the methods of the API', () => {
  assert.deepEqual(android, api);
});

test('the web implements exactly the methods of the API', () => {
  assert.deepEqual(webMethods, api);
});

test('the plugin and its event have the same name in TypeScript, Swift and Kotlin', () => {
  assert.match(read('src/index.ts'), /registerPlugin<BackgroundUploadPlugin>\('BackgroundUpload'/);
  assert.match(swift, /jsName = "BackgroundUpload"/);
  assert.match(kotlin, /@CapacitorPlugin\(name = "BackgroundUpload"\)/);
  assert.match(read('src/definitions.ts'), /addListener\(eventName: 'event'/);
  assert.match(swift, /eventName = "event"/);
  assert.match(kotlin, /EVENT = "event"/);
  assert.match(web, /const EVENT = 'event'/);
});

test('the error codes are the same on every platform', () => {
  const core = read('ios/Sources/BackgroundUploadCore/Outcome.swift');
  const kt = read('android/src/main/kotlin/io/github/maximbelov/backgroundupload/Outcome.kt');
  for (const [swiftName, kotlinName, value] of [
    ['httpStatus', 'HTTP_STATUS', '0'],
    ['attemptsExhausted', 'ATTEMPTS_EXHAUSTED', '-2'],
    ['fileUnreadable', 'FILE_UNREADABLE', '-3'],
  ]) {
    assert.match(core, new RegExp(`${swiftName} = ${value}\\b`));
    assert.match(kt, new RegExp(`${kotlinName} = ${value}\\b`));
  }
  assert.match(web, /const HTTP_STATUS = 0\b/);
  assert.match(web, /const ATTEMPTS_EXHAUSTED = -2\b/);
  assert.match(core, /maxAttempts = 10/);
  assert.match(kt, /MAX_ATTEMPTS = 10/);
});

test('startUpload rejects with the same codes on every platform', () => {
  for (const code of ['MISSING_OPTION', 'INVALID_URL', 'FILE_NOT_FOUND']) {
    assert.match(swift, new RegExp(`"${code}"`));
    assert.match(kotlin, new RegExp(`"${code}"`));
    assert.match(web, new RegExp(`'${code}'`));
  }
});

test('the README documents every method', () => {
  const readme = read('README.md');
  for (const method of api) {
    assert.match(readme, new RegExp(`### ${method}\\(`), `README.md has no section for ${method}()`);
  }
});
