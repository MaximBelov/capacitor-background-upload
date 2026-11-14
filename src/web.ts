import { WebPlugin } from '@capacitor/core';

import type { BackgroundUploadPlugin } from './definitions';

export class BackgroundUploadWeb extends WebPlugin implements BackgroundUploadPlugin {
  async echo(options: { value: string }): Promise<{ value: string }> {
    console.log('ECHO', options);
    return options;
  }
}
