# capacitor-background-upload

Multipart file uploads that keep going when the app is in the background, and after it has been killed, for Capacitor 8 on
iOS and Android, with the same API on the web for an app that also runs in a browser.

- **iOS**: a background `URLSession`. The request body is written to a file and handed to the system, which sends it
  while the app is suspended or not running. No AFNetworking, no third-party code.
- **Android**: a `WorkManager` job that waits for a network connection. The request is sent with `HttpURLConnection`;
  the only dependency is `androidx.work`.
- **Web**: an `XMLHttpRequest` with a `FormData` body, while the page is open. There is no background on the web; see
  [On the web](#on-the-web).

Both native platforms retry a request that got no response (up to 10 attempts, 30 s apart and doubling), keep every
terminal event on the device until you acknowledge it, and send the file under its bare name.

| Method / feature                                          | iOS | Android | Web                                  |
| --------------------------------------------------------- | --- | ------- | ------------------------------------ |
| `startUpload`                                             | ✅  | ✅      | ✅ while the page is open            |
| `removeUpload`                                            | ✅  | ✅      | ✅ aborts the request                |
| `acknowledgeEvent`                                        | ✅  | ✅      | ✅                                   |
| `addListener('event')`                                    | ✅  | ✅      | ✅                                   |
| Upload goes on in the background                          | ✅  | ✅      | ❌ ends with the page, with no event |
| Upload goes on after the app is killed                    | ✅  | ✅      | ❌                                   |
| Retry of a request that got no response                   | ✅  | ✅      | ❌ one attempt, then `FAILED` -2     |
| Terminal events kept until acknowledged                   | ✅  | ✅      | ✅ in the tab's `sessionStorage`     |
| `filePath` as a path, `file://` or `convertFileSrc()` URL | ✅  | ✅      | ❌ a URL the page can fetch          |
| `file` (a `Blob` or `File`)                               | ❌  | ❌      | ✅                                   |
| `notificationTitle`                                       | ❌  | ✅      | ❌                                   |

## Install

```bash
npm install capacitor-background-upload
npx cap sync
```

Requires Capacitor 8, Android 8.0 (API 26) or newer, iOS 15 or newer. On iOS the plugin is a Swift package; CocoaPods
works too.

On Android 13 and newer the progress notification appears only once the app holds `POST_NOTIFICATIONS`. The plugin
declares the permission but does not ask for it; uploads run either way.

## Use

```typescript
import { BackgroundUpload } from 'capacitor-background-upload';

// One listener for every upload. Terminal events that arrived while the app was not listening, or before it was
// killed, are delivered to the first listener added.
await BackgroundUpload.addListener('event', async (event) => {
  switch (event.state) {
    case 'UPLOADING':
      console.log(`${event.id}: ${event.progress}%`);
      break;
    case 'UPLOADED':
      console.log(`${event.id} done: ${event.statusCode} ${event.serverResponse}`);
      await BackgroundUpload.acknowledgeEvent({ eventId: event.eventId! });
      break;
    case 'FAILED':
      console.log(`${event.id} failed: ${event.statusCode ?? ''} ${event.error}`);
      await BackgroundUpload.acknowledgeEvent({ eventId: event.eventId! });
      break;
  }
});

// A presigned S3 POST: the form fields go in `parameters`, and are always sent before the file, as S3 requires.
await BackgroundUpload.startUpload({
  id: 'photo-1.jpg',
  filePath: 'file:///data/user/0/com.example/files/photo-1.jpg',
  serverUrl: 'https://my-bucket.s3.eu-west-1.amazonaws.com/',
  parameters: { key: 'uploads/photo-1.jpg', policy: '…', 'x-amz-signature': '…' },
});
```

### What ends an upload

| What happened                                     | Event                                                            |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| The server answered 2xx                           | `UPLOADED` with `statusCode` and `serverResponse`                |
| The server answered anything else (403, 500, ...) | `FAILED`, `errorCode: 0`, with `statusCode` and `serverResponse` |
| No response, 10 times                             | `FAILED`, `errorCode: -2`                                        |
| The file is gone when an attempt starts           | `FAILED`, `errorCode: -3`                                        |
| `removeUpload()`                                  | nothing: the upload and its stored events are forgotten          |

`startUpload` itself rejects, and queues nothing, when `id`, `filePath` or `serverUrl` is missing (`MISSING_OPTION`),
`serverUrl` is not http(s) (`INVALID_URL`) or there is no file at `filePath` (`FILE_NOT_FOUND`).

### One uploader per process

There is no init call. The uploader is created with the plugin, once per process, and reports to the plugin's listeners;
calling `addListener` again just adds a listener. `removeAllListeners()` stops the events reaching JavaScript and leaves
the uploads running.

### Things that differ between iOS and Android

- **iOS, app swiped away by the user**: iOS cancels the session's tasks. The plugin notices at the next launch (about 5
  seconds after the plugin loads) and sends those uploads again from the start. An app ended by the system instead
  (memory pressure, a crash) does not stop the upload: the system finishes it and reports it at the next launch.
- **iOS, finished while not running**: the app is not woken to hear about it (`sessionSendsLaunchEvents` is off). The
  outcome is delivered when the app next runs.
- **Android, foreground notification**: the job asks to run as a foreground service with a progress notification. On a
  Pixel 10a with Android 16 the system refused that every time, also with the app in front, and the upload ran as an
  ordinary job instead, which the system may stop after about 10 minutes; a stopped job is retried from the start.
  Very long uploads on such devices are therefore not guaranteed to finish in one go.
- **Android, app force-stopped**: the job is cancelled with the app; it runs again, from the start, the next time the
  app starts.
- **Events while in the background**: on both platforms events reach JavaScript only while the web view runs; those
  sent while it was paused arrive when the app comes back. On iOS the outcome itself is only reported when the app runs
  again, so `finishUploadTime` and `uploadDuration` include the time the app was suspended.
- **Progress** counts bytes handed to the system's network stack, which takes them faster than a slow network sends
  them, so it can reach 100 well before the server has the file. At most one `UPLOADING` event a second per upload,
  and always one at 100. Progress events are not stored.
- **The file part's `Content-Type`** comes from the platform's own table for the extension, so the two can differ for
  an unusual one (`.bin` is `application/macbinary` on iOS and `application/octet-stream` on Android). S3 takes the
  object's type from a `Content-Type` form field, not from this header.

## On the web

The same calls work in a browser, so an app has one upload code path. What the web cannot do is upload in the
background: the request is an ordinary `XMLHttpRequest`, it runs while the page is open, and closing, reloading or
navigating away from the page ends it with no event. Start it again on the next load if it matters. No service worker
and no Background Fetch are used.

```typescript
// A file the user picked: pass the Blob in `file`; `filePath` then only names the multipart part.
const [picked] = (document.querySelector('input[type=file]') as HTMLInputElement).files!;
await BackgroundUpload.startUpload({
  id: 'photo-1.jpg',
  file: picked,
  filePath: picked.name,
  serverUrl: 'https://my-bucket.s3.eu-west-1.amazonaws.com/',
  parameters: { key: 'uploads/photo-1.jpg', policy: '…', 'x-amz-signature': '…' },
});

// Or a URL the page can fetch (same origin, allowed by CORS, blob: or data:), fetched before startUpload resolves.
await BackgroundUpload.startUpload({ id: 'report', filePath: '/files/report.pdf', serverUrl: 'https://example.com/up' });
```

- **The file** is `file` when it is given, and otherwise whatever `fetch(filePath)` returns; a fetch that fails or
  answers outside 2xx makes `startUpload` reject with `FILE_NOT_FOUND`. A native path or `file://` URL means nothing
  to a browser. The part is named after the bare name of `filePath` (`blob` for a `blob:` or `data:` URL), and its
  `Content-Type` is the Blob's type, or `application/octet-stream` when it has none.
- **The request** carries `parameters` first, sorted by name, then the file, as on iOS and Android, with `headers`
  except `Content-Type` and `Content-Length`, which the browser writes. The server has to allow the page's origin by
  CORS. The plugin watches upload progress, which makes the browser send a preflight `OPTIONS` request first, also to
  a presigned S3 POST, so the bucket's CORS rules have to allow `POST` (or `PUT`) from the origin.
- **Events** have the same names and fields as on iOS and Android. `UPLOADING` comes from `upload.onprogress`, at most
  once a second and always once at 100. Any response ends the upload: 2xx as `UPLOADED`, anything else as `FAILED`
  with `errorCode: 0`. There is one attempt: a network error, or a request refused by CORS (the browser does not say
  which), is `FAILED` with `errorCode: -2` at once. `-3` is not used.
- **`removeUpload`** aborts the request; as on iOS and Android it sends no event. Starting an id that is running
  aborts the old request the same way. Any number of uploads can run at once, each under its own id.
- **Terminal events** get an `eventId` and are kept in the tab's `sessionStorage` until acknowledged: a reload of the
  tab delivers them again to the first listener, other tabs do not see them, and closing the tab forgets them.

## Development

```bash
npm run build          # TypeScript, and the API section of this README from src/definitions.ts
npm test               # TypeScript unit tests (Vitest)
npm run test:parity    # the TypeScript API, the Swift, the Kotlin and this README agree
npm run test:ios       # the Swift uploader with XCTest on macOS, against a local HTTP server
npm run test:android   # the Kotlin request and stores with JUnit, against a local HTTP server
```

`example-app/` is a Capacitor app with the plugin installed from this folder and a test server to drive it from a
computer; its README says how.

## API

<docgen-index>

* [`startUpload(...)`](#startupload)
* [`removeUpload(...)`](#removeupload)
* [`acknowledgeEvent(...)`](#acknowledgeevent)
* [`addListener('event', ...)`](#addlistenerevent-)
* [`removeAllListeners()`](#removealllisteners)
* [Interfaces](#interfaces)
* [Type Aliases](#type-aliases)

</docgen-index>

<docgen-api>
<!--Update the source file JSDoc comments and rerun docgen to update the docs below-->

### startUpload(...)

```typescript
startUpload(options: UploadOptions) => Promise<void>
```

Queues a multipart upload that carries on while the app is in the background, and after it has been killed.

- **iOS**: the request body is written to a file and handed to a background `URLSession`, so the system sends it
  while the app is suspended or not running. An attempt that fails before the server answers is retried with a
  growing delay, up to 10 attempts.
- **Android**: a `WorkManager` job that waits for a network connection, runs in the foreground with a notification
  where the system allows it, and is retried with a growing delay when the connection drops, up to 10 attempts.

Any response from the server ends the upload: a 2xx status as `UPLOADED`, any other as `FAILED` with `statusCode`
and `serverResponse` set and `errorCode` 0. The multipart file name is the file's bare name (`photo.jpg`) on both
platforms.

The promise resolves once the upload is queued; what happens next arrives as `event`s. It rejects, and queues
nothing, when `id`, `filePath` or `serverUrl` is missing, when `serverUrl` is not an http(s) URL, or when there is
no file at `filePath` (on the web: when `file` is not given and `filePath` cannot be fetched with a 2xx answer).

| Param         | Type                                                    |
| ------------- | ------------------------------------------------------- |
| **`options`** | <code><a href="#uploadoptions">UploadOptions</a></code> |

**Since:** 0.1.0

--------------------


### removeUpload(...)

```typescript
removeUpload(options: { id: string; }) => Promise<void>
```

Cancels an upload and forgets it: no event is sent for it afterwards, and those of its events not yet acknowledged
are dropped. Resolves also when there is no upload with that id. On the web the request is aborted.

| Param         | Type                         |
| ------------- | ---------------------------- |
| **`options`** | <code>{ id: string; }</code> |

**Since:** 0.1.0

--------------------


### acknowledgeEvent(...)

```typescript
acknowledgeEvent(options: { eventId: string; }) => Promise<void>
```

Deletes a delivered `UPLOADED` or `FAILED` event from the device, so that it is not delivered again. Resolves also
when there is no such event. On the web the events are kept in the tab's `sessionStorage`, so a reload of the tab
delivers them again and closing it forgets them.

| Param         | Type                              |
| ------------- | --------------------------------- |
| **`options`** | <code>{ eventId: string; }</code> |

**Since:** 0.1.0

--------------------


### addListener('event', ...)

```typescript
addListener(eventName: 'event', listenerFunc: (event: UploadEvent) => void) => Promise<PluginListenerHandle>
```

Listens for every event of every upload, in one stream; `state` says which kind each one is.

A terminal event (`UPLOADED`, `FAILED`) is written to the device before it is sent. One that arrives while no
listener is attached is held, and those not acknowledged before the app was killed are loaded again when the
plugin loads; all of them are delivered to the first listener added. `UPLOADING` events are not held.

There is nothing to initialise: the uploader is one per process, created with the plugin.

| Param              | Type                                                                    |
| ------------------ | ----------------------------------------------------------------------- |
| **`eventName`**    | <code>'event'</code>                                                    |
| **`listenerFunc`** | <code>(event: <a href="#uploadevent">UploadEvent</a>) =&gt; void</code> |

**Returns:** <code>Promise&lt;<a href="#pluginlistenerhandle">PluginListenerHandle</a>&gt;</code>

**Since:** 0.1.0

--------------------


### removeAllListeners()

```typescript
removeAllListeners() => Promise<void>
```

Removes every listener. Uploads keep running, and their terminal events are kept until they are acknowledged.

**Since:** 0.1.0

--------------------


### Interfaces


#### UploadOptions

| Prop                    | Type                                                          | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Since |
| ----------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| **`id`**                | <code>string</code>                                           | Your identifier for the upload. Every event about it carries it back as `id`, and `removeUpload` takes it. Starting an upload with the id of one that is still queued or running replaces it.                                                                                                                                                                                                                                                                                                                                                                                                                                  |       |
| **`filePath`**          | <code>string</code>                                           | The file to send: an absolute path, a `file://` URL, or a URL from `Capacitor.convertFileSrc()`. It is read when the request body is built and is not copied, so leave it in place until the terminal event arrives. Its bare name (`photo.jpg`) is the file name of the multipart part. On the web it is a URL the page can fetch (same origin or allowed by CORS, a `blob:` URL from `URL.createObjectURL()`, or a `data:` URL), unless `file` is given, in which case it only names the part. The file is fetched by `startUpload`, before it resolves. A `blob:` or `data:` URL has no name, so the part is called `blob`. |       |
| **`file`**              | <code>Blob</code>                                             | Web only: the file itself, for example a `File` from an `&lt;input type="file"&gt;`. When it is given it is sent as is, and `filePath` is used only for the name of the part. iOS and Android ignore it: a `Blob` cannot cross the native bridge.                                                                                                                                                                                                                                                                                                                                                                              | 0.2.0 |
| **`serverUrl`**         | <code>string</code>                                           | The http(s) URL the multipart request is sent to.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |       |
| **`fileKey`**           | <code>string</code>                                           | The name of the multipart field that carries the file. Defaults to `file`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |       |
| **`parameters`**        | <code><a href="#uploadparameters">UploadParameters</a></code> | Extra form fields, sent before the file. A presigned S3 POST puts its policy and object key here; S3 requires them to come before the file, which is the order this plugin always uses.                                                                                                                                                                                                                                                                                                                                                                                                                                        |       |
| **`headers`**           | <code><a href="#uploadheaders">UploadHeaders</a></code>       | Extra request headers. `Content-Type` and `Content-Length` are set by the plugin. On the web the browser refuses some headers (`Cookie`, `Host`, `Origin`, ...) and a header other than the CORS-safelisted ones needs the server's permission in its preflight answer.                                                                                                                                                                                                                                                                                                                                                        |       |
| **`requestMethod`**     | <code>'POST' \| 'PUT'</code>                                  | `POST` (the default) or `PUT`. The body is multipart in both cases.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |       |
| **`notificationTitle`** | <code>string</code>                                           | Android only: the title of the notification shown while uploads run. Defaults to `Uploading files`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |       |


#### UploadParameters

Form fields, by name. Every value is sent as text.


#### UploadHeaders

Request headers, by name.


#### PluginListenerHandle

| Prop         | Type                                      |
| ------------ | ----------------------------------------- |
| **`remove`** | <code>() =&gt; Promise&lt;void&gt;</code> |


#### UploadEvent

| Prop                   | Type                                                | Description                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`id`**               | <code>string</code>                                 | The `id` the upload was started with.                                                                                                                                                                                                                                                                                                                             |
| **`state`**            | <code><a href="#uploadstate">UploadState</a></code> | What happened.                                                                                                                                                                                                                                                                                                                                                    |
| **`progress`**         | <code>number</code>                                 | `UPLOADING` only: the share of the body sent so far, 0 to 100.                                                                                                                                                                                                                                                                                                    |
| **`eventId`**          | <code>string</code>                                 | `UPLOADED` and `FAILED` only: the key to pass to `acknowledgeEvent`. Until it is acknowledged the event is kept on the device and delivered again after every launch.                                                                                                                                                                                             |
| **`statusCode`**       | <code>number</code>                                 | The HTTP status of the response, when there was one.                                                                                                                                                                                                                                                                                                              |
| **`serverResponse`**   | <code>string</code>                                 | The response body as text, when there was a response.                                                                                                                                                                                                                                                                                                             |
| **`error`**            | <code>string</code>                                 | `FAILED` only: what went wrong, in words.                                                                                                                                                                                                                                                                                                                         |
| **`errorCode`**        | <code>number</code>                                 | `FAILED` only: `0` when the server answered with a status outside 2xx (see `statusCode`), `-2` when the request failed on every one of its attempts, `-3` when the file could not be read. On the web there is one attempt, so a network error or a CORS refusal is `-2` at once, and `-3` is not used: a file that cannot be fetched makes `startUpload` reject. |
| **`uploadDuration`**   | <code>number</code>                                 | `UPLOADED` only: milliseconds from the start of the last attempt to its response.                                                                                                                                                                                                                                                                                 |
| **`finishUploadTime`** | <code>number</code>                                 | `UPLOADED` only: when the response arrived, in milliseconds since the epoch.                                                                                                                                                                                                                                                                                      |


### Type Aliases


#### UploadState

Where an upload stands. `UPLOADING` events carry `progress`; `UPLOADED` and `FAILED` are terminal and carry an
`eventId` that has to be acknowledged.

<code>'UPLOADING' | 'UPLOADED' | 'FAILED'</code>

</docgen-api>
