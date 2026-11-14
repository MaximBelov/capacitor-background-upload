import type { PluginListenerHandle } from '@capacitor/core';

/**
 * Where an upload stands. `UPLOADING` events carry `progress`; `UPLOADED` and `FAILED` are terminal and carry an
 * `eventId` that has to be acknowledged.
 */
export type UploadState = 'UPLOADING' | 'UPLOADED' | 'FAILED';

export interface UploadOptions {
  /**
   * Your identifier for the upload. Every event about it carries it back as `id`, and `removeUpload` takes it.
   * Starting an upload with the id of one that is still queued or running replaces it.
   */
  id: string;
  /**
   * The file to send: an absolute path, a `file://` URL, or a URL from `Capacitor.convertFileSrc()`. It is read when
   * the request body is built and is not copied, so leave it in place until the terminal event arrives.
   */
  filePath: string;
  /** The http(s) URL the multipart request is sent to. */
  serverUrl: string;
  /** The name of the multipart field that carries the file. Defaults to `file`. */
  fileKey?: string;
  /**
   * Extra form fields, sent before the file. A presigned S3 POST puts its policy and object key here; S3 requires them
   * to come before the file, which is the order this plugin always uses.
   */
  parameters?: Record<string, string>;
  /** Extra request headers. `Content-Type` and `Content-Length` are set by the plugin. */
  headers?: Record<string, string>;
  /** `POST` (the default) or `PUT`. The body is multipart in both cases. */
  requestMethod?: 'POST' | 'PUT';
  /** Android only: the title of the notification shown while uploads run. Defaults to `Uploading files`. */
  notificationTitle?: string;
}

export interface UploadEvent {
  /** The `id` the upload was started with. */
  id: string;
  /** What happened. */
  state: UploadState;
  /** `UPLOADING` only: the share of the body sent so far, 0 to 100. */
  progress?: number;
  /**
   * `UPLOADED` and `FAILED` only: the key to pass to `acknowledgeEvent`. Until it is acknowledged the event is kept on
   * the device and delivered again after every launch.
   */
  eventId?: string;
  /** The HTTP status of the response, when there was one. */
  statusCode?: number;
  /** The response body as text, when there was a response. */
  serverResponse?: string;
  /** `FAILED` only: what went wrong, in words. */
  error?: string;
  /**
   * `FAILED` only: `0` when the server answered with a status outside 2xx (see `statusCode`), `-2` when the request
   * failed on every one of its attempts, `-3` when the file could not be read.
   */
  errorCode?: number;
  /** `UPLOADED` only: milliseconds from the start of the last attempt to its response. */
  uploadDuration?: number;
  /** `UPLOADED` only: when the response arrived, in milliseconds since the epoch. */
  finishUploadTime?: number;
}

export interface BackgroundUploadPlugin {
  /**
   * Queues a multipart upload that carries on while the app is in the background, and after it has been killed.
   *
   * - **iOS**: the request body is written to a file and handed to a background `URLSession`, so the system sends it
   *   while the app is suspended or not running. An attempt that fails before the server answers is retried with a
   *   growing delay, up to 10 attempts.
   * - **Android**: a `WorkManager` job that waits for a network connection, runs in the foreground with a notification
   *   where the system allows it, and is retried with a growing delay when the connection drops, up to 10 attempts.
   *
   * Any response from the server ends the upload: a 2xx status as `UPLOADED`, any other as `FAILED` with `statusCode`
   * and `serverResponse` set and `errorCode` 0. The multipart file name is the file's bare name (`photo.jpg`) on both
   * platforms.
   *
   * The promise resolves once the upload is queued; what happens next arrives as `event`s. It rejects, and queues
   * nothing, when `id`, `filePath` or `serverUrl` is missing, when `serverUrl` is not an http(s) URL, or when there is
   * no file at `filePath`.
   *
   * @since 0.1.0
   */
  startUpload(options: UploadOptions): Promise<void>;

  /**
   * Cancels an upload and forgets it: no event is sent for it afterwards, and those of its events not yet acknowledged
   * are dropped. Resolves also when there is no upload with that id.
   *
   * @since 0.1.0
   */
  removeUpload(options: { id: string }): Promise<void>;

  /**
   * Deletes a delivered `UPLOADED` or `FAILED` event from the device, so that it is not delivered again. Resolves also
   * when there is no such event.
   *
   * @since 0.1.0
   */
  acknowledgeEvent(options: { eventId: string }): Promise<void>;

  /**
   * Listens for every event of every upload, in one stream; `state` says which kind each one is.
   *
   * A terminal event (`UPLOADED`, `FAILED`) is written to the device before it is sent. One that arrives while no
   * listener is attached is held, and those not acknowledged before the app was killed are loaded again when the
   * plugin loads; all of them are delivered to the first listener added. `UPLOADING` events are not held.
   *
   * There is nothing to initialise: the uploader is one per process, created with the plugin.
   *
   * @since 0.1.0
   */
  addListener(eventName: 'event', listenerFunc: (event: UploadEvent) => void): Promise<PluginListenerHandle>;

  /**
   * Removes every listener. Uploads keep running, and their terminal events are kept until they are acknowledged.
   *
   * @since 0.1.0
   */
  removeAllListeners(): Promise<void>;
}
