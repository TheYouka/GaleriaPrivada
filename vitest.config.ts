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
    // Con GALERIA_SLOW_TESTS=1, kdf.test.ts y keys.test.ts corren Argon2 de producción (256 MiB,
    // p = 4): un archivo cada vez, para que no compitan con el resto por la CPU y la memoria (un test
    // de 74 ms llegó a pasar del límite de 5 s) ni falseen la calibración (PLAN.md, nota 82).
    fileParallelism: process.env.GALERIA_SLOW_TESTS !== '1',
  },
});
