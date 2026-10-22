import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

// Entradas y salidas por defecto de electron-vite 6:
//   src/main/index.ts → out/main, src/preload/index.ts → out/preload, src/renderer → out/renderer.
// main y preload salen en CJS porque package.json no declara "type".
const alias = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@renderer': resolve(__dirname, 'src/renderer/src'),
};

export default defineConfig({
  main: {
    resolve: { alias },
  },
  preload: {
    resolve: { alias },
    build: {
      // [H3-2] El preload con sandbox solo puede hacer require('electron'): todo lo demás
      // (src/shared) se empaqueta dentro de out/preload/index.js. electron sigue externo.
      externalizeDeps: false,
    },
  },
  renderer: {
    resolve: { alias },
    plugins: [react(), tailwindcss()],
    build: {
      // Sin URLs data: (la CSP no admite data:).
      assetsInlineLimit: 0,
    },
    server: {
      // Origen de desarrollo fijo: http://127.0.0.1:5173 (CSP de desarrollo, guard de red y
      // host-resolver-rules lo comparan de forma exacta).
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
    },
  },
});
