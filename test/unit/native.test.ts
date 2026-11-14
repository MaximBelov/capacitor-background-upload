import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { BackgroundUploadPlugin, UploadEvent } from '../../src';

// What the native side of Capacitor injects into the web view: a bridge object that makes the platform 'android', the
// headers of the installed plugins, nativePromise for promise methods and nativeCallback for listeners.
const nativePromise = vi.fn(async () => undefined);
const listeners: ((event: UploadEvent) => void)[] = [];
const nativeCallback = vi.fn(
  (_plugin: string, method: string, options: { eventName: string }, callback: (e: UploadEvent) => void) => {
    if (method === 'addListener' && options.eventName === 'event') listeners.push(callback);
    return 'callback-id';
  },
);
const g = globalThis as Record<string, unknown>;

let BackgroundUpload: BackgroundUploadPlugin;

beforeAll(async () => {
  g.androidBridge = {};
  g.Capacitor = {
    PluginHeaders: [
      {
        name: 'BackgroundUpload',
        methods: [
          { name: 'startUpload', rtype: 'promise' },
          { name: 'removeUpload', rtype: 'promise' },
          { name: 'acknowledgeEvent', rtype: 'promise' },
          { name: 'addListener', rtype: 'callback' },
          { name: 'removeListener', rtype: 'promise' },
          { name: 'removeAllListeners', rtype: 'promise' },
        ],
      },
    ],
    nativePromise,
    nativeCallback,
  };
  ({ BackgroundUpload } = await import('../../src'));
});

afterAll(() => {
  delete g.androidBridge;
  delete g.Capacitor;
});

describe('on a native platform', () => {
  it('sends startUpload with every option to the native plugin named BackgroundUpload', async () => {
    const options = {
      id: 'photo.jpg',
      filePath: 'file:///data/user/0/app/files/photo.jpg',
      serverUrl: 'https://bucket.s3.amazonaws.com/',
      fileKey: 'file',
      parameters: { key: 'uploads/photo.jpg', policy: 'p' },
      headers: { 'X-A': '1' },
      requestMethod: 'POST' as const,
      notificationTitle: 'Uploading files',
    };
    await BackgroundUpload.startUpload(options);
    expect(nativePromise).toHaveBeenLastCalledWith('BackgroundUpload', 'startUpload', options);
  });

  it('sends removeUpload and acknowledgeEvent with their keys', async () => {
    await BackgroundUpload.removeUpload({ id: 'photo.jpg' });
    expect(nativePromise).toHaveBeenLastCalledWith('BackgroundUpload', 'removeUpload', { id: 'photo.jpg' });
    await BackgroundUpload.acknowledgeEvent({ eventId: 'e1' });
    expect(nativePromise).toHaveBeenLastCalledWith('BackgroundUpload', 'acknowledgeEvent', { eventId: 'e1' });
  });

  it('passes on a rejection from native', async () => {
    nativePromise.mockRejectedValueOnce(new Error('No file at x'));
    await expect(BackgroundUpload.startUpload({ id: 'x', filePath: 'x', serverUrl: 'https://x' })).rejects.toThrow(
      'No file at x',
    );
  });

  it('delivers every native event to an event listener, whatever its state', async () => {
    const seen: UploadEvent[] = [];
    await BackgroundUpload.addListener('event', (e) => seen.push(e));
    expect(nativeCallback).toHaveBeenCalledWith(
      'BackgroundUpload',
      'addListener',
      { eventName: 'event' },
      expect.any(Function),
    );
    const events: UploadEvent[] = [
      { id: 'a', state: 'UPLOADING', progress: 40 },
      { id: 'a', state: 'UPLOADED', eventId: 'e1', statusCode: 204, serverResponse: '' },
      { id: 'b', state: 'FAILED', eventId: 'e2', statusCode: 403, errorCode: 0, error: 'The server answered 403' },
    ];
    for (const event of events) listeners.forEach((l) => l(event));
    expect(seen).toEqual(events);
  });
});
