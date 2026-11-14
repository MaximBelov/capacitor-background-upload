export interface BackgroundUploadPlugin {
  echo(options: { value: string }): Promise<{ value: string }>;
}
