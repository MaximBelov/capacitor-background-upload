import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UploadEvent, UploadOptions } from '../../src';
import { BackgroundUploadWeb } from '../../src/web';

// A stand-in for the browser's XMLHttpRequest that records what the plugin sends and lets a test play the network.
class FakeXHR {
  static all: FakeXHR[] = [];
  method = '';
  url = '';
  headers: { [name: string]: string } = {};
  body: FormData | undefined;
  sent = false;
  aborted = false;
  status = 0;
  responseText = '';
  upload: { onprogress: ((e: ProgressEvent) => void) | null; onload: (() => void) | null } = {
    onprogress: null,
    onload: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXHR.all.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: FormData) {
    this.body = body;
    this.sent = true;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  // What the network does.
  progress(loaded: number, total: number, lengthComputable = true) {
    this.upload.onprogress?.({ loaded, total, lengthComputable } as ProgressEvent);
  }
  bodySent() {
    this.upload.onload?.();
  }
  respond(status: number, text: string) {
    this.status = status;
    this.responseText = text;
    this.onload?.();
  }
  fail() {
    this.onerror?.();
  }
}

class FakeStorage {
  items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

const fetchMock = vi.fn();
let storage: FakeStorage;
let web: BackgroundUploadWeb;
let events: UploadEvent[];

const options = (extra: Partial<UploadOptions> = {}): UploadOptions => ({
  id: 'a',
  filePath: '/uploads/photo.jpg',
  serverUrl: 'https://bucket.example.com/',
  file: new Blob(['hello'], { type: 'image/jpeg' }),
  ...extra,
});

const last = () => FakeXHR.all[FakeXHR.all.length - 1];
const parts = (xhr: FakeXHR) => [...(xhr.body as FormData).entries()];
const terminal = () => events.filter((e) => e.state !== 'UPLOADING');

beforeEach(async () => {
  FakeXHR.all = [];
  storage = new FakeStorage();
  fetchMock.mockReset();
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('sessionStorage', storage);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_000_000);
  web = new BackgroundUploadWeb();
  events = [];
  await web.addListener('event', (e) => events.push(e));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('startUpload on the web', () => {
  it.each([
    ['id', { id: '' }, 'MISSING_OPTION'],
    ['serverUrl', { serverUrl: '' }, 'MISSING_OPTION'],
    ['filePath', { filePath: '' }, 'MISSING_OPTION'],
    ['a relative serverUrl', { serverUrl: '/upload' }, 'INVALID_URL'],
    ['an ftp serverUrl', { serverUrl: 'ftp://example.com/x' }, 'INVALID_URL'],
  ])('rejects without %s, and sends nothing', async (_name, extra, code) => {
    await expect(web.startUpload(options(extra))).rejects.toMatchObject({ code });
    expect(FakeXHR.all).toHaveLength(0);
  });

  it('rejects with FILE_NOT_FOUND when filePath cannot be fetched, and sends nothing', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(web.startUpload(options({ file: undefined }))).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(web.startUpload(options({ file: undefined }))).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    expect(FakeXHR.all).toHaveLength(0);
  });

  it('sends the headers, the fields sorted by name and then the file, to serverUrl with the method', async () => {
    await web.startUpload(
      options({
        filePath: 'file:///data/photo%201.jpg?x=1',
        fileKey: 'upload',
        requestMethod: 'PUT',
        parameters: { policy: 'p', key: 'uploads/photo.jpg', size: 5 as unknown as string, skip: {} as string },
        headers: { 'X-A': '1', 'Content-Type': 'text/plain', 'content-length': '9' },
      }),
    );
    const xhr = last();
    expect(xhr.sent).toBe(true);
    expect(xhr.method).toBe('PUT');
    expect(xhr.url).toBe('https://bucket.example.com/');
    // The browser writes Content-Type with the boundary, and Content-Length.
    expect(xhr.headers).toEqual({ 'X-A': '1' });
    const sent = parts(xhr);
    expect(sent.map(([name]) => name)).toEqual(['key', 'policy', 'size', 'upload']);
    expect(sent.slice(0, 3).map(([, value]) => value)).toEqual(['uploads/photo.jpg', 'p', '5']);
    const file = sent[3][1] as File;
    expect(file.name).toBe('photo 1.jpg');
    expect(file.type).toBe('image/jpeg');
    expect(await file.text()).toBe('hello');
  });

  it('defaults to POST and the field name file', async () => {
    await web.startUpload(options());
    expect(last().method).toBe('POST');
    expect(parts(last()).map(([name]) => name)).toEqual(['file']);
    expect((parts(last())[0][1] as File).name).toBe('photo.jpg');
  });

  it('fetches filePath when no file is given, and names a blob: URL blob', async () => {
    fetchMock.mockResolvedValueOnce(new Response('from url', { status: 200 }));
    await web.startUpload(options({ file: undefined, filePath: 'blob:https://app.example.com/1234' }));
    expect(fetchMock).toHaveBeenCalledWith('blob:https://app.example.com/1234');
    const file = parts(last())[0][1] as File;
    expect(file.name).toBe('blob');
    expect(await file.text()).toBe('from url');
  });

  it('maps upload progress to UPLOADING events: whole percents, one a second, always 100', async () => {
    await web.startUpload(options());
    const xhr = last();
    xhr.progress(0, 0, false); // not computable: nothing
    xhr.progress(333, 1000);
    xhr.progress(400, 1000); // within the second: dropped
    vi.setSystemTime(1_001_000);
    xhr.progress(500, 1000);
    xhr.progress(1000, 1000); // 100 is never held back
    xhr.bodySent(); // and not repeated
    expect(events).toEqual([
      { id: 'a', state: 'UPLOADING', progress: 33 },
      { id: 'a', state: 'UPLOADING', progress: 50 },
      { id: 'a', state: 'UPLOADING', progress: 100 },
    ]);
  });

  it('sends 100 when the body is out, also without a progress event at the end', async () => {
    await web.startUpload(options());
    last().progress(10, 100);
    last().bodySent();
    expect(events.map((e) => e.progress)).toEqual([10, 100]);
  });

  it('ends with UPLOADED, the status, the body and the timings on a 2xx', async () => {
    await web.startUpload(options());
    vi.setSystemTime(1_002_500);
    last().respond(204, 'ok');
    expect(events).toEqual([
      {
        id: 'a',
        state: 'UPLOADED',
        statusCode: 204,
        serverResponse: 'ok',
        finishUploadTime: 1_002_500,
        uploadDuration: 2_500,
        eventId: expect.any(String),
      },
    ]);
  });

  it('ends with FAILED, errorCode 0, the status and the body on any other status', async () => {
    await web.startUpload(options());
    last().respond(403, '<Error>AccessDenied</Error>');
    expect(events).toEqual([
      {
        id: 'a',
        state: 'FAILED',
        error: 'The server answered 403',
        errorCode: 0,
        statusCode: 403,
        serverResponse: '<Error>AccessDenied</Error>',
        eventId: expect.any(String),
      },
    ]);
  });

  it('ends with FAILED and errorCode -2 on a network error, with no status', async () => {
    await web.startUpload(options());
    last().fail();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: 'a', state: 'FAILED', errorCode: -2, eventId: expect.any(String) });
    expect(events[0].statusCode).toBeUndefined();
    expect(events[0].error).toMatch(/No response/);
  });

  it('runs several uploads at once, each with its own events and eventIds', async () => {
    await web.startUpload(options({ id: 'a' }));
    await web.startUpload(options({ id: 'b' }));
    const [a, b] = FakeXHR.all;
    b.progress(1, 2);
    a.respond(200, 'A');
    b.respond(500, 'B');
    expect(events.map((e) => [e.id, e.state])).toEqual([
      ['b', 'UPLOADING'],
      ['a', 'UPLOADED'],
      ['b', 'FAILED'],
    ]);
    expect(events[1].eventId).not.toBe(events[2].eventId);
  });

  it('replaces an upload started again with the same id: the old request is aborted and reports nothing', async () => {
    await web.startUpload(options());
    const old = last();
    await web.startUpload(options());
    expect(old.aborted).toBe(true);
    old.respond(200, 'late');
    last().respond(200, 'new');
    expect(terminal().map((e) => e.serverResponse)).toEqual(['new']);
  });

  it('leaves a running upload alone when a start with its id fails', async () => {
    await web.startUpload(options());
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(web.startUpload(options({ file: undefined }))).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    expect(FakeXHR.all[0].aborted).toBe(false);
    FakeXHR.all[0].respond(200, '');
    expect(terminal()).toHaveLength(1);
  });
});

describe('removeUpload on the web', () => {
  it('aborts the request and sends no event, as on iOS and Android', async () => {
    await web.startUpload(options());
    const xhr = last();
    await web.removeUpload({ id: 'a' });
    expect(xhr.aborted).toBe(true);
    xhr.progress(5, 10);
    xhr.fail();
    xhr.respond(200, '');
    expect(events).toEqual([]);
  });

  it('drops a start still fetching its file', async () => {
    let answer!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (answer = resolve)));
    const started = web.startUpload(options({ file: undefined }));
    await web.removeUpload({ id: 'a' });
    answer(new Response('x'));
    await started;
    expect(FakeXHR.all).toHaveLength(0);
  });

  it('forgets the events of the id not yet acknowledged, and resolves when there is no such upload', async () => {
    await web.startUpload(options());
    last().respond(200, '');
    await web.removeUpload({ id: 'a' });
    await web.removeUpload({ id: 'nothing' });
    await new BackgroundUploadWeb().addListener('event', (e) => events.push(e));
    expect(terminal()).toHaveLength(1);
  });

  it('rejects without id', async () => {
    await expect(web.removeUpload({ id: '' })).rejects.toMatchObject({ code: 'MISSING_OPTION' });
  });
});

describe('terminal events on the web', () => {
  it('are held until the first listener is added; progress is not', async () => {
    const quiet = new BackgroundUploadWeb();
    await quiet.startUpload(options());
    last().progress(1, 2);
    last().respond(200, 'done');
    const seen: UploadEvent[] = [];
    await quiet.addListener('event', (e) => seen.push(e));
    expect(seen.map((e) => e.state)).toEqual(['UPLOADED']);
  });

  it('are delivered again after a reload of the tab until acknowledged', async () => {
    await web.startUpload(options({ id: 'a' }));
    last().respond(200, '');
    await web.startUpload(options({ id: 'b' }));
    last().respond(500, '');
    await web.acknowledgeEvent({ eventId: events[0].eventId as string });

    const reloaded: UploadEvent[] = [];
    await new BackgroundUploadWeb().addListener('event', (e) => reloaded.push(e));
    expect(reloaded).toEqual([events[1]]);

    await web.acknowledgeEvent({ eventId: events[1].eventId as string });
    await web.acknowledgeEvent({ eventId: 'unknown' });
    expect(storage.items.size).toBe(0);
  });

  it('are still delivered when there is no sessionStorage', async () => {
    vi.stubGlobal('sessionStorage', undefined);
    const plain = new BackgroundUploadWeb();
    const seen: UploadEvent[] = [];
    await plain.addListener('event', (e) => seen.push(e));
    await plain.startUpload(options());
    last().respond(200, '');
    expect(seen.map((e) => e.state)).toEqual(['UPLOADED']);
    await plain.acknowledgeEvent({ eventId: seen[0].eventId as string });
  });

  it('acknowledgeEvent rejects without eventId', async () => {
    await expect(web.acknowledgeEvent({ eventId: '' })).rejects.toMatchObject({ code: 'MISSING_OPTION' });
  });
});
