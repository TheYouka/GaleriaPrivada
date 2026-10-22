import { app } from 'electron';
import { handle } from '../register';

export function registerAppHandlers(): void {
  handle('app:getInfo', { requiresUnlock: false }, () => ({
    version: app.getVersion(),
    platform: process.platform === 'linux' ? 'linux' : 'win32',
    ffmpegAvailable: false, // media/ffmpeg.ts llega en F2
  }));
}
