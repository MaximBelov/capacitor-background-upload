import { describe, expect, it } from 'vitest';

import { BackgroundUploadWeb } from '../../src/web';

describe('on the web', () => {
  const web = new BackgroundUploadWeb();

  it.each([
    ['startUpload', () => web.startUpload({ id: 'a', filePath: '/a', serverUrl: 'https://x' })],
    ['removeUpload', () => web.removeUpload({ id: 'a' })],
    ['acknowledgeEvent', () => web.acknowledgeEvent({ eventId: 'e' })],
  ])('%s rejects as unimplemented', async (_name, call) => {
    await expect(call()).rejects.toMatchObject({ code: 'UNIMPLEMENTED' });
  });
});
