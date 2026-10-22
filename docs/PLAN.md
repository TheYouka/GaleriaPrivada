# Galería: plan de implementación

Versión 1 (22-oct-2026). Basado en `docs/DESIGN.md` versión 3 (leído completo), la revisión v3 (`.agents/tasks/design-review.md`), el anexo de requisitos (`.agents/tasks/requirements-addendum.md`, secciones 1–4, vinculantes) y las notas de entorno (`.agents/tasks/env.md`).

Precedencia: manda `docs/DESIGN.md`, salvo en lo que el usuario decidió en las secciones 4 (tras la revisión v3) y 5 (compilación de Linux) del anexo `.agents/tasks/requirements-addendum.md`. El hallazgo v3-1 queda descartado como riesgo aceptado y los hallazgos v3-2 a v3-11 entran en este plan como tareas obligatorias, marcadas `[H3-n]`. Esas desviaciones están en "Notas sobre el diseño" para llevarlas a DESIGN en su próxima revisión. El `CHANGES_REQUESTED` de `design-verdict.json` se mantiene a propósito y no bloquea este plan.

## Resumen de fases

| Fase | Contenido | Lo que el usuario puede probar al terminar |
|---|---|---|
| 0 | Base del proyecto (este flujo) | Ventana oscura "Galería"; typecheck, lint, tests, build y E2E de humo en verde |
| 1 | Núcleo criptográfico, perfiles, bloqueo y sistema de temas | Crear perfil, desbloquear, bloquear, cambiar contraseña, editar, borrar, cambiar entre "Clásico" y "Ondas" |
| 2 | ffmpeg, importación segura y galería | Importar (el original se borra), buscar, filtrar, ordenar, seleccionar, renombrar, borrar, mover la bóveda, Ayuda |
| 3 | Visor, edición y reproductor | Abrir fotos con animación, zoom, recortar, girar, voltear, revertir, reproducir vídeos |
| 4 | Playlists, música y presentación | Playlists reordenables, presentación con transiciones, música, modos de audio, bucle, ventana o pantalla completa |
| 5 | Vídeo dual y fusión | Dos vídeos lado a lado y fusión cifrada en la bóveda |
| 6 | Temas completos | Los 5 temas en todas las pantallas |
| 7 | Instaladores y E2E completos | Instalar el `.exe` en Windows y el `.deb`/AppImage en Linux |

Correspondencia con el brief: sus fases 1–5 son las 1–5; la fase de temas del anexo es la 6; su fase 6 (instaladores + Playwright E2E) es la 7. El orden no cambia y la numeración coincide con la de DESIGN (F1–F7, sección 26.1).

## Convenciones

- Terminal: PowerShell. Usar `npm.cmd` y `npx.cmd` (`npm.ps1` está bloqueado por la ExecutionPolicy RemoteSigned), encadenar con `;` y fijar variables con `$env:VAR = '…'`. Dentro de `package.json` los scripts corren en `cmd.exe`, así que ahí `&&` sí funciona.
- Workspace: `c:\Users\AlbertoVázquezAguila\Documents\Galeria_App` (ruta no ASCII). Las rutas del plan son relativas a esa raíz.
- Las fases 1–7 se lanzan como flujos separados cuando el usuario apruebe este plan, en orden. Ningún flujo hace commits sin autorización explícita del usuario en ese flujo. Los flujos automáticos no ejecutan `npm run dev` (es un proceso largo y es para que pruebe el usuario).
- Cada tarea tiene Qué, Archivos y Verificación, y deja el repo compilando.
- Verificación común (VC), obligatoria al cerrar cada fase, todo en verde:

  ```powershell
  npm.cmd run typecheck; npm.cmd run lint; npx.cmd prettier --check .; npm.cmd test; npm.cmd run build; npm.cmd run test:e2e
  ```

- Filtros: `npm.cmd test -- tests/unit/crypto` (Vitest por ruta) y `npm.cmd run test:e2e -- tests/e2e/profiles.spec.ts` (npm añade el argumento al final del script, que termina en `playwright test`).
- Tests lentos (Argon2 de producción, archivos de más de 1 GiB): `it.runIf(process.env.GALERIA_SLOW_TESTS === '1')`. Se ejecutan al cerrar la fase que los crea: `$env:GALERIA_SLOW_TESTS = '1'; npm.cmd test; npm.cmd run test:e2e; Remove-Item Env:GALERIA_SLOW_TESTS`.
- Datos de test: siempre bajo `tests/.tmp/` (en `.gitignore`). Está dentro de la ruta no ASCII, así que cada test ejerce también ese riesgo (R1). Nunca se usan fotos reales.
- Los nombres de sección `§x.y` remiten a `docs/DESIGN.md`.

## Decisiones pendientes del usuario

| # | Decisión | Estado | Qué hace el plan mientras tanto | Confirmar antes de |
|---|---|---|---|---|
| D18 (importaciones) | Pausar el bloqueo por inactividad durante una importación (salvo en `awaiting-confirmation`) | **Recomendada, pendiente de confirmar** (la parte de fusiones está confirmada) | Implementa la recomendación con un único punto de cambio: la constante `IMPORT_PAUSES_AUTOLOCK = true` en `src/main/import/import-service.ts`. Si el usuario la rechaza, se pone a `false` y se ajustan su test (2.9) y el límite 10 de la Ayuda (2.12) | Fase 2 |
| D16 | Qué significa "silenciar todo" en la presentación | Recomendación (a) de §17.2 | Implementa (a): `mute` = silencio en los vídeos + interruptor "Música de fondo" al lado | Fase 4 |
| D9 | Selector de perfiles por tema | Recomendación de §15.10 | F1 hace `fotos` y el stub de `ps3`; F6 el resto | Fase 6 |
| D10 | Nombres visibles neutros de los temas | Recomendación de §15.12 | F1 ya muestra "Clásico" y "Ondas" | Fase 6 |
| D11 | Dónde compilar los paquetes de Linux | **Decidido: en el PC Linux del usuario** (en Windows no tiene permisos de administrador, así que no hay WSL2; anexo §5) | F7 prepara un script y la guía; el usuario compila y ejecuta los tests de Linux en su PC y comparte el informe (7.4). GitHub Actions queda como alternativa documentada | Fase 7 |
| D13 | Electron 44.9.3 o 45.x | 44.9.3 | Se reevalúa en 7.1 | Fase 7 |

## Decisiones de este plan

| # | Decisión | Motivo |
|---|---|---|
| P1 | Fases 0–7 con la numeración de DESIGN (F1–F7) | Las marcas `[F1]…[F7]` del árbol de §4 coinciden con las fases |
| P2 | El scaffold borra el `PLAN.md` de la raíz | Lo creó el setup y su nota de ABI ya no aplica: los tres módulos nativos son N-API y cargan en Node y en Electron (§2.5, §26.2) |
| P3 | `src/shared/types.ts` se crea en la Fase 0 con `Id` y `AppInfo` (completo en F1) | `app:getInfo` del scaffold necesita `AppInfo` y así no hay que moverlo después |
| P4 | `tsconfig.node.json` lleva `lib: ["ES2024", "DOM"]`; `src/main/**` prohíbe `window` y `document` con `no-restricted-globals` | El preload corre en un contexto DOM (pone `data-theme` en `DOMContentLoaded`, §15.4) y los tipos de Electron usan `File`; la regla ESLint evita usar el DOM en main |
| P5 | Restricciones de imports con `@typescript-eslint/no-restricted-imports` (la regla del core queda desactivada) y opciones generadas por una función en `eslint.config.mjs` | En la configuración plana, un bloque posterior **sustituye** las opciones de la misma regla en vez de fusionarlas: cada excepción por archivo tiene que repetir la lista completa menos lo permitido |
| P6 | Los repos son funciones que reciben `db` como primer parámetro; `SessionManager.getDb(epoch)` es el único sitio que entrega la DB | Repos testeables sin sesión y una sola comprobación de época `[H3-6]` |
| P7 | `src/main/import/sniff.ts` nace en F1 con las filas de foto (lo necesita `avatars.ts`) y F2 añade vídeo, RAW y CR3 | `avatars.ts` [F1] depende de `sniff.ts` [F2] en §4 |
| P8 | Archivo nuevo `src/main/import/path-guard.ts` [F2] con la comparación de rutas `[H3-3]` | Lógica pura y crítica para no perder datos: merece su propio módulo y test |
| P9 | La reconciliación lista los 256 shards de `thumbs/` con `readdir` en un `Set` `[H3-7]` | Mantiene la semántica de §12.6 (antes de mostrar la galería) con 256 llamadas en vez de 100 000 |
| P10 | El guard de Node también envuelve `process.binding` y rechaza `tcp_wrap`, `udp_wrap`, `cares_wrap` y `tls_wrap` `[H3-5]` | El anexo pide cubrir `process.binding`; Node y Electron usan `internalBinding`/`_linkedBinding` internamente, así que no rompe nada. Aun así no protege frente a una dependencia maliciosa (tiene `child_process` y addons nativos) y se documenta |
| P11 | Los permisos (§5.4, punto 4) y el corrector ortográfico van en `security/network-guard.ts` (por sesión); la política de WebRTC y la navegación en `security/navigation-guard.ts` (por webContents) | §5.4 no fija el archivo de los permisos |
| P12 | Fixtures generados en `tests/.tmp/fixtures/` por `tests/fixtures/generate.mjs`, invocado por un `globalSetup` de Playwright y por los tests de Vitest que los necesitan | No se versionan binarios grandes (hay uno de 1 GiB) |
| P13 | Paquetes de Linux en el PC Linux del usuario (D11); el workflow de GitHub Actions se describe en 7.4 pero no se crea salvo que el usuario lo pida | Crear CI implica subir el código a GitHub, contrario a la preferencia de privacidad |
| P14 | En la Fase 0, `importDropped` del preload es un stub que devuelve `{ ok: false, error: { code: 'INTERNAL', details: { reason: 'not-implemented' } } }`; F2 lo completa | El contrato del scaffold solo tiene `app:getInfo`, pero el E2E de `[H3-2]` exige que la función exista |

## Seguimiento de los hallazgos de la revisión v3 (anexo, sección 4)

| Hallazgo | Decisión del usuario | Tareas |
|---|---|---|
| v3-1 (H.264 de 10 bits o 4:2:2/4:4:4) | **Descartado, riesgo aceptado.** Sin `videoAction`/`COPYABLE_PIX`, sin sus tests ni fixtures | Una línea en la Ayuda (2.12) y en "Notas sobre el diseño" |
| `[H3-2]` esquemas zod fuera del preload | Obligatorio, scaffold | 0.3, 0.4, 0.6, 0.7 |
| `[H3-3]` rutas de `import:paths` sin normalizar | Obligatorio, F2, **protección contra pérdida de datos** | 1.10 (helper de esquemas), 2.4, 2.9 |
| `[H3-4]` `json_each(?)` en lugar de `IN (…)` | Obligatorio, F2 y F4 | 2.5, 4.1 |
| `[H3-5]` guard de Node: `dgram.Socket`, `process.binding`, `app.setProxy` | Obligatorio, scaffold/F1 | 0.5, 0.6, 0.7 |
| `[H3-6]` `getDb(epoch)`, `drained()`, borrados por `KeylessCleanup` | Obligatorio, F1/F2 | 1.8, 2.9 |
| `[H3-7]` miniaturas ausentes con `readdir` | Obligatorio, F2 | 2.10 |
| `[H3-8]` incoherencias del contrato IPC | Obligatorio, F1 | 1.1, 1.9, 1.10, 2.11 |
| `[H3-9]` licencia del build de ffmpeg | Obligatorio, F2 | 2.1 |
| `[H3-10]` árbol y alias de Vitest | Obligatorio, scaffold | 0.3, 1.11, 1.12 |
| `[H3-11]` CR3 y pistas sin códec o sin decodificador | Obligatorio, F2 | 2.1, 2.4, 2.7 |

---

## Fase 0 — Base del proyecto (este flujo)

### Objetivo

Dejar un repo git sin commits con el scaffold de Electron + electron-vite + React + TypeScript que compila, pasa lint y tests, y arranca una ventana oscura con el título "Galería". La base de seguridad (ventana endurecida, CSP, bloqueo de red en todas las capas de §5.4) ya funciona y la prueba un E2E. Un spike confirma que `@node-rs/argon2`, `better-sqlite3-multiple-ciphers` y `sharp` cargan dentro del proceso main de Electron en esta máquina (ruta no ASCII). No se implementa ninguna función del producto.

### Dependencias

Ninguna. Node 26.10.0, npm 11.19.1 y git 2.55.0 ya están comprobados (`.agents/tasks/env.md`) y el repo ya tiene `git init`. No hace falta Visual Studio Build Tools: los tres módulos nativos traen binarios N-API precompilados (§2.1).

### Tareas

- [ ] 0.1. Prerrequisitos, estado del repo y versiones.
      Qué: ejecutar `node -v`, `npm.cmd -v` y `git --version`. Si falta Node (≥ 24) o git, parar con `send_message` (severidad `warning`) y decir qué instalar, sin adivinar. Confirmar que `git -C . rev-parse --is-inside-work-tree` devuelve `true` y que no hay commits (`git rev-list --all --count` = 0). Borrar el `PLAN.md` de la raíz (P2). Comprobar que existen todas las versiones fijadas de 0.2 con `npm.cmd view <paquete>@<versión> version`; si alguna no existe, usar el último parche publicado de la misma minor y anotarlo en "Resultados del spike de módulos nativos".
      Archivos: borra `PLAN.md` (raíz).
      Verificación: las tres versiones se imprimen; `Test-Path PLAN.md` devuelve `False`; cada `npm.cmd view` imprime su versión.

- [ ] 0.2. `package.json` e instalación con versiones exactas.
      Qué: reescribir `package.json` con `name: "galeria"`, `version: "0.0.0"`, `private: true`, `productName: "Galería"`, `description: "Galería privada de fotos y vídeos, cifrada y sin conexión"`, `main: "out/main/index.js"`, sin `"type"`, `engines.node: "^24.0.0 || >=26.0.0"` (corrige el `">=24"` actual) y los scripts de la tabla de abajo. Instalar (sin `--force` ni `--legacy-peer-deps`; si npm da `ERESOLVE`, anotar el conflicto en "Resultados del spike" y bajar solo el paquete conflictivo a la mayor versión compatible):

      ```powershell
      npm.cmd install --save-exact @node-rs/argon2@2.2.2 better-sqlite3-multiple-ciphers@13.0.3 sharp@0.35.5 exifr@7.1.3 zod@4.6.7
      npm.cmd install --save-dev --save-exact react@19.3.1 react-dom@19.3.1 radix-ui@1.8.1 motion@14.6.0 @tanstack/react-virtual@3.14.22 zustand@5.0.16 @dnd-kit/core@6.3.1 @dnd-kit/sortable@10.0.0 lucide-react@1.61.0 tailwindcss@4.3.3 @tailwindcss/vite@4.3.3 @fontsource-variable/inter@5.3.0 @fontsource-variable/noto-sans@5.3.0 @fontsource-variable/nunito@5.3.0 @fontsource-variable/fraunces@5.3.0 @fontsource-variable/caveat@5.3.0
      npm.cmd install --save-dev --save-exact electron@44.9.3 electron-vite@6.0.0 vite@8.3.5 @vitejs/plugin-react@6.1.2 typescript@6.0.3 @types/node@24.19.2 @types/react@19.3.0 @types/react-dom@19.3.0 vitest@5.0.5 @vitest/coverage-v8@5.0.5 @playwright/test@1.64.1 eslint@9.39.5 @eslint/js@9.39.5 typescript-eslint@8.72.0 eslint-plugin-react-hooks@7.1.1 eslint-plugin-react-refresh@0.5.7 eslint-plugin-jsx-a11y@6.10.2 eslint-config-prettier@10.1.8 globals@17.13.0 prettier@3.9.10 prettier-plugin-tailwindcss@0.8.1 electron-builder@26.15.3
      ```

      El postinstall de `electron` descarga el binario a `%LOCALAPPDATA%\electron\Cache` (ruta no ASCII). Si falla por la ruta: `$env:electron_config_cache = 'C:\ebcache\electron'`, repetir y anotarlo en "Resultados del spike".

      | Script | Comando |
      |---|---|
      | `dev` | `electron-vite dev` |
      | `build` | `electron-vite build` |
      | `typecheck` | `tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json` |
      | `lint` | `eslint .` |
      | `format` | `prettier --write .` |
      | `test` | `vitest run` |
      | `test:e2e` | `electron-vite build && playwright test` |
      | `spike:native` | `electron scripts/native-spike.cjs` |
      | `make:icon` | `node scripts/make-icon.mjs` |

      Archivos: `package.json`, `package-lock.json`.
      Verificación: `npm.cmd ls --depth=0` termina con código 0 sin `invalid` ni `missing`; ninguna versión de `package.json` empieza por `^` o `~`; `npx.cmd electron --version` imprime `v44.9.3`.

- [ ] 0.3. Configuración base, árbol de carpetas y `src/shared` mínimo `[H3-2]` `[H3-10]`.
      Qué:
      - `.gitignore`: `node_modules/`, `out/`, `dist/`, `release/`, `coverage/`, `.cache/`, `resources/ffmpeg/*-x64/`, `test-results/`, `playwright-report/`, `tests/.tmp/`, `*.log`, `*.tsbuildinfo`, `.env*`, `GaleriaData/`.
      - `.editorconfig`: UTF-8, LF, 2 espacios, línea final. `.nvmrc` se queda en `26`.
      - `.prettierrc.json`: `singleQuote: true`, `printWidth: 100`, `trailingComma: "all"`, `plugins: ["prettier-plugin-tailwindcss"]`, `tailwindStylesheet: "./src/renderer/src/styles/base.css"` (Tailwind v4). `.prettierignore`: los mismos directorios generados de `.gitignore` más `package-lock.json`, `docs/` y `.agents/`.
      - `tsconfig.json`: solo `"files": []` y `references` a los otros dos. `tsconfig.node.json`: `composite: true`, `strict`, `target`/`lib` `ES2024` + `DOM` (P4), `module: "ESNext"`, `moduleResolution: "Bundler"`, `isolatedModules: true`, `skipLibCheck: true`, `types: ["node"]`, `paths` `@shared/*` → `./src/shared/*` y `@renderer/*` → `./src/renderer/src/*` **sin `baseUrl`** (obsoleto en TS 6); `include`: `src/main/**/*.ts`, `src/preload/**/*.ts`, `src/shared/**/*.ts`, `tests/**/*.ts`, `*.config.ts`. `tsconfig.web.json`: igual pero `lib` `ES2024`, `DOM`, `DOM.Iterable`, `jsx: "react-jsx"`, `types: ["vite/client"]`, `include` `src/renderer/**/*` y `src/shared/**/*.ts`.
      - `vitest.config.ts`: `test.include: ['tests/unit/**/*.test.ts']`, `environment: 'node'`, `pool: 'forks'` (cada archivo en su proceso, así el guard instalado por un test no afecta a otros) y `resolve.alias` de `@shared` y `@renderer` con rutas absolutas (`fileURLToPath(new URL('./src/shared', import.meta.url))`) `[H3-10]`.
      - Todas las carpetas del árbol de §4, con `.gitkeep` en las vacías: `scripts/`, `resources/{build,ffmpeg,licenses}/`, `src/shared/`, `src/main/{security,protocol,crypto,profiles,session,settings,vault,db/migrations,db/repos,import,media,music,ipc/handlers}/`, `src/preload/`, `src/renderer/src/{lib,stores,themes/tokens,themes/shells,themes/backgrounds,themes/titlebars,components,styles,assets/avatars,assets/textures,assets/wallpapers}/`, `src/renderer/src/screens/{profiles,gallery,viewer,player,playlists,presentation,dual,settings,help}/`, `tests/unit/{crypto,shared,main,renderer,tooling}/`, `tests/e2e/helpers/`, `tests/fixtures/`. Con `[H3-10]` el árbol incluye además `src/renderer/src/lib/errors-es.ts` [F1], `src/renderer/src/themes/BackgroundHost.tsx` [F1] y `src/main/ipc/schemas.ts` [S].
      - `src/shared/errors.ts`: `ERROR_CODES` (los 20 de §10.1), `ErrorCode`, `AppError`, `Result<T>`, más una clase `AppErrorException` que lleva un `AppError` (la usa main para lanzar y `register.ts` para convertir).
      - `src/shared/types.ts` (P3): `Id` y `AppInfo`.
      - `src/shared/ipc-contract.ts` `[H3-2]`: **solo tipos y arrays `as const`**, sin importar nada de `dependencies`: `INVOKE_CHANNELS = ['app:getInfo'] as const`, `EVENT_CHANNELS = [] as const`, `InvokeChannel`, `EventChannel`, mapas de tipos `ReqOf`/`ResOf`/`PayloadOf` e `interface GaleriaApi` de §10.2 (`invoke`, `on`, `importDropped`, `initialTheme`).
      - `tests/unit/smoke.test.ts`: importa `ERROR_CODES` desde `@shared/errors` y comprueba que hay 20 códigos y que incluye `INTERNAL` (trivial, y de paso prueba el alias de Vitest).
      Archivos: `.gitignore`, `.editorconfig`, `.prettierrc.json`, `.prettierignore`, `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json`, `vitest.config.ts`, los `.gitkeep`, `src/shared/errors.ts`, `src/shared/types.ts`, `src/shared/ipc-contract.ts`, `tests/unit/smoke.test.ts`.
      Verificación: `npm.cmd run typecheck` y `npm.cmd test` terminan en verde (1 archivo de test).

- [ ] 0.4. ESLint con las reglas de seguridad `[H3-2]`.
      Qué: `eslint.config.mjs` (configuración plana): `ignores` con los directorios generados, `docs/` y `.agents/`; `@eslint/js` recommended; `typescript-eslint` recommended; en `src/renderer/**` react-hooks, react-refresh, jsx-a11y y `globals.browser`; en el resto `globals.node`; `eslint-config-prettier` al final. Las opciones de cada regla restringida se generan con una función (P5) para que cada excepción repita la lista completa. Reglas (todas `error`):
      - `@typescript-eslint/no-restricted-imports` (y `no-restricted-imports` del core desactivada):
        - en `src/main/**` y `src/preload/**`: `http`, `https`, `net`, `tls`, `dgram`, `dns`, `http2` y sus formas `node:`, salvo `node:http` en `src/main/media/loopback-server.ts` y todo en `src/main/security/node-egress-guard.ts`; `child_process`/`node:child_process` salvo en `src/main/media/ffmpeg.ts`;
        - en todo `src/`: `{ name: 'electron', importNames: ['net'] }`; `sharp` con `allowTypeImports: true` salvo en `src/main/media/sharp-loader.ts`;
        - **`[H3-2]`** en `src/shared/**`, `src/preload/**` y `src/renderer/**`: `zod`, `sharp`, `exifr`, `better-sqlite3-multiple-ciphers` y `@node-rs/argon2`.
      - `no-restricted-syntax` en `src/main/**`: `CallExpression[callee.property.name='transaction'] > :function[async=true]` (§13.3) e `ImportExpression[source.value='sharp']` (salvo en `sharp-loader.ts`, que conserva solo el primer selector).
      - `no-restricted-globals`: `fetch`, `WebSocket`, `EventSource`, `XMLHttpRequest` en `src/main/**` y `src/preload/**`; además `window` y `document` en `src/main/**` (P4); `RTCPeerConnection` y `webkitRTCPeerConnection` en `src/renderer/**`.
      - `no-restricted-properties` en todo `src/`, sin `object`: `openExternal`, `openPath`, `onBeforeRequest` (salvo `src/main/security/network-guard.ts`) y `onHeadersReceived` (salvo `src/main/security/csp.ts`).
      - `tests/unit/tooling/eslint-rules.test.ts`: usa `new ESLint()` y `lintText(código, { filePath })` con rutas virtuales para comprobar que cada regla salta donde debe y no salta en su excepción. Casos mínimos: `fetch()` en `src/main/x.ts`; `import { z } from 'zod'` en `src/preload/index.ts` y en `src/shared/x.ts`; `import sharp from 'sharp'` en `src/main/x.ts` (error) y en `src/main/media/sharp-loader.ts` (sin error); `import type { Sharp } from 'sharp'` en `src/main/x.ts` (sin error); `await import('sharp')` en `src/main/x.ts`; `ses.webRequest.onBeforeRequest(…)` en `src/main/x.ts` (error) y en `src/main/security/network-guard.ts` (sin error); `db.transaction(async () => {})`; `shell.openExternal('x')`; `import { net } from 'electron'`; `import cp from 'node:child_process'` fuera de `ffmpeg.ts`; `new RTCPeerConnection()` en `src/renderer/src/x.ts`.
      Archivos: `eslint.config.mjs`, `tests/unit/tooling/eslint-rules.test.ts`.
      Verificación: `npm.cmd run lint` y `npm.cmd test -- tests/unit/tooling` en verde.

- [ ] 0.5. Guards de seguridad de main y sus unitarios `[H3-5]`.
      Qué:
      - `src/main/security/node-egress-guard.ts`: `installNodeEgressGuard()` con el código de §5.4, punto 10, más `[H3-5]`:
        - `for (const k of ['bind', 'connect', 'send'] as const) dgram.Socket.prototype[k] = deny;`;
        - envoltura de `process.binding` (P10): si el nombre es `tcp_wrap`, `udp_wrap`, `cares_wrap` o `tls_wrap`, lanza `EGALERIA_NET`; si no, delega en el original;
        - comentario en el archivo: "Cubre los usos accidentales de red en el código de las dependencias. No protege frente a una dependencia maliciosa de main, que tiene todos los privilegios de Node (`child_process`, addons nativos); eso queda fuera del modelo (§5.1)".
        - Falla cerrado: ninguna asignación va en `try`.
      - `src/main/security/startup-checks.ts`: `FORBIDDEN_SWITCHES` y `forbiddenDebugSwitch(isPackaged, has)` de §5.2, paso 2.
      - `src/main/security/csp.ts`: `PROD_CSP` (cadena exacta de §5.3), `buildDevCsp(devUrl)` (el `ws://` sale del `host` y el `port` de la URL) e `installDevCsp(ses, devUrl)`, el único `onHeadersReceived` del código, que solo toca las respuestas del origen de desarrollo.
      - `src/main/security/network-guard.ts` (P11): `installSessionGuards(ses, { devUrl, e2e })`, idempotente con un `WeakSet` (un segundo `onBeforeRequest` en la misma sesión sustituiría al primero). Instala el único `onBeforeRequest` (permite `app:` y `vault:`; `devtools:` solo sin empaquetar; el origen exacto `http://127.0.0.1:5173` + `ws://127.0.0.1:5173` solo con `devUrl`, comparando `new URL(url).origin`; cancela todo lo demás y cuenta por esquema `{ http, https, ws, wss, file, other }`), `will-download` → `preventDefault()`, `await ses.setProxy({ mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:9', proxyBypassRules: devUrl ? '' : '<-loopback>' })`, `setPermissionRequestHandler`/`setPermissionCheckHandler` que solo conceden `fullscreen`, `setDisplayMediaRequestHandler` que deniega y `setSpellCheckerEnabled(false)`. Exporta `getBlockedCounters()`.
      - `src/main/security/navigation-guard.ts`: `installWebContentsGuards(contents, rendererOrigin)` con `will-navigate`/`will-redirect` (fuera del origen → `preventDefault()`), `will-frame-navigate` en subframes (siempre se deniega), `setWindowOpenHandler(() => ({ action: 'deny' }))`, `will-attach-webview` → `preventDefault()` y `setWebRTCIPHandlingPolicy('disable_non_proxied_udp')`.
      - `tests/unit/main/node-egress-guard.test.ts` (Vitest instala el guard en su propio proceso, `pool: 'forks'`). Con un servidor TCP y un socket UDP del test en `127.0.0.1` que cuentan lo que reciben:
        - `fetch('http://127.0.0.1:<p>/')`, `net.connect(<p>, '127.0.0.1')`, `dns.promises.lookup('example.com')`, `dns.lookup(…)` y `new dns.Resolver().resolve4(…)` fallan con `code === 'EGALERIA_NET'`;
        - `[H3-5]` `new dgram.Socket('udp4').send(Buffer.from('x'), <u>, '127.0.0.1')`, `.bind(0)` y `.connect(<u>)` lanzan `EGALERIA_NET`; `dgram.createSocket('udp4')` también;
        - `[H3-5]` `process.binding('tcp_wrap')`, `('udp_wrap')`, `('cares_wrap')` y `('tls_wrap')` lanzan `EGALERIA_NET`;
        - el servidor TCP recibió 0 conexiones y el UDP 0 datagramas;
        - siguen funcionando `net.createServer().listen(0, '127.0.0.1')` y `child_process.spawn(process.execPath, ['-e', 'process.stdout.write("ok")'])` (entrega `ok`).
      - `tests/unit/main/startup-checks.test.ts`: sin empaquetar nunca devuelve un switch; empaquetado devuelve el primero de `FORBIDDEN_SWITCHES` que esté presente y `null` si no hay ninguno.
      Archivos: los cinco de `src/main/security/` y los dos tests.
      Verificación: `npm.cmd test -- tests/unit/main` en verde; `npm.cmd run lint` en verde (comprueba de paso que las excepciones de ESLint de 0.4 encajan con los archivos reales).

- [ ] 0.6. Arranque de main, protocolo `app://`, IPC mínimo, preload y renderer placeholder `[H3-2]` `[H3-5]`.
      Qué:
      - `electron.vite.config.ts`: se apoya en los valores por defecto de electron-vite 6 para entradas y salidas (`src/main/index.ts` → `out/main`, `src/preload/index.ts` → `out/preload`, `src/renderer` → `out/renderer`, CJS en main y preload porque `package.json` no declara `"type"`). Añade: `resolve.alias` `@shared`/`@renderer` en los tres; **`preload.build.externalizeDeps: false`** `[H3-2]` (`electron` sigue externo); en `renderer`, `plugins: [react(), tailwindcss()]`, `build.assetsInlineLimit: 0` y `server: { host: '127.0.0.1', port: 5173, strictPort: true }`. Si hace falta fijar `outDir`, usar rutas absolutas con `resolve(...)`: Vite resuelve `outDir` relativo a `root`.
      - `src/main/app-paths.ts`: raíz `GaleriaData` y `userData` ASCII de §8.1 (`%LOCALAPPDATA%\Galeria\…` en Windows, XDG en Linux) y override `GALERIA_DATA_DIR` (solo si es absoluta; `userData` = `<GALERIA_DATA_DIR>.electron`). Crea la raíz si no existe.
      - `src/main/protocol/schemes.ts`: `registerSchemesAsPrivileged` de §5.5 (`app` y `vault`).
      - `src/main/protocol/app-protocol.ts`: `ses.protocol.handle('app', …)` en la sesión `galeria`, sirve `join(__dirname, '../renderer')`; solo GET; rechaza `..`, rutas absolutas y NUL; MIME por extensión (`.html .js .css .woff2 .svg .png .webp .json`, el resto 404); cabeceras `Content-Security-Policy: PROD_CSP`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`.
      - `src/main/window.ts`: `createMainWindow()` con los `webPreferences` exactos de §5.2 salvo `frame: true` (la barra propia llega en F1), sin `setContentProtection` y sin `replaceMainWindow` (F1); `additionalArguments: ['--galeria-theme=fotos', '--galeria-scheme=dark']`; `show` en `ready-to-show`; carga `ELECTRON_RENDERER_URL` si `!app.isPackaged` y existe, si no `app://bundle/index.html`; exporta `getMainWindow()` y `getRendererOrigin()`.
      - `src/main/ipc/schemas.ts` `[H3-2]`: `SCHEMAS` tipado como `{ [C in InvokeChannel]: z.ZodType<ReqOf<C>> }` (falta un canal = error de compilación); `app:getInfo` → `z.undefined()`. Es el único sitio con esquemas zod del IPC.
      - `src/main/ipc/register.ts` (versión mínima de §5.6): `handle(channel, { requiresUnlock }, fn)` toma el esquema de `SCHEMAS`; pasos 1 (emisor: `event.sender.id` de la ventana actual y origen del frame), 2 (zod `.strict()`, `VALIDATION` con `details.path` sin el valor), 5 (`Result<T>`) y 6 (`AppErrorException` → `{ ok: false, error }`; cualquier otra → `INTERNAL` sin `err.message`). Acepta `requiresUnlock` pero aún no lo aplica.
      - `src/main/ipc/handlers/app.ts`: `app:getInfo` → `{ version: app.getVersion(), platform, ffmpegAvailable: false }`.
      - `src/main/index.ts`, en este orden exacto (§5.2): (1) `installNodeEgressGuard()`; (2) `if (forbiddenDebugSwitch(app.isPackaged, (s) => app.commandLine.hasSwitch(s))) app.exit(1)`; (3) `app.setPath('userData', …)`; (4) `requestSingleInstanceLock()` (si `false`, `app.quit()`; si no, `second-instance` enfoca la ventana); (5) `app.enableSandbox()`; (6) `registerSchemesAsPrivileged`; (7) `host-resolver-rules` (`MAP * ~NOTFOUND`, con `EXCLUDE 127.0.0.1` solo con `ELECTRON_RENDERER_URL` sin empaquetar) y `password-store=basic` en Linux. Antes de `ready`: `app.on('session-created', installSessionGuards)` y `app.on('web-contents-created', installWebContentsGuards)`. Tras `whenReady()`: `[H3-5]` `await app.setProxy({ mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:9', proxyBypassRules: devUrl ? '' : '<-loopback>' })` y `app.configureHostResolver({ secureDnsMode: 'off' })`; `await installSessionGuards` en `defaultSession` y en `session.fromPartition('galeria')`; `installDevCsp` si hay `devUrl`; `Menu.setApplicationMenu(null)`; protocolo `app`; registrar `app:getInfo`; crear la ventana. `window-all-closed` → `app.quit()`. Nunca `crashReporter.start()` ni autoUpdater. Con `!app.isPackaged && process.env.GALERIA_E2E === '1'`, `globalThis.__galeriaNetBlocked = getBlockedCounters()`.
      - `src/preload/index.ts`: `contextBridge.exposeInMainWorld('galeria', api)` con `invoke` (rechaza canales fuera de `INVOKE_CHANNELS`), `on` (allowlist `EVENT_CHANNELS`, devuelve la función para darse de baja), `importDropped` (stub de P14) e `initialTheme` leído de `process.argv` (`--galeria-theme`, `--galeria-scheme`; por defecto `fotos`/`dark`). Solo importa `electron` y `@shared/*`.
      - Renderer: `src/renderer/index.html` (`lang="es"`, `<meta charset="utf-8">`, `<title>Galería</title>`, sin scripts en línea); `src/renderer/src/lockdown.ts` (borra `RTCPeerConnection`, `webkitRTCPeerConnection`, `RTCDataChannel`, `RTCSessionDescription`, `RTCIceCandidate`, §5.4 punto 5); `main.tsx` (primer import `./lockdown`, después `./styles/base.css`, y monta `<App />`); `App.tsx` (pantalla completa `#1b1b1f` con `<h1>Galería</h1>` centrado, sin funciones); `env.d.ts` (`interface Window { galeria: GaleriaApi }`); `styles/base.css` (`@import "tailwindcss";` y `@theme inline { --color-bg: #1b1b1f; --color-text: #f2f2f2; }`, que F1 sustituye por los tokens `--g-*`).
      - `scripts/make-icon.mjs`: `sharp({ create: { width: 512, height: 512, channels: 4, background: '#1b1b1f' } }).png()` → `resources/build/icon.png`. Ejecutarlo una vez con `npm.cmd run make:icon`; el PNG se versiona.
      - `electron-builder.yml` mínimo: `appId: app.galeria.desktop`, `productName: Galería`, `directories` (`output: release`, `buildResources: resources/build`), `files` (`out/**`, `package.json`), `asar: true`, `npmRebuild: false`, `publish: null`.
      Archivos: los enumerados arriba.
      Verificación: `npm.cmd run typecheck`, `npm.cmd run lint` y `npm.cmd run build` en verde; existen `out/main/index.js`, `out/preload/index.js` y `out/renderer/index.html`; `out/preload/index.js` no contiene `require("zod")` ni ningún otro `require` salvo `electron` (lo confirma el E2E de 0.7); `resources/build/icon.png` mide 512×512.

- [ ] 0.7. Playwright y E2E de humo `[H3-2]` `[H3-5]`.
      Qué:
      - `playwright.config.ts`: `testDir: 'tests/e2e'`, `workers: 1`, `fullyParallel: false`, `timeout: 60_000`, `retries: 0`, `reporter: 'list'`, `outputDir: 'test-results'`. No hace falta instalar navegadores (`_electron`).
      - `tests/e2e/helpers/launch.ts`: `launchApp()` crea `tests/.tmp/e2e/<uuid>` (ruta absoluta), lanza `_electron.launch({ args: ['.'], cwd: <raíz>, env })` con el entorno del proceso sin `ELECTRON_RENDERER_URL` ni `ELECTRON_RUN_AS_NODE` y con `GALERIA_E2E=1` y `GALERIA_DATA_DIR=<dir>`, espera `firstWindow()` y devuelve `{ app, page, dataDir, close() }`; `close()` cierra la app y borra `<dir>` y `<dir>.electron`.
      - `tests/e2e/smoke.spec.ts`. Antes de los tests de red, el proceso del test levanta un servidor HTTP en `127.0.0.1:<p>` y un socket UDP en `127.0.0.1:<u>` que cuentan conexiones y datagramas. Casos (uno por `test`):
        1. **Ventana**: el `h1` "Galería" es visible; `webContents.getLastWebPreferences()` desde main confirma `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`; en el renderer `typeof require` y `typeof process` valen `'undefined'`.
        2. **Preload e IPC** `[H3-2]`: `page.evaluate(() => window.galeria.invoke('app:getInfo'))` devuelve `{ ok: true, data: { ffmpegAvailable: false, platform, version } }`; `typeof window.galeria.importDropped === 'function'`; `invoke` con un canal fuera de la allowlist se rechaza sin llegar a main.
        3. **CSP**: `fetch('https://example.com')` desde el renderer se rechaza.
        4. **`webRequest` aislado**: `electronApp.evaluate` crea una `BrowserWindow` oculta (`partition: 'galeria'`, `sandbox: true`) y `loadURL('http://127.0.0.1:<p>/')` devuelve `'ERR_BLOCKED_BY_CLIENT'`; `__galeriaNetBlocked.http ≥ 1`; 0 conexiones.
        5. **`electron.net`**: `net.fetch('http://127.0.0.1:<p>/')` desde main se rechaza, el contador `http` vuelve a subir y hay 0 conexiones. Si el contador no sube (R17), se aplica la variante de §5.4 punto 10 (el guard sustituye `electron.net.fetch` y `electron.net.request`) y se anota en "Resultados del spike".
        6. **Node en main**: con `process.getBuiltinModule`, `fetch(…)`, `net.connect(<p>, '127.0.0.1')` y `dns.promises.lookup('example.com')` fallan con `EGALERIA_NET`; `[H3-5]` `new dgram.Socket('udp4').send(…, <u>, '127.0.0.1')` y `process.binding('tcp_wrap')` también; 0 conexiones y 0 datagramas.
        7. **Proxy** `[H3-5]`: `session.fromPartition('galeria').resolveProxy('https://example.com')` devuelve `SOCKS5 127.0.0.1:9` (o la forma equivalente `SOCKS 127.0.0.1:9`); si `app.resolveProxy` existe en Electron 44, se comprueba lo mismo a nivel de app.
        8. **WebRTC**: `[typeof RTCPeerConnection, typeof webkitRTCPeerConnection]` vale `['undefined', 'undefined']`; desde un `<iframe>` vacío creado por script, `iframe.contentWindow.RTCPeerConnection` (si existe) con `iceServers` TURN/TCP a `127.0.0.1:<p>` y STUN a `127.0.0.1:<u>`, `createDataChannel`, `createOffer`, `setLocalDescription` y 5 s de espera: 0 conexiones y 0 datagramas. Si llega algo (R19), no se improvisa otra capa: ese test se marca `test.fixme` con un comentario que cita R19, se anota en "Resultados del spike" y se avisa en el informe final; el resto tiene que pasar.
      Archivos: `playwright.config.ts`, `tests/e2e/helpers/launch.ts`, `tests/e2e/smoke.spec.ts`.
      Verificación: `npm.cmd run test:e2e` en verde (8 tests, o 7 + 1 `fixme` justificado por R19).

- [ ] 0.8. Spike de módulos nativos.
      Qué: `scripts/native-spike.cjs`, válido en Electron y en Node (detecta `process.versions.electron`; en Electron espera `app.whenReady()` y sale con `app.exit(código)`, en Node con `process.exit(código)`). Trabaja en `tests/.tmp/spike/` (dentro de la ruta no ASCII, a propósito) y lo borra al terminar:
      - `@node-rs/argon2`: `hashRaw` con 8 MiB, t=1, p=1 y `algorithm: 2`, `version: 1`; comprueba 32 bytes de salida.
      - `better-sqlite3-multiple-ciphers`: crear `spike.db` con `cipher='sqlcipher'`, `legacy=4` y `db.key(Buffer.from("x'<64 hex>'"))`; insertar una fila con un marcador; cerrar; reabrir y leer el marcador; reabrir con otra clave → tiene que fallar (`SQLITE_NOTADB`); los 16 primeros bytes no son `SQLite format 3\0`; el marcador no aparece en los bytes del archivo. Si `db.key(Buffer)` no acepta la forma `x'…'`, probar el plan B de §9.1 (`PRAGMA key = "x'…'"`) e informar de cuál funcionó (R5).
      - `sharp`: PNG de 64×64 en memoria → WebP; comprobar `metadata().format === 'webp'`.
      - Imprime un JSON `{ runtime: { electron, node, modules }, argon2, sqlcipher, sharp }` con `"ok"` o `{ error, code }` en cada módulo, y sale con 0 si los tres van bien o 1 si alguno falla.
      Ejecutarlo dos veces: `npm.cmd run spike:native` (main de Electron 44, Node 24) y `node scripts/native-spike.cjs` (Node 26 del sistema, el que usa Vitest; confirma §2.5). Copiar las dos salidas JSON y cualquier fallo con su solución propuesta a "Resultados del spike de módulos nativos" (sustituyendo el texto "Pendiente…"). Un fallo se documenta, no bloquea el flujo. Solución prevista si falla por la ruta no ASCII: `subst G: "c:\Users\AlbertoVázquezAguila\Documents\Galeria_App"` y repetir desde `G:\` (R1).
      Archivos: `scripts/native-spike.cjs`, `docs/PLAN.md` (solo la sección de resultados).
      Verificación: las dos ejecuciones terminan con código 0, o el fallo queda documentado con su solución.

- [ ] 0.9. `README.md` en español.
      Qué: sustituir el README actual por uno mínimo: qué es Galería (bóveda privada de fotos y vídeos, cifrada, sin conexión, Windows y Linux) y que hoy es solo el scaffold; prerrequisitos (Node 26 Current, recomendado el último parche 26.x, o Node 24 LTS; git; en PowerShell `npm.cmd`/`npx.cmd` por la ExecutionPolicy; no hace falta Visual Studio Build Tools); `npm.cmd ci`; la tabla de scripts de 0.2; enlaces a `docs/DESIGN.md` y `docs/PLAN.md`.
      Archivos: `README.md`.
      Verificación: `npx.cmd prettier --check README.md` en verde.

- [ ] 0.10. Verificación final del scaffold.
      Qué: ejecutar la VC completa y las dos variantes del spike; confirmar que no hay commits y que todo queda sin seguimiento para que lo revise el usuario. No ejecutar `npm run dev`. No hacer commits.
      Archivos: ninguno nuevo (solo se rellena "Resultados del spike" si falta algo).
      Verificación: `npm.cmd run typecheck; npm.cmd run lint; npx.cmd prettier --check .; npm.cmd test; npm.cmd run build; npm.cmd run test:e2e` en verde; `git rev-list --all --count` devuelve 0 (o el error "no commits"); `git status --short` lista los archivos nuevos como `??`.

### Criterios de aceptación

- `package.json` con versiones exactas, `engines` corregido y los 9 scripts; `npm.cmd ls --depth=0` limpio.
- Árbol de §4 completo (con `.gitkeep`), incluidos `src/main/ipc/schemas.ts` y los huecos de `[H3-10]`.
- `src/shared/**` y `src/preload/**` no importan ningún paquete de `dependencies`; ESLint lo impide y el test de reglas lo demuestra `[H3-2]`.
- El arranque sigue el orden exacto de §5.2 (pasos 1–7), con `app.setProxy` y `configureHostResolver` después de `ready` `[H3-5]`.
- Los 8 casos del E2E de humo pasan (o el de WebRTC queda en `fixme` documentado por R19), incluida la llamada a `app:getInfo` a través del preload con sandbox `[H3-2]`.
- Unitarios del guard de Node (con `dgram.Socket` y `process.binding`) y de `startup-checks` en verde.
- Spike ejecutado en Electron y en Node, con los resultados anotados.
- Sin commits y sin `PLAN.md` en la raíz.

### Cómo verificar

VC completa (arriba) más `npm.cmd run spike:native` y `node scripts/native-spike.cjs`.

### Riesgos

- R1 (ruta no ASCII): instalación de Electron, carga de las DLL de sharp y rutas de SQLite. Mitigación: spike en `tests/.tmp/` dentro de la ruta real; `electron_config_cache` y `subst G:` como soluciones previstas.
- R17 (`webRequest` y `net.fetch`) y R19 (WebRTC): los resuelve o los reabre el E2E de 0.7, sin improvisar.
- Configuración plana de ESLint: un bloque posterior sustituye las opciones de una regla (P5); el test de 0.4 lo detecta.
- `pool: 'forks'` de Vitest: si el guard instalado en su test rompiera la comunicación del worker, ese test pasa a lanzar un `process.execPath` hijo con las mismas comprobaciones.

### Qué puede probar el usuario al final de la fase

- `npm.cmd run dev`: se abre una ventana oscura con el título "Galería", sin funciones.
- `npm.cmd run test:e2e`: ve pasar la prueba de humo, incluido el bloqueo de red.
- Revisar con `git status` todos los archivos, sin commits.

---

## Fase 1 — Núcleo criptográfico, perfiles, bloqueo y sistema de temas

### Objetivo

Formato cifrado (§7) y jerarquía de claves (§6) con tests exhaustivos; DB SQLCipher; perfiles (crear, desbloquear, bloquear, cambiar contraseña, editar y borrar con contraseña); selector estilo Netflix; auto-bloqueo y bloqueo por suspensión o bloqueo del SO; ventana sin marco con barra de título propia; arquitectura de temas completa con `fotos` y un stub de `ps3` (§15.13).

### Dependencias

Fase 0 terminada (VC en verde y spike con argon2 y SQLCipher cargando; si SQLCipher solo funcionó con el plan B de §9.1, 1.6 usa esa forma).

### Tareas

- [ ] 1.1. Tipos y contrato IPC de F1 `[H3-8]`.
      Qué: completar `src/shared/types.ts` con todos los tipos de §10.1 (son tipos puros; los de fases posteriores se declaran ya, así el contrato es estable), `src/shared/constants.ts` (formatos y límites de §10.3 y §12.3), `src/shared/themes.ts` (`ThemeId`, catálogo y nombres visibles de D10). Ampliar `src/shared/ipc-contract.ts` con los canales de F1 (`app:*`, `window:*`, `settings:*`, `profiles:*`, `session:*`, `prefs:*`) y los eventos `session:locking`, `session:locked`, `window:state`. `[H3-8]`: `profiles:delete` devuelve `{ leftoverPath: string | null }`.
      Archivos: `src/shared/{types,constants,themes,ipc-contract}.ts`, `tests/unit/shared/ipc-contract.test.ts`.
      Verificación: `npm.cmd test -- tests/unit/shared` en verde. El test comprueba que `INVOKE_CHANNELS` y `EVENT_CHANNELS` no tienen duplicados, que `import:paths` no está en `INVOKE_CHANNELS` (allowlist genérica, §5.6) y, con `expectTypeOf`, que ningún `ResOf<C>` ni `PayloadOf<E>` contiene `Buffer` ni `Uint8Array` (invariante de §22: el renderer nunca recibe claves).

- [ ] 1.2. Log tipado (§21.2).
      Qué: `src/main/log.ts` con niveles, `LogEvent` como unión cerrada de literales, campos permitidos de §21.2, rotación 1 MiB × 3 en `GaleriaData/logs/main.log` y `debug` solo sin empaquetar. Se registra el `info` "override activo" de `GALERIA_DATA_DIR` (§8.1).
      Archivos: `src/main/log.ts`, `tests/unit/main/log.test.ts`.
      Verificación: `npm.cmd test -- tests/unit/main/log.test.ts` (escribe, rota a `.1` y `.2` y descarta el cuarto); `npm.cmd run typecheck` rechaza un `log.warn('texto libre')` en un archivo de prueba de tipos (`// @ts-expect-error` dentro del test).

- [ ] 1.3. Primitivas criptográficas (§6).
      Qué: `secure-buffer.ts` (`alloc32()`, `zeroize(buf)`), `file-format.ts` (constantes de §7.1, `encodeHeader`/`decodeHeader`, `chunkCount`, `chunkLen`, `chunkOffset`, `fileLength`, `chunkNonce`, `chunkAad`), `keys.ts` (`wrapMasterKey`/`unwrapMasterKey` con `AAD_mk` de §6.2, `deriveKeys(mk, profileId)` con los tres `info` de §6.3, `KeyRing.zeroize()`, `DekCache` LRU de 64 que pone a cero al expulsar), `kdf.ts` (`hashRaw` con literales `algorithm: 2`, `version: 1`; calibración de §6.1 con reloj y función hash inyectables; parámetros rápidos `8 MiB / t=1 / p=1` solo si `GALERIA_TEST_FAST_KDF=1` y `!app.isPackaged`, con `warn`). Siempre `authTagLength: 16` al cifrar y al descifrar.
      Archivos: `src/main/crypto/{secure-buffer,file-format,keys,kdf}.ts`; `tests/unit/crypto/{file-format,keys,kdf}.test.ts`.
      Verificación: `npm.cmd test -- tests/unit/crypto` en verde, con estos casos:
      - `file-format`: tamaños y offsets para P ∈ {0, 1, 65535, 65536, 65537, 3·65536, 1 MiB+123}; ejemplo de §7.6 con sus valores fijos (n = 3, offsets 108/65660/131212, L = 150156); vector de nonce (`…8899AABB` → `…8899AAB9` para i = 2); AAD de 25 bytes con `final`.
      - `keys`: envolver y desenvolver la MK; **contraseña incorrecta** (KEK distinta) → `WRONG_PASSWORD`; cambiar `profileId`, `m`, `t`, `p` o la sal en la AAD → falla; las tres claves HKDF son distintas entre sí y entre perfiles; `KeyRing.zeroize()` deja las cuatro claves a cero; la LRU pone a cero la DEK expulsada.
      - `kdf`: con tiempos simulados, > 1,5 s prueba los candidatos en el orden de §6.1 y se queda con el primero que baja; < 0,5 s sube `t` con la fórmula (0,255 s → 8); un fallo de memoria pasa al siguiente candidato; el suelo `(64 MiB, t=3)` se usa aunque tarde; sin candidatos → `INTERNAL { reason: 'kdf-memory' }`. Test lento (`GALERIA_SLOW_TESTS=1`): parámetros de producción y delta de `maxRSS` ≤ 1,5 × m.

- [ ] 1.4. Objetos cifrados: escritor y lector con acceso aleatorio (§7.7).
      Qué: `object-writer.ts` (`createObjectWriter`: DEK interna nunca aceptada como parámetro, retiene el último chunk hasta saber si es final, cabecera en offset 0 al terminar, `fsync`, `abort()` que nunca lanza, `destroyKeys()` síncrono, `signal` que llama a `destroyKeys()`, `ENOSPC` → `DISK_FULL`, otros → `IO`) y `object-reader.ts` (`openObject` valida cabecera, `fileId`, `kind` y tamaño `L` con `fstat`; `createReadStream(a, b)` verifica cada tag antes de entregar bytes; `readAll()`; `destroyKeys()`; `ENOENT` → `NOT_FOUND`).
      Archivos: `src/main/crypto/{object-writer,object-reader}.ts`; `tests/unit/crypto/{object-roundtrip,object-tamper,object-range,object-lifecycle}.test.ts`.
      Verificación: `npm.cmd test -- tests/unit/crypto` en verde. Tests obligatorios (todos con `tests/.tmp/` y claves aleatorias):

      | Archivo | Casos |
      |---|---|
      | `object-roundtrip` | **Ida y vuelta** para P ∈ {0, 1, 65535, 65536, 65537, 3·65536, 1 MiB+123}, escribiendo en trozos de tamaños aleatorios; **archivo vacío** (P = 0: un chunk final de 0 bytes + tag, L = 124); **tamaños múltiplos exactos de 64 KiB** (65536 y 3·65536: no hay chunk vacío extra y el último lleva `final = 1`); dos escrituras del mismo contenido producen DEK, cabecera y ciphertext distintos (§22) |
      | `object-tamper` | **Cabecera manipulada**: cambiar un bit de cada campo (magic, version, kind, flags, chunkSize, plaintextSize, fileId, nonceBase, wrapNonce, wrappedDek, wrapTag) → `INTEGRITY` al abrir; **chunk manipulado**: un bit del ciphertext y un bit del tag de cada chunk → `INTEGRITY` al leer ese chunk y ningún byte de ese chunk entregado; **chunks reordenados** (intercambiar 0 y 1) → `INTEGRITY`; **truncado**: quitar el último chunk, cortar a mitad de chunk, dejar solo la cabecera → `INTEGRITY`; **extensión**: +1 byte y +un chunk copiado → `INTEGRITY`; **chunk de otro archivo** (mismo P, copiar el chunk 1 de A sobre el de B) → `INTEGRITY`; **intercambio de archivos** (abrir A esperando el `fileId` de B) → `INTEGRITY`; `kind` esperado distinto → `INTEGRITY`; otra K_wrap (otra bóveda) → `INTEGRITY`; un tag de 12 bytes no valida |
      | `object-range` | **Lecturas aleatorias**: 200 rangos aleatorios más los bordes de cada chunk (`a` y `b` en `k·65536 − 1`, `k·65536`, `k·65536 + 1`) comparados byte a byte con el plaintext; el ejemplo de §7.6 (`[70000, 140000]` → 70001 bytes); rango de un solo byte en el último chunk; solo se leen del disco los chunks `i0..i1` (lector con `fs` espiado) |
      | `object-lifecycle` | `abort()` borra el `.part` y deja la DEK a cero; tras `destroyKeys()`, `write()` rechaza con `LOCKED`; `destroyKeys()` del reader hace fallar con `LOCKED` las lecturas pendientes; disparar el `AbortSignal` pone la DEK a cero de forma síncrona; `ENOSPC` simulado (escritura inyectada) → `DISK_FULL` y `.part` borrado; antes de `finish()` los 108 primeros bytes del `.part` son cero |

- [ ] 1.5. `sharp-loader` y firmas de foto (P7).
      Qué: `src/main/media/sharp-loader.ts` (`getSharp()` de §12.4: `VIPS_DISC_THRESHOLD = '4g'` antes del `import()` dinámico y `cache(false)`). `src/main/import/sniff.ts` con las filas de foto de §12.3 (JPEG, PNG, WebP, GIF, AVIF; `mif1`/`msf1`/`miaf` según compatible brands; HEIC y BMP con cabecera DIB válida → `UNSUPPORTED_FORMAT`; el resto `unknown`), lectura de hasta 512 bytes.
      Archivos: `src/main/media/sharp-loader.ts`, `src/main/import/sniff.ts`, `tests/unit/main/{sharp-loader,sniff-photo}.test.ts`.
      Verificación: `npm.cmd test -- tests/unit/main/sharp-loader.test.ts tests/unit/main/sniff-photo.test.ts`: la variable está puesta cuando sharp se carga; `getSharp()` devuelve siempre la misma instancia; `sharp.cache()` informa límites 0; cada firma de foto se reconoce; BMP (24 bits escrito a mano) y HEIC (`ftypheic` y `mif1` + `heic`) se rechazan; `mif1` + `avif` es AVIF.

- [ ] 1.6. Base de datos SQLCipher (§9).
      Qué: `src/main/db/database.ts` (`openDatabase(path, kDb, { creating })` con los PRAGMA de §9.1 y `rawKeyArg` sin strings; plan B solo si el spike lo exigió), `migrate.ts` (§9.3), `migrations/index.ts` (esquema v1 de §9.2 literal) y `repos/kv-repo.ts` (claves cerradas validadas con zod). Los repos son funciones con `db` como primer parámetro (P6).
      Archivos: `src/main/db/{database,migrate}.ts`, `src/main/db/migrations/index.ts`, `src/main/db/repos/kv-repo.ts`; `tests/unit/main/{database,migrate,kv-repo}.test.ts`.
      Verificación: `npm.cmd test -- tests/unit/main/database.test.ts tests/unit/main/migrate.test.ts tests/unit/main/kv-repo.test.ts`. Casos de §9.1 (crear, cerrar y reabrir; clave incorrecta → `SQLITE_NOTADB`; cabecera distinta de `SQLite format 3\0`; un string insertado no aparece en los bytes del archivo ni del `-wal`); migración v1 con `user_version = 1`; migración que falla → `ROLLBACK`, `.bak-v0` conservado, `VAULT_CORRUPT { stage: 'migration' }`; `user_version` mayor → `VAULT_CORRUPT { stage: 'newer-version' }` sin tocar el archivo; `kv-repo` rechaza claves desconocidas y valores que no validan.

- [ ] 1.7. Layout de la bóveda y almacenes JSON en claro (§8).
      Qué: `src/main/vault/vault-layout.ts` (rutas de §8.5, sharding `aa`, `removeVaultDir(dir, profileId, mode)` de §8.5.1); `src/main/settings/settings-store.ts` (`writeJsonAtomic` de §8.3 con reintentos `EPERM`/`EBUSY` y `fsync` de directorio en Linux; `settings.json` y `prefs/<id>.json` con valores por defecto y reescritura si no validan); `src/main/profiles/profile-store.ts` (`profiles.json` + `.bak` idéntico, lectura con las tres reglas de §8.3). Al arrancar se borran los `*.tmp-*` de `GaleriaData`.
      Archivos: los tres módulos; `tests/unit/main/{vault-layout,settings-store,profile-store}.test.ts`.
      Verificación: `npm.cmd test -- tests/unit/main/vault-layout.test.ts tests/unit/main/settings-store.test.ts tests/unit/main/profile-store.test.ts`. Casos de §8.5.1 (carpeta sin `vault.json`, con `vault.json` de otro perfil, con `vault.json` correcto más archivos ajenos: nunca se toca un archivo ajeno; `dir` u `objects/` como junction en Windows o enlace simbólico en Linux: no se borra nada a través del enlace; los enlaces simbólicos de archivo en Windows se omiten con `skipIf` si crearlos da `EPERM`); `profiles.json` dañado → se usa el `.bak` y se reescribe; los dos dañados → `VAULT_CORRUPT` sin escribir nada; ninguno → lista vacía.

- [ ] 1.8. Sesión, trabajos y bloqueo (§12.11, §13) `[H3-6]`.
      Qué:
      - `session/jobs.ts`: `JobRegistry` con las reglas de §12.11 (`BUSY` al superar el límite), `abortAll(reason)` síncrono, `JobHandle` con `epoch` (época de la sesión en `start()`), `setPausesAutoLock`, `done()` y `drained(): Promise<void>` que se resuelve cuando todos los trabajos abortados llamaron a `done()` `[H3-6]`.
      - `session/auto-lock.ts`: conjunto de motivos de pausa (`'playback'`, `'maintenance'`, `'job'`); corre solo con el conjunto vacío y se reinicia desde cero al vaciarse.
      - `session/keyless-cleanup.ts`: cola de tareas sin claves, serializada por ruta (una petición sobre una ruta en curso se une a la tarea existente); solo recibe rutas y descriptores.
      - `session/session-manager.ts`: máquina de estados de §13.1 con `epoch` creciente por sesión; `getDb(epoch?)` lanza `LOCKED` si no hay DB abierta **o si `epoch` no coincide con la sesión actual** `[H3-6]` (los IPC usan la época actual; los trabajos, la de su `JobHandle`); desbloqueo de §13.1 que en el paso 1 espera también el `drained()` de la sesión anterior, como mucho 5 s, y si no termina sigue con un `warn` `[H3-6]`; el paso 6 (reconciliar) es un gancho vacío hasta F2; secuencia de bloqueo de §13.3 (pasos 1–4 síncronos con `suspend`, `os-lock`, `error` y `vault-unavailable`; espera ≤ 2 s con `manual`, `inactivity` y `shutdown`; paso 6 en `KeylessCleanup`); registro de readers y writers abiertos con `destroyKeys()`; disparadores de §13.2 (`powerMonitor` `suspend` y `lock-screen`; en Linux `getSystemIdleState(60)` cada 5 s; `before-quit` → `shutdown`; vigilante de `vault.json` cada 10 s; `uncaughtException`/`unhandledRejection` → bloqueo `error` y diálogo nativo). Con `GALERIA_E2E=1` y sin empaquetar expone `globalThis.__galeriaLastZeroizeMs`.
      Archivos: los cuatro módulos; `tests/unit/main/{jobs,auto-lock,keyless-cleanup,session-manager}.test.ts`.
      Verificación: `npm.cmd test -- tests/unit/main/jobs.test.ts tests/unit/main/auto-lock.test.ts tests/unit/main/keyless-cleanup.test.ts tests/unit/main/session-manager.test.ts`, con fakes inyectados:
      - con un trabajo colgado en un `await` que nunca se resuelve, `lock('suspend')` deja a cero KeyRing, caché de DEKs y DEK del writer **antes de devolver** y sin que el trabajo termine; con `lock('manual')` la espera no pasa de 2 s (reloj falso);
      - `[H3-6]` un trabajo de la época 1 que pide `getDb(1)` después de desbloquear la época 2 recibe `LOCKED`; el desbloqueo espera `drained()` de la sesión anterior y continúa a los 5 s con un `warn` si no termina;
      - reglas de `BUSY` de §12.11 por tipo de trabajo; `abortAll` dispara todas las señales;
      - motivos de pausa del auto-bloqueo (D12, `maintenance`, `job`), con reloj falso;
      - `KeylessCleanup` une dos peticiones sobre la misma ruta.

- [ ] 1.9. Servicio de perfiles y avatares (§14.4) `[H3-8]`.
      Qué: `src/main/profiles/avatars.ts` (12 ids integrados; `pickAvatarPhoto` con los pasos 1–7 de §14.4: `lstat`, ≤ 50 MiB, firma con `sniff.ts`, `getSharp()` con `limitInputPixels`, 256×256 WebP sin metadatos, token de 10 min en memoria). `src/main/profiles/profile-service.ts`: `list` (con `vaultStatus` y timeout de 1,5 s), `createProfile` (8 pasos de §14.4 con `vaults/<id>.creating`), `updateProfile` (exige contraseña, D14), `changePassword` (§6.6, solo vuelve a envolver), `deleteProfile` (§14.4: lo primero es desenvolver la MK; devuelve `{ leftoverPath: string | null }` `[H3-8]`), limpieza de `vaults/*.creating` al arrancar y `warn` `vault.orphan-dir` para carpetas sin perfil.
      Archivos: los dos módulos; `tests/unit/main/{avatars,profile-service}.test.ts`.
      Verificación: `npm.cmd test -- tests/unit/main/avatars.test.ts tests/unit/main/profile-service.test.ts`:
      - crear con un fallo inyectado en cada paso 2–7 → no queda carpeta ni avatar y `profiles.json` no cambia; las claves quedan a cero también en esa ruta; una caída simulada antes del paso 7 deja `vaults/<id>.creating`, que el arranque borra;
      - nombre duplicado sin distinguir mayúsculas ni acentos → `PROFILE_NAME_TAKEN`; el perfil 11 → `PROFILE_LIMIT`;
      - cambiar la contraseña conserva la MK (la DB abre igual), la antigua da `WRONG_PASSWORD` y `profiles.json.bak` ya no contiene la envoltura antigua;
      - `deleteProfile` con contraseña incorrecta no cambia nada; con la correcta devuelve `{ leftoverPath: null }`, y con un archivo ajeno dentro de la bóveda devuelve su ruta en `leftoverPath` sin borrar el ajeno `[H3-8]`;
      - avatar: JPEG, PNG, WebP, GIF (primer fotograma) y AVIF → WebP 256×256 sin EXIF; BMP y HEIC → `UNSUPPORTED_FORMAT`; > 50 MiB → `TOO_LARGE` sin leer; > 268 MP → `TOO_LARGE`; enlace simbólico → `UNSUPPORTED_FORMAT`; el archivo elegido no cambia (mismo SHA-256).

- [ ] 1.10. IPC completo de F1, ventana sin marco y avatar por `vault://` `[H3-8]` `[H3-3]`.
      Qué:
      - `ipc/register.ts`: añade el paso 3 (`requiresUnlock` → `LOCKED`) y el 4 (`maintenance` → `BUSY` salvo la lista de §5.6).
      - `ipc/schemas.ts`: esquemas de todos los canales de F1 con las reglas de §10.3. Dos ayudantes: `text(min, max)` normaliza a NFC, recorta y cuenta code points; `rawPath()` **no normaliza ni recorta** y solo valida no vacía, ≤ 32 767 unidades UTF-16, `path.isAbsolute` y sin NUL `[H3-3]` (lo usará `import:paths` en F2). Contraseñas: `Uint8Array` de 8–1024 bytes; `confirmName` comparado por pliegue.
      - Handlers `ipc/handlers/{window,profiles,session,settings}.ts` (incluye `prefs:get`/`prefs:set`). `[H3-8]`: `session:unlock` con la bóveda ausente devuelve `VAULT_UNAVAILABLE` con `details.path` = la ruta configurada (ya está en claro en `profiles.json`).
      - `src/main/window.ts`: `frame: false` (§15.6), `additionalArguments` calculados con `settings.json` cada vez que se crea una ventana (§15.4), `replaceMainWindow()` de §13.3 (pasos 1–5), `setContentProtection(true)` al desbloquear si `prefs.contentProtection` (D15) y al cambiar la preferencia; evento `window:state`.
      - `src/main/protocol/vault-protocol.ts` (primera versión): solo `vault://avatar/<profileId>?rev=` y `vault://avatar/pending/<token>`, sin desbloqueo, con las cabeceras de §11.3 y `X-Galeria-Error`.
      - `src/main/index.ts`: limpieza de arranque (1.7, 1.9), `SessionManager`, handlers y `GALERIA_TEST_FAST_KDF` (solo sin empaquetar).
      Archivos: los enumerados; `tests/unit/main/{register,schemas,vault-protocol-avatar}.test.ts`.
      Verificación: `npm.cmd test -- tests/unit/main` en verde: emisor de otra ventana u origen → `VALIDATION`; clave extra en el payload → `VALIDATION` con `details.path`; canal "U" bloqueado → `LOCKED`; excepción no controlada → `INTERNAL` sin `message`; `text()` convierte `"  A\u0301lbum "` en `"Álbum"` y `rawPath()` deja intactos `"a\u0301.jpg"` y `"foto.jpg "`; avatar inexistente → 404.

- [ ] 1.11. Base del renderer `[H3-10]`.
      Qué: `lib/ipc.ts` (envoltorio tipado de `window.galeria`), `lib/vault-url.ts`, `lib/format.ts` (tamaños, duraciones y fechas en español), `lib/keyboard.ts`, `lib/focus.ts`, **`lib/errors-es.ts`** `[H3-10]` (mensaje en español para cada `ErrorCode`); stores `session-store.ts`, `nav-store.ts`, `theme-store.ts`; componentes base sobre Radix (`Button`, `IconButton`, `Dialog`, `ConfirmDialog`, `Menu`, `Tile`, `Avatar`, `Slider`, `TextField`, `PasswordField`, `Toast`, `LiveRegion`) con foco visible y `aria-*` de §14.1; `<MotionConfig reducedMotion="user">` en la raíz.
      Archivos: `src/renderer/src/lib/*.ts`, `src/renderer/src/stores/{session,nav,theme}-store.ts`, `src/renderer/src/components/*.tsx`, `tests/unit/renderer/errors-es.test.ts`.
      Verificación: `npm.cmd test -- tests/unit/renderer` (cada uno de los 20 códigos tiene un mensaje no vacío; un código desconocido da un mensaje genérico); `npm.cmd run lint` sin avisos de jsx-a11y.

- [ ] 1.12. Sistema de temas con `fotos` completo y stub de `ps3` (§15) `[H3-10]`.
      Qué: `themes/registry.ts` (`ThemeDefinition` de §15.1), `themes/build-css.ts` (reglas `[data-theme][data-scheme]` con los tokens `--g-*` de §15.3), `themes/ThemeProvider.tsx` (`adoptedStyleSheets`; `applyTheme` con `document.startViewTransition` y 200 ms, inmediato con movimiento reducido), `themes/contrast.ts`, `themes/tokens/fotos.ts` (claro y oscuro) y `themes/tokens/ps3.ts` (stub oscuro), `themes/shells/SidebarShell.tsx` y `themes/shells/XmbShell.tsx` (stub navegable con ←/→ y ↑/↓), `themes/backgrounds/MicaBackground.tsx` y `WavesBackground.tsx` (stub: canvas 2D, 30 fps, estático con movimiento reducido), **`themes/BackgroundHost.tsx`** `[H3-10]` (prop `paused` de §15.7), `themes/titlebars/Titlebar.tsx` (variantes `fluent` y `xmb`; el resto en F6), `styles/fonts.css` (Inter y Nunito de `@fontsource-variable`), `styles/themes.css` (solo `fotos`), `styles/base.css` con `@theme inline` sobre `--g-*`. El preload pone `data-theme` y `data-scheme` en `DOMContentLoaded` a partir de `--galeria-theme`/`--galeria-scheme`. Persistencia de §15.9 (global y por perfil).
      Archivos: los enumerados; `src/preload/index.ts`; `tests/unit/renderer/{theme-contrast,build-css}.test.ts`.
      Verificación: `npm.cmd test -- tests/unit/renderer` en verde: contraste AA de §15.11 para `fotos` claro y oscuro y `ps3` oscuro (con `surface-alpha` compuesto sobre los dos `bgExtremes`); `build-css` genera una regla por tema y esquema admitidos.

- [ ] 1.13. Pantallas de perfiles, shell y Ajustes iniciales (§14.2–§14.5, §14.9).
      Qué:
      - `assets/avatars/*.svg`: 12 ilustraciones propias (`aurora` … `sol`), sin parecido con marcas.
      - `screens/profiles/`: `ProfilePicker` (estructura de §14.2: "¿Quién eres?", avatares de 160/120 px, "Añadir perfil", "Administrar perfiles", botón de paleta del tema global; roving tabindex; animaciones de entrada, respiración, hover/foco y layout compartido hacia el desbloqueo; con movimiento reducido solo el anillo; insignia "Disco no conectado"; bienvenida sin perfiles), `UnlockDialog` (§14.3; `VAULT_UNAVAILABLE` muestra la ruta de `details.path` y "Reintentar"; "Buscar la bóveda…" llega en 2.11), `ManageProfiles`, `ProfileForm` (aviso de no recuperación y casilla obligatoria, "Preparando tu bóveda…"), `ChangePasswordDialog` (con la nota de §6.6), `DeleteProfileDialog` (contraseña + nombre; foco inicial en "Cancelar"; si `leftoverPath` no es `null`, muestra la ruta seleccionable). Variantes del selector `fluent` y `xmb-row` (D9).
      - Shell tras desbloquear: `SidebarShell`/`XmbShell` con el `NavModel` de §14.5; la entrada Galería muestra "Tu bóveda está lista. La importación llega en la siguiente fase."; candado en la barra de título y `Ctrl+L`; enlace "Saltar al contenido"; foco al `<h1>` en cada cambio de pantalla.
      - `screens/settings/`: `SettingsScreen` con las pestañas Apariencia (`ThemePicker` + `ThemePreview`, esquema, "Aplicar a: solo mi perfil / toda la app") y Seguridad (bloqueo por inactividad, texto por plataforma de §14.9, interruptor de D15, "Cambiar contraseña").
      - El renderer envía `session:activity` como mucho cada 10 s y pinta el velo opaco al recibir `session:locking`.
      Archivos: los enumerados en `src/renderer/src/`.
      Verificación: `npm.cmd run typecheck` y `npm.cmd run lint` en verde; recorrido E2E de 1.14.

- [ ] 1.14. E2E de perfiles, bloqueo, instancia única y temas.
      Qué: `tests/e2e/helpers/launch.ts` añade `GALERIA_TEST_FAST_KDF=1` por defecto, `lockAndGetNewWindow()` (espera la ventana nueva con `electronApp.waitForEvent('window')`) y `createProfile(page, nombre, contraseña)`. Specs:
      - `profiles.spec.ts`: crear perfil (no se habilita "Crear perfil" sin la casilla de no recuperación ni con contraseñas distintas; el aviso es visible); desbloquear con contraseña incorrecta ("Contraseña incorrecta", texto seleccionado) y correcta; editar el nombre exige contraseña; cambiar la contraseña (la antigua falla, la nueva funciona); borrar exige contraseña y nombre, y la carpeta `vaults/<id>` desaparece; no hay ningún "¿Olvidaste tu contraseña?"; navegación del selector solo con teclado.
      - `lock.spec.ts`: `Ctrl+L` vuelve al selector en una ventana nueva; `oldPid !== newPid` y `process.kill(oldPid, 0)` lanza `ESRCH` antes de 5 s (R20; si falla, plan B de §13.3 y se anota en "Notas sobre el diseño"); `powerMonitor.emit('suspend')` bloquea con `__galeriaLastZeroizeMs ≤ 200`; tras bloquear, `vault://avatar` sigue respondiendo y cualquier canal "U" devuelve `LOCKED`.
      - `single-instance.spec.ts`: dos instancias con distinto `GALERIA_DATA_DIR` arrancan las dos; con el mismo, la segunda sale con código 0 en menos de 5 s y la primera recibe `second-instance`.
      - `themes-basic.spec.ts`: cambiar de "Clásico" a "Ondas" en Ajustes cambia `data-theme` sin recargar, conserva la pantalla actual y el foco; la elección global se mantiene tras bloquear (ventana nueva con el tema nuevo).
      Archivos: `tests/e2e/helpers/launch.ts`, `tests/e2e/{profiles,lock,single-instance,themes-basic}.spec.ts`.
      Verificación: `npm.cmd run test:e2e` en verde (incluye el humo de la Fase 0).

### Criterios de aceptación

- Todos los tests de crypto de 1.3 y 1.4 pasan, incluidos los obligatorios del brief: ida y vuelta, contraseña incorrecta, chunk manipulado, chunks reordenados, truncado, lecturas aleatorias por rango, cabecera manipulada, archivo vacío, múltiplos exactos de 64 KiB y chunk de otro archivo.
- La DB está cifrada (los 4 puntos de §9.1) y el test lento de Argon2 pasa con `GALERIA_SLOW_TESTS=1`.
- Crear, desbloquear, bloquear (manual, inactividad, suspensión, bloqueo del SO), cambiar la contraseña, editar y borrar funcionan; borrar sin la contraseña es imposible por cualquier ruta.
- `profiles:delete` devuelve `{ leftoverPath }` y `VAULT_UNAVAILABLE` lleva `details.path` `[H3-8]`; `getDb(epoch)` y `drained()` están en `SessionManager` `[H3-6]`.
- Al bloquear se crea un proceso de renderer nuevo y las claves quedan a cero en ≤ 200 ms con `suspend`.
- Los temas `fotos` y `ps3` (stub) cambian en vivo y cumplen el contraste AA.

### Cómo verificar

VC completa más `$env:GALERIA_SLOW_TESTS = '1'; npm.cmd test -- tests/unit/crypto; Remove-Item Env:GALERIA_SLOW_TESTS`. Revisión visual con `npm.cmd run dev`: selector en "Clásico" y en "Ondas", animaciones con y sin movimiento reducido (Windows: Configuración → Accesibilidad → Efectos visuales → Efectos de animación).

### Riesgos

- R5 (`db.key(Buffer)`): resuelto o derivado al plan B en el spike; 1.6 lo confirma.
- R20 (proceso de renderer reutilizado): `lock.spec.ts` lo comprueba con el plan B preparado.
- Calibración de Argon2 en equipos lentos: la UI muestra "Preparando tu bóveda…" hasta 4 s.
- Ventana sin marco (R8): sin el menú de snap layouts de Windows 11; Win+flechas sigue funcionando.
- `document.startViewTransition` en el Chromium de Electron 44: si no existiera, `applyTheme` cambia sin transición (mismo código que con movimiento reducido).

### Qué puede probar el usuario al final de la fase

Con `npm.cmd run dev`: crear uno o varios perfiles (con el aviso de que no hay recuperación), ver el selector estilo Netflix, desbloquear, equivocarse de contraseña, bloquear con `Ctrl+L` o suspendiendo el equipo, dejar que se bloquee por inactividad (Ajustes → Seguridad → 1 min), cambiar la contraseña, editar el nombre o el avatar (incluida una foto, con su aviso), borrar un perfil y cambiar entre los temas "Clásico" y "Ondas".

---

## Fase 2 — ffmpeg, importación segura y galería

### Objetivo

Empaquetado de ffmpeg/ffprobe con su licencia, pipeline de importación seguro de §12 (el original solo se borra tras verificar, renombrar y confirmar), protocolo `vault://media|thumb` con Range, galería virtualizada con búsqueda, filtros, orden, selección, renombrar y borrar, reconciliación, traslado de la bóveda y Ayuda con los límites.

### Dependencias

Fase 1 terminada. Confirmación del usuario sobre D18 para importaciones (si no la hay, se implementa la recomendación con `IMPORT_PAUSES_AUTOLOCK = true`). La descarga de ffmpeg (2.1) necesita red una vez, como herramienta de desarrollo (§19.3); la app sigue sin red.

### Tareas

- [ ] 2.1. ffmpeg/ffprobe: empaquetado por plataforma y licencia (§19) `[H3-9]` `[H3-11]`.
      Qué:
      - `resources/ffmpeg/manifest.json`: los dos artefactos de §19.2 (BtbN `lgpl-shared` 8.1.3, tag `autobuild-2026-10-22-13-06`) con sus SHA-256 y los dos paquetes de código fuente (FFmpeg en el commit completo de `5c4f5744cd`, que esta tarea resuelve, y los scripts de BtbN del tag), con SHA-256 vacío hasta `--record-sources`.
      - `scripts/fetch-ffmpeg.mjs` (`--platform win|linux`, `--record-sources`, `GALERIA_FFMPEG_ARCHIVE_DIR`, caché en `.cache/ffmpeg/`): pasos 1–7 de §19.3, más `[H3-9]`: ejecuta `ffmpeg -hide_banner -L` y `ffmpeg -version`, guarda en `BUILDINFO.json` la licencia detectada y la línea `configuration:`, **falla si aparece `--enable-gpl` o `--enable-nonfree`**, y copia a `resources/licenses/ffmpeg/` el texto que corresponda, sacado del paquete de código fuente (`COPYING.LGPLv2.1`, o `COPYING.LGPLv3` + `COPYING.GPLv3` si la configuración trae `--enable-version3`). Script npm `fetch:ffmpeg`.
      - `src/main/media/ffmpeg.ts` (§19.4): resolución de binarios (empaquetado y desarrollo), `ffmpegAvailable` con `fs.access(X_OK)`, `spawn` con `windowsHide`, `stdio` de §19.4, `signal`, entorno mínimo (`SystemRoot`; `LD_LIBRARY_PATH` en Linux), timeouts, constructores de argumentos que siempre fijan `pipe:1`, `-f <demuxer>` antes de cada `-i` y `-protocol_whitelist`; parser de `-progress`. `[H3-11]`: al arrancar ejecuta una vez `ffmpeg -hide_banner -decoders` y guarda el conjunto de decodificadores de vídeo. `AppInfo.ffmpegAvailable` pasa a ser real.
      - Implicaciones que quedan fijadas: build LGPL compartido (D4), sin codificador H.264 por software, así que las conversiones y fusiones salen en VP9 + Opus dentro de MP4 fragmentado (§18.4); la decodificación de H.264/HEVC la hace FFmpeg (LGPL). Los binarios de Linux solo se pueden verificar en Linux (paso 5 de §19.3): en Windows se descarga y comprueba el SHA-256 de los dos, pero la ejecución de los de Linux queda para 7.4.
      Archivos: `resources/ffmpeg/manifest.json`, `scripts/fetch-ffmpeg.mjs`, `src/main/media/ffmpeg.ts`, `src/main/ipc/handlers/app.ts`, `package.json`, `tests/unit/main/ffmpeg.test.ts`.
      Verificación: `npm.cmd run fetch:ffmpeg -- --record-sources` termina con código 0 y deja `resources/ffmpeg/win-x64/bin/{ffmpeg,ffprobe}.exe`, `BUILDINFO.json` con la licencia y `resources/licenses/ffmpeg/` con el texto que corresponde; una segunda ejecución verifica los SHA-256 sin red (con la caché); `npm.cmd test -- tests/unit/main/ffmpeg.test.ts` (ningún constructor admite una ruta de salida; siempre llevan `-protocol_whitelist` y `-f`; parser de progreso; parser de `-decoders`); el E2E de humo ahora espera `ffmpegAvailable: true` si existen los binarios.

- [ ] 2.2. Range y servidor loopback (§11.2, §18.5).
      Qué: `src/main/protocol/range.ts` (puro) y `src/main/media/loopback-server.ts` (`127.0.0.1`, puerto aleatorio, token de 32 bytes con `timingSafeEqual`, comprobación de `Host`, GET/HEAD, refs registradas, límites de §18.5, cierre con `close()` + `closeAllConnections()` al terminar, cancelar o bloquear).
      Archivos: los dos módulos; `tests/unit/main/{range,loopback-server}.test.ts`.
      Verificación: `npm.cmd test -- tests/unit/main/range.test.ts tests/unit/main/loopback-server.test.ts`: todas las formas de §11.2 (`bytes=a-b`, `a-`, `-n`, varios rangos → 200, `a > b` → 200, `P = 0` → 416, `a ≥ P` → 416, `bytes=-0` → 416, `-n` con `n > P`, `b ≥ P` recortado, `HEAD` con Range → 206 sin cuerpo); loopback con token incorrecto, `Host` distinto o ref desconocida → 404 y socket cerrado; Range sobre un objeto cifrado devuelve los bytes exactos; tras abortar no acepta conexiones.

- [ ] 2.3. Object store, `inFlight` y `vault://media|thumb` (§11).
      Qué: `src/main/vault/object-store.ts` (rutas por id, nunca reabre un objeto para escribir, borrado criptográfico de §12.10), `src/main/vault/in-flight.ts`, y en `vault-protocol.ts` los hosts `media` y `thumb` con validación, búsqueda de fila `ready`, Range, cabeceras de §11.3 (CORS con el origen del renderer), errores de §11.4 (423 desde `locking`, 503 `BUSY` en `maintenance`, 500 `INTEGRITY`) y `controller.error()` de los streams abiertos al bloquear (§11.5).
      Archivos: los tres módulos; `tests/unit/main/{object-store,vault-protocol}.test.ts`.
      Verificación: `npm.cmd test -- tests/unit/main/object-store.test.ts tests/unit/main/vault-protocol.test.ts` con requests simulados: 200 y 206 con los bytes exactos; id con formato inválido → 400; id inexistente → 404; bloqueado → 423; `maintenance` → 503 `BUSY`; objeto manipulado → 500 `INTEGRITY`; tras el borrado criptográfico los 108 primeros bytes ya no son la cabecera y el archivo desaparece.

- [ ] 2.4. Módulos puros de importación y comparación de rutas `[H3-3]` `[H3-11]`.
      Qué:
      - `sniff.ts` completo (§12.3): filas de vídeo (MP4, MOV `qt  `, WebM/MKV por DocType, AVI), RAW (CR2/NEF/ARW/DNG/ORF/RAF/RW2) y **`[H3-11]` CR3: brand `crx ` en la fila de rechazo HEIC/RAW/BMP, evaluada antes que la fila MP4**.
      - `walk.ts` (recursivo, sin seguir enlaces, 32 niveles, 100 000 archivos), `naming.ts` (§12.4.1), `capture-date.ts` (§12.8).
      - **`path-guard.ts` (P8) `[H3-3]`, protección contra pérdida de datos**: las rutas de `import:paths` se usan exactamente como las devuelve `webUtils.getPathForFile` (sin NFC ni `trim`; esquema `rawPath()` de 1.10). `isInsideProtectedRoot(p, roots)`: compara `await fs.realpath.native(p)` con el `realpath` de `GaleriaData` y de cada `vaultDir` conocido; en `win32`, ambos en minúsculas después de `path.win32.normalize`; pertenencia por segmentos (`rel = path.relative(root, p)`, dentro si `rel === ''` o si `!rel.startsWith('..') && !path.isAbsolute(rel)`); si `realpath` falla, el candidato es `skipped`. Rechaza también las rutas de dispositivo (`\\.\`, `\\?\GLOBALROOT`).
      Archivos: `src/main/import/{sniff,walk,naming,capture-date,path-guard}.ts`; `tests/unit/main/{sniff,walk,naming,capture-date,path-guard}.test.ts`.
      Verificación: `npm.cmd test -- tests/unit/main/sniff.test.ts tests/unit/main/walk.test.ts tests/unit/main/naming.test.ts tests/unit/main/capture-date.test.ts tests/unit/main/path-guard.test.ts`:
      - `sniff`: cada firma; `ftypcrx ` → rechazo RAW `[H3-11]`; contenedor sin pista de vídeo tratado como "cualquier otra" (con el resultado de ffprobe simulado);
      - `walk`: omite enlaces simbólicos y junctions;
      - `naming`: los 6 casos de §12.4.1;
      - `capture-date` (con `process.env.TZ = 'Europe/Madrid'` al principio del archivo): los casos de §12.8, incluida la hora inexistente `"2026:03:29 02:30:00"`;
      - `path-guard` `[H3-3]`: una ruta dentro de `GaleriaData` con otras mayúsculas queda dentro en `win32` (`skipIf` en Linux); `GaleriaData2` junto a `GaleriaData` no queda dentro (segmentos, no prefijos); un enlace hacia la bóveda se resuelve con `realpath` y queda dentro; `realpath` que falla → `skipped`; `rawPath()` conserva NFD y espacios finales.

- [ ] 2.5. Repositorio de medios, eventos agrupados y canales de medios `[H3-4]`.
      Qué: `src/main/db/repos/media-repo.ts` (insertar `pending`, marcar `ready`, `list(query)` con el orden total de §9.2 y el orden por nombre con `Intl.Collator('es', { numeric: true, sensitivity: 'base' })` en JS, búsqueda con `name_fold` y escape de `%`, `_` y `\`, `get`, `rename`); borrado de §12.10 con **`[H3-4]` un único parámetro JSON**: `SELECT id, thumb_id FROM media WHERE id IN (SELECT value FROM json_each(?))` y `DELETE FROM media WHERE id IN (SELECT value FROM json_each(?))` con `JSON.stringify(ids)` en la misma transacción, y después el borrado criptográfico de los objetos. `src/main/ipc/library-events.ts` (§10.2). Handlers `media:list`, `media:get`, `media:rename`, `media:delete`.
      Archivos: `src/main/db/repos/media-repo.ts`, `src/main/ipc/library-events.ts`, `src/main/ipc/handlers/media.ts`, `src/main/ipc/schemas.ts`, `src/shared/ipc-contract.ts`; `tests/unit/main/{media-repo,library-events}.test.ts`.
      Verificación: `npm.cmd test -- tests/unit/main/media-repo.test.ts tests/unit/main/library-events.test.ts`: filtros, orden con empates y `NULL` de duración al final en los dos sentidos, búsqueda con pliegue de acentos, orden natural por nombre; **`[H3-4]` borrar 40 000 filas en una sola llamada funciona** (con `IN (?, ?, …)` daría `too many SQL variables` por encima de 32 766); reloj falso: 1000 confirmaciones en 3 s producen ≤ 5 eventos `import` y el último llega después de la última confirmación.

- [ ] 2.6. Borrado del original y limpiezas de Linux (§12.4 pasos 8–9, §12.9, §12.9.1).
      Qué: `secure-delete.ts` (`O_RDWR | O_NOFOLLOW` en Linux, `fstat` sobre el descriptor con `bigint`, comparación exacta con el `snapshot`, ceros en bloques de 1 MiB, `fsync`, `ftruncate(0)`, `fsync`, `unlink`; con `nlink > 1` solo `unlink` y `warn`; sin permiso de escritura, `lstat` + `unlink`), `linux-thumbnails.ts` (URI con la regla de `g_filename_to_uri`, MD5, borrado en `normal/large/x-large/xx-large` y `fail/*` de las dos bases) y `linux-recent.ts` (§12.9.1, agrupado por trabajo).
      Archivos: `src/main/import/{secure-delete,linux-thumbnails,linux-recent}.ts`; `tests/unit/main/{secure-delete,linux-thumbnails,linux-recent}.test.ts`.
      Verificación: `npm.cmd test -- tests/unit/main/secure-delete.test.ts tests/unit/main/linux-thumbnails.test.ts tests/unit/main/linux-recent.test.ts`: con `fs.link`, el segundo nombre conserva su SHA-256; un original modificado después del escaneo no se toca (`CHANGED_DURING_IMPORT`); vector del spec `file:///home/jens/photos/me.png` → `c6ee772d9e49320e97ec29a7eb5b1697`; vectores de GLib para nombres con `; # ? % [ ] & = + , ' ! $ ~ @`, espacio y `á`, generados en el PC Linux del usuario con `python3 -c "import sys; from gi.repository import GLib; print(GLib.filename_to_uri(sys.argv[1], None))"` (en esta máquina Windows no hay WSL2, así que en F2 esos vectores quedan como `it.todo` y se fijan en 7.4 con el script de Linux); `recently-used.xbel` pierde solo los `<bookmark>` borrados y conserva el resto byte a byte.

- [ ] 2.7. Pipelines de foto y vídeo y miniaturas (§12.4 pasos 0–4, §12.5) `[H3-11]`.
      Qué: `image-pipeline.ts` (lectura a buffer, `exifr.parse` con las opciones de §12.4 y `reviveValues: false`, EXIF saneado, miniatura con `getSharp()`), `video-pipeline.ts` (ffprobe con demuxer forzado y salida validada con zod, dimensiones con rotación, tabla de acciones de §12.5 por `codec_name`, **sin comprobación de `pix_fmt`** porque v3-1 está descartado; `[H3-11]`: si la primera pista de vídeo no tiene `codec_name` o FFmpeg no tiene decodificador para él (conjunto de 2.1), `UNSUPPORTED_FORMAT` sin pasar por D8; comando de §12.5 hacia `pipe:1`; progreso), `src/main/media/thumbnails.ts` (foto con sharp; vídeo con el fotograma en `t = min(1 s, 10 %)` leído del objeto temporal por loopback y reintento en `t = 0`).
      Archivos: `src/main/import/{image-pipeline,video-pipeline}.ts`, `src/main/media/thumbnails.ts`; `tests/unit/main/{image-pipeline,video-pipeline,thumbnails}.test.ts`.
      Verificación: `npm.cmd test -- tests/unit/main/image-pipeline.test.ts tests/unit/main/video-pipeline.test.ts tests/unit/main/thumbnails.test.ts`: la decisión de acción para cada fila de la tabla con JSON de ffprobe de ejemplo; pista sin `codec_name` y códec sin decodificador → `UNSUPPORTED_FORMAT` y fuera de `toConvert` `[H3-11]`; rotación ±90° intercambia ancho y alto; miniaturas de foto (incluido AVIF, R14) y de vídeo (desde el `.part` cifrado, sin escribir nada en claro).

- [ ] 2.8. Generador de fixtures (P12, §23.2).
      Qué: `tests/fixtures/generate.mjs` escribe en `tests/.tmp/fixtures/` (si ya existen, no regenera): JPEG con EXIF `DateTimeOriginal`, orientación 6 y un marcador aleatorio de 32 bytes en EXIF y en el nombre; PNG, WebP, GIF animado, AVIF; un BMP de 24 bits escrito a mano (solo para el rechazo); un `.CR3` falso con cabecera `ftypcrx `; con el ffmpeg empaquetado (`testsrc2` + `sine`): MP4 VP9/Opus, WebM VP9/Opus, MKV VP9 + Opus, MKV VP9 + FLAC, MOV mpeg4 (convertir), AVI y un MP4 de ≥ 1 GiB (`-stream_loop -1 -c copy -fs 1G`, solo con `GALERIA_SLOW_TESTS=1`). H.264: en Windows se intenta `-c:v h264_mf` y en Linux el `ffmpeg` de la distro si trae libx264, solo como herramienta de test; si no hay codificador, esos tests se marcan `skip` (§23.2). `playwright.config.ts` añade `globalSetup: './tests/e2e/global-setup.ts'`, que llama al generador.
      Archivos: `tests/fixtures/generate.mjs`, `tests/e2e/global-setup.ts`, `playwright.config.ts`.
      Verificación: `node tests/fixtures/generate.mjs` termina con código 0 y crea los archivos; una segunda ejecución no regenera nada.

- [ ] 2.9. Servicio de importación, canales e integración con la sesión `[H3-3]` `[H3-6]` (D18 pendiente).
      Qué: `src/main/import/import-service.ts` con un trabajo `import` en `JobRegistry` (12.11): escaneo y validación (§12.3, con `path-guard`), preescaneo de vídeos y `awaiting-confirmation` (§12.5.1), pasos 0–9 de §12.4, duplicados de §12.7 (incluida la sustitución en dos transacciones), cancelación y bloqueo. `[H3-6]`: el trabajo usa `getDb(handle.epoch)`; después de un abort no toca `objects/` ni `thumbs/`: los borrados de la rama de fallo se encargan a `KeylessCleanup`. **D18 (pendiente de confirmar)**: `IMPORT_PAUSES_AUTOLOCK = true` llama a `setPausesAutoLock(true)` fuera de `awaiting-confirmation`. Handlers `import:chooseFiles`, `import:chooseFolder`, `import:paths` (esquema `rawPath()` `[H3-3]`), `import:confirm`, `import:cancel`, eventos `import:progress`, `import:done`, `import:confirmNeeded`. El preload completa `importDropped` (§12.2: `instanceof File`, `webUtils.getPathForFile`, descarta vacías) y `import:paths` sigue fuera de `INVOKE_CHANNELS`. Todos los diálogos llevan `dontAddToRecent`.
      Archivos: `src/main/import/import-service.ts`, `src/main/ipc/handlers/import.ts`, `src/main/ipc/schemas.ts`, `src/shared/ipc-contract.ts`, `src/preload/index.ts`; `tests/unit/main/{import-service,import-paths,no-temp-leak}.test.ts`.
      Verificación: `npm.cmd test -- tests/unit/main/import-service.test.ts tests/unit/main/import-paths.test.ts tests/unit/main/no-temp-leak.test.ts`:
      - fallo inyectado en cada paso 0–7 (incluido entre los dos renombrados del paso 6) → el original sigue con el mismo SHA-256;
      - original modificado entre escaneo y proceso → `CHANGED_DURING_IMPORT`, intacto;
      - duplicado `ready` sano → `duplicates` y original borrado; duplicado `pending` → `skipped`; `UNIQUE` en el paso 5 → `skipped`; objeto dañado + reimportación conserva nombre, fecha de importación, ediciones y posición en dos playlists, también con una caída simulada entre A y B;
      - reimportar un MKV remultiplexado → `duplicates`; BMP, HEIC, RAW y CR3 → `UNSUPPORTED_FORMAT` con el original intacto;
      - D8: `convert: false` omite los vídeos a recodificar; `import:cancel` en `awaiting-confirmation` no toca nada; segunda importación → `BUSY` antes del diálogo;
      - reloj falso: sin bloqueo por inactividad en `scanning`/`encrypting` tras 10 min (D18); en `awaiting-confirmation` bloquea a los `autoLockMinutes` y cancela sin tocar nada;
      - **`[H3-6]`** `lock('suspend')` entre los dos renombrados del paso 6 y desbloqueo inmediato: el trabajo antiguo no ejecuta ninguna sentencia sobre la DB nueva (espía en la DB) y sus borrados pasan por `KeylessCleanup`;
      - **`[H3-3]` (`import-paths.test.ts`)**: en una carpeta con `a\u0301.jpg` (NFD) y `á.jpg` (NFC), soltar solo el NFD importa y borra solo ese, y el NFC conserva su SHA-256 (Windows y Linux, NTFS no normaliza); `foto.jpg ` (espacio final) junto a `foto.jpg`: solo se toca el soltado (`skipIf(win32)`, Win32 no permite crear ese nombre por la vía normal); en Windows, la ruta del avatar `GaleriaData\avatars\<id>.webp` escrita con otras mayúsculas queda `skipped` y el avatar no se borra;
      - `no-temp-leak` (§12.4, en un proceso hijo con `TMP`/`TEMP`/`TMPDIR` vigilados y control positivo): miniatura de JPEG 8000×6000 con orientación 6, PNG entrelazado de 16 bits 6000×6000, GIF animado de 40 fotogramas 2000×2000 y AVIF 6000×4000, y avatar: el directorio sigue vacío. F3 añade `edits-render`.

- [ ] 2.10. Reconciliación al desbloquear (§12.6) `[H3-7]`.
      Qué: `src/main/vault/reconcile.ts` con los puntos 1, 2, 3, 4, 6 y 7 de §12.6 (el 5, música, llega en 4.2), enganchado al paso 6 del desbloqueo. Punto 3 con **`[H3-7]` (P9)**: `readdir` de los 256 directorios `thumbs/<aa>/` en un `Set` y comparación con `SELECT thumb_id FROM media WHERE state = 'ready' AND thumb_id IS NOT NULL`, en lugar de un `stat` por miniatura. Cola de regeneración en segundo plano y barrido de huérfanos (1 directorio cada 50 ms, respetando `inFlight` y reconsultando la DB antes de cada borrado), los dos registrados en el `AbortController` de la sesión.
      Archivos: `src/main/vault/reconcile.ts`, `src/main/session/session-manager.ts`; `tests/unit/main/reconcile.test.ts`.
      Verificación: `npm.cmd test -- tests/unit/main/reconcile.test.ts`: `pending` con objeto final → `ready`; con `.part` que verifica → renombrado; con `.part` que no verifica → borrado criptográfico, fila borrada y `warn`; miniatura `.part` que verifica → renombrada; `import.replace.*` terminado o deshecho según exista `newId`, con valor inválido conservado y `error`; **`[H3-7]` con 1000 filas y 37 miniaturas ausentes se detectan exactamente esas 37, con como mucho 256 `readdir` y ningún `stat` por miniatura (espía en `fs`)**; el barrido no borra un id de `inFlight` ni uno que la DB referencia en el último momento.

- [ ] 2.11. Traslado de la bóveda, disco ausente y "Buscar la bóveda…" (§8.7) `[H3-8]`.
      Qué: `src/main/vault/relocate.ts` (pasos 1–8, subestado `maintenance`, cancelación, bloqueo en cada tramo con `KeylessCleanup`, `pendingCleanup`); handlers `vault:getInfo`, `vault:relocate`, `vault:relocateCancel`, `vault:locate` (este con `VAULT_UNAVAILABLE` + `details.path` si la carpeta elegida no es la bóveda `[H3-8]`) y eventos `relocate:progress`/`relocate:done`. UI: Ajustes → Almacenamiento (ubicación, tamaño, espacio libre, "Mover bóveda…", "Volver a la ubicación predeterminada", diálogo de progreso no descartable) y el botón "Buscar la bóveda…" en `UnlockDialog`. `[H3-8]` en textos y tipos: el renderer nunca construye ni envía rutas; solo ve la ubicación de la bóveda (§14.3, §14.9) y las rutas de originales no borrados (§14.6).
      Archivos: `src/main/vault/relocate.ts`, `src/main/ipc/handlers/vault.ts`, `src/main/ipc/schemas.ts`, `src/shared/ipc-contract.ts`, `src/renderer/src/screens/settings/SettingsScreen.tsx`, `src/renderer/src/screens/profiles/UnlockDialog.tsx`; `tests/unit/main/relocate.test.ts`.
      Verificación: `npm.cmd test -- tests/unit/main/relocate.test.ts`: copia verificada por SHA-256; cancelar antes del paso 5 deja todo como estaba; caída simulada en cada tramo deja la bóveda antigua o la nueva referenciada, nunca ninguna; con un `removeVaultDir` falso que no termina + bloqueo después del paso 6, las claves quedan a cero antes de que termine; trabajo activo → `BUSY`; `vault:locate` con una carpeta de otro perfil → `VAULT_UNAVAILABLE` con `details.path`.

- [ ] 2.12. Galería, importación en la UI y Ayuda (§14.6, §14.10).
      Qué: stores `library-store.ts`, `selection-store.ts` (reductor puro: clic, Ctrl, Shift con ancla, `Ctrl+A`, Esc, intersección al cambiar la consulta), `import-store.ts`; `screens/gallery/`: `GalleryScreen`, `GalleryGrid` (TanStack Virtual por filas, cabeceras de mes solo al ordenar por fecha, tamaños 120/180/260, `role="grid"` con `aria-*` y roving tabindex, atajos y menú contextual de §14.6), `CommandBar` (búsqueda con debounce de 200 ms, filtros, orden guardado en `prefs.gallerySort`, tamaño, "Importar"), `FilterBar` (tipo, fechas, playlist, chips), `SelectionBar` (Presentación y Vídeo dual deshabilitados hasta F4/F5 con el tooltip "Disponible próximamente"), `ImportDropZone`, `ImportProgress` (panel no modal, `AlertDialog` de D8 con foco en "Omitir esos vídeos", resumen con las rutas no borradas seleccionables), `RenameDialog`, confirmación de borrado con foco en "Cancelar"; atajos globales de §14.1. `screens/help/HelpScreen.tsx`: los 13 límites de §24.2 en orden, con el límite 10 según D18, **más la línea del riesgo aceptado v3-1: "Algunos vídeos de cámara (H.264 de 10 bits o 4:2:2/4:4:4) podrían no reproducirse en Galería después de importarlos."**, y la tabla de atajos; se abre con F1.
      Archivos: los enumerados en `src/renderer/src/`; `tests/unit/renderer/selection-store.test.ts`.
      Verificación: `npm.cmd test -- tests/unit/renderer/selection-store.test.ts` (rango con Shift determinista sobre el orden total; `Ctrl+A`; intersección); `npm.cmd run lint` sin avisos de jsx-a11y.

- [ ] 2.13. E2E de importación, galería y bóveda.
      Qué: diálogos nativos simulados con `electronApp.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, paths)`; cada test copia los fixtures a una carpeta de origen propia antes de importar. Specs:
      - `import.spec.ts`: importar archivos y una carpeta → aparecen en la galería con miniatura y los originales ya no existen; BMP y CR3 quedan en `failed` con su original intacto; un MOV mpeg4 pide confirmación D8 y "Omitir esos vídeos" lo conserva; **ningún archivo bajo la raíz de datos de prueba (salvo `music/`) contiene los primeros 64 bytes de ningún fixture ni el marcador de 32 bytes** (§22).
      - `gallery.spec.ts`: búsqueda con acentos, filtros de tipo y fecha, los 5 órdenes, selección con Ctrl, Shift, `Ctrl+A` y teclado, renombrar con F2, borrar con Supr y confirmación (los objetos desaparecen del disco).
      - `playback-fmp4.spec.ts` (§18.4, versión F2): un vídeo convertido (MOV mpeg4 → MP4 fragmentado VP9) se reproduce en `<video>` con `duration` finita igual a la de origen ± 0,5 s y un `currentTime = 0,75·D` dispara `seeked` en menos de 3 s. Lo mismo con el MKV VP9 + Opus y el MKV VP9 + FLAC remultiplexados. Si falla, este punto de diseño se reabre (R4); no se improvisa.
      - `import-lock.spec.ts` (lento): importar el MP4 de 1 GiB y, a mitad, `powerMonitor.emit('suspend')`: `__galeriaLastZeroizeMs ≤ 200`, el original conserva su SHA-256 y, tras desbloquear, no quedan filas `pending` ni `.part` en `tmp/` y el vídeo no aparece.
      - `relocate.spec.ts`: mover la bóveda a `tests/.tmp/…/destino` y volver a la ubicación predeterminada; la galería sigue igual.
      Archivos: `tests/e2e/{import,gallery,playback-fmp4,import-lock,relocate}.spec.ts`, `tests/e2e/helpers/launch.ts`.
      Verificación: `npm.cmd run test:e2e` en verde y `$env:GALERIA_SLOW_TESTS = '1'; npm.cmd run test:e2e -- tests/e2e/import-lock.spec.ts; Remove-Item Env:GALERIA_SLOW_TESTS` en verde.

- [ ] 2.14. Medición de carga del hilo main (R6).
      Qué: con `perf_hooks.monitorEventLoopDelay()` activo solo con `GALERIA_E2E=1`, importar el MP4 de 1 GiB y 500 fotos y anotar en "Notas sobre el diseño" el p99 y el máximo. Si algún bloqueo supera 100 ms seguidos, el plan B de §3 (mover el cifrado y el hash a un `utilityProcess`) se abre como tarea nueva antes de cerrar la fase.
      Archivos: `src/main/session/session-manager.ts` (gancho de medición), `docs/PLAN.md`.
      Verificación: la cifra queda anotada; si supera 100 ms, existe la tarea nueva.

### Criterios de aceptación

- El original solo se borra en el paso 9, después de verificar, renombrar y confirmar; cualquier fallo anterior lo deja intacto (tests de inyección en cada paso).
- `[H3-3]` las rutas de `import:paths` no se normalizan; los tests NFD, espacio final y mayúsculas en Windows pasan.
- `[H3-4]` borrar 40 000 elementos funciona; `[H3-6]` el trabajo de una sesión no toca la DB de la siguiente; `[H3-7]` la reconciliación no hace un `stat` por miniatura; `[H3-9]` `BUILDINFO.json` declara la licencia y `resources/licenses/ffmpeg/` tiene el texto correcto; `[H3-11]` CR3 y pistas sin códec o sin decodificador → `UNSUPPORTED_FORMAT`.
- Nada descifrado en disco (E2E de §22 y `no-temp-leak`); `vault://` con Range y búsqueda de vídeo funcionando.
- La Ayuda muestra los 13 límites, la línea de v3-1 y los atajos.

### Cómo verificar

VC completa más el E2E lento de 2.13. En Windows con la carpeta Descargas: comprobar a mano que tras importar desde una copia en `Descargas` el archivo desaparece de ahí.

### Riesgos

- R4 (duración y búsqueda del MP4 fragmentado): verificación obligatoria en 2.13; si falla, se reabre el diseño.
- R6 (hilo main): medido en 2.14.
- R9 (BtbN borra los autobuilds): caché en `.cache/ffmpeg/` y `GALERIA_FFMPEG_ARCHIVE_DIR`; recomendado guardar los cuatro archivos fuera de git junto al proyecto.
- R14 (AVIF en el prebuilt de sharp): fixture AVIF en 2.7 y 2.9.
- R16 (temporales de libvips): `no-temp-leak` en Windows; en Linux se repite en 7.4.
- R21 (`-strict experimental` para Opus/FLAC en MP4): si aparece en los fixtures, ese audio pasa a "convertir a Opus" con D8 y se anota aquí.
- v3-1 aceptado: un H.264 de cámara de 10 bits o 4:2:2 puede quedar sin reproducirse; documentado en la Ayuda.
- D18 de importaciones sin confirmar: un solo cambio de constante si el usuario la rechaza.

### Qué puede probar el usuario al final de la fase

Con `npm.cmd run dev`, **usando copias** (el original se borra al importar): importar fotos y vídeos con el botón, con `Ctrl+I`/`Ctrl+Shift+I` o arrastrando archivos y carpetas; ver cómo desaparecen de su carpeta; ver la galería agrupada por mes; buscar, filtrar, ordenar, seleccionar con Ctrl/Shift/`Ctrl+A`, renombrar, borrar; importar dos veces lo mismo (duplicado); mover la bóveda a otra carpeta o a un disco externo y desconectarlo ("Disco no conectado"); leer la Ayuda con F1.

---

## Fase 3 — Visor, edición y reproductor de vídeo

### Objetivo

Visor con animación de apertura desde la miniatura, navegación con flechas, zoom con rueda y arrastre; edición no destructiva (recortar, girar, voltear, revertir) con miniatura regenerada; reproductor con los controles básicos de §16.6, sin subtítulos.

### Dependencias

Fase 2 terminada (medios en la bóveda, `vault://media` con Range, `thumbnails.ts`, `JobRegistry`).

### Tareas

- [ ] 3.1. Modelo de edición (§16.3).
      Qué: `src/shared/edits.ts` con `EditState`, `foldEdits(ops)` según la tabla de §16.3, forma canónica (≤ 3 ops) para listas de más de 64, y el mapeo a sharp (`q2`, región de recorte en píxeles).
      Archivos: `src/shared/edits.ts`, `tests/unit/shared/edits.test.ts`.
      Verificación: `npm.cmd test -- tests/unit/shared/edits.test.ts`: 4 giros = identidad; `flipH`² = identidad; `flipV` = `rotate 2` + `flipH`; composición de recortes; la forma canónica produce el mismo `EditState`.

- [ ] 3.2. Render de ediciones en main (§16.3).
      Qué: `src/main/media/edits-render.ts` con la cadena `autoOrient().flop(flip).rotate(q2·90).extract(...).resize(512, 512, inside).webp(78)` vía `getSharp()` y `{ sequentialRead: true, limitInputPixels: 268402689 }`. Ampliar `no-temp-leak.test.ts` con `edits-render` sobre los mismos fixtures grandes.
      Archivos: `src/main/media/edits-render.ts`, `tests/unit/main/{edits-render,no-temp-leak}.test.ts`.
      Verificación: `npm.cmd test -- tests/unit/main/edits-render.test.ts tests/unit/main/no-temp-leak.test.ts`: imagen asimétrica de 4×2 píxeles en los 8 estados D4 combinados con un recorte, comparada píxel a píxel (salida sin pérdida para el test) con la matriz que calcula `foldEdits`. Si sharp no aplicara el orden documentado, plan B de dos pasadas de §16.3 (PNG sin pérdida en memoria y después `extract` + `resize`).

- [ ] 3.3. Guardar ediciones (§16.5).
      Qué: `src/main/db/repos/edit-repo.ts` y handler `edits:save` con el trabajo `edit` (`BUSY` por `mediaId`), pasos 1–7 de §16.5 (miniatura nueva renombrada antes de la transacción, `thumb_rev += 1`, borrado criptográfico de la antigua tras el `COMMIT`) y la tabla de fallos. La cola de regeneración de 2.10 y la sustitución de duplicados de 2.9 pasan a usar estos mismos pasos 2–6 con las ediciones guardadas.
      Archivos: `src/main/db/repos/edit-repo.ts`, `src/main/ipc/handlers/edits.ts`, `src/main/ipc/schemas.ts`, `src/shared/ipc-contract.ts`, `src/main/vault/reconcile.ts`, `src/main/import/import-service.ts`; `tests/unit/main/edits-save.test.ts`.
      Verificación: `npm.cmd test -- tests/unit/main/edits-save.test.ts`: guardar, revertir (`[]`), `ops` con más de 64 elementos → `VALIDATION`, recorte fuera de rango → `VALIDATION`, vídeo → `VALIDATION`, edición concurrente del mismo medio → `BUSY`, bloqueo a mitad → ediciones intactas y miniatura nueva limpiada por la reconciliación, original que no descifra → `INTEGRITY`.

- [ ] 3.4. Visor y zoom (§16.1, §16.2).
      Qué: `screens/viewer/Viewer.tsx` (FLIP desde el rect del mosaico con `clip-path` y Motion en 280 ms, sustitución por el original tras `img.decode()`, cierre inverso o fundido, ←/→, Home/End, precarga ±1, `I`, `E`, Supr, `F`, Esc; `role="dialog"` con foco devuelto al mosaico), `ZoomPan.tsx`, `zoom-math.ts` (puro), `EditedImage.tsx` (render CSS de §16.3) e `InfoPanel.tsx`.
      Archivos: `src/renderer/src/screens/viewer/{Viewer,ZoomPan,EditedImage,InfoPanel}.tsx`, `src/renderer/src/screens/viewer/zoom-math.ts`; `tests/unit/renderer/zoom-math.test.ts`.
      Verificación: `npm.cmd test -- tests/unit/renderer/zoom-math.test.ts`: escala acotada a [1, 8], zoom centrado en el cursor (el punto bajo el cursor no se mueve), límites del desplazamiento sin hueco en los bordes, doble clic 1 ↔ 2.

- [ ] 3.5. Editor (§16.4).
      Qué: `screens/viewer/Editor.tsx`: recorte con 8 asas, proporciones de §16.4 y rejilla de tercios, manejable con teclado (`aria-label` en el rectángulo y cada asa; flechas 1 %, Shift 10 %); girar izquierda/derecha; voltear horizontal/vertical; deshacer/rehacer (`Ctrl+Z`/`Ctrl+Y`) en el renderer; "Restablecer original", "Cancelar", "Guardar".
      Archivos: `src/renderer/src/screens/viewer/Editor.tsx`.
      Verificación: `npm.cmd run typecheck` y `npm.cmd run lint`; recorrido E2E de 3.7.

- [ ] 3.6. Reproductor de vídeo (§16.6).
      Qué: `screens/player/VideoPlayer.tsx` y `PlayerControls.tsx` (reproducir/pausar, barra con rangos cargados, ±10 s, tiempo, volumen y silencio, velocidad 0,25×–2× con `preservesPitch`, bucle, pantalla completa; teclado de §16.6; ocultación a los 2,5 s; duración de la DB si `video.duration` no es finita; mensajes de error con `X-Galeria-Error`), `stores/player-store.ts` (volumen y velocidad en memoria). En main, `session:setPlayback` activa la pausa `'playback'` del auto-bloqueo y `powerSaveBlocker` (`prevent-display-sleep`).
      Archivos: `src/renderer/src/screens/player/{VideoPlayer,PlayerControls}.tsx`, `src/renderer/src/stores/player-store.ts`, `src/main/ipc/handlers/session.ts`.
      Verificación: `npm.cmd run typecheck` y `npm.cmd run lint`; recorrido E2E de 3.7.

- [ ] 3.7. E2E del visor, el editor y el reproductor.
      Qué: `tests/e2e/viewer.spec.ts` (abrir desde el mosaico y llegar al estado final de la animación, ←/→, zoom con rueda y arrastre, Esc sale del zoom y después cierra, el foco vuelve al mosaico); `tests/e2e/editor.spec.ts` (recortar + girar + voltear + guardar → `thumbRev` sube y la miniatura cambia; revertir → vuelve la original; el objeto original no cambia de SHA-256 en disco); `tests/e2e/player.spec.ts` (play/pausa, ±10 s, velocidad 0,25× y 2×, bucle, volumen, pantalla completa con `F`; con `GALERIA_E2E=1` main expone `globalThis.__galeriaAutoLockReasons`, que contiene `'playback'` mientras el vídeo se reproduce y queda vacío al pausar; la lógica del temporizador ya la cubre `auto-lock.test.ts`).
      Archivos: `tests/e2e/{viewer,editor,player}.spec.ts`.
      Verificación: `npm.cmd run test:e2e` en verde.

### Criterios de aceptación

- El visor abre con la animación desde la miniatura, navega con flechas, hace zoom con rueda (1×–8×) y desplaza arrastrando.
- Recortar, girar y voltear se guardan como operaciones; el original no cambia; revertir lo restaura; la miniatura se regenera.
- El reproductor tiene solo los controles de §16.6, sin subtítulos.
- `no-temp-leak` incluye `edits-render` y sigue vacío.

### Cómo verificar

VC completa. Revisión visual con `npm.cmd run dev`: animación de apertura y cierre, zoom centrado en el cursor, asas del recorte con teclado, controles que se ocultan.

### Riesgos

- Orden de operaciones de sharp: test de píxeles con plan B (§16.3).
- Animación FLIP con mosaicos fuera de pantalla: cierre por fundido (§16.1).
- `__galeriaAutoLockReasons` es un gancho de test nuevo (como `__galeriaNetBlocked`): solo existe con `GALERIA_E2E=1` y sin empaquetar, y no contiene datos de la bóveda.

### Qué puede probar el usuario al final de la fase

Abrir fotos desde la galería y ver cómo se despliegan, pasar con las flechas, hacer zoom con la rueda y arrastrar, recortar, girar y voltear, guardar y después "Restablecer original"; reproducir vídeos con pausa, ±10 s, velocidad, bucle, volumen y pantalla completa.

---

## Fase 4 — Playlists, música y presentación

### Objetivo

Playlists (crear, renombrar, borrar, añadir, quitar, reordenar arrastrando y con teclado), biblioteca de música en claro por perfil (copia sin borrar el original) y presentación al estilo de Fotos de Windows: pantalla completa por defecto o en ventana, transiciones configurables, duración por diapositiva, música con fundidos, modos de audio con vídeos (por defecto suena el vídeo y la música se silencia), bucle activo por defecto y mezcla de fotos y vídeos con precarga.

### Dependencias

Fase 3 terminada (visor, `EditedImage`, reproductor y `session:setPlayback`). Confirmación de D16 (si no la hay, se implementa la recomendación (a)).

### Tareas

- [ ] 4.1. Repositorio y canales de playlists `[H3-4]`.
      Qué: `src/main/db/repos/playlist-repo.ts` y `ipc/handlers/playlists.ts` (`list`, `create`, `rename`, `delete`, `addItems`, `removeItems`, `reorder`, límite de 2000 → `PLAYLIST_FULL`). **`[H3-4]`**: `addItems` y `removeItems` usan un único parámetro JSON con `json_each(?)` (`INSERT … SELECT value FROM json_each(?) WHERE …` y `DELETE … WHERE media_id IN (SELECT value FROM json_each(?))`), nunca un `IN (?, ?, …)` con un parámetro por id. `reorder` exige la permutación exacta y reescribe `position` densa.
      Archivos: `src/main/db/repos/playlist-repo.ts`, `src/main/ipc/handlers/playlists.ts`, `src/main/ipc/schemas.ts`, `src/shared/ipc-contract.ts`; `tests/unit/main/playlist-repo.test.ts`.
      Verificación: `npm.cmd test -- tests/unit/main/playlist-repo.test.ts`: **`[H3-4]` `addItems` con 40 000 ids sobre una playlist sin límite de prueba (y `removeItems` con 40 000) funciona en una llamada**, y con el límite real de 2000 devuelve `PLAYLIST_FULL`; `alreadyPresent` correcto; `reorder` con una permutación incompleta → `VALIDATION`; borrar un medio lo quita de sus playlists (cascada).

- [ ] 4.2. Música (§8.6.1) y su reconciliación.
      Qué: `src/main/music/music-service.ts` (diálogo con `dontAddToRecent`, `lstat`, ≤ 1 GiB, ≤ 200 archivos, firmas de la tabla de §8.6.1, copia a `music/<trackId>.<ext>.part` + `fsync` + `rename`, duración con ffprobe, título del nombre de archivo, `INSERT` por pista, `DISK_FULL` detiene, trabajo `music-import` con `BUSY`), `src/main/db/repos/music-repo.ts`, `ipc/handlers/music.ts` (`import`, `list`, `rename`, `delete` limpiando `kv['presentation.defaultTracks']`), host `music` en `vault-protocol.ts` y punto 5 de §12.6 en `reconcile.ts`. El original nunca se toca.
      Archivos: los enumerados; `tests/unit/main/{music-service,music-sniff}.test.ts`.
      Verificación: `npm.cmd test -- tests/unit/main/music-service.test.ts tests/unit/main/music-sniff.test.ts`: firmas MP3 (ID3 y sync de Layer III), AAC ADTS, M4A, Ogg, FLAC y WAV; otra firma → `UNSUPPORTED_FORMAT`; > 1 GiB → `TOO_LARGE`; 201 archivos → `VALIDATION`; el original conserva su SHA-256 y sigue en su sitio; `music:delete` quita el id de `kv`; reconciliación borra `.part`, huérfanos y filas sin archivo.

- [ ] 4.3. Ajustes de presentación en main (§10.2, §17.2).
      Qué: `src/shared/presentation.ts` (`DEFAULT_PRESENTATION` = valores de §8.4/§17.2) y `ipc/handlers/presentation.ts` con `presentation:getConfig`, `presentation:saveDefaults` y `playlists:setPresentation` según las reglas transaccionales de §10.2 (las pistas solo en `playlist_music` o en `kv`, nunca en `presentation_json`).
      Archivos: `src/shared/presentation.ts`, `src/main/ipc/handlers/presentation.ts`, `src/main/ipc/schemas.ts`, `src/shared/ipc-contract.ts`; `tests/unit/main/presentation-config.test.ts`.
      Verificación: `npm.cmd test -- tests/unit/main/presentation-config.test.ts`: guardar y leer los valores por defecto; ajustes propios de una playlist con pistas en orden; `settings: null` vuelve a los predeterminados y borra `playlist_music`; ids de pistas borradas se descartan al componer; `slideMs` fuera de pasos de 500 → `VALIDATION`; `trackIds` inexistentes → `NOT_FOUND`.

- [ ] 4.4. Pantallas de playlists y música (§14.8, §14.9).
      Qué: `screens/playlists/PlaylistsScreen.tsx` (tarjetas con portada, "Nueva playlist", menú Abrir/Presentación/Renombrar/Eliminar) y `PlaylistDetail.tsx` (lista reordenable con `@dnd-kit/sortable`, `KeyboardSensor`, `Alt+↑/↓`, anuncios en español por `announcements`, guardado optimista con reversión y toast); "Añadir a playlist" y "Quitar de la playlist" en la `SelectionBar`; filtro y orden "Orden de la playlist" en la galería; `screens/settings/MusicLibrary.tsx` (importar, escuchar un fragmento, renombrar, eliminar, aviso "La música se guarda sin cifrar…", resumen de fallos).
      Archivos: los enumerados en `src/renderer/src/screens/`.
      Verificación: `npm.cmd run typecheck` y `npm.cmd run lint`; recorrido E2E de 4.7.

- [ ] 4.5. Lógica pura de la presentación (§17.3, §17.4, §17.8).
      Qué: `screens/presentation/transitions.ts` (descripción pura de `fade`, `slide`, `zoom`, `kenburns`, `none` y `random` sin repetir la anterior; vídeos con `kenburns` → `fade`; movimiento reducido → `fade` de 150 ms), `scheduler.ts` (estados `preparing → entering → showing → leaving`, eventos de §17.4, reloj inyectable, espera de 8 s y `failed`, bucle) y `audio-graph.ts` (`fadeTo` de §17.8 con 32 rampas y `cancelAndHoldAtTime`; `audioPlan(mode, kind)` con la tabla de §17.8; reglas del volumen del usuario).
      Archivos: `src/renderer/src/screens/presentation/{transitions,scheduler,audio-graph}.ts`; `tests/unit/renderer/{transitions,scheduler,audio-plan,audio-fade}.test.ts`.
      Verificación: `npm.cmd test -- tests/unit/renderer`: `scheduler` con reloj falso (foto dura `slideMs` tras entrar, vídeo hasta `ended`, pausa congela, siguiente/anterior manual, diapositiva lenta omitida a los 8 s, **con `loop` la siguiente de la última es la 0** y sin `loop` aparece el fin); `audioPlan` para los 4 modos y los 2 tipos (por defecto `video`: la música baja a 0 y se pausa en los vídeos y vuelve después); `audio-fade` con un `AudioParam` falso (solo `cancelAndHoldAtTime`, `setValueAtTime` y `linearRampToValueAtTime`; nunca `setValueCurveAtTime`; tiempos estrictamente crecientes; valores monótonos que acaban en `target`; un segundo `fadeTo` a mitad empieza con `cancelAndHoldAtTime`); `random` no repite la anterior.

- [ ] 4.6. Pantalla de presentación (§17).
      Qué: `PresentationScreen.tsx` (capa sobre el shell, `role="dialog"`, foco atrapado y devuelto al salir; pantalla completa con `window:setFullScreen` si `startFullscreen`, modo ventana bajo la barra de título; `F` alterna; `session:setPlayback`; los fondos animados se pausan), `SlideStage.tsx` (dos capas A/B con Motion `animate()` sobre `opacity`/`transform`; precarga de §17.5 con `decode()` y un pool de 3 `<video crossOrigin="anonymous">` conectados a Web Audio una sola vez), `PresentationControls.tsx` (barra de §17.9 que se oculta a los 3 s; menú de modo de audio con "Silencio en los vídeos" e interruptor "Música de fondo" juntos, D16), `PresentationSettingsPanel.tsx` (en vivo, "Guardar como predeterminado" y "Guardar para esta playlist"), `stores/presentation-store.ts`; Ajustes → Presentación con los valores por defecto. Inicio desde la selección o F5 y desde una playlist. Atributos `data-slide-index`, `data-phase` y `data-music-gain` solo sin empaquetar (§23.2). Errores de §17.10.
      Archivos: `src/renderer/src/screens/presentation/{PresentationScreen,SlideStage,PresentationControls,PresentationSettingsPanel}.tsx`, `src/renderer/src/stores/presentation-store.ts`, `src/renderer/src/screens/settings/SettingsScreen.tsx`.
      Verificación: `npm.cmd run typecheck` y `npm.cmd run lint`; recorrido E2E de 4.7.

- [ ] 4.7. E2E de playlists y presentación.
      Qué: `tests/e2e/playlists.spec.ts` (crear, añadir desde la selección, reordenar con ratón y con teclado, quitar, renombrar, borrar sin borrar los medios); `tests/e2e/presentation.spec.ts` (con 3 fotos y 1 vídeo con audio y una pista de música importada: arranca en pantalla completa; en modo ventana la barra de título sigue visible; **bucle**: tras la última, `data-slide-index` vuelve a 0; modo por defecto `video`: `data-music-gain` llega a 0 durante el vídeo y vuelve a `musicVolume` después; `music`, `both` y `mute` según la tabla; cambiar el volumen de la música en mitad de un fundido no produce ningún `pageerror`; desactivar las transiciones da corte instantáneo; `loop = false` muestra "Fin de la presentación").
      Archivos: `tests/e2e/{playlists,presentation}.spec.ts`.
      Verificación: `npm.cmd run test:e2e` en verde.

### Criterios de aceptación

- `[H3-4]` `addItems`/`removeItems` con más de 32 766 ids funcionan.
- La música se copia en claro a `music/` del perfil y el original no se toca; qué pistas usa cada presentación está solo en la DB cifrada.
- Presentación: pantalla completa por defecto y opción en ventana; 6 tipos de transición configurables o desactivables; duración por diapositiva; música con fundidos que se puede apagar; 4 modos de audio con `video` por defecto; bucle activo por defecto; fotos y vídeos mezclados con precarga.

### Cómo verificar

VC completa. Revisión visual y auditiva con `npm.cmd run dev`: suavidad de las transiciones, Ken Burns, fundidos de música al entrar y salir de un vídeo, modo ventana.

### Riesgos

- `MediaElementSource` en silencio sin CORS: `vault://` responde `Access-Control-Allow-Origin` (§5.5, §11.3) y el E2E lo comprueba con `data-music-gain` y el nivel de un `AnalyserNode` en desarrollo.
- `autoplayPolicy: 'no-user-gesture-required'` (§5.2) para encadenar vídeos con sonido.
- D16 sin confirmar: el cambio a la opción (b) sería añadir un quinto modo `silence`.

### Qué puede probar el usuario al final de la fase

Crear playlists, reordenarlas arrastrando o con el teclado, importar su propia música (sigue en su carpeta original), lanzar una presentación con F5 o desde una playlist, cambiar transiciones, duración y modo de audio en vivo, verla en pantalla completa o en ventana, y comprobar que tras la última diapositiva vuelve a empezar.

---

## Fase 5 — Vídeo dual y fusión

### Objetivo

Reproducir dos vídeos lado a lado con controles sincronizados o independientes y crear opcionalmente un vídeo fusionado con ffmpeg (`hstack` tras escalar a una altura común; audio izquierdo, derecho, mezcla o ninguno; duración del más corto o del más largo), que se importa cifrado en la bóveda sin que ffmpeg lea nada descifrado del disco.

### Dependencias

Fase 4 terminada (en particular `loopback-server.ts`, `ffmpeg.ts`, `thumbnails.ts` y el pipeline de inserción de F2; reproductor de F3).

### Tareas

- [ ] 5.1. Verificación previa del MP4 fragmentado de la fusión (§18.4, primera tarea obligatoria).
      Qué: test que genera dos vídeos `testsrc2` + `sine` de 20 s y 12 s, los importa, los fusiona con la línea de comandos exacta de §18.3 (loopback como entrada, `pipe:1` como salida hacia el cifrador) y comprueba en `<video>` que `duration` es finita e igual a `D ± 0,5 s` y que `currentTime = 0,75·D` dispara `seeked` en menos de 3 s. Si falla, la fase se detiene y este punto del diseño se reabre (no se improvisa otro contenedor).
      Archivos: `tests/e2e/merge-fmp4.spec.ts` (usa un `merge-service` mínimo que 5.3 completa).
      Verificación: `npm.cmd run test:e2e -- tests/e2e/merge-fmp4.spec.ts` en verde.

- [ ] 5.2. Sincronización de la reproducción dual (§18.1).
      Qué: `screens/dual/sync.ts` (puro): reloj maestro = el más largo; búsqueda a `t` con el esclavo en `min(t, dEsclavo)`; corrección de deriva cada 250 ms (salto si `|drift| > 0,5 s`; ajuste de `playbackRate` ±5 % entre 0,04 y 0,5 s hasta `< 0,02`); pausa cruzada con `waiting`/`canplay`; bucle de los dos al terminar el maestro.
      Archivos: `src/renderer/src/screens/dual/sync.ts`, `tests/unit/renderer/dual-sync.test.ts`.
      Verificación: `npm.cmd test -- tests/unit/renderer/dual-sync.test.ts` con elementos de vídeo falsos y reloj falso: cada rama del controlador y el regreso a `rate` normal.

- [ ] 5.3. Servicio de fusión (§18.2–§18.7).
      Qué: `src/main/media/merge-service.ts` (parámetros `H`, `FPS`, `D` y `Δ`; grafo y argumentos exactos de §18.3 con `<PAD_X>`, `<AUDIO>`, `<DEMUX_X>`, `<MAPA_AUDIO>` y `<CODEC_AUDIO>`; `pipeline(child.stdout, objectWriter)`; progreso cada 250 ms; verificación con ffprobe por loopback; fusión idéntica → `existed: true`; inserción con `source = 'merge'`, `converted = 1`, `captured_at_source = 'generated'`; tabla de errores de §18.7). Trabajo `merge` en `JobRegistry` (`BUSY` si hay otra) que **pausa el bloqueo por inactividad (D18, confirmado por el usuario)**; suspensión, bloqueo del SO y bloqueo manual la cancelan. Handlers `merge:start`, `merge:cancel`, eventos `merge:progress`/`merge:done`. El servidor loopback se cierra al terminar, cancelar o bloquear.
      Archivos: `src/main/media/merge-service.ts`, `src/main/ipc/handlers/merge.ts`, `src/main/ipc/schemas.ts`, `src/shared/ipc-contract.ts`; `tests/unit/main/merge-service.test.ts`.
      Verificación: `npm.cmd test -- tests/unit/main/merge-service.test.ts`: argumentos exactos para las 4 opciones de audio × 2 de duración (incluido "mezcla con un solo lado con audio" e "izquierdo con `tpad`"); `H` par y ≤ 1080 con vídeos rotados; `leftId === rightId` o una foto → `VALIDATION`; segunda fusión → `BUSY`; reloj falso: sin bloqueo por inactividad durante la fusión, y un `suspend` simulado bloquea y cancela (`kill()`, loopback cerrado, `.part` borrado).

- [ ] 5.4. Pantalla de vídeo dual y diálogo de fusión (§18.1).
      Qué: `screens/dual/DualVideoScreen.tsx` (dos `<video>` al 50 % con `object-fit: contain`; acceso desde la selección de 2 vídeos o desde la navegación con dos huecos "Elegir vídeo…"; audio izquierdo activo y derecho silenciado por defecto; interruptor "Controles sincronizados"; teclado con `Ctrl+←/→`; `session:setPlayback`), `MergeDialog.tsx` (opciones y valores por defecto de §18.1, nombre "Fusión AAAA-MM-DD HH.mm", progreso con "Cancelar", botón deshabilitado sin ffmpeg o con otra fusión en curso), `stores/dual-store.ts`. Se habilita "Vídeo dual" en la `SelectionBar`.
      Archivos: `src/renderer/src/screens/dual/{DualVideoScreen,MergeDialog}.tsx`, `src/renderer/src/stores/dual-store.ts`, `src/renderer/src/screens/gallery/SelectionBar.tsx`.
      Verificación: `npm.cmd run typecheck` y `npm.cmd run lint`; recorrido E2E de 5.5.

- [ ] 5.5. E2E del vídeo dual y la fusión.
      Qué: `tests/e2e/dual.spec.ts` (sincronizado: un solo control mueve los dos, deriva < 0,1 s tras 5 s; independiente: cada lado por separado) y `tests/e2e/merge.spec.ts` (fusión "mezcla" + "más corto" aparece en la galería como vídeo con duración `min(dL, dR) ± 0,5 s`; repetirla con los mismos parámetros muestra "Ya existía un vídeo idéntico"; ningún archivo bajo la raíz de datos contiene los primeros 64 bytes de los fixtures ni de la salida descifrada; con `GALERIA_E2E=1`, durante la fusión `__galeriaAutoLockReasons` contiene `'job'`; `powerMonitor.emit('suspend')` a mitad cancela y no deja `.part`).
      Archivos: `tests/e2e/{dual,merge}.spec.ts`.
      Verificación: `npm.cmd run test:e2e` en verde.

### Criterios de aceptación

- El MP4 fragmentado de la fusión tiene duración finita y búsqueda rápida en `<video>` (5.1).
- La reproducción dual funciona sincronizada e independiente.
- La fusión usa solo loopback de entrada y `pipe:1` de salida; el resultado entra cifrado en la bóveda; la inactividad no la cancela, pero la suspensión sí.

### Cómo verificar

VC completa. Revisión visual con `npm.cmd run dev` de un vídeo horizontal junto a uno vertical (rotación aplicada) y del vídeo fusionado.

### Riesgos

- R4 en la fusión (5.1 lo comprueba antes que nada).
- R10 (VP9 lento): `-cpu-used 5 -row-mt 1`, progreso y cancelación.
- Determinismo de VP9 con `-map_metadata -1` no verificado: si no es determinista, la segunda fusión simplemente no se detecta como idéntica (sin otras consecuencias).

### Qué puede probar el usuario al final de la fase

Seleccionar dos vídeos y verlos lado a lado, con controles sincronizados o por separado, elegir de qué lado suena el audio y crear un vídeo fusionado (audio izquierdo, derecho, mezcla o ninguno; duración del más corto o del más largo) que aparece cifrado en su galería.

---

## Fase 6 — Temas completos

### Objetivo

Completar `xbox` ("Mosaico"), `ps3` ("Ondas"), `macos` ("Cristal") y `album` ("Álbum") en todas las pantallas (galería, búsqueda/filtros/orden, selección, visor, editor, reproductor, playlists, configuración de la presentación, vídeo dual, ajustes, selector de perfiles, desbloqueo y bloqueo), sin bifurcar ninguna función, con contraste AA, foco visible, movimiento reducido y fondos animados ligeros, y con verificación visual por capturas de Playwright.

### Dependencias

Fases 1–5 terminadas (todas las pantallas existen). Confirmación de D9 y D10 (si no la hay, se mantienen las recomendaciones).

### Tareas

- [ ] 6.1. Tokens de los cuatro temas y su contraste (§15.2, §15.3, §15.11).
      Qué: `themes/tokens/{xbox,macos,album}.ts` y `ps3.ts` completo con los esquemas, fuentes y acentos de §15.2 (`fonts.css` añade Noto Sans, Fraunces y Caveat); `bgExtremes` de cada tema.
      Archivos: `src/renderer/src/themes/tokens/{xbox,ps3,macos,album}.ts`, `src/renderer/src/themes/registry.ts`, `src/renderer/src/styles/fonts.css`, `tests/unit/renderer/theme-contrast.test.ts`.
      Verificación: `npm.cmd test -- tests/unit/renderer/theme-contrast.test.ts` recorre los 5 temas y todos sus esquemas con las parejas de §15.11 (texto ≥ 4,5:1, foco y componentes ≥ 3:1, superficies translúcidas compuestas sobre los dos `bgExtremes`).

- [ ] 6.2. Shells y barras de título (§15.5, §15.6).
      Qué: `PivotShell.tsx` (Tabs horizontales, foco con escala + borde), `XmbShell.tsx` completo (fila de categorías con `translateX` de 250 ms, columna de subelementos, Esc/Retroceso vuelven a la barra), `VibrancyShell.tsx` (barra lateral translúcida, botones de ventana a la izquierda), `TopbarShell.tsx` (pestañas de papel); variantes `xbox`, `traffic-lights` y `album` de `Titlebar.tsx`. Mismo `NavModel` y mismas pantallas en todos.
      Archivos: `src/renderer/src/themes/shells/{PivotShell,XmbShell,VibrancyShell,TopbarShell}.tsx`, `src/renderer/src/themes/titlebars/Titlebar.tsx`.
      Verificación: `npm.cmd run typecheck` y `npm.cmd run lint`; recorrido funcional de 6.5.

- [ ] 6.3. Fondos y rendimiento (§15.7).
      Qué: `WavesBackground.tsx` completo (3 cintas, color del mes con tabla propia de 12 colores y brillo por hora, 30 fps como máximo, media resolución, presupuesto ≤ 3 ms, rAF cancelado con `paused`, un fotograma estático con movimiento reducido), `WallpaperBackground.tsx` (degradado SVG propio + `backdrop-filter` solo en barra lateral y de herramientas), `PaperBackground.tsx` (textura PNG propia de 256 px + grano estático); assets en `assets/textures/` y `assets/wallpapers/`, todos creados para el proyecto.
      Archivos: `src/renderer/src/themes/backgrounds/{WavesBackground,WallpaperBackground,PaperBackground}.tsx`, `src/renderer/src/assets/{textures,wallpapers}/*`.
      Verificación: medición con el Performance Monitor de las DevTools en `npm.cmd run dev`: `waves` visible ≤ 5 % de un núcleo de media y 0 % con `paused` (ventana minimizada, presentación o vídeo en marcha); las cifras se anotan en "Notas sobre el diseño".

- [ ] 6.4. Estilos estructurales y selector de perfiles por tema (§15.10, D9).
      Qué: `styles/themes.css` con los selectores `[data-theme="…"]` de cada tema (mosaicos `flat` con tamaños 2×2/2×1/1×1 en Playlists y en el selector de `xbox`; `polaroid` con rotación determinista por hash del id que se endereza al enfocar; `vibrancy`; lista `xmb`); variantes del selector `tiles`, `xmb-row`, `login` (contraseña en línea bajo el avatar) y `polaroid` con la misma estructura, orden del DOM y teclado; textos sobre fotos siempre sobre etiqueta sólida; `ThemePreview` de los 5 temas.
      Archivos: `src/renderer/src/styles/themes.css`, `src/renderer/src/screens/profiles/ProfilePicker.tsx`, `src/renderer/src/screens/profiles/UnlockDialog.tsx`, `src/renderer/src/screens/settings/ThemePreview.tsx`.
      Verificación: `npm.cmd run typecheck` y `npm.cmd run lint`; capturas de 6.5.

- [ ] 6.5. Verificación visual y funcional por tema.
      Qué: `tests/e2e/themes.spec.ts` con `toHaveScreenshot` por tema, esquema y pantalla (selector, desbloqueo, galería con fixtures, visor, editor, reproductor, playlists, ajustes de la presentación, vídeo dual, ajustes), con máscaras sobre el contenido dinámico (miniaturas, fechas, fondo de ondas) y `prefs.contentProtection = false` en el perfil de prueba. `tests/e2e/themes-functional.spec.ts` repite en los 5 temas el mismo recorrido funcional solo con teclado (crear perfil, desbloquear, importar, buscar, seleccionar, abrir el visor, lanzar una presentación, bloquear), que es la invariante de §22 "los temas no bifurcan funcionalidad". Las capturas de referencia se generan con `npm.cmd run test:e2e -- tests/e2e/themes.spec.ts --update-snapshots`, el usuario las revisa y se guardan en `tests/e2e/themes.spec.ts-snapshots/` (con sufijo por plataforma).
      Archivos: `tests/e2e/{themes,themes-functional}.spec.ts`, `tests/e2e/themes.spec.ts-snapshots/`.
      Verificación: `npm.cmd run test:e2e` en verde con las capturas de referencia aprobadas.

### Criterios de aceptación

- Las 5 combinaciones de tema funcionan en todas las pantallas con el mismo recorrido de teclado.
- Contraste AA, foco visible y movimiento reducido en todos (ondas estáticas, sin deslizamiento XMB, sin escalados).
- Fondos animados ≤ 5 % de CPU y en pausa con la ventana oculta, presentaciones y vídeos.
- Sin logotipos, iconos, sonidos, fondos ni fuentes de Microsoft, Sony o Apple; nombres visibles neutros (D10).

### Cómo verificar

VC completa y revisión manual con NVDA en Windows del selector y de la galería en dos temas. La validación completa de WCAG requiere pruebas manuales con tecnologías de asistencia y la revisión de un experto; los tests automáticos solo cubren el contraste y el teclado.

### Riesgos

- `backdrop-filter` y GPUs antiguas: limitado a dos superficies (§15.7).
- Capturas inestables entre máquinas: máscaras, `animations: 'disabled'` de Playwright y referencias por plataforma.
- `setContentProtection` podría ennegrecer capturas: el perfil de prueba lo desactiva.

### Qué puede probar el usuario al final de la fase

Cambiar en vivo entre Clásico, Mosaico, Ondas, Cristal y Álbum desde Ajustes → Apariencia o desde el botón de paleta del selector, ver la previsualización de cada uno, aplicarlo solo a su perfil o a toda la app, y usar todas las pantallas en cualquiera de ellos.

---

## Fase 7 — Instaladores y E2E completos

### Objetivo

Instalador NSIS para Windows y AppImage + `.deb` para Linux con los fuses de §20.1, licencias completas, y la suite E2E completa en verde en los dos sistemas, más la lista de comprobación manual del binario empaquetado.

### Dependencias

Fases 1–6 terminadas. Decisiones D11 (dónde compilar Linux) y D13 (versión de Electron). Linux se compila y se prueba en el PC Linux del usuario (D11, anexo §5). En la máquina Windows no hay permisos de administrador, así que no se usa WSL2. Los agentes no tienen acceso a ese PC: 7.4 y 7.5 dejan preparado un script y una guía, el flujo pausa y el usuario ejecuta los pasos y comparte el informe.

### Tareas

- [ ] 7.1. Reevaluar Electron 45 (D13, R7).
      Qué: `npm.cmd view electron@45 version` y notas de la versión; si el usuario decide cambiar, actualizar `electron` (y `@types/node` si cambia el Node interno), repetir el spike de 0.8 y la VC.
      Archivos: `package.json`, `package-lock.json` (solo si se cambia).
      Verificación: VC en verde con la versión elegida.

- [ ] 7.2. Configuración completa de electron-builder, iconos y licencias (§20.1).
      Qué: `electron-builder.yml` completo de §20.1 (`asarUnpack` de `*.node`, `sharp` y `@img`; `extraResources` de ffmpeg por SO y licencias; `electronFuses`; `win` NSIS sin `perMachine` y `deleteAppDataOnUninstall: false`; `linux` AppImage + deb, categoría Graphics). `resources/build/icon.ico` e iconos definitivos generados con sharp desde un SVG propio. `resources/licenses/`: FFmpeg según `BUILDINFO.json` (2.1), OFL de las cinco fuentes y `THIRD-PARTY-NOTICES.md` con las licencias de las dependencias de producción. `package.json`: `author` con correo (lo exige el `.deb`), `homepage` y scripts `dist:win` y `dist:linux` de §4. "Acerca de" muestra la licencia de FFmpeg con la versión de `BUILDINFO.json`, el commit, el tag de BtbN y el aviso de código fuente bajo petición.
      Archivos: `electron-builder.yml`, `resources/build/*`, `resources/licenses/*`, `package.json`, `src/renderer/src/screens/settings/SettingsScreen.tsx`.
      Verificación: `npm.cmd run dist:win` genera `release/Galeria-<versión>-win-x64.exe`; `npx.cmd @electron/fuses read --app release/win-unpacked/galeria.exe` muestra los fuses de §20.1.

- [ ] 7.3. Instalador de Windows y comprobación manual (§20.2).
      Qué: instalar el `.exe` en esta máquina (si electron-builder o NSIS fallan por la ruta no ASCII: `subst G: "c:\Users\AlbertoVázquezAguila\Documents\Galeria_App"`, compilar desde `G:\` y `$env:ELECTRON_BUILDER_CACHE = 'C:\ebcache'`, R1). Lista manual: arranca; crear perfil; importar; ver; editar; presentación con música; vídeo dual y fusión; bloquear; desinstalar no borra `%LOCALAPPDATA%\Galeria`; lanzado con `--remote-debugging-port=9222` sale con código 1 y el puerto 9222 no queda abierto (`Get-NetTCPConnection -LocalPort 9222` vacío); SmartScreen avisa (binario sin firmar, R11).
      Archivos: ninguno (resultado anotado en "Notas sobre el diseño").
      Verificación: la lista completa marcada.

- [ ] 7.4. Linux: compilación, tests y paquetes (D11, P13).
      Qué: los binarios nativos de Linux solo se instalan en Linux (R2). Se hace en el PC Linux del usuario, no en WSL2 (anexo §5). En Windows se prepara `scripts/linux-build.sh` y la sección "Compilar en Linux" del README. El script no usa `sudo`, avisa si falta algo y escribe `release/linux-report.txt` con versiones, resultados y vectores de GLib. El usuario copia el repo a su PC Linux sin `node_modules`, `out`, `release` ni `.cache`, con un USB o `git bundle`, sin pasar por la nube. Instala Node 24 LTS o 26 en su usuario (nvm o tarball, sin administrador), ejecuta el script y pega el informe en el chat. Pasos del script: `npm ci`, `npm run fetch:ffmpeg -- --platform linux` (aquí sí se ejecuta el paso 5 de §19.3), `npm test` (incluye los tests solo de Linux: vectores de GLib de 2.6, `no-temp-leak`, espacio final en nombres de 2.9), `npm run test:e2e` (en el escritorio del usuario, sin `xvfb-run`) y `npm run dist:linux`. Alternativa documentada y no creada (P13): un workflow de GitHub Actions con matriz `windows-latest` / `ubuntu-latest` que ejecuta `npm ci`, `npm run fetch:ffmpeg`, la VC (con `xvfb-run` en Ubuntu) y `dist:win`/`dist:linux`, publicando los artefactos; solo si el usuario acepta subir el código a GitHub.
      Archivos: `tests/unit/main/linux-thumbnails.test.ts` (vectores fijados si quedaron en `it.todo`).
      Verificación: el informe del usuario (`release/linux-report.txt`) muestra `npm test`, `npm run test:e2e` y `npm run dist:linux` en verde y la generación de `release/Galeria-<versión>-linux-x86_64.AppImage` y el `.deb`. Los vectores de GLib del informe quedan fijados en `linux-thumbnails.test.ts`. Si algo falla, el agente corrige en Windows y el usuario repite el script.

- [ ] 7.5. Comprobaciones manuales en Linux (§20.3).
      Qué: instalar el `.deb` en Ubuntu 24.04 (instala `chrome-sandbox` con SUID; nunca `--no-sandbox`); documentar en el README que el AppImage en Ubuntu 24.04+ necesita un perfil AppArmor; comprobar en GNOME y KDE que no aparece ningún aviso del llavero (`enableCookieEncryption: false` y `--password-store=basic`); redimensionado de la ventana sin marco en Wayland (R8); bloqueo del SO en GNOME y KDE (`getSystemIdleState`, límite 11); arranque en Debian 12 y Fedora 39+ (glibc). Las hace el usuario en su PC Linux con la lista que deja el README. El flujo pausa hasta recibir sus resultados. Instalar el `.deb` necesita `sudo` en ese PC; si no lo tiene, se anota y se prueba solo el AppImage.
      Archivos: `README.md`, "Notas sobre el diseño".
      Verificación: la lista marcada, con lo que no se pudo probar señalado.

- [ ] 7.6. Suite E2E completa y cierre.
      Qué: ejecutar todos los specs de las fases 0–6 en Windows y en Linux, incluidos los lentos; actualizar el README (instalación, límites, cómo compilar en cada SO).
      Archivos: `README.md`.
      Verificación: VC completa con `GALERIA_SLOW_TESTS=1` en Windows y su equivalente en el PC Linux del usuario (script de 7.4), todo en verde.

### Criterios de aceptación

- `.exe` NSIS instalable en Windows; `.deb` y AppImage en Linux, compilados en Linux.
- Fuses de §20.1 activos; sin `publish`, sin auto-actualización; desinstalar no borra las bóvedas.
- Licencias de FFmpeg, fuentes y dependencias incluidas y visibles en "Acerca de".
- Suite E2E completa y unitarios en verde en los dos SO; lista manual del empaquetado completa.

### Cómo verificar

7.3, 7.4, 7.5 y 7.6.

### Riesgos

- R1 (ruta no ASCII con electron-builder/NSIS): `subst G:` y `ELECTRON_BUILDER_CACHE`.
- R2 (nativos de Linux): solo en Linux.
- R3 (AppImage y AppArmor): recomendar el `.deb`.
- R11 (sin firma): fuera de alcance.
- R15 (Playwright no controla el binario con fuses): por eso la lista manual de 7.3.
- R18 (escape de GLib): vectores fijados en 7.4 si no se pudieron en F2.

### Qué puede probar el usuario al final de la fase

Instalar Galería con el `.exe` en Windows y con el `.deb` (o el AppImage) en Linux, usarla como una app normal desde el menú de inicio, y desinstalarla comprobando que sus bóvedas siguen en su sitio.

---

## Resultados del spike de módulos nativos

Ejecutado por el paso de scaffold (Fase 0, tarea 0.8) en Windows 11 x64, con el repo en la ruta no ASCII `c:\Users\AlbertoVázquezAguila\Documents\Galeria_App` y el directorio de trabajo `tests\.tmp\spike\` dentro de ella. Los tres módulos cargan y funcionan **dentro del proceso main de Electron 44.9.3** y en el Node 26 del sistema, sin recompilar nada y sin ninguna solución alternativa.

| Módulo | Versión | ¿Recompilar? | Electron main (Node 24.22.0, ABI 149) | Node 26.10.0 (ABI 147, Vitest) | Errores / soluciones |
|---|---|---|---|---|---|
| `@node-rs/argon2` | 2.2.2 (`@node-rs/argon2-win32-x64-msvc`) | No (N-API precompilado) | ok: `hashRaw` Argon2id (`algorithm: 2`, `version: 1`), 8 MiB, t=1, p=1 → 32 bytes; determinista con la misma sal y distinto con otra contraseña | ok | Ninguno |
| `better-sqlite3-multiple-ciphers` | 13.0.3 (SQLite3 Multiple Ciphers 2.4.0, SQLite 3.53.4) | No: usa `prebuilds/win32-x64.node` del tarball | ok: `cipher='sqlcipher'`, `legacy=4`, `db.key(Buffer x'<64 hex>')`; crear, insertar, cerrar y reabrir; clave incorrecta → `SQLITE_NOTADB`; sin clave → `SQLITE_NOTADB`; cabecera distinta de `SQLite format 3\0`; el marcador no aparece en los bytes del archivo | ok | Ninguno. **R5 resuelto**: `db.key(Buffer)` acepta la forma `x'…'` como clave cruda (con `kdf_iter = 1` la DB sigue abriendo, y un control con una frase de paso y `kdf_iter = 1` falla con `SQLITE_NOTADB`); el plan B de §9.1 no hace falta |
| `sharp` | 0.35.5 (libvips 8.18.7, `@img/sharp-win32-x64`) | No (N-API precompilado) | ok: PNG 64×64 generado en memoria → `resize(32, 32)` → WebP; `metadata()` da `webp` 32×32 | ok | Ninguno |

Detalles de la instalación en esta máquina:

- **npm 11.19 bloquea los scripts de instalación de las dependencias** salvo los aprobados en `allowScripts` de `package.json`. npm atribuye a `better-sqlite3-multiple-ciphers` un `install: node-gyp rebuild` implícito (el paquete trae `binding.gyp`, aunque declara `gypfile: false`), que fallaría sin Visual Studio Build Tools. Se deniega de forma explícita con `npm.cmd install-scripts deny better-sqlite3-multiple-ciphers` (`allowScripts: { "better-sqlite3-multiple-ciphers": false }`): el módulo carga su binario de `prebuilds/`. También se deniega `electron-winstaller` (dependencia transitiva de electron-builder solo para Squirrel.Windows, que no se usa). Ningún otro paquete tiene scripts pendientes (`npm.cmd install-scripts ls`).
- **Electron 44 no tiene `postinstall`**: descarga el binario la primera vez que se ejecuta (`npx.cmd electron --version` → `Downloading Electron binary...` → `v44.9.3`) en `%LOCALAPPDATA%\electron\Cache` (ruta no ASCII). Funcionó sin `electron_config_cache`.
- **Ruta no ASCII (R1)**: ningún fallo en la instalación, en la carga de las DLL de sharp ni en las rutas de SQLite. No hizo falta `subst G:`. La consola de PowerShell muestra la `á` como mojibake (`V├ízquez`), pero es solo la codificación de la consola: las rutas reales son correctas.
- El spike pone `userData` de Electron en `tests\.tmp\spike-electron-userdata\` (si no, Electron crearía `%APPDATA%\Electron`); se borra al empezar la siguiente ejecución, porque Chromium mantiene archivos abiertos hasta salir.

Salida de `npm.cmd run spike:native` (main de Electron):

```json
{
  "runtime": { "electron": "44.9.3", "node": "24.22.0", "modules": "149", "napi": "10", "platform": "win32", "arch": "x64", "cleanup": true },
  "argon2": "ok",
  "sqlcipher": "ok",
  "sharp": "ok",
  "details": {
    "argon2": { "version": "2.2.2", "outputBytes": 32 },
    "sqlcipher": { "version": "13.0.3", "sqlite3mc": "SQLite3 Multiple Ciphers 2.4.0", "sqlite": "3.53.4", "keyForm": "db.key(Buffer x'<64 hex>')", "rawKeyConfirmed": true, "fileBytes": 8192 },
    "sharp": { "version": "0.35.5", "libvips": "8.18.7", "webpBytes": 66 }
  }
}
```

Salida de `node scripts/native-spike.cjs` (Node 26 del sistema): idéntica salvo `"electron": null`, `"node": "26.10.0"` y `"modules": "147"`. Las dos terminan con código 0.

Resultados de las capas de red del E2E de humo (0.7), que esta sección también recoge:

- **R17 no se da**: `webRequest` intercepta `electron.net.fetch` (rechaza con `net::ERR_BLOCKED_BY_CLIENT` y el contador `http` pasa de 1 a 2). No hace falta la variante de §5.4 punto 10.
- **R19 no se da**: el `RTCPeerConnection` de un `<iframe>` vacío llega a crear la oferta (`ran`) y, tras 5 s, el servidor TCP recibe 0 conexiones y el socket UDP 0 datagramas. El test 8 pasa sin `fixme`.
- `resolveProxy('https://example.com')` devuelve `SOCKS5 127.0.0.1:9` en la sesión `galeria`, en `defaultSession` y en `app.resolveProxy` (existe en Electron 44).

## Notas sobre el diseño

Incoherencias o huecos de `docs/DESIGN.md` v3 encontrados al planificar, y cambios que hay que llevar al diseño en su próxima revisión. `DESIGN.md` no se ha editado.

1. **v3-1 (descartado por el usuario)**: §12.5 sigue decidiendo solo por `codec_name`. Falta en §24.2 la línea "Algunos vídeos de cámara (H.264 de 10 bits o 4:2:2/4:4:4) podrían no reproducirse en Galería después de importarlos." Este plan ya la pone en la Ayuda (2.12).
2. **`[H3-2]`**: §3, §4 y §5.6 no dicen dónde viven los esquemas zod. Hay que añadir `src/main/ipc/schemas.ts` [S] al árbol, la regla "`src/shared/**` y `src/preload/**` no importan paquetes de `dependencies`" y `preload.build.externalizeDeps: false` en la descripción de `electron.vite.config.ts`. La firma de §5.6 pasa a `handle(channel, { requiresUnlock }, fn)`, con el esquema tomado de `SCHEMAS`.
3. **`[H3-3]`**: la primera frase de §10.3 ("todas las cadenas se normalizan a NFC y se recortan") contradice la fila `paths`; la excepción y la comparación por `realpath` + minúsculas en `win32` + segmentos de §12.3 punto 2 están en 2.4. `path-guard.ts` es un archivo nuevo (P8).
4. **`[H3-4]`**: §12.10 punto 2 y `playlists:addItems`/`removeItems` deben usar `json_each(?)`.
5. **`[H3-5]`**: la frase de §5.4 punto 10 "Cubre también el código de las dependencias" es demasiado fuerte; la redacción correcta está en 0.5. Hay que añadir `dgram.Socket.prototype`, la envoltura de `process.binding` (P10), `app.setProxy` y `app.configureHostResolver({ secureDnsMode: 'off' })`. Además, `installSessionGuards` tiene que ser idempotente (un segundo `onBeforeRequest` en la misma sesión sustituye al primero y `session-created` puede coincidir con la llamada explícita).
6. **`[H3-6]`**: §12.6 punto 1 ("al desbloquear no hay trabajos, así que `inFlight` está vacío") no está garantizado tras un bloqueo de 0 ms. `getDb(epoch)`, `drained()` y los borrados de la rama de fallo por `KeylessCleanup` están en 1.8 y 2.9; los repos reciben `db` por parámetro (P6).
7. **`[H3-7]`**: §12.6 punto 3 debe decir que se listan los shards con `readdir` (P9).
8. **`[H3-8]`**: §10.2 dice que `profiles:delete` devuelve `void` y §21.1 promete `details.leftoverPath` en un `ok`; pasa a `{ leftoverPath: string | null }`. `VAULT_UNAVAILABLE` lleva `details.path` en `session:unlock` y `vault:locate`. §12.2 debe decir "el renderer nunca construye ni envía rutas" y §14.6 "además de la ubicación de la bóveda, es el único sitio donde el renderer ve rutas".
9. **`[H3-9]`**: §19.1 y §4 dan por hecho LGPL-2.1; probablemente es LGPL-3.0 (`--enable-version3`). "Acerca de" y `resources/licenses/` dependen de `BUILDINFO.json` (2.1).
10. **`[H3-10]`**: faltan en el árbol `lib/errors-es.ts` [F1] y `themes/BackgroundHost.tsx` [F1]; `vitest.config.ts` necesita `resolve.alias`. También es nueva la carpeta `tests/unit/tooling/` (test de las reglas de ESLint, 0.4).
11. **`[H3-11]`**: §12.3 debe incluir el brand `crx ` (CR3) en la fila de rechazo, y §12.5 el rechazo de pistas sin `codec_name` o sin decodificador.
12. `avatars.ts` [F1] usa las firmas de foto de `sniff.ts` [F2]: `sniff.ts` nace en F1 con las filas de foto (P7).
13. `no-temp-leak.test.ts` [F2] cita `edits-render` [F3]: F2 cubre miniaturas y avatar, F3 añade `edits-render` (3.2).
14. `reconcile.ts` [F2] incluye la música (§12.6 punto 5) y `vault://music`, que son de F4: F4 los añade (4.2).
15. §14.3 (F1) ofrece "Buscar la bóveda…", pero `vault:locate` vive en `ipc/handlers/vault.ts` [F2]: el botón llega en 2.11 y en F1 el diálogo muestra la ruta y "Reintentar".
16. `src/shared/types.ts` está marcado [F1], pero `AppInfo` hace falta en el scaffold (P3).
17. `tsconfig.node.json` declara solo `types: ["node"]`, pero el preload toca el DOM (§15.4): `lib` incluye `DOM` y ESLint prohíbe `window`/`document` en main (P4).
18. §5.4 punto 4 no fija el archivo de los permisos (P11). §26.2 no dice cómo implementar `importDropped` antes de F2 (P14). §26.2 deja al planner el `PLAN.md` de la raíz: se borra (P2).
19. §23.2 marca como `skip` los fixtures H.264 si no hay codificador. Como el uso real del usuario son vídeos H.264 de redes sociales, 2.8 intenta generarlos con `h264_mf` (Windows) o el ffmpeg de la distro (Linux), solo como herramienta de test.
20. Ganchos y variables de test nuevos, con las mismas condiciones que los de §23.2 (`GALERIA_E2E=1` y sin empaquetar, sin datos de la bóveda): `globalThis.__galeriaAutoLockReasons` (3.7, 5.5) y `GALERIA_SLOW_TESTS=1` para los tests lentos.
21. Mediciones que anotan las fases aquí: carga del hilo main (2.14, R6), CPU de las ondas (6.3), comprobaciones manuales de Windows y Linux (7.3, 7.5) y, si aplican, los planes B de R5, R17, R19 y R20.

Encontrado en el scaffold (Fase 0):

22. **Guard de DNS y `listen`**: `net.Server#listen(port, '127.0.0.1')` siempre llama a `dns.lookup`, también con un literal IP, así que el código de §5.4 punto 10 (que sustituye todo `lookup`) rompe el servidor loopback de §18 y el propio unitario que §5.4 exige (`listen(0, '127.0.0.1')` sigue funcionando). `node-egress-guard.ts` deja pasar `dns.lookup` y `dns.promises.lookup` solo cuando el nombre es un literal IP (`net.isIP`), que Node resuelve sin red; cualquier nombre sigue fallando con `EGALERIA_NET` y `Socket#connect` sigue bloqueado.
23. **Comparación de orígenes**: el `URL` de Node devuelve `origin === 'null'` para esquemas no especiales (`app://bundle`) y para `about:blank`, así que la comparación de §5.4 punto 1 y §5.6 paso 1 con `new URL(url).origin` aceptaría orígenes distintos. Se compara `${protocol}//${host}` (`originOf()` en `security/navigation-guard.ts`), que usan el guard de navegación, el del emisor del IPC y el guard de red.
24. **`allowScripts` de npm 11.19**: ver "Resultados del spike". §2.1 dice que `better-sqlite3-multiple-ciphers` no compila nada; con npm 11.19 hay que denegar su `node-gyp rebuild` implícito en `package.json` para que `npm ci` no lo intente si alguien aprueba todos los scripts.
25. **`installSessionGuards(ses, { devUrl })`**: la opción `e2e` de 0.5 no hace falta (los contadores se exponen en `index.ts`). La idempotencia guarda la promesa por sesión (`WeakMap`), así que la llamada explícita del arranque espera al mismo `setProxy` que lanzó `session-created`.
26. **Firma de `invoke`**: `invoke(channel, ...args: InvokeArgs<C>)`, que permite omitir la petición cuando `ReqOf<C>` es `undefined` (`invoke('app:getInfo')`). `ThemeId` va ya en `src/shared/types.ts` porque lo necesita `GaleriaApi.initialTheme`; el preload lleva una lista temporal de ids hasta que F1 cree `src/shared/themes.ts`.
27. **`getLastWebPreferences()`** no está en `electron.d.ts` (existe en runtime) y no informa de `spellcheck`; el E2E comprueba el resto de opciones y el corrector queda cubierto por `spellcheck: false` y `setSpellCheckerEnabled(false)`.
28. **Avisos sin impacto**: Vitest avisa de que `vitest.config.ts` (ESM en un paquete sin `"type"`) no será compatible con el futuro `configLoader: 'native'` de Vite (si cambia el valor por defecto, renombrar a `vitest.config.mts`); npm marca `eslint@9.39.5` como fuera de soporte (se mantiene por el peer de `eslint-plugin-jsx-a11y` 6.10.2, §2.3); `npm audit` da 8 avisos moderados, todos en la cadena de desarrollo de `electron-builder` (`sprintf-js` vía `global-agent`/`@electron/get`), sin efecto en runtime. Se revisan en F7.
29. Node 26.10.0 no es LTS (línea Current). Cumple todos los `engines` y §2.5 lo acepta; no se pausó el flujo.
30. **`engines.node`**: §2.5 y 0.2 lo escriben `"^24.0.0 || >=26.0.0"`; el brief del scaffold pide que no haya ningún `^` ni `~` en `package.json`. Se usa la forma equivalente `">=24.0.0 <25.0.0 || >=26.0.0"` (mismo conjunto de versiones: 24.x y ≥ 26, sin Node 25).

