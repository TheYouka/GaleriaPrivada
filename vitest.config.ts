import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Mismos alias que electron.vite.config.ts y los tsconfig, con rutas absolutas ([H3-10]).
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@renderer': fileURLToPath(new URL('./src/renderer/src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    // Cada archivo en su propio proceso: el guard de red que instala un test no afecta a los demás.
    pool: 'forks',
  },
});
