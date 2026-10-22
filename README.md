# Galería

Galería es una bóveda privada de fotos y vídeos para Windows y Linux, con la experiencia de Fotos de Windows. Todo lo que se importa se cifra dentro de la bóveda del perfil y la app funciona sin conexión: no usa la nube ni hace ninguna conexión de red.

Estado actual: solo el scaffold (Fase 0). Hay una ventana oscura con el título "Galería" y la base de seguridad (ventana endurecida, CSP estricta y red bloqueada), pero todavía ninguna función del producto.

## Prerrequisitos

- Node.js 26 (línea Current; se recomienda el último parche 26.x) o Node.js 24 LTS. `engines.node` admite 24.x y ≥ 26 (Node 25 no, porque Vitest lo excluye).
- Git.
- En PowerShell, usa `npm.cmd` y `npx.cmd` en lugar de `npm` y `npx`: la política de ejecución `RemoteSigned` bloquea `npm.ps1` porque no está firmado.
- No hace falta Visual Studio Build Tools: los módulos nativos (`@node-rs/argon2`, `better-sqlite3-multiple-ciphers` y `sharp`) traen binarios N-API precompilados. `package.json` deniega a propósito el script de instalación de `better-sqlite3-multiple-ciphers` (`allowScripts`), que intentaría compilar con node-gyp.

Instalación:

```powershell
npm.cmd ci
```

## Scripts

| Script                     | Qué hace                                                              |
| -------------------------- | --------------------------------------------------------------------- |
| `npm.cmd run dev`          | Arranca la app en desarrollo (`electron-vite dev`, Vite en 127.0.0.1) |
| `npm.cmd run build`        | Compila main, preload y renderer en `out/`                            |
| `npm.cmd run typecheck`    | Comprueba los tipos (`tsconfig.node.json` y `tsconfig.web.json`)      |
| `npm.cmd run lint`         | ESLint, incluidas las reglas de seguridad                             |
| `npm.cmd run format`       | Formatea con Prettier                                                 |
| `npm.cmd test`             | Tests unitarios con Vitest                                            |
| `npm.cmd run test:e2e`     | Compila y ejecuta los E2E de Playwright contra la app de Electron     |
| `npm.cmd run spike:native` | Carga los módulos nativos dentro del proceso main de Electron         |
| `npm.cmd run make:icon`    | Regenera `resources/build/icon.png`                                   |

## Documentación

- [Diseño técnico](docs/DESIGN.md)
- [Plan de implementación](docs/PLAN.md)
