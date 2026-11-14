import { registerPlugin } from '@capacitor/core';

import type { BackgroundUploadPlugin } from './definitions';

const BackgroundUpload = registerPlugin<BackgroundUploadPlugin>('BackgroundUpload', {
  web: () => import('./web').then((m) => new m.BackgroundUploadWeb()),
});

export * from './definitions';
export { BackgroundUpload };
