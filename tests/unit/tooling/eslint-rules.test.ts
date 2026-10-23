// Comprueba que las reglas de seguridad de eslint.config.mjs saltan donde deben y no saltan en sus
// excepciones (P5: un bloque posterior sustituye las opciones de la regla, no las fusiona).
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const IMPORTS = '@typescript-eslint/no-restricted-imports';
const GLOBALS = 'no-restricted-globals';
const SYNTAX = 'no-restricted-syntax';
const PROPERTIES = 'no-restricted-properties';

interface Case {
  title: string;
  file: string;
  code: string;
  rule: string;
  fires: boolean;
}

const cases: Case[] = [
  // Red de Node y globals
  {
    title: 'fetch() en main',
    file: 'src/main/x.ts',
    code: "fetch('x');",
    rule: GLOBALS,
    fires: true,
  },
  {
    title: 'fetch() en preload',
    file: 'src/preload/x.ts',
    code: "fetch('x');",
    rule: GLOBALS,
    fires: true,
  },
  {
    title: 'window en main',
    file: 'src/main/x.ts',
    code: 'window.close();',
    rule: GLOBALS,
    fires: true,
  },
  {
    title: 'node:net en main',
    file: 'src/main/x.ts',
    code: "import net from 'node:net';\nexport { net };",
    rule: IMPORTS,
    fires: true,
  },
  {
    title: 'node:net en node-egress-guard.ts',
    file: 'src/main/security/node-egress-guard.ts',
    code: "import net from 'node:net';\nexport { net };",
    rule: IMPORTS,
    fires: false,
  },
  {
    title: 'node:http en loopback-server.ts',
    file: 'src/main/media/loopback-server.ts',
    code: "import http from 'node:http';\nexport { http };",
    rule: IMPORTS,
    fires: false,
  },
  {
    title: 'node:https en loopback-server.ts (la excepción no abre el resto)',
    file: 'src/main/media/loopback-server.ts',
    code: "import https from 'node:https';\nexport { https };",
    rule: IMPORTS,
    fires: true,
  },
  {
    title: 'node:child_process fuera de ffmpeg.ts',
    file: 'src/main/x.ts',
    code: "import cp from 'node:child_process';\nexport { cp };",
    rule: IMPORTS,
    fires: true,
  },
  {
    title: 'node:child_process en ffmpeg.ts',
    file: 'src/main/media/ffmpeg.ts',
    code: "import cp from 'node:child_process';\nexport { cp };",
    rule: IMPORTS,
    fires: false,
  },
  {
    title: 'net de electron',
    file: 'src/main/x.ts',
    code: "import { net } from 'electron';\nexport { net };",
    rule: IMPORTS,
    fires: true,
  },
  // [H3-2] paquetes de dependencies fuera de main
  {
    title: 'zod en el preload',
    file: 'src/preload/index.ts',
    code: "import { z } from 'zod';\nexport const s = z.string();",
    rule: IMPORTS,
    fires: true,
  },
  {
    title: 'zod en shared',
    file: 'src/shared/x.ts',
    code: "import { z } from 'zod';\nexport const s = z.string();",
    rule: IMPORTS,
    fires: true,
  },
  {
    title: 'zod en main',
    file: 'src/main/x.ts',
    code: "import { z } from 'zod';\nexport const s = z.string();",
    rule: IMPORTS,
    fires: false,
  },
  // sharp
  {
    title: 'sharp en main',
    file: 'src/main/x.ts',
    code: "import sharp from 'sharp';\nexport default sharp;",
    rule: IMPORTS,
    fires: true,
  },
  {
    title: 'sharp en sharp-loader.ts',
    file: 'src/main/media/sharp-loader.ts',
    code: "import sharp from 'sharp';\nexport default sharp;",
    rule: IMPORTS,
    fires: false,
  },
  {
    title: 'import type de sharp en main',
    file: 'src/main/x.ts',
    code: "import type { Sharp } from 'sharp';\nexport type S = Sharp;",
    rule: IMPORTS,
    fires: false,
  },
  {
    title: "await import('sharp') en main",
    file: 'src/main/x.ts',
    code: "export async function f() {\n  return import('sharp');\n}",
    rule: SYNTAX,
    fires: true,
  },
  {
    title: "await import('sharp') en sharp-loader.ts",
    file: 'src/main/media/sharp-loader.ts',
    code: "export async function f() {\n  return import('sharp');\n}",
    rule: SYNTAX,
    fires: false,
  },
  {
    title: 'transacción async en sharp-loader.ts (conserva el primer selector)',
    file: 'src/main/media/sharp-loader.ts',
    code: 'declare const db: { transaction(f: unknown): void };\ndb.transaction(async () => {});',
    rule: SYNTAX,
    fires: true,
  },
  {
    title: 'db.transaction(async () => {}) en main',
    file: 'src/main/x.ts',
    code: 'declare const db: { transaction(f: unknown): void };\ndb.transaction(async () => {});',
    rule: SYNTAX,
    fires: true,
  },
  // Listeners únicos de webRequest y shell
  {
    title: 'onBeforeRequest fuera de network-guard.ts',
    file: 'src/main/x.ts',
    code: 'declare const ses: { webRequest: { onBeforeRequest(f: unknown): void } };\nses.webRequest.onBeforeRequest(() => {});',
    rule: PROPERTIES,
    fires: true,
  },
  {
    title: 'onBeforeRequest en network-guard.ts',
    file: 'src/main/security/network-guard.ts',
    code: 'declare const ses: { webRequest: { onBeforeRequest(f: unknown): void } };\nses.webRequest.onBeforeRequest(() => {});',
    rule: PROPERTIES,
    fires: false,
  },
  {
    title: 'onHeadersReceived en network-guard.ts',
    file: 'src/main/security/network-guard.ts',
    code: 'declare const ses: { webRequest: { onHeadersReceived(f: unknown): void } };\nses.webRequest.onHeadersReceived(() => {});',
    rule: PROPERTIES,
    fires: true,
  },
  {
    title: 'onHeadersReceived en csp.ts',
    file: 'src/main/security/csp.ts',
    code: 'declare const ses: { webRequest: { onHeadersReceived(f: unknown): void } };\nses.webRequest.onHeadersReceived(() => {});',
    rule: PROPERTIES,
    fires: false,
  },
  {
    title: "shell.openExternal('x')",
    file: 'src/main/x.ts',
    code: "import { shell } from 'electron';\nvoid shell.openExternal('x');",
    rule: PROPERTIES,
    fires: true,
  },
  {
    title: "shell['openPath'] en el renderer",
    file: 'src/renderer/src/x.ts',
    code: "declare const shell: { openPath(p: string): void };\nshell['openPath']('x');",
    rule: PROPERTIES,
    fires: true,
  },
  // WebRTC
  {
    title: 'new RTCPeerConnection() en el renderer',
    file: 'src/renderer/src/x.ts',
    code: 'export const pc = new RTCPeerConnection();',
    rule: GLOBALS,
    fires: true,
  },
];

let eslint: ESLint;

// La primera llamada carga eslint.config.mjs y los plugins; con toda la suite en paralelo puede
// pasar de los 5 s por test, así que se hace aquí con más margen.
beforeAll(async () => {
  eslint = new ESLint({ cwd: ROOT });
  await eslint.lintText('export {};', { filePath: join(ROOT, 'src/main/warmup.ts') });
}, 60_000);

async function rulesFor(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(ROOT, file) });
  expect(result?.fatalErrorCount ?? 0).toBe(0);
  return (result?.messages ?? []).map((m) => m.ruleId ?? 'fatal');
}

describe('reglas de seguridad de ESLint', () => {
  it.each(cases)('$title → $rule: $fires', async ({ file, code, rule, fires }) => {
    const rules = await rulesFor(file, code);
    if (fires) expect(rules).toContain(rule);
    else expect(rules).not.toContain(rule);
  });
});
