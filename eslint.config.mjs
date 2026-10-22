// @ts-check
// Configuración plana de ESLint con las reglas de seguridad de docs/DESIGN.md §5.4 y [H3-2].
//
// P5: en la configuración plana, un bloque posterior SUSTITUYE las opciones de la misma regla en vez
// de fusionarlas. Por eso las opciones de cada regla restringida se generan con una función y cada
// excepción por archivo repite la lista completa menos lo permitido. tests/unit/tooling lo comprueba.
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const MAIN = 'src/main/**/*.{ts,tsx}';
const PRELOAD = 'src/preload/**/*.{ts,tsx}';
const SHARED = 'src/shared/**/*.{ts,tsx}';
const RENDERER = 'src/renderer/**/*.{ts,tsx}';

const NODE_NET_MODULES = ['http', 'https', 'net', 'tls', 'dgram', 'dns', 'http2'].flatMap((m) => [
  m,
  `node:${m}`,
]);
const CHILD_PROCESS = ['child_process', 'node:child_process'];
// Paquetes de `dependencies` que solo puede cargar main ([H3-2]).
const MAIN_ONLY_DEPS = [
  'zod',
  'sharp',
  'exifr',
  'better-sqlite3-multiple-ciphers',
  '@node-rs/argon2',
];

/**
 * Opciones de @typescript-eslint/no-restricted-imports para un ámbito, menos los nombres permitidos.
 * @param {'main' | 'preload' | 'shared' | 'renderer'} scope
 * @param {string[]} [allow]
 */
function restrictedImports(scope, allow = []) {
  /** @type {{ name: string; message: string; importNames?: string[]; allowTypeImports?: boolean }[]} */
  const paths = [];
  /** @param {string} name @param {string} message @param {object} [extra] */
  const add = (name, message, extra = {}) => {
    if (!allow.includes(name)) paths.push({ name, message, ...extra });
  };
  if (scope === 'main' || scope === 'preload') {
    for (const name of NODE_NET_MODULES) {
      add(name, 'Red de Node prohibida en main y preload (§5.4, punto 10).');
    }
    for (const name of CHILD_PROCESS) {
      add(name, 'child_process solo en src/main/media/ffmpeg.ts (§5.4, punto 10).');
    }
  }
  add('electron', 'electron.net prohibido: va por la red de Chromium (§5.4, punto 10).', {
    importNames: ['net'],
  });
  if (scope === 'main') {
    add('sharp', 'sharp solo se carga en src/main/media/sharp-loader.ts (§12.4).', {
      allowTypeImports: true,
    });
  } else {
    for (const name of MAIN_ONLY_DEPS) {
      add(
        name,
        '[H3-2] src/shared, src/preload y src/renderer no importan paquetes de dependencies.',
      );
    }
  }
  const patterns =
    scope === 'main'
      ? []
      : [
          {
            group: MAIN_ONLY_DEPS.map((d) => `${d}/*`),
            message:
              '[H3-2] src/shared, src/preload y src/renderer no importan paquetes de dependencies.',
          },
        ];
  return /** @type {const} */ (['error', { paths, patterns }]);
}

const TRANSACTION_ASYNC = {
  selector: "CallExpression[callee.property.name='transaction'] > :function[async=true]",
  message: 'db.transaction() con una función async confirma antes de que termine (§13.3).',
};
const SHARP_DYNAMIC_IMPORT = {
  selector: "ImportExpression[source.value='sharp']",
  message: 'sharp solo se carga en src/main/media/sharp-loader.ts (§12.4).',
};

const NET_GLOBALS = ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest'].map((name) => ({
  name,
  message: 'Red prohibida en main y preload (§5.4, punto 10).',
}));
const DOM_GLOBALS = ['window', 'document'].map((name) => ({
  name,
  message: 'main no tiene DOM (P4).',
}));
const WEBRTC_GLOBALS = ['RTCPeerConnection', 'webkitRTCPeerConnection'].map((name) => ({
  name,
  message: 'WebRTC prohibido: no pasa por webRequest ni por la CSP (§5.4, punto 5).',
}));

/**
 * Opciones de no-restricted-properties (sin `object`) en todo src/, menos las permitidas.
 * @param {string[]} [allow]
 */
function restrictedProperties(allow = []) {
  const all = [
    { property: 'openExternal', message: 'shell.openExternal prohibido (§5.4, punto 9).' },
    { property: 'openPath', message: 'shell.openPath prohibido (§5.4, punto 9).' },
    {
      property: 'onBeforeRequest',
      message:
        'Solo en src/main/security/network-guard.ts: un segundo listener sustituye al guard.',
    },
    {
      property: 'onHeadersReceived',
      message: 'Solo en src/main/security/csp.ts: un segundo listener sustituye al de la CSP.',
    },
  ];
  return /** @type {const} */ (['error', ...all.filter((p) => !allow.includes(p.property))]);
}

export default defineConfig(
  {
    ignores: [
      'node_modules/',
      'out/',
      'dist/',
      'release/',
      '.cache/',
      'coverage/',
      'test-results/',
      'playwright-report/',
      'tests/.tmp/',
      'resources/',
      'docs/',
      '.agents/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Entornos
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    ignores: ['src/renderer/**'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: [RENDERER],
    languageOptions: { globals: globals.browser },
  },
  { ...reactHooks.configs.flat.recommended, files: [RENDERER] },
  { ...reactRefresh.configs.vite, files: [RENDERER] },
  { ...jsxA11y.flatConfigs.recommended, files: [RENDERER] },

  // Seguridad: todo src/
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-properties': restrictedProperties(),
    },
  },
  // Seguridad: por ámbito
  {
    files: [MAIN],
    rules: {
      '@typescript-eslint/no-restricted-imports': restrictedImports('main'),
      'no-restricted-syntax': ['error', TRANSACTION_ASYNC, SHARP_DYNAMIC_IMPORT],
      'no-restricted-globals': ['error', ...NET_GLOBALS, ...DOM_GLOBALS],
    },
  },
  {
    files: [PRELOAD],
    rules: {
      '@typescript-eslint/no-restricted-imports': restrictedImports('preload'),
      'no-restricted-globals': ['error', ...NET_GLOBALS],
    },
  },
  {
    files: [SHARED],
    rules: { '@typescript-eslint/no-restricted-imports': restrictedImports('shared') },
  },
  {
    files: [RENDERER],
    rules: {
      '@typescript-eslint/no-restricted-imports': restrictedImports('renderer'),
      'no-restricted-globals': ['error', ...WEBRTC_GLOBALS],
    },
  },
  // Seguridad: excepciones por archivo (cada una repite la lista completa menos lo permitido)
  {
    files: ['src/main/media/loopback-server.ts'],
    rules: { '@typescript-eslint/no-restricted-imports': restrictedImports('main', ['node:http']) },
  },
  {
    files: ['src/main/security/node-egress-guard.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': restrictedImports('main', NODE_NET_MODULES),
    },
  },
  {
    files: ['src/main/media/ffmpeg.ts'],
    rules: { '@typescript-eslint/no-restricted-imports': restrictedImports('main', CHILD_PROCESS) },
  },
  {
    files: ['src/main/media/sharp-loader.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': restrictedImports('main', ['sharp']),
      'no-restricted-syntax': ['error', TRANSACTION_ASYNC],
    },
  },
  {
    files: ['src/main/security/network-guard.ts'],
    rules: { 'no-restricted-properties': restrictedProperties(['onBeforeRequest']) },
  },
  {
    files: ['src/main/security/csp.ts'],
    rules: { 'no-restricted-properties': restrictedProperties(['onHeadersReceived']) },
  },

  prettier,
);
