// Genera resources/build/icon.png (512×512, color sólido #1b1b1f). Se ejecuta una vez con
// `npm.cmd run make:icon` y el PNG se versiona. icon.ico y los iconos definitivos llegan en F7.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const out = fileURLToPath(new URL('../resources/build/icon.png', import.meta.url));
mkdirSync(dirname(out), { recursive: true });
await sharp({ create: { width: 512, height: 512, channels: 4, background: '#1b1b1f' } })
  .png()
  .toFile(out);
const { width, height, format } = await sharp(out).metadata();
console.log(`icon: ${out} (${width}×${height} ${format})`);
