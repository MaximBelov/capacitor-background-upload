import { CapacitorException, WebPlugin } from '@capacitor/core';
import type { ExceptionCode } from '@capacitor/core';

import type { BackgroundUploadPlugin, UploadEvent, UploadOptions } from './definitions';

const EVENT = 'event';
/** Where terminal events wait for `acknowledgeEvent`: per tab, kept across a reload, gone with the tab. */
const STORAGE_KEY = 'capacitor-background-upload.events';
/** At most one `UPLOADING` event a second per upload, and always one at 100, as on iOS and Android. */
const PROGRESS_INTERVAL_MS = 1000;
/** The error codes a `FAILED` event carries, the same as on iOS and Android. */
const HTTP_STATUS = 0;
const ATTEMPTS_EXHAUSTED = -2;

interface Running {
  xhr: XMLHttpRequest;
  startedAt: number;
  lastPercent: number;
  lastProgressAt: number;
}

function reject(message: string, code: string): CapacitorException {
  return new CapacitorException(message, code as ExceptionCode);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.host !== '';
  } catch {
    return false;
  }
}

/** The bare name of the file, which is what the multipart part carries on every platform. */
function fileNameOf(filePath: string): string {
  const value = filePath.trim();
  if (/^(blob|data):/i.test(value)) return 'blob';
  const path = value.split(/[?#]/)[0];
  const name = path.slice(path.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(name) || 'blob';
  } catch {
    return name || 'blob';
  }
}

/** Form values arrive as strings, numbers or booleans; all are sent as text, sorted by name, as on iOS and Android. */
function formFields(parameters: unknown): [string, string][] {
  if (!parameters || typeof parameters !== 'object') return [];
  return Object.entries(parameters as { [name: string]: unknown })
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .map(([name, value]): [string, string] => [name, String(value)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

let counter = 0;
function newEventId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID().toUpperCase();
  counter += 1;
  return `${Date.now().toString(16)}-${counter.toString(16)}-${Math.random().toString(16).slice(2)}`.toUpperCase();
}

export class BackgroundUploadWeb extends WebPlugin implements BackgroundUploadPlugin {
  /** Uploads whose request is out, by id. */
  private readonly running = new Map<string, Running>();
  /** Starts still fetching their file, by id; a later start or a removeUpload replaces or drops the entry. */
  private readonly starting = new Map<string, object>();

  constructor() {
    super();
    // Terminal events not acknowledged before the tab was reloaded go to the first listener, as after a relaunch.
    for (const event of this.storedEvents()) this.notifyListeners(EVENT, event, true);
  }

  async startUpload(options: UploadOptions): Promise<void> {
    const { id, filePath, serverUrl } = options ?? ({} as UploadOptions);
    if (!id) throw reject('id is required', 'MISSING_OPTION');
    if (!serverUrl) throw reject('serverUrl is required', 'MISSING_OPTION');
    if (!filePath) throw reject('filePath is required', 'MISSING_OPTION');
    if (!isHttpUrl(serverUrl)) throw reject(`serverUrl is not an http(s) URL: ${serverUrl}`, 'INVALID_URL');

    const ticket = {};
    this.starting.set(id, ticket);
    let file: Blob;
    try {
      file = options.file ?? (await this.fetchFile(filePath));
    } catch (e) {
      // A start that failed does not touch an upload already running with this id, as on iOS and Android.
      if (this.starting.get(id) === ticket) this.starting.delete(id);
      throw e;
    }
    // Replaced by a later start, or removed, while the file was being fetched.
    if (this.starting.get(id) !== ticket) return;
    this.starting.delete(id);

    const body = new FormData();
    for (const [name, value] of formFields(options.parameters)) body.append(name, value);
    body.append(options.fileKey || 'file', file, fileNameOf(filePath));

    const xhr = new XMLHttpRequest();
    xhr.open((options.requestMethod || 'POST').toUpperCase(), serverUrl);
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      // The browser writes the multipart Content-Type with its boundary and the length itself.
      if (typeof value !== 'string' || /^content-(type|length)$/i.test(name)) continue;
      xhr.setRequestHeader(name, value);
    }

    this.cancel(id);
    const upload: Running = { xhr, startedAt: Date.now(), lastPercent: -1, lastProgressAt: 0 };
    this.running.set(id, upload);
    const current = () => this.running.get(id) === upload;

    xhr.upload.onprogress = (e) => {
      if (current() && e.lengthComputable && e.total > 0) this.progress(id, upload, (e.loaded * 100) / e.total);
    };
    xhr.upload.onload = () => {
      if (current()) this.progress(id, upload, 100);
    };
    xhr.onload = () => {
      if (!current()) return;
      this.running.delete(id);
      const statusCode = xhr.status;
      if (statusCode === 0) return this.finish(this.networkError(id));
      const serverResponse = typeof xhr.responseText === 'string' ? xhr.responseText : '';
      if (statusCode >= 200 && statusCode <= 299) {
        const finishUploadTime = Date.now();
        this.finish({
          id,
          state: 'UPLOADED',
          statusCode,
          serverResponse,
          finishUploadTime,
          uploadDuration: Math.max(0, finishUploadTime - upload.startedAt),
        });
      } else {
        this.finish({
          id,
          state: 'FAILED',
          error: `The server answered ${statusCode}`,
          errorCode: HTTP_STATUS,
          statusCode,
          serverResponse,
        });
      }
    };
    xhr.onerror = xhr.ontimeout = () => {
      if (!current()) return;
      this.running.delete(id);
      this.finish(this.networkError(id));
    };
    xhr.send(body);
  }

  async removeUpload(options: { id: string }): Promise<void> {
    const id = options?.id;
    if (!id) throw reject('id is required', 'MISSING_OPTION');
    this.starting.delete(id);
    this.cancel(id);
    this.storeEvents(this.storedEvents().filter((event) => event.id !== id));
  }

  async acknowledgeEvent(options: { eventId: string }): Promise<void> {
    const eventId = options?.eventId;
    if (!eventId) throw reject('eventId is required', 'MISSING_OPTION');
    this.storeEvents(this.storedEvents().filter((event) => event.eventId !== eventId));
  }

  private async fetchFile(filePath: string): Promise<Blob> {
    let response: Response;
    try {
      response = await fetch(filePath);
    } catch {
      throw reject(`No file at ${filePath}`, 'FILE_NOT_FOUND');
    }
    if (!response.ok) throw reject(`No file at ${filePath}`, 'FILE_NOT_FOUND');
    return response.blob();
  }

  /**
   * Aborts the request for the id, if there is one. It is taken out of `running` first, so its handlers see that it is
   * no longer current and report nothing: removeUpload and a replacing start send no event, as on iOS and Android.
   */
  private cancel(id: string): void {
    const upload = this.running.get(id);
    if (!upload) return;
    this.running.delete(id);
    upload.xhr.abort();
  }

  private progress(id: string, upload: Running, share: number): void {
    const percent = Math.min(100, Math.floor(share));
    const now = Date.now();
    if (percent === upload.lastPercent) return;
    if (percent < 100 && upload.lastPercent >= 0 && now - upload.lastProgressAt < PROGRESS_INTERVAL_MS) return;
    upload.lastPercent = percent;
    upload.lastProgressAt = now;
    this.notifyListeners(EVENT, { id, state: 'UPLOADING', progress: percent });
  }

  private networkError(id: string): UploadEvent {
    return {
      id,
      state: 'FAILED',
      error: 'No response from the server: a network error, or the request was refused by CORS',
      errorCode: ATTEMPTS_EXHAUSTED,
    };
  }

  /** Stores the terminal event under a new eventId, then reports it, held until a listener is added. */
  private finish(event: UploadEvent): void {
    const stored = { ...event, eventId: newEventId() };
    this.storeEvents([...this.storedEvents(), stored]);
    this.notifyListeners(EVENT, stored, true);
  }

  private storedEvents(): UploadEvent[] {
    try {
      const value = JSON.parse(globalThis.sessionStorage?.getItem(STORAGE_KEY) ?? '[]');
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  private storeEvents(events: UploadEvent[]): void {
    try {
      if (events.length) globalThis.sessionStorage?.setItem(STORAGE_KEY, JSON.stringify(events));
      else globalThis.sessionStorage?.removeItem(STORAGE_KEY);
    } catch {
      // No storage (a sandboxed frame, a full quota): the events are still delivered, just not kept across a reload.
    }
  }
}
