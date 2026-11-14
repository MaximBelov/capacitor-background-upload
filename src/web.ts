import { WebPlugin } from '@capacitor/core';

import type { BackgroundUploadPlugin } from './definitions';

export class BackgroundUploadWeb extends WebPlugin implements BackgroundUploadPlugin {
  async startUpload(): Promise<void> {
    throw this.unimplemented('Background uploads are not available on the web.');
  }

  async removeUpload(): Promise<void> {
    throw this.unimplemented('Background uploads are not available on the web.');
  }

  async acknowledgeEvent(): Promise<void> {
    throw this.unimplemented('Background uploads are not available on the web.');
  }
}
